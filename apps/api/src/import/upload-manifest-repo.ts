// B-20 · 直传路径上传 manifest 仓库（20 §2.1/§2.2，Codex P1-r2）。
//   presign 持久化「本次直传会话声明的期望分片清单」（每 part 的 s3Key + 可选 content-hash）；
//   POST /import/jobs 据本表校验「所有 expected part 都已落桶」才建 job——与助手路径
//   import_pairings.landed_parts 同义的 manifest 完整性闸（直传不再「有任意对象就建 job」）。
//   失败/异常一律由上层收口为人话 ErrorEnvelope（绝不裸露 DB 报错，脊柱 §11.B）；本仓库只做受保护 SQL。
import type { ImportSource, JobStatus, ProgressView } from '@cb/shared';
import type { Queryable } from '../jobs/types.js';
import type { QueryableDb } from '../events/db-tx.js';
import { normalizeProgress } from '../jobs/repo.js';

/** 一个期望分片的声明（presign 落 manifest）。 */
export interface ExpectedPart {
  clientPartId: string;
  s3Key: string;
  /** 端到端完整性校验用（presign 可选声明；缺则只校验「键存在」不校验 hash）。 */
  contentSha256?: string | null;
}

/** presign 持久化 manifest 入参。 */
export interface PersistManifestInput {
  ownerUserId: string;
  uploadId: string;
  source: ImportSource;
  totalBytes: number;
  expectedParts: ExpectedPart[];
}

/** manifest 行（POST /import/jobs 读出据此判齐 + 取有序 rawS3Keys）。 */
export interface UploadManifest {
  uploadId: string;
  source: ImportSource;
  /** clientPartId → { s3Key, contentSha256 }。 */
  expectedParts: Record<string, { s3Key: string; contentSha256: string | null }>;
  consumedAt: string | null;
  /**
   * 兑换时回写的 job_id（Codex P1-r5：consumed_at 与 job INSERT 同事务、本列与 consumed_at 同语句写）。
   *   不变式：consumed_at 非空 ⇒ job_id 非空。同一 uploadId 重试据此恢复已建 job（非 404、不重复建）。
   */
  jobId: string | null;
}

/**
 * presign 持久化 upload manifest（Codex P1-r2）。同 (owner, uploadId) 重放 → upsert 回放同一行
 *   （断点续传重新 presign 同 uploadId 不重复建行、覆盖 expected 清单为最新声明）。consumed_at 不被 upsert 清。
 */
export async function persistUploadManifest(
  db: Queryable,
  input: PersistManifestInput,
): Promise<void> {
  const expected: Record<string, { s3Key: string; contentSha256: string | null }> = {};
  for (const p of input.expectedParts) {
    expected[p.clientPartId] = { s3Key: p.s3Key, contentSha256: p.contentSha256 ?? null };
  }
  await db.query(
    `INSERT INTO import_uploads (owner_user_id, upload_id, source, expected_parts, total_bytes)
     VALUES ($1, $2, $3, $4::jsonb, $5)
     ON CONFLICT (owner_user_id, upload_id)
       DO UPDATE SET expected_parts = EXCLUDED.expected_parts,
                     source         = EXCLUDED.source,
                     total_bytes    = EXCLUDED.total_bytes,
                     updated_at     = now()`,
    [input.ownerUserId, input.uploadId, input.source, JSON.stringify(expected), input.totalBytes],
  );
}

/**
 * 读 upload manifest（POST /import/jobs 完整性闸前置；按 owner + uploadId 定位，跨 owner 读不到）。
 *   不存在/非本人 → null（uploadId 失效引导重发）。
 */
export async function readUploadManifest(
  db: Queryable,
  ownerUserId: string,
  uploadId: string,
): Promise<UploadManifest | null> {
  const res = await db.query<{
    upload_id: string;
    source: ImportSource;
    expected_parts: Record<string, { s3Key: string; contentSha256: string | null }>;
    consumed_at: string | null;
    job_id: string | null;
  }>(
    `SELECT upload_id, source, expected_parts, consumed_at, job_id
       FROM import_uploads
      WHERE owner_user_id = $1 AND upload_id = $2`,
    [ownerUserId, uploadId],
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    uploadId: row.upload_id,
    source: row.source,
    expectedParts: row.expected_parts ?? {},
    consumedAt: row.consumed_at ? new Date(row.consumed_at).toISOString() : null,
    jobId: row.job_id ?? null,
  };
}

/** manifest 完整性闸判定结果（直传路径，与助手路径 manifestState 同义）。 */
export interface ManifestGateResult {
  /** 所有 expected part 都已落桶（键存在；声明过 hash 的不在此校验，hash 硬校验为 P2 后续加固）。 */
  complete: boolean;
  /** manifest 声明的期望 part 数。 */
  expectedCount: number;
  /** 实际已落桶且在 manifest 内的 part 数。 */
  landedCount: number;
  /** 有序 rawS3Keys（按 clientPartId 字典序，worker 据此逐个拉原文）。仅 complete 时供建 job。 */
  rawS3Keys: string[];
}

/**
 * 据 manifest 的 expected parts 与桶里实际落地的 key 集，判「是否传齐」（Codex P1-r2 直传完整性闸）。
 *   expected 为空（无声明）→ 视作未齐（不建 job，避免空 manifest 误放行）。
 *   complete 当且仅当：每个 expected part 的 s3Key 都出现在 landedKeys 中。
 */
export function evaluateManifestGate(
  manifest: UploadManifest,
  landedKeys: Iterable<string>,
): ManifestGateResult {
  const landed = new Set(landedKeys);
  const entries = Object.entries(manifest.expectedParts).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  const expectedCount = entries.length;
  let landedCount = 0;
  const rawS3Keys: string[] = [];
  for (const [, part] of entries) {
    if (landed.has(part.s3Key)) {
      landedCount += 1;
      rawS3Keys.push(part.s3Key);
    }
  }
  const complete = expectedCount > 0 && landedCount === expectedCount;
  return { complete, expectedCount, landedCount, rawS3Keys };
}

/** 原子兑换 + 建 job 入参（Codex P1-r5：consume(consumed_at) + job INSERT 同一 PG 事务）。 */
export interface ConsumeAndInsertInput {
  ownerUserId: string;
  uploadId: string;
  /** worker 据此从 S3 拉原文（gate.rawS3Keys，有序）。 */
  rawS3Keys: string[];
  source: ImportSource;
  /** 续传草稿挂接（可空）。 */
  draftId?: string;
  /** progress 五项 pending 的 JSON（建 job 行用，由调用方传 initialImportProgress 序列化）。 */
  initialProgressJson: string;
}

/** 原子兑换 + 建 job 产物（供秒回完整 JobView，Codex P1-7/P1-r5）。 */
export interface ConsumedJob {
  jobId: string;
  fenceToken: number;
  attemptNo: number;
  createdAt: string;
}

/**
 * 原子兑换 manifest + 建 import job（Codex P1-r6，照搬助手路径 createImportJobForPairing 的「单次 UPDATE」正确形态）。
 *   **单条 CTE / 必须在同一 PG 事务连接（tx）上执行**——consume(置 consumed_at) 与 job INSERT 要么都成、要么都不成：
 *     ① `active` SELECT ... FROM import_uploads WHERE owner+upload AND consumed_at IS NULL **FOR UPDATE**
 *        ——纯读守门 + 行级写锁（不写行），**未命中（不存在/非本人/已兑换）→ 0 行 → INSERT 数据源为空 → 不建 job**。
 *     ② `new_job` INSERT INTO jobs SELECT ... **FROM active** RETURNING id...——数据源是 active，
 *        active 空时 INSERT 自然 0 行（绝不建孤儿 job，与助手路径 INSERT...SELECT FROM active 同义）。
 *     ③ 末尾**单次** UPDATE import_uploads SET consumed_at=now(), job_id=(SELECT id FROM new_job)
 *        WHERE id=(SELECT id FROM active)——把 consumed_at 与 job_id **在同一条 UPDATE 同时写**进 active 命中的那一行
 *        （import_uploads 行在本语句**只被改一次**）。不变式 `consumed_at 非空 ⇒ job_id 非空` 由【同一条 UPDATE 同时写两列】在 PG 层硬保证。
 *   ⚠️ 旧实现（Codex r5/r6 命中）在同一 data-modifying CTE 里先 `consumed` UPDATE 置 consumed_at、再 `linked` 二次 UPDATE 同一行回写 job_id：
 *     真实 PostgreSQL 单语句二次改同一行结果不可靠（第二个 UPDATE 看到的是语句开始时的快照，可能不命中已被前一个 CTE 改过的行）
 *     → 可能留下 consumed_at 非空但 job_id IS NULL → 破坏不变式 + 同 uploadId 重试无法按 job_id 恢复。
 *     现改为「active 守门(纯读 FOR UPDATE) → INSERT SELECT FROM active → 单次 UPDATE 一并写 consumed_at/job_id」，根除「同行二次改」的不可靠面。
 *   ⚠️ 更早的孤儿 job 隐患（Codex P1-r2）：INSERT 必须 `SELECT FROM active`（数据源是守门 CTE），绝不可 `VALUES`——
 *     真实 PG 中所有 data-modifying CTE 都会执行，INSERT...VALUES 不依赖守门 → active 未命中时仍建 job → 孤儿 queued。
 *   兑换成功（首次）→ 返回 {@link ConsumedJob}；已被兑换/不存在 → 返回 null（调用方据此走恢复或 404）。
 *   注意：fence_token 初值 1（与助手路径一致：claimLease 领时再换；>0 表「需入队」）。
 */
export async function consumeManifestAndInsertJob(
  tx: QueryableDb,
  input: ConsumeAndInsertInput,
): Promise<ConsumedJob | null> {
  const subjectRef = JSON.stringify({
    uploadId: input.uploadId,
    source: input.source,
    rawS3Keys: input.rawS3Keys,
    ...(input.draftId ? { draftId: input.draftId } : {}),
  });
  const res = await tx.query<{
    id: string;
    fence_token: number;
    attempt_no: number;
    created_at: string;
  }>(
    `WITH active AS (
        SELECT u.id, u.owner_user_id
          FROM import_uploads u
         WHERE u.owner_user_id = $1 AND u.upload_id = $2 AND u.consumed_at IS NULL
         FOR UPDATE
     ),
     new_job AS (
        INSERT INTO jobs (type, status, owner_user_id, subject_ref, progress, fence_token)
        SELECT 'import', 'queued', a.owner_user_id, $3::jsonb, $4::jsonb, 1
          FROM active a
        RETURNING id, fence_token, attempt_no, created_at
     ),
     redeemed AS (
        UPDATE import_uploads u
           SET consumed_at = now(),
               job_id      = (SELECT id FROM new_job),
               updated_at  = now()
         WHERE u.id = (SELECT id FROM active)
         RETURNING u.id
     )
     SELECT id, fence_token, attempt_no, created_at FROM new_job`,
    [input.ownerUserId, input.uploadId, subjectRef, input.initialProgressJson],
  );
  const row = res.rows[0];
  if (!row) return null; // 不存在/非本人/已被兑换（并发或重放）→ 不建 job，调用方走恢复/404。
  return {
    jobId: row.id,
    fenceToken: Number(row.fence_token),
    attemptNo: Number(row.attempt_no ?? 0),
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString(),
  };
}

/** 恢复读出的已建 job 视图字段（Codex P1-r5：同 uploadId 重试回放已建 job 的 JobView，非 404）。 */
export interface RecoveredJobView {
  jobId: string;
  status: JobStatus;
  progress: ProgressView;
  attemptNo: number;
  createdAt: string;
}

/**
 * 据已兑换 manifest 回写的 job_id 读出该 job 的 JobView 字段（Codex P1-r5 幂等可恢复）。
 *   同一 uploadId 在「manifest 已 consumed 且 job_id 已回写」时重试——返回已存在 job 的真实状态/进度
 *   （不返回 404、不重复建 job）。owner 守门：仅本人 owner 的 job 可恢复（不暴露他人 job）。
 *   返回 null = job 行已不存在（极端：被 GC，理论上 FK 阻止）→ 调用方退回 404 引导重发。
 */
export async function readJobViewForRecovery(
  db: Queryable,
  ownerUserId: string,
  jobId: string,
): Promise<RecoveredJobView | null> {
  const res = await db.query<{
    id: string;
    status: JobStatus;
    progress: Partial<ProgressView> | null;
    attempt_no: number;
    created_at: string;
  }>(
    `SELECT id, status, progress, attempt_no, created_at
       FROM jobs
      WHERE id = $1 AND owner_user_id = $2 AND type = 'import'`,
    [jobId, ownerUserId],
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    jobId: row.id,
    status: row.status,
    progress: normalizeProgress(row.progress),
    attemptNo: Number(row.attempt_no ?? 0),
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString(),
  };
}

// B-21 · 本机助手配对仓库（20-step1-import §3 / §6.4）。
//   配对会话 import_pairings 的写/读：铸码（mint）、状态读（read）、上传进度推进（part 落地）、
//   上传齐后自动建 import Job（create job + enqueue）+ 回写 pairId。
//   配对码隐私硬约束（Codex#15）：只存 pairing_code_hash（SHA-256，与 pair-auth.ts 共用唯一真源），
//     绝不持久化明文 6 位码——明文只在 mint 响应返回一次（铸码者眼前）。
//   失败/异常一律由上层收口为人话 ErrorEnvelope（绝不裸露 DB 报错，脊柱 §11.B）；本仓库只做受保护 SQL。
import { randomInt } from 'node:crypto';
import type { ImportSource, JobId, PairPhase } from '@cb/shared';
import type { Queryable } from '../jobs/types.js';
import { hashPairingCode } from '../middleware/pair-auth.js';
import { initialImportProgress } from './create-job.js';

/** 配对码有效期（默认 20 分钟，20 §3.1 / §6.4）。 */
export const PAIRING_TTL_MS = 20 * 60 * 1000;

/** 配对码长度（6 位数字，20 §3.1）。 */
const PAIRING_CODE_DIGITS = 6;

/** 验收口径固定串（导入-03/24 命令框内容、一键复制；恒定，不含 BASE/code）。 */
export const CURL_ONE_LINER = 'curl -fsSL agora.app/import | sh';

/**
 * 生成 6 位一次性配对码（明文）。用 crypto.randomInt（CSPRNG，非 Math.random），
 * 左补零保证恒 6 位（避免 042100 被截成 42100 导致校验长度漂移）。明文只返一次、绝不落库。
 */
export function generatePairingCode(): string {
  const max = 10 ** PAIRING_CODE_DIGITS; // 1_000_000
  return String(randomInt(0, max)).padStart(PAIRING_CODE_DIGITS, '0');
}

/**
 * 注入了 BASE + code 的整行可复制命令（导入-25 真实链路）。
 *   形如：curl -fsSL <BASE>/api/v1/import/connect/script?code=XXXXXX | node -
 * BASE 由调用方据请求 Host + x-forwarded-proto 算（railway 给 https）。
 */
export function buildConnectCommand(base: string, code: string): string {
  const trimmed = base.replace(/\/+$/, ''); // 去尾斜杠，避免 //api
  return `curl -fsSL ${trimmed}/api/v1/import/connect/script?code=${code} | node -`;
}

/** mint 入参（铸码者 + 可选续传草稿挂接）。 */
export interface MintPairingInput {
  ownerUserId: string;
  draftId?: string;
}

/** mint 产物（明文码只此处出现一次，不落库）。 */
export interface MintedPairing {
  pairId: string;
  pairingCode: string; // 明文 6 位，仅返回一次（服务端只存 hash）
  expiresAt: string; // ISO
}

/**
 * 铸一次性配对码（20 §3.1 / §6.4）。
 *   - 只存 pairing_code_hash（Codex#15），明文随返回值出一次。
 *   - phase='waiting'、attempt_count=0、max_attempts=5（默认）、expires_at=now+20min。
 *   - 唯一约束只限 active 配对（uq_pairings_code_active）——active 期 hash 撞键极罕见，
 *     撞键则 ON CONFLICT DO NOTHING 返回 0 行 → 重铸一个新码（最多重试几次）。
 *   幂等由上层 requireIdempotency(import.connect.pair) 兜（同 key 回放首次 pairId+码），本函数只负责写一行。
 */
export async function mintPairing(db: Queryable, input: MintPairingInput): Promise<MintedPairing> {
  // active 期 hash 撞键概率极低；重试几次铸新码以确保插入成功。
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = generatePairingCode();
    const codeHash = hashPairingCode(code);
    const res = await db.query<{ id: string; expires_at: string }>(
      `INSERT INTO import_pairings
         (owner_user_id, pairing_code_hash, phase, draft_id, expires_at)
       VALUES
         ($1, $2, 'waiting', $3, now() + ($4 || ' milliseconds')::interval)
       ON CONFLICT (pairing_code_hash) WHERE used_at IS NULL AND phase IN ('waiting','uploading')
         DO NOTHING
       RETURNING id, expires_at`,
      [input.ownerUserId, codeHash, input.draftId ?? null, String(PAIRING_TTL_MS)],
    );
    const row = res.rows[0];
    if (row) {
      return {
        pairId: row.id,
        pairingCode: code,
        expiresAt: new Date(row.expires_at).toISOString(),
      };
    }
    // 撞 active hash（极罕见）：换码重试。
  }
  throw new Error('mintPairing: code collision after retries');
}

/** 状态读返回（网页轮询 GET /connect/pair/:pairId 用，含 owner 供属主校验）。 */
export interface PairingStatusRow {
  ownerUserId: string;
  phase: PairPhase;
  jobId: string | null;
  uploadedParts: number;
  totalParts: number | null;
  expired: boolean; // expires_at <= now()（SQL 算，避时钟漂移）
}

/**
 * 读配对状态（20 §3.4）。owner 由 handler 校验（仅本人可轮询自己的配对）。
 *   过期未达终态的配对在此读时按「显示口径」折算 phase=expired（不裸转圈，有出口态）；
 *   真正落库 expired 由 sweeper GC（本读不写库，保持只读语义）。
 */
export async function readPairingStatus(
  db: Queryable,
  pairId: string,
): Promise<PairingStatusRow | null> {
  const res = await db.query<{
    owner_user_id: string;
    phase: PairPhase;
    job_id: string | null;
    uploaded_parts: number;
    total_parts: number | null;
    expired: boolean;
  }>(
    `SELECT owner_user_id,
            phase,
            job_id,
            uploaded_parts,
            total_parts,
            (expires_at <= now()) AS expired
       FROM import_pairings
      WHERE id = $1`,
    [pairId],
  );
  const row = res.rows[0];
  if (!row) return null;
  // 过期且未达终态 → 对外显示 expired（导入-19 有出口态）。job_created 是终态不被过期覆盖。
  let phase = row.phase;
  if (row.expired && phase !== 'job_created' && phase !== 'expired') {
    phase = 'expired';
  }
  return {
    ownerUserId: row.owner_user_id,
    phase,
    jobId: row.job_id,
    uploadedParts: row.uploaded_parts,
    totalParts: row.total_parts,
    expired: row.expired,
  };
}

/** 一片原文落地登记（B-21 多分片协议，Codex P1-8 manifest）。 */
export interface PartLandedInput {
  pairId: string;
  /** 分片序号（0 起）。 */
  partIndex: number;
  /** 该分片在 agora-raw 桶的 key（已由路由真实写桶，Codex P0-2）。 */
  s3Key: string;
  /** 该分片内容 hash（端到端完整性 + per-part 幂等键来源，Codex P1-5）。 */
  contentSha256: string;
  /** 期望分片总数（声明则用于 complete 齐全校验；单片无 totalParts 视作 1）。 */
  totalParts?: number;
  uploadId?: string;
}

/** 落地登记结果（含登记后的 manifest 状态，供路由判「是否传齐」）。 */
export interface PartLandedResult {
  /** false = 配对已终态/过期，未登记（上层出人话信封）。 */
  recorded: boolean;
  /** 已落地分片数（manifest 键数）。 */
  uploadedParts: number;
  /** 期望总数（声明过则有值）。 */
  totalParts: number | null;
  /** 是否传齐（0..totalParts-1 全到齐；未声明 totalParts 则按已落地数 = 单片 1 判定）。 */
  complete: boolean;
}

/** 从 landed_parts manifest 算「已落地数 / 是否齐全 / 有序 rawS3Keys」。 */
function manifestState(
  landed: Record<string, { key: string; hash: string }>,
  totalParts: number | null,
): { uploadedParts: number; complete: boolean; rawS3Keys: string[] } {
  const indices = Object.keys(landed)
    .map((k) => Number(k))
    .filter((n) => Number.isInteger(n) && n >= 0)
    .sort((a, b) => a - b);
  const uploadedParts = indices.length;
  // 齐全：声明了 totalParts → 必须 0..totalParts-1 连续全到齐；未声明（单片）→ 至少 1 片即齐。
  let complete: boolean;
  if (totalParts !== null && totalParts > 0) {
    complete =
      uploadedParts >= totalParts &&
      indices.every((n, i) => n === i) &&
      indices.length === totalParts;
  } else {
    complete = uploadedParts >= 1;
  }
  const rawS3Keys = indices.map((i) => landed[String(i)]!.key);
  return { uploadedParts, complete, rawS3Keys };
}

/**
 * 记录一片原文落地（20 §3.3 分片途中 status:'uploading'，Codex P1-8 持久化 manifest）。
 *   受保护更新：仅 active 配对（未用、未过期、phase waiting/uploading）可登记，置 phase='uploading'。
 *   把本片登记进 landed_parts manifest（partIndex → { key, hash }），更新 uploaded_parts/total_parts。
 *   **不置 used_at**（Codex P1-4：多分片途中允许继续上传，used_at 只在 complete 兑换时落）。
 *   返回登记后的 manifest 状态（uploadedParts / totalParts / complete）；0 行 = 配对已终态/过期 → recorded:false。
 */
export async function recordPartLanded(
  db: Queryable,
  input: PartLandedInput,
): Promise<PartLandedResult> {
  const partEntry = JSON.stringify({ key: input.s3Key, hash: input.contentSha256 });
  const res = await db.query<{
    landed_parts: Record<string, { key: string; hash: string }>;
    total_parts: number | null;
  }>(
    `UPDATE import_pairings
        SET phase          = 'uploading',
            landed_parts   = jsonb_set(landed_parts, ARRAY[$2::text], $3::jsonb, true),
            total_parts    = COALESCE($4, total_parts),
            upload_id      = COALESCE($5, upload_id),
            uploaded_parts = (
              SELECT count(*) FROM jsonb_object_keys(
                jsonb_set(landed_parts, ARRAY[$2::text], $3::jsonb, true)
              )
            ),
            updated_at     = now()
      WHERE id = $1
        AND phase IN ('waiting','uploading')
        AND expires_at > now()
      RETURNING landed_parts, total_parts`,
    [
      input.pairId,
      String(input.partIndex),
      partEntry,
      input.totalParts ?? null,
      input.uploadId ?? null,
    ],
  );
  const row = res.rows[0];
  if (!row) return { recorded: false, uploadedParts: 0, totalParts: null, complete: false };
  const totalParts = row.total_parts ?? null;
  const { uploadedParts, complete } = manifestState(row.landed_parts ?? {}, totalParts);
  return { recorded: true, uploadedParts, totalParts, complete };
}

/** 读 active 配对的 manifest（complete 阶段建 job 前取 rawS3Keys + 校验齐全）。 */
export interface PairingManifest {
  uploadedParts: number;
  totalParts: number | null;
  complete: boolean;
  rawS3Keys: string[];
  source: ImportSource;
}

/**
 * 读配对 manifest（Codex P1-8：建 job 前据此判「传齐才建」+ 取有序 rawS3Keys）。
 *   仅读 active 配对（job_created/expired 终态不返）；不存在/终态 → null。
 */
export async function readPairingManifest(
  db: Queryable,
  pairId: string,
): Promise<PairingManifest | null> {
  const res = await db.query<{
    landed_parts: Record<string, { key: string; hash: string }>;
    total_parts: number | null;
  }>(
    `SELECT landed_parts, total_parts
       FROM import_pairings
      WHERE id = $1
        AND phase IN ('waiting','uploading')
        AND expires_at > now()`,
    [pairId],
  );
  const row = res.rows[0];
  if (!row) return null;
  const totalParts = row.total_parts ?? null;
  const { uploadedParts, complete, rawS3Keys } = manifestState(row.landed_parts ?? {}, totalParts);
  return { uploadedParts, totalParts, complete, rawS3Keys, source: 'mixed' };
}

/** 上传齐后自动建 import Job 入参（Codex P0-2：subject_ref 必带 rawS3Keys，worker 据此拉原文）。 */
export interface CreateImportJobInput {
  pairId: string;
  ownerUserId: string;
  source: ImportSource;
  /** 已落地分片在 agora-raw 桶的有序 key 集（worker 逐个 getObject，IMPORT 不再 NO_CONTENT，Codex P0-2）。 */
  rawS3Keys: string[];
  uploadId?: string;
}

/** create job 产物（回写 pairId 后给上层组 ConnectUploadResult，含全量 JobView 字段，Codex P1-7）。 */
export interface CreatedImportJob {
  jobId: JobId;
  fenceToken: number;
  attemptNo: number;
  createdAt: string;
}

/**
 * 最后一片落地、传齐后自动建 import Job（20 §3.3，等价直传路径 POST /import/jobs）+ 回写 pairId + 兑换 used_at。
 *   **CTE 门控顺序（Codex P1-r4 真实 PG 语义修复·单次 UPDATE）**：
 *     ① `active`（SELECT ... FROM import_pairings WHERE <完整 active predicate> FOR UPDATE）——守门 + 行级锁，
 *        只产出当前可兑换的 active 配对行（一并锁住该行，防并发二次兑换）。
 *     ② `new_job`（INSERT INTO jobs SELECT ... FROM active RETURNING id）——**INSERT 的数据源是 active**，
 *        故 active 空（配对非 active）时 INSERT 自然 0 行、**绝不建孤儿 job**。
 *     ③ 末尾**单次** `UPDATE import_pairings SET phase='job_created', used_at=now(), job_id=(SELECT id FROM new_job)
 *        WHERE id=(SELECT id FROM active)`——pairing 行在本语句**只被更新一次**（同时置终态 phase + 兑换 used_at + 回写 job_id）。
 *   ⚠️ 旧实现（Codex r4 命中）在同一 data-modifying CTE 里先 `linked` UPDATE 兑换、再 `link_job` 二次 UPDATE 同一行回写 job_id：
 *     真实 PostgreSQL 单语句二次改同一行结果不可靠（第二个 UPDATE 看到的是语句开始时的快照，可能不命中已被前一个 CTE 改过的行）
 *     → 可能建了 job 但 job_id 未落回 pairing → job_created 终态却 job_id IS NULL → 网页无法恢复 eventsUrl/jobId。
 *     现改为「active 守门 → INSERT → 单次 UPDATE 一并写 phase/used_at/job_id」，根除「同行二次改」的不可靠面，
 *     不变式 `phase='job_created' ⇒ job_id 非空` 由【同一条 UPDATE 同时写两列】在 PG 层硬保证。
 *   ⚠️ 更早的孤儿 job 隐患（Codex P1-r2）：INSERT 必须 `SELECT FROM active`（数据源是守门 CTE），绝不可 `VALUES`——
 *     真实 PG 中所有 data-modifying CTE 都会执行，INSERT...VALUES 不依赖守门 → active 未命中时仍建 job → 孤儿 queued。
 *   - INSERT jobs（type=import, status=queued, subject_ref 带 uploadId/source/**rawS3Keys**，progress 五项 pending，Codex P1-7）。
 *   - 重复触发（助手重试同 key 已被幂等层挡）二次仍幂等：若 pairing 已 job_created 则走上面的回放分支、不再建新 job。
 *   返回 { jobId, fenceToken, attemptNo, createdAt } 供 BullMQ enqueue + 组完整 JobView；active 空 → null（不建 job）。
 */
export async function createImportJobForPairing(
  db: Queryable,
  input: CreateImportJobInput,
): Promise<CreatedImportJob | null> {
  // 若该配对已建过 job（job_created），直接回放既有 jobId + job 行字段（幂等，避免重复建 job）。
  const existing = await db.query<{
    job_id: string | null;
    phase: string;
  }>(`SELECT job_id, phase FROM import_pairings WHERE id = $1`, [input.pairId]);
  const cur = existing.rows[0];
  if (cur?.phase === 'job_created' && cur.job_id) {
    const j = await db.query<{ attempt_no: number; created_at: string }>(
      `SELECT attempt_no, created_at FROM jobs WHERE id = $1`,
      [cur.job_id],
    );
    const jr = j.rows[0];
    // 已建：回放（fenceToken 取 0，调用方仅在「新建」分支 enqueue；回放分支不重复入队）。
    return {
      jobId: cur.job_id,
      fenceToken: 0,
      attemptNo: jr?.attempt_no ?? 0,
      createdAt: jr ? new Date(jr.created_at).toISOString() : new Date().toISOString(),
    };
  }

  const subjectRef = JSON.stringify({
    uploadId: input.uploadId ?? input.pairId,
    source: input.source,
    rawS3Keys: input.rawS3Keys,
  });
  const initialProgress = JSON.stringify(initialImportProgress());

  // 建 job + 同 CTE 兑换 + 回写 job_id（仅 active 配对可建/回写；job_created 终态不再变）。
  //   门控顺序（Codex P1-r4 单次 UPDATE）：
  //     ① active 先 SELECT active 配对（守门 + FOR UPDATE 行锁，RETURNING id）——未命中 active row → active 空；
  //     ② new_job INSERT ... SELECT FROM active——**数据源是 active**，active 空 → INSERT 0 行（不建孤儿 job）；
  //     ③ 末尾单次 UPDATE import_pairings 把 phase='job_created'/used_at/job_id 一并写进 active 命中的那一行
  //        （pairing 行本语句只被改一次：phase+used_at+job_id 同写，不再二次改同一行，根除真实 PG 不可靠面）。
  //   真实 PG 所有 data-modifying CTE 都执行，但 INSERT/UPDATE 均以 active 为数据源，未命中时全为 0 行（Codex P1-r2/r4）。
  //   **完整 active predicate（Codex P1-r3）**：守门点不仅判 phase，还须 used_at IS NULL（未被一次性兑换）、
  //     expires_at > now()（未过期，与 uq_pairings_code_active / readPairingManifest 同口径，避时钟漂移用 SQL now()）、
  //     attempt_count < max_attempts（重试未耗尽）。任一不满足 → active 空 → INSERT 0 行 → 不建 job、不兑换、不回写。
  //   不变式：phase='job_created' ⇒ job_id 非空（同一条 UPDATE 同时写 phase 与 job_id，PG 层硬保证，不可能脱节）。
  const res = await db.query<{
    id: string;
    fence_token: number;
    attempt_no: number;
    created_at: string;
  }>(
    `WITH active AS (
        SELECT p.id
          FROM import_pairings p
         WHERE p.id = $1
           AND p.phase IN ('waiting','uploading')
           AND p.used_at IS NULL
           AND p.expires_at > now()
           AND p.attempt_count < p.max_attempts
         FOR UPDATE
     ),
     new_job AS (
        INSERT INTO jobs (type, status, owner_user_id, subject_ref, progress, fence_token)
        SELECT 'import', 'queued', $2, $3::jsonb, $4::jsonb, 1
          FROM active
        RETURNING id, fence_token, attempt_no, created_at
     ),
     redeemed AS (
        UPDATE import_pairings p
           SET phase      = 'job_created',
               used_at    = now(),
               job_id     = (SELECT id FROM new_job),
               updated_at = now()
         WHERE p.id = (SELECT id FROM active)
         RETURNING p.id
     )
     SELECT id, fence_token, attempt_no, created_at FROM new_job`,
    [input.pairId, input.ownerUserId, subjectRef, initialProgress],
  );
  const row = res.rows[0];
  if (!row) return null; // 配对已非 active（被取消/过期/竞态）→ 不建 job
  return {
    jobId: row.id,
    fenceToken: Number(row.fence_token),
    attemptNo: Number(row.attempt_no),
    createdAt: new Date(row.created_at).toISOString(),
  };
}

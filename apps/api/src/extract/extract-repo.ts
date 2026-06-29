// 30 · 提取域仓储（B-22/B-23，30-step2-extract §5.1/§5.2，受保护写入 §11.A）。全部注入 Queryable/Tx，便于 mock 单测、无真 PG。
//   写入铁律（§11.A / Codex#3）：fence 校验【内联进单条 SQL 的数据源 jobs】，禁「先 SELECT 校验、再独立 INSERT/UPDATE」两步（TOCTOU）。
//     rowCount=0 是正常控制流（被 fence out / 去重命中），调用方干净退出、不报错不重试。
//   血缘焊死（§11.E / Codex#2）：candidate_evidence 经两条复合 FK（(candidate_id,snapshot_id)→candidates、(segment_id,snapshot_id)→segments）
//     钉死「证据 + 候选 + 段」同源同快照，DB 层杜绝跨快照证据（提取-33/34）。
import type { Queryable } from '../jobs/types.js';
import type { Tx } from '../events/db-tx.js';
import type { ExtractSegment } from './cluster.js';

/** 读某 snapshot 的去敏段集（analyze 子任务输入；§5.2 只读去敏段，提取-31）。owner 经 raw_snapshots 内联守门。 */
export async function readSnapshotSegments(
  db: Queryable,
  snapshotId: string,
): Promise<ExtractSegment[]> {
  const res = await db.query<{
    id: string;
    snapshot_id: string;
    title: string | null;
    source: string | null;
    project: string | null;
    happened_at: string | null;
    content: string;
    message_count: number;
  }>(
    `SELECT id, snapshot_id, title, source, project,
            happened_at::text AS happened_at, content, message_count
       FROM session_segments
      WHERE snapshot_id = $1
      ORDER BY id ASC`,
    [snapshotId],
  );
  return res.rows.map((r) => ({
    segmentId: r.id,
    snapshotId: r.snapshot_id,
    title: r.title,
    source: r.source,
    project: r.project,
    happenedAt: r.happened_at,
    content: r.content,
    messageCount: r.message_count,
  }));
}

/** 受保护建候选入参（§5.1 模板 2；fence 经 jobs 内联校验，extract_job_id/snapshot_id/owner 焊进数据源）。 */
export interface InsertCandidateArgs {
  jobId: string;
  fenceToken: number;
  snapshotId: string;
  slug: string;
  status: 'generating' | 'ready' | 'failed';
  name: string | null;
  intent: string | null;
  type: string | null;
  confidence: string | null;
  segmentCount: number | null;
  frequencyRatio: number | null;
  reusability: number | null;
  scopeCoherence: number | null;
  splitSuggested: boolean;
  scope: unknown | null;
  reusabilityBreakdown: unknown | null;
  /** failed 时人话 ErrorBody（非堆栈，§11.B）；非 failed 传 null。 */
  error: unknown | null;
}

/**
 * 受保护建候选（§11.A 模板 2，受保护 INSERT + (extract_job_id, slug) 去重叠加）。
 *   fence 校验内联进数据源 `jobs WHERE id AND fence_token AND status='running'`：
 *     - 被 fence out（取消/重入队换 fence）→ SELECT 无行 → INSERT 0 行 → 返回 null（handler 干净退出，不建候选）。
 *     - (extract_job_id, slug) 撞重 → ON CONFLICT DO NOTHING → 0 行 → 返回 null（去重，计数不翻倍，提取-32）。
 *   owner_user_id 取自 jobs 行（血缘焊死，不靠入参传 owner，杜绝越权写）。
 *   ⚠️ snapshot_id 由入参传（worker 携 snapshot_id 只在该快照段集聚类，证据不跨快照，提取-33）；
 *      DB 层由 candidate_evidence 复合 FK 钉死证据与候选 snapshot 同源（§11.E）。
 */
export async function insertCandidateProtected(
  db: Queryable,
  args: InsertCandidateArgs,
): Promise<string | null> {
  const res = await db.query<{ id: string }>(
    `INSERT INTO capability_candidates (
        id, extract_job_id, snapshot_id, owner_user_id,
        status, error, slug, name, intent, type, confidence,
        segment_count, frequency_ratio, reusability, scope_coherence, split_suggested,
        scope, reusability_breakdown
     )
     SELECT
        gen_uuid_v7(), j.id, $3, j.owner_user_id,
        $4, $5::jsonb, $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15,
        $16::jsonb, $17::jsonb
     FROM jobs j
     WHERE j.id = $1 AND j.fence_token = $2 AND j.status = 'running'
     ON CONFLICT (extract_job_id, slug) DO NOTHING
     RETURNING id`,
    [
      args.jobId,
      args.fenceToken,
      args.snapshotId,
      args.status,
      args.error === null ? null : JSON.stringify(args.error),
      args.slug,
      args.name,
      args.intent,
      args.type,
      args.confidence,
      args.segmentCount,
      args.frequencyRatio,
      args.reusability,
      args.scopeCoherence,
      args.splitSuggested,
      args.scope === null ? null : JSON.stringify(args.scope),
      args.reusabilityBreakdown === null ? null : JSON.stringify(args.reusabilityBreakdown),
    ],
  );
  return res.rows[0]?.id ?? null;
}

/**
 * 受保护写一条段级证据（§11.A + §11.E 复合 FK）。fence 经 `jobs WHERE id AND fence AND running` 内联；
 *   复合 FK 在 INSERT 时强制「(candidate_id, snapshot_id) ∈ candidates」「(segment_id, snapshot_id) ∈ segments」——
 *   DB 层杜绝跨快照证据（提取-33/34）。(candidate_id, segment_id) 撞重 → ON CONFLICT DO NOTHING（同段不重复挂，提取-32）。
 *   0 行 = fence out 或去重命中（正常控制流）。
 */
export async function insertEvidenceProtected(
  db: Queryable,
  args: {
    jobId: string;
    fenceToken: number;
    candidateId: string;
    segmentId: string;
    snapshotId: string;
  },
): Promise<boolean> {
  const res = await db.query<{ id: string }>(
    `INSERT INTO candidate_evidence (id, candidate_id, segment_id, snapshot_id)
     SELECT gen_uuid_v7(), $3, $4, $5
     FROM jobs j
     WHERE j.id = $1 AND j.fence_token = $2 AND j.status = 'running'
     ON CONFLICT (candidate_id, segment_id) DO NOTHING
     RETURNING id`,
    [args.jobId, args.fenceToken, args.candidateId, args.segmentId, args.snapshotId],
  );
  return (res.rows[0]?.id ?? null) !== null;
}

/**
 * 受保护回填候选 segment_count（§5.1：= candidate_evidence 行数，保证频次条段数 == 下钻条数，提取-34）。
 *   fence 经 jobs 联表内联校验（模板 3 思路，extract_job_id 为联表键）；同一行只改一次（§11.A 不二次改同行）。
 *   0 行 = fence out（正常控制流）。
 */
export async function updateCandidateSegmentCountProtected(
  db: Queryable,
  args: { jobId: string; fenceToken: number; candidateId: string; segmentCount: number },
): Promise<boolean> {
  const res = await db.query(
    `UPDATE capability_candidates c
        SET segment_count = $4, updated_at = now()
       FROM jobs j
      WHERE c.id = $3
        AND c.extract_job_id = j.id
        AND j.id = $1
        AND j.fence_token = $2
        AND j.status = 'running'`,
    [args.jobId, args.fenceToken, args.candidateId, args.segmentCount],
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * 单候选落库事务被 fence out 的哨兵（Codex r2#1）：事务进行中任一受保护写返回 0 行（被接管/取消换 fence）→
 *   立即抛此哨兵 → 外层 withTransaction ROLLBACK（候选 + 已写证据一并不落，绝不留半 ready / 证据缺失 / count 不符）。
 *   调用方据 instanceof 当 fence-out 干净处理（不当业务失败重试）。
 */
export class CandidateLandingFencedOut extends Error {
  constructor(stage: string) {
    super(
      `single-candidate landing fenced out at ${stage} (protected write matched 0 rows); rolled back`,
    );
    this.name = 'CandidateLandingFencedOut';
  }
}

/**
 * 单候选落库事务开头拿 jobs FOR UPDATE guard（Codex r2#1）：确认 retry/extract job 仍 running + fence 匹配，并行锁住该 job 行，
 *   杜绝「候选 insert 成功、证据/count 写到一半被换 fence」的 TOCTOU 半残。0 行 → 抛哨兵 → 外层 ROLLBACK。
 *   与受保护写入的内联 fence 校验叠加（双保险：guard 锁住 job 行 + 每条写仍自带 fence WHERE）。
 */
async function assertJobRunningForUpdate(
  db: Queryable,
  jobId: string,
  fenceToken: number,
  stage: string,
): Promise<void> {
  const res = await db.query(
    `SELECT id FROM jobs
      WHERE id = $1 AND fence_token = $2 AND status = 'running'
      FOR UPDATE`,
    [jobId, fenceToken],
  );
  if ((res.rowCount ?? res.rows.length ?? 0) === 0) throw new CandidateLandingFencedOut(stage);
}

/** 单候选原子落库入参（候选 + 证据 + segment_count 回填，全在同一事务，Codex#4）。 */
export interface ReadyCandidateWithEvidenceArgs {
  tx: Tx;
  jobId: string;
  fenceToken: number;
  snapshotId: string;
  /** ready 候选骨架（command insert 字段同 InsertCandidateArgs，status 固定 'ready'、error 固定 null）。 */
  candidate: Omit<InsertCandidateArgs, 'jobId' | 'fenceToken' | 'snapshotId' | 'status' | 'error'>;
  /** 该候选的支撑段 id 列表（逐段写证据；复合 FK 钉死同快照）。 */
  segmentIds: string[];
}

/** 单候选原子落库结果（成功 / fence-out 或去重命中 / 0 证据写入兜底）。 */
export type ReadyCandidateOutcome =
  | { kind: 'inserted'; candidateId: string; written: number }
  | { kind: 'skipped' }; // 候选 INSERT 0 行（fence out 或 (job,slug) 去重）

/**
 * 单候选原子落库（Codex#4）：在【同一事务 tx】里 ① 受保护建 ready 候选 ② 逐段受保护写证据 ③ 回填 segment_count。
 *   血缘原子性铁律：候选 + 证据 + segment_count 要么全成、要么全无——绝不留「ready 候选但 evidence 缺失/段数不符」破坏血缘（提取-34）。
 *
 *   - 候选 INSERT 0 行（fence out 或 (job,slug) 去重）→ 返回 { kind:'skipped' }（不写证据/不回填，调用方据 isCancelled 区分停/跳过）。
 *   - 证据 INSERT 0 行：仅 fence out 时发生（去重在同候选首次落库不触发）；written 计实际写入数。
 *     若证据 INSERT 抛错（如复合 FK 违反、DB 异常）→ 上抛，外层 withTransaction ROLLBACK（候选一并不落），
 *     调用方据此改落 failed item，绝不 append 半残 ready（Codex#4）。
 *   - segment_count 回填用实际写入证据数（written），保证频次条段数 == 下钻条数（提取-34），同事务原子。
 *   所有写入 fence 经 jobs 内联校验（§11.A），fence out → guard 0 行；本函数不吞错（与旧 emitOneCandidate 的 catch 吞证据失败相反）。
 */
export async function insertReadyCandidateWithEvidenceInTx(
  args: ReadyCandidateWithEvidenceArgs,
): Promise<ReadyCandidateOutcome> {
  const { tx, jobId, fenceToken, snapshotId, candidate, segmentIds } = args;
  // Tx 与 Queryable 结构同源（都只 query；Tx.rowCount 可空，helper 读 `?? null` 兼容）→ 复用受保护写入 helper。
  const db = tx as unknown as Queryable;

  // ⓪ 事务开头拿 jobs FOR UPDATE guard（Codex r2#1）：确认 running + fence，行锁住该 job，杜绝中途换 fence 的半残。
  //    0 行 → 抛哨兵 → 外层 ROLLBACK（整单不落）。注意：guard 持锁后，下方候选 insert 的 0 行只可能是 (job,slug) 去重。
  await assertJobRunningForUpdate(db, jobId, fenceToken, 'guard');

  // ① 受保护建 ready 候选（fence/去重守门内联进数据源）。guard 已确认 fence → 0 行只可能是 (job,slug) 去重 → 整单跳过。
  const candidateId = await insertCandidateProtected(db, {
    jobId,
    fenceToken,
    snapshotId,
    status: 'ready',
    error: null,
    ...candidate,
  });
  if (!candidateId) return { kind: 'skipped' }; // (job,slug) 去重（fence 已被 guard 锁住、不会失配）→ 整单不落

  // ② 逐段受保护写证据（复合 FK 钉死同快照）。
  //    - 证据 INSERT 抛错（复合 FK 违反/DB 异常）→ 上抛（外层 ROLLBACK，候选一并不落，不留半残 ready）。
  //    - 证据 INSERT 0 行（去重命中 written 不增；fence out 极罕见——guard 已持锁——仍按 fence-out 哨兵回滚兜底，Codex r2#1）。
  let written = 0;
  for (const segmentId of segmentIds) {
    const ok = await insertEvidenceProtected(db, {
      jobId,
      fenceToken,
      candidateId,
      segmentId,
      snapshotId,
    });
    if (ok) written++;
  }

  // ③ 回填 segment_count = 实际写入证据数（同事务原子，保证频次条段数 == 下钻条数，提取-34）。
  //    回填受保护写返回 0 行（fence out）→ 候选 segment_count 半残（≠ 证据数）→ 抛哨兵 ROLLBACK（无半 ready，Codex r2#1）。
  const countOk = await updateCandidateSegmentCountProtected(db, {
    jobId,
    fenceToken,
    candidateId,
    segmentCount: written,
  });
  if (!countOk) throw new CandidateLandingFencedOut('segment_count');

  return { kind: 'inserted', candidateId, written };
}

/**
 * 受保护建「失败态候选」（单候选 LLM 没出/超时 → status=failed + 人话 error，不阻塞其余，提取-17/29）。
 *   复用 insertCandidateProtected（status='failed'、error 携人话副文）；其余信号留 NULL（失败行字段稀疏，§2.2 示例）。
 *   失败行仍带已知名（来自聚类草稿）+ slug（用于「! 名称 · 错误副文」与后续重试寻址）。
 */
export async function insertFailedCandidateProtected(
  db: Queryable,
  args: {
    jobId: string;
    fenceToken: number;
    snapshotId: string;
    slug: string;
    name: string | null;
    error: unknown;
  },
): Promise<string | null> {
  return insertCandidateProtected(db, {
    jobId: args.jobId,
    fenceToken: args.fenceToken,
    snapshotId: args.snapshotId,
    slug: args.slug,
    status: 'failed',
    name: args.name,
    intent: null,
    type: null,
    confidence: null,
    segmentCount: null,
    frequencyRatio: null,
    reusability: null,
    scopeCoherence: null,
    splitSuggested: false,
    scope: null,
    reusabilityBreakdown: null,
    error: args.error,
  });
}

/** 收尾合并重建用：某 extract_job_id 当前【全部】候选行（真源；含旧 attempt 已落候选，提取-32/硬规则③）。 */
export interface CandidateRowForFinal {
  id: string;
  status: string;
  isNew: boolean;
  name: string | null;
  intent: string | null;
  type: string | null;
  confidence: string | null;
  segmentCount: number | null;
  scopeCoherence: number | null;
  splitSuggested: boolean | null;
  error: unknown | null;
}

/**
 * 收尾合并重建（Codex r3 P1：已生成不丢）：读某 extract_job_id 当前【全部】候选（DB 真源）。
 *   sweeper 接管重跑时，本 attempt 内存累加器只含本轮新 append 项，去重命中（(extract_job_id, slug)）的旧候选不在其中——
 *   终态 finalProgress.items / result 计数若只用内存累加器会丢旧候选（违反硬规则③）。此处从 DB 全量重建，确保已浮现（含旧 attempt）不丢。
 *   按 created_at, id 升序（与逐个浮现的稳定序一致）；isNew=false（收尾合并的旧/已存在候选不是「刚浮现」）。
 */
export async function readAllCandidatesForJob(
  db: Queryable,
  extractJobId: string,
): Promise<CandidateRowForFinal[]> {
  const res = await db.query<{
    id: string;
    status: string;
    name: string | null;
    intent: string | null;
    type: string | null;
    confidence: string | null;
    segment_count: number | null;
    scope_coherence: number | null;
    split_suggested: boolean | null;
    error: unknown | null;
  }>(
    `SELECT id, status, name, intent, type, confidence,
            segment_count, scope_coherence, split_suggested, error
       FROM capability_candidates
      WHERE extract_job_id = $1
      ORDER BY created_at ASC, id ASC`,
    [extractJobId],
  );
  return res.rows.map((r) => ({
    id: r.id,
    status: r.status,
    isNew: false,
    name: r.name,
    intent: r.intent,
    type: r.type,
    confidence: r.confidence,
    segmentCount: r.segment_count,
    scopeCoherence: r.scope_coherence,
    splitSuggested: r.split_suggested,
    error: r.error,
  }));
}

// ---------------------------------------------------------------------------
// 单候选重试（B-23）：retry job 的 fence 守门 + 同事务删旧证据/重写/回填 segment_count（§5.2 受保护写入）
// ---------------------------------------------------------------------------

/** 重试读候选当前态（owner 内联守门；不存在/非属主 → null，调用方 404，不暴露存在性）。 */
export async function readCandidateForOwner(
  db: Queryable,
  candidateId: string,
  ownerUserId: string,
): Promise<{
  id: string;
  snapshotId: string;
  status: string;
  slug: string;
  name: string | null;
  retryCnt: number;
} | null> {
  const res = await db.query<{
    id: string;
    snapshot_id: string;
    status: string;
    slug: string;
    name: string | null;
    retry_cnt: number;
  }>(
    `SELECT id, snapshot_id, status, slug, name, retry_cnt
       FROM capability_candidates
      WHERE id = $1 AND owner_user_id = $2`,
    [candidateId, ownerUserId],
  );
  const r = res.rows[0];
  return r
    ? {
        id: r.id,
        snapshotId: r.snapshot_id,
        status: r.status,
        slug: r.slug,
        name: r.name,
        retryCnt: r.retry_cnt,
      }
    : null;
}

/**
 * 重试成功 → 同一事务内：删该候选旧证据 + 回写候选字段（ready）+ 重写证据 + 回填 segment_count（§5.2）。
 *   fence 取自【新 retry job】（非原萃取 job）；所有写入经 retry job 的 jobs 联表内联校验 fence + running。
 *   - 任一步 fence out（retry job 被取消/接管换 fence）→ guard 0 行 → 返回 false（旧 worker 干净退出，不改证据/不改 count）。
 *   - 同一行只改一次（§11.A）：候选行的 status/error/字段在一条 UPDATE 内一并写；segment_count 在重写证据后单独一条 UPDATE（针对 evidence 行数派生，不与上一条改同一逻辑列两次）。
 *   重写证据仍受复合 FK 约束（不能写出跨快照证据，§11.E）。
 */
export interface RetrySuccessArgs {
  tx: Tx;
  retryJobId: string;
  fenceToken: number;
  candidateId: string;
  snapshotId: string;
  segmentIds: string[];
  fields: {
    name: string;
    intent: string;
    type: string;
    confidence: string;
    frequencyRatio: number;
    reusability: number;
    scopeCoherence: number;
    splitSuggested: boolean;
    scope: unknown;
    reusabilityBreakdown: unknown;
  };
}

export async function applyRetrySuccessInTx(args: RetrySuccessArgs): Promise<boolean> {
  const { tx, retryJobId, fenceToken, candidateId, snapshotId, segmentIds, fields } = args;
  const db = tx as unknown as Queryable;

  // ⓪ 事务开头拿 retry job FOR UPDATE guard（Codex r2#1）：确认 running + fence + 行锁，杜绝重写证据/回填 count 中途换 fence 的半残。
  //    0 行（被接管/取消换 fence）→ 抛哨兵 → 外层 ROLLBACK（候选/证据全不动）；调用方据 instanceof 当 fence-out 干净退出。
  await assertJobRunningForUpdate(db, retryJobId, fenceToken, 'retry-guard');

  // ① 候选行受保护回写为 ready（fence 经 retry job 联表内联；同一行只改一次）。
  //   ⚠️ retry_cnt 不在此 +1（Codex#3 双重加一）：受理重试时 createRetryJob 的 flipped CTE 已 retry_cnt+1，
  //      worker 成功收尾再 +1 会让单次重试 retryCount 漂到 2、escalate/上限语义错。计数权威 = 受理 CTE，本处只翻状态。
  const up = await tx.query(
    `UPDATE capability_candidates c
        SET status = 'ready', error = NULL,
            name = $4, intent = $5, type = $6, confidence = $7,
            frequency_ratio = $8, reusability = $9, scope_coherence = $10, split_suggested = $11,
            scope = $12::jsonb, reusability_breakdown = $13::jsonb,
            updated_at = now()
       FROM jobs j
      WHERE c.id = $3
        AND j.id = $1
        AND j.fence_token = $2
        AND j.status = 'running'`,
    [
      retryJobId,
      fenceToken,
      candidateId,
      fields.name,
      fields.intent,
      fields.type,
      fields.confidence,
      fields.frequencyRatio,
      fields.reusability,
      fields.scopeCoherence,
      fields.splitSuggested,
      JSON.stringify(fields.scope),
      JSON.stringify(fields.reusabilityBreakdown),
    ],
  );
  if ((up.rowCount ?? 0) === 0) return false; // fence out → 不改证据、不改 count（guard 已挡此态，留作双保险，干净退出）

  // ② 删旧证据（受保护：经 retry job fence 守门；候选行已确认在本 fence 下可写）。
  await tx.query(
    `DELETE FROM candidate_evidence ce
       USING jobs j
      WHERE ce.candidate_id = $3
        AND j.id = $1 AND j.fence_token = $2 AND j.status = 'running'`,
    [retryJobId, fenceToken, candidateId],
  );

  // ③ 重写证据（复合 FK 钉死同快照；fence 守门内联）。记实际写入行数用于 segment_count 回填（Codex r2#1：从实际 evidence count 派生，不用入参长度）。
  let written = 0;
  for (const segId of segmentIds) {
    const ins = await tx.query(
      `INSERT INTO candidate_evidence (id, candidate_id, segment_id, snapshot_id)
       SELECT gen_uuid_v7(), $3, $4, $5
       FROM jobs j
       WHERE j.id = $1 AND j.fence_token = $2 AND j.status = 'running'
       ON CONFLICT (candidate_id, segment_id) DO NOTHING
       RETURNING id`,
      [retryJobId, fenceToken, candidateId, segId, snapshotId],
    );
    if ((ins.rowCount ?? ins.rows.length ?? 0) > 0) written++;
  }

  // ④ 回填 segment_count = 实际写入证据行数（频次条段数 == 下钻条数，提取-34；针对 evidence 派生，单独一条 UPDATE）。
  //    回填受保护写 0 行（fence out）→ count 半残（≠ 证据数）→ 抛哨兵 ROLLBACK（候选/证据全不落，无半 ready，Codex r2#1）。
  const cnt = await tx.query(
    `UPDATE capability_candidates c
        SET segment_count = $4, updated_at = now()
       FROM jobs j
      WHERE c.id = $3
        AND j.id = $1 AND j.fence_token = $2 AND j.status = 'running'`,
    [retryJobId, fenceToken, candidateId, written],
  );
  if ((cnt.rowCount ?? 0) === 0) throw new CandidateLandingFencedOut('retry-segment_count');

  return true;
}

/**
 * 重试再失败 → 受保护回写候选 failed + 人话 error（提取-20：仍带退路、不裸码）。
 *   fence 取自新 retry job；同一行只改一次。0 行 = fence out（正常控制流）。
 *   ⚠️ retry_cnt 不在此 +1（Codex#3 双重加一）：受理重试时 createRetryJob 的 flipped CTE 已 retry_cnt+1。
 *      worker 收尾（成功/失败）只翻状态、不再次 +1，保证单次重试 retryCount 只 +1、escalate/上限语义不漂。
 */
export async function applyRetryFailureProtected(
  db: Queryable,
  args: { retryJobId: string; fenceToken: number; candidateId: string; error: unknown },
): Promise<boolean> {
  const res = await db.query(
    `UPDATE capability_candidates c
        SET status = 'failed', error = $4::jsonb, updated_at = now()
       FROM jobs j
      WHERE c.id = $3
        AND j.id = $1 AND j.fence_token = $2 AND j.status = 'running'`,
    [args.retryJobId, args.fenceToken, args.candidateId, JSON.stringify(args.error)],
  );
  return (res.rowCount ?? 0) > 0;
}

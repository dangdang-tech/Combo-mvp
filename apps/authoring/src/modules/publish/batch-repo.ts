// 50 · 批量发布仓储（B-29 无连坐 P0，50-step5-publish §2.3/§2.4/§2.5/§5）。注入 Queryable/TxPool，无真 PG。
//   核心三块：
//     ① createPublishBatchTx —— 单 PG 事务建 publish_batch job + publish_batches + 每 item 一行 publish_batch_items
//        （item.idempotency_key UNIQ → 重复点「全部发布」/重发只一批一组 item，无连坐第一道；建批用 publish_batch.create 幂等兜重复建批）。
//     ② advanceBatchItemTx（模板 A，§5）—— item 进中间态（structuring/publishing），fence 经 item→batch→job 内联校验、
//        单语句、终态不可回退；不触批次计数（计数只在进终态那一刻、由模板 B 处理）。
//     ③ finalizeBatchItemTx（模板 B，§5 Codex#5-r3 计数幂等化）—— item 进终态（published/failed）+ batch 计数【合成单条 CTE】：
//        item 终态 UPDATE 带防重 `state NOT IN ('published','failed')`，batch 计数只按 RETURNING 实际迁移行递增（0 行→0 递增），
//        重复回写（重投/重试/双消费）不重复递增、不漏不重；processed_count 为 generated 列（=published+failed），完成判定 processed=total。
//   读：readPublishBatchView（批 + items 全量，供 §2.4 恢复/轮询 + SSE state_snapshot）。
//   单 item 重试（§2.5）：retryBatchItemTx —— 仅 failed → pending，换 attempt_no，清 error/missing_fields，不动其余 item、不重建批次。
//   无连坐保证：每 item 独立 state/error/idempotency_key；worker 逐项 try/catch（失败落该 item error、不断批），其余继续。
import type { JobStatus, CoverInput, TierInput, Visibility, ErrorBody } from '@cb/shared';
import { ErrorCode } from '@cb/shared';
import type { Queryable } from '../../platform/jobs/types.js';
import type { Tx, TxPool } from '../../platform/events/db-tx.js';
import { withTransaction } from '../../platform/events/db-tx.js';
import { backfillDraftBatch } from '../drafts/index.js';

/**
 * 建批业务错误（带 code，路由层据 code → HTTP + 人话信封；与 PublishError 同口径）。
 *   建批唯一冲突用例：请求内有重复 idempotency_key（或与既有项全局撞键）→ 整事务回滚（withTransaction 接抛 ROLLBACK）。
 */
export class PublishBatchError extends Error {
  constructor(
    public code: (typeof ErrorCode)[keyof typeof ErrorCode],
    message: string,
  ) {
    super(message);
    this.name = 'PublishBatchError';
  }
}

/** 批内单项的发布入参（封面/价格/可见性；建批时随 item 落 subject 形态，worker 逐项透传给 publish-one）。 */
export interface BatchItemPublishInput {
  candidateId?: string;
  versionId?: string;
  idempotencyKey: string;
  cover?: CoverInput;
  tiers?: TierInput[];
  visibility?: Visibility;
}

/** publish_batch_items 行（仓储/worker/视图关心的列）。 */
export interface BatchItemRow {
  id: string;
  batchId: string;
  candidateId: string | null;
  versionId: string | null;
  capabilityId: string | null;
  idempotencyKey: string;
  state: string;
  missingFields: string[] | null;
  /** 该 item 人话错误（ErrorBody，非堆栈/非 code，§2 错误信封口径）。 */
  error: ErrorBody | null;
  attemptNo: number;
  /** 建批时落的逐项发布入参（worker 取它走 publish-one）。本期存 publish_batch_items.subject jsonb。 */
  input: BatchItemPublishInput;
}

/** publish_batches 行（计数三元 + 状态镜像 jobs.status）。 */
export interface BatchRow {
  id: string;
  ownerUserId: string;
  jobId: string;
  total: number;
  publishedCount: number;
  failedCount: number;
  /** generated = published + failed（进度分子、完成判定，Codex#7）。 */
  processedCount: number;
  status: JobStatus;
}

// ===========================================================================
// ① 建批（单 PG 事务）：publish_batch job + publish_batches + N × publish_batch_items
// ===========================================================================

export interface CreatePublishBatchArgs {
  ownerUserId: string;
  items: BatchItemPublishInput[];
  /** 批量发布由某草稿发起（P0-2）：建批同事务把 batch_id + current_step='publish' 回填该草稿（续传回批进度）。 */
  draftId?: string;
}

export interface CreatedPublishBatch {
  batchId: string;
  jobId: string;
  total: number;
  /** 入队是否成功（失败留 queued 交 staleQueued sweeper 补投；仅观测/对账，不裸转圈）。 */
  fenceToken: number;
}

/** 批 job 初始 progress（永不裸转圈：连接即有「逐个发布」子任务可点亮 + done/total 进度，§3）。 */
function initialBatchProgress(total: number): {
  percent: number;
  phrase: string;
  done: number;
  total: number;
  unit: string;
  subtasks: Array<{ key: string; label: string; status: 'pending' }>;
  items: never[];
} {
  return {
    percent: 0,
    phrase: '正在准备批量发布…',
    done: 0,
    total,
    unit: '个能力',
    subtasks: [
      { key: 'structuring', label: '逐个整理', status: 'pending' },
      { key: 'publishing', label: '逐个发布', status: 'pending' },
    ],
    items: [],
  };
}

/**
 * 建批【单 PG 事务】（§2.3 / §5）。任一步失败整体回滚（不留半建批次）。
 *   1) INSERT jobs(type='publish_batch', status='queued', fence_token=1)；owner_user_id 取入参（建批前路由已鉴权本人）。
 *   2) INSERT publish_batches(job_id, total)；processed_count 为 generated 列、不直写。
 *   3) 逐 item INSERT publish_batch_items(idempotency_key UNIQ, state='pending', subject=逐项发布入参)，
 *      `ON CONFLICT (idempotency_key) DO NOTHING RETURNING id` —— 用 RETURNING 数实际落库行数 insertedCount。
 *   【Codex#P1 修：total 必等实际 item 行数，否则 batch 必卡死】请求内若有重复 idempotency_key（或与既有项全局撞键），
 *      ON CONFLICT 会静默跳过该行 → insertedCount < total。此时**整事务回滚**（抛 PublishBatchError，withTransaction 接 ROLLBACK）
 *      并返回冲突错误，**绝不**留一个 total > 实际行数的卡死 batch（worker 无剩余 item 可处理、processed_count 永追不到 total）。
 *      批次级幂等「重复点全部发布回放同批」由路由 preHandler requireIdempotency(publish_batch.create) 兜（202 回放，不进本函数），
 *      故本函数无需做幂等恢复，只须保证 batch.total === 实际可处理 item 行数（铁律：processed 能到 total、批必能 completed）。
 *   返回 batchId/jobId/total/fenceToken（调用方据 fenceToken 入队 publish_batch job）。
 */
export async function createPublishBatchTx(
  txPool: TxPool,
  args: CreatePublishBatchArgs,
): Promise<CreatedPublishBatch> {
  const total = args.items.length;
  return withTransaction(txPool, async (tx: Tx) => {
    // 1) 建 publish_batch job（queued、fence_token=1：>0 表「需入队」，领租约时换发执行 fence，脊柱 §6.2）。
    const jobRes = await tx.query<{ id: string }>(
      `INSERT INTO jobs (type, status, owner_user_id, subject_ref, progress, fence_token)
       VALUES ('publish_batch', 'queued', $1, $2::jsonb, $3::jsonb, 1)
       RETURNING id`,
      [
        args.ownerUserId,
        JSON.stringify({ kind: 'publish_batch' }),
        JSON.stringify(initialBatchProgress(total)),
      ],
    );
    const jobId = jobRes.rows[0]!.id;

    // 2) 建 publish_batches（计数三元初值 0；processed_count generated）。
    const batchRes = await tx.query<{ id: string }>(
      `INSERT INTO publish_batches (owner_user_id, job_id, total, published_count, failed_count, status)
       VALUES ($1, $2, $3, 0, 0, 'queued')
       RETURNING id`,
      [args.ownerUserId, jobId, total],
    );
    const batchId = batchRes.rows[0]!.id;

    // 3) 逐 item 建行（idempotency_key UNIQ；ON CONFLICT DO NOTHING + RETURNING 数实际落库行）。
    //    撞键（请求内重复 / 全局已存在）→ 该行 0 返回 → insertedCount 缺口，下方校验回滚。
    let insertedCount = 0;
    for (const it of args.items) {
      const itemRes = await tx.query<{ id: string }>(
        `INSERT INTO publish_batch_items
           (batch_id, candidate_id, version_id, idempotency_key, state, subject)
         VALUES ($1, $2, $3, $4, 'pending', $5::jsonb)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING id`,
        [
          batchId,
          it.candidateId ?? null,
          it.versionId ?? null,
          it.idempotencyKey,
          JSON.stringify(it),
        ],
      );
      insertedCount += itemRes.rows.length;
    }

    // 强校验【铁律：batch.total 必等实际可处理 item 行数，否则 worker 卡死 running】：
    //   insertedCount < total = 有 item 被 ON CONFLICT 静默跳过（请求内重复 idempotency_key 或全局撞键）。
    //   → 抛错（withTransaction 接 ROLLBACK，整批回滚不留半建/卡死批），路由层据 code 出人话冲突信封；不静默吞、不建 total 不符的批。
    if (insertedCount !== total) {
      throw new PublishBatchError(
        ErrorCode.VALIDATION_FAILED,
        `publish batch item idempotency_key conflict: inserted ${insertedCount} of ${total} (duplicate keys in request or already used)`,
      );
    }

    // 草稿落点回填（P0-2）：批量发布由某草稿发起 → 同事务把 batch_id + current_step='publish' 焊到该草稿
    //   （owner 守卫 + 单次写 + current_step 永不倒退）。0 行（无 draftId / 草稿已弃 / 非本人）= 无害 no-op：
    //   batch 是发布真源，草稿只是续传指针，回填失败【不回滚建批】（不抛、不挡建批，已生成不丢）。
    if (typeof args.draftId === 'string' && args.draftId.length > 0) {
      await backfillDraftBatch(tx, {
        draftId: args.draftId,
        ownerUserId: args.ownerUserId,
        batchId,
      });
    }

    return { batchId, jobId, total, fenceToken: 1 };
  });
}

// ===========================================================================
// ② 模板 A · 中间态推进（item 进 structuring/publishing；非终态、不触计数，§5）
// ===========================================================================

/**
 * item 进中间态（仅 'structuring' | 'publishing'）。fence 经 item→batch→job 内联校验、单语句（§5 模板 A）。
 *   终态不可回退到中间态（`state NOT IN ('published','failed')`）。rowCount=0 = 已被 fence out / 已终态 → 安全退出（不报错）。
 *   返回 true = 推进成功；false = 0 行（已被接管 / 终态）。不动批次计数（计数只在进终态那一刻，模板 B 处理）。
 */
export async function advanceBatchItemTx(
  db: Queryable,
  args: {
    itemId: string;
    jobId: string;
    fenceToken: number;
    state: 'structuring' | 'publishing';
    versionId?: string | null;
    capabilityId?: string | null;
  },
): Promise<boolean> {
  const res = await db.query(
    `WITH guard AS (
        SELECT bi.id
          FROM publish_batch_items bi
          JOIN publish_batches b ON b.id = bi.batch_id
          JOIN jobs j           ON j.id = b.job_id
         WHERE bi.id = $1
           AND j.id = $2
           AND j.fence_token = $3
           AND j.status = 'running'
         FOR UPDATE OF bi
     )
     UPDATE publish_batch_items bi
        SET state = $4,
            version_id = COALESCE($5, bi.version_id),
            capability_id = COALESCE($6, bi.capability_id),
            updated_at = now()
       FROM guard
      WHERE bi.id = guard.id
        AND bi.state NOT IN ('published','failed')`,
    [
      args.itemId,
      args.jobId,
      args.fenceToken,
      args.state,
      args.versionId ?? null,
      args.capabilityId ?? null,
    ],
  );
  return (res.rowCount ?? 0) > 0;
}

// ===========================================================================
// ②.5 早回填 versionId（create-capability 成功立即回填到 item 行，早于 structure，已生成不丢）
// ===========================================================================

/**
 * 把 create-capability 新建的 versionId【立即】回填到本 item 行（受保护单语句，fence 经 item→batch→job 内联校验）。
 *   时机：candidate 项 create-capability 成功后【立即】、早于 structure 阶段——确保「已建版本」即刻焊在 item 行上。
 *   为何必须早回填（已生成不丢，硬规则③）：structure 阶段 fencedOut（被接管/取消）/失败时若 versionId 未落 item 行，
 *     重试（sweeper 重入队 / 手动）会再走 create-capability 建一遍版本（item.versionId 仍 null）→ 重复建版、已建版本丢失。
 *     早回填后重试读 item.versionId 命中既有版本 → 复用（跳过 create-capability，直接续 structure/publish），不重复建版。
 *   受保护：fence 经 item→batch→job（与模板 A 同口径，j.fence_token=:fence AND j.status='running'）；0 行 = 已被接管 → 安全 no-op
 *     （新版本仍由后续 attempt 据 candidate 续——但既有版本未回填的窗口极小且重试幂等：见 create-capability 同 candidate 协同注）。
 *   单语句只改一次：仅在 item 尚无 version_id 时回填（`AND bi.version_id IS NULL`，防覆盖已回填值——重投/并发幂等）；
 *     不动 state（state 由模板 A/B 管），不触批次计数。返回 true = 回填成功；false = 已被接管 / 已有 versionId（幂等 no-op）。
 */
export async function backfillItemVersionTx(
  db: Queryable,
  args: {
    itemId: string;
    jobId: string;
    fenceToken: number;
    versionId: string;
    capabilityId?: string | null;
  },
): Promise<boolean> {
  return backfillItemVersionInTx(db, args);
}

/**
 * backfillItemVersionTx 的【同事务句柄】变体（Codex r7 P1 原子窗口修）：受同一外部 tx（与 create-capability 同事务）执行。
 *   背景：旧实现 create-capability 先【独立事务 COMMIT】建新 capability/version，再用【另一独立事务】受保护回填 item.version_id。
 *     这两笔之间存在原子性窗口——若 create COMMIT 后、回填 COMMIT 前 job 被接管/lease 过期（fence 翻动），回填命中 0 行
 *     → item 仍无 version_id，但版本已 COMMIT 落库 → 下个 attempt 据 candidate 复跑再 create → 【重复建版】（违「重试不重复建版」）。
 *   修法（方案 A 原子）：把 create-capability 的建体 INSERT 与本回填【合成同一受保护事务】——create-capability 接受
 *     onCreatedInTx 钩子，在建体同 tx 内调本函数做 fence 校验 + 回填；命中 0 行（被接管/换 fence/已终态）→ 钩子返回 false →
 *     create-capability 抛 sentinel 回滚整事务 → 建体 INSERT 一并回滚（version 未提交）。如此「建版 + 回填」要么同 COMMIT、
 *     要么同 ROLLBACK，绝不出现「已提交 version 但 item 无指针」的窗口；接管后重试据 candidate 重新建（无残留半版），不重复建版。
 *   语义与 backfillItemVersionTx 完全一致（fence 经 item→batch→job、仅 version_id IS NULL 时回填、不动 state/计数），
 *     差别仅在用调用方传入的 tx 句柄（同一连接 = 同一事务）而非独立 db 连接。
 */
export async function backfillItemVersionInTx(
  tx: Tx,
  args: {
    itemId: string;
    jobId: string;
    fenceToken: number;
    versionId: string;
    capabilityId?: string | null;
  },
): Promise<boolean> {
  const res = await tx.query(
    `WITH guard AS (
        SELECT bi.id
          FROM publish_batch_items bi
          JOIN publish_batches b ON b.id = bi.batch_id
          JOIN jobs j           ON j.id = b.job_id
         WHERE bi.id = $1
           AND j.id = $2
           AND j.fence_token = $3
           AND j.status = 'running'
         FOR UPDATE OF bi
     )
     UPDATE publish_batch_items bi
        SET version_id = $4,
            capability_id = COALESCE($5, bi.capability_id),
            updated_at = now()
       FROM guard
      WHERE bi.id = guard.id
        AND bi.version_id IS NULL`,
    [args.itemId, args.jobId, args.fenceToken, args.versionId, args.capabilityId ?? null],
  );
  return (res.rowCount ?? 0) > 0;
}

// ===========================================================================
// ③ 模板 B · item 终态迁移 + batch 计数（合成单条 CTE，计数幂等化，§5 Codex#5-r3）
// ===========================================================================

export interface FinalizeBatchItemResult {
  /** 本次是否真正迁移了 item（rowCount>0）。重复回写 / fence out → false（计数 +0，幂等无害）。 */
  moved: boolean;
  /** 批次是否在本次迁移后到达完成态（processed_count === total）。供 worker 决定是否落 job completed。 */
  batchCompleted: boolean;
}

/**
 * item 进终态（'published' | 'failed'）+ batch 计数【合成单条 CTE】（§5 模板 B）。
 *   - guard：fence 经 item→batch→job 内联校验，`FOR UPDATE OF bi, b` 同时锁 item 与 batch 行（防与并发 item/sweeper 竞争）。
 *   - moved：item 终态 UPDATE 带防重 `state NOT IN ('published','failed')`（只允许「非终态→终态」），RETURNING 实际迁移行。
 *   - batch 计数只按 moved 实际迁移行递增（0 行→0 递增）；status 在 processed(=published+failed)≥total 时置 'completed'（含 failed item）。
 *   幂等：同 item 终态回写被重复执行（重投/重试/双消费）→ moved 命中 0 行 → 计数 +0 → 不重复递增，「不漏不重」成立。
 *   无连坐：失败只落该 item 的 error（人话 ErrorBody）、批次照常计 failed_count、不影响其余 item、不把批次整体标 failed。
 */
export async function finalizeBatchItemTx(
  db: Queryable,
  args: {
    itemId: string;
    jobId: string;
    fenceToken: number;
    state: 'published' | 'failed';
    error?: ErrorBody | null;
    missingFields?: string[] | null;
    versionId?: string | null;
    capabilityId?: string | null;
  },
): Promise<FinalizeBatchItemResult> {
  const res = await db.query<{ batch_completed: boolean; moved: boolean }>(
    `WITH
     guard AS (
        SELECT bi.id AS item_id, b.id AS batch_id, b.total
          FROM publish_batch_items bi
          JOIN publish_batches b ON b.id = bi.batch_id
          JOIN jobs j           ON j.id = b.job_id
         WHERE bi.id = $1
           AND j.id = $2
           AND j.fence_token = $3
           AND j.status = 'running'
         FOR UPDATE OF bi, b
     ),
     moved AS (
        UPDATE publish_batch_items bi
           SET state = $4,
               error = $5::jsonb,
               missing_fields = $6,
               version_id = COALESCE($7, bi.version_id),
               capability_id = COALESCE($8, bi.capability_id),
               updated_at = now()
          FROM guard
         WHERE bi.id = guard.item_id
           AND bi.state NOT IN ('published','failed')
        RETURNING bi.id, bi.state
     ),
     bumped AS (
        UPDATE publish_batches b
           SET published_count = b.published_count
                 + (SELECT count(*) FROM moved WHERE moved.state = 'published')::int,
               failed_count    = b.failed_count
                 + (SELECT count(*) FROM moved WHERE moved.state = 'failed')::int,
               status = CASE
                 WHEN (b.published_count + b.failed_count + (SELECT count(*) FROM moved)::int) >= guard.total
                 THEN 'completed' ELSE 'running' END,
               updated_at = now()
          FROM guard
         WHERE b.id = guard.batch_id
           AND EXISTS (SELECT 1 FROM moved)
        RETURNING b.status
     )
     SELECT (SELECT status FROM bumped) = 'completed' AS batch_completed,
            EXISTS (SELECT 1 FROM moved) AS moved`,
    [
      args.itemId,
      args.jobId,
      args.fenceToken,
      args.state,
      args.error != null ? JSON.stringify(args.error) : null,
      args.missingFields ?? null,
      args.versionId ?? null,
      args.capabilityId ?? null,
    ],
  );
  // 末 SELECT 无 FROM、恒返一行：moved 列 = EXISTS(moved CTE) 真值（实际迁移行）；重复回写/fence out → moved=false。
  const row = res.rows[0];
  return {
    moved: row?.moved === true,
    batchCompleted: row?.batch_completed === true,
  };
}

// ===========================================================================
// 读批 + items（§2.4 恢复/轮询 + SSE state_snapshot）
// ===========================================================================

interface RawBatchRow {
  id: string;
  owner_user_id: string;
  job_id: string;
  total: number | string;
  published_count: number | string;
  failed_count: number | string;
  processed_count: number | string;
  status: JobStatus;
}
interface RawItemRow {
  id: string;
  batch_id: string;
  candidate_id: string | null;
  version_id: string | null;
  capability_id: string | null;
  idempotency_key: string;
  state: string;
  missing_fields: string[] | null;
  error: ErrorBody | null;
  attempt_no: number | string;
  subject: BatchItemPublishInput | null;
}

function toBatchRow(r: RawBatchRow): BatchRow {
  return {
    id: r.id,
    ownerUserId: r.owner_user_id,
    jobId: r.job_id,
    total: Number(r.total),
    publishedCount: Number(r.published_count),
    failedCount: Number(r.failed_count),
    processedCount: Number(r.processed_count),
    status: r.status,
  };
}
function toItemRow(r: RawItemRow): BatchItemRow {
  return {
    id: r.id,
    batchId: r.batch_id,
    candidateId: r.candidate_id,
    versionId: r.version_id,
    capabilityId: r.capability_id,
    idempotencyKey: r.idempotency_key,
    state: r.state,
    missingFields: r.missing_fields,
    error: r.error,
    attemptNo: Number(r.attempt_no),
    input: r.subject ?? {
      idempotencyKey: r.idempotency_key,
      ...(r.version_id ? { versionId: r.version_id } : {}),
    },
  };
}

/** 读批次行（不含 items）。不存在 → null。 */
export async function readBatch(db: Queryable, batchId: string): Promise<BatchRow | null> {
  const res = await db.query<RawBatchRow>(
    `SELECT id, owner_user_id, job_id, total, published_count, failed_count, processed_count, status
       FROM publish_batches WHERE id = $1`,
    [batchId],
  );
  return res.rows[0] ? toBatchRow(res.rows[0]) : null;
}

/** 读批内全部 item（按 created_at 序，逐个浮现顺序稳定）。 */
export async function readBatchItems(db: Queryable, batchId: string): Promise<BatchItemRow[]> {
  const res = await db.query<RawItemRow>(
    `SELECT id, batch_id, candidate_id, version_id, capability_id, idempotency_key,
            state, missing_fields, error, attempt_no, subject
       FROM publish_batch_items
      WHERE batch_id = $1
      ORDER BY created_at ASC`,
    [batchId],
  );
  return res.rows.map(toItemRow);
}

export interface PublishBatchFull {
  batch: BatchRow;
  items: BatchItemRow[];
}

/** 读批 + items 全量（§2.4 / SSE state_snapshot）。批不存在 → null。 */
export async function readPublishBatchFull(
  db: Queryable,
  batchId: string,
): Promise<PublishBatchFull | null> {
  const batch = await readBatch(db, batchId);
  if (!batch) return null;
  const items = await readBatchItems(db, batchId);
  return { batch, items };
}

/** 读单 item（§2.5 重试受理回放）。不存在 → null。 */
export async function readBatchItem(
  db: Queryable,
  batchId: string,
  itemId: string,
): Promise<BatchItemRow | null> {
  const res = await db.query<RawItemRow>(
    `SELECT id, batch_id, candidate_id, version_id, capability_id, idempotency_key,
            state, missing_fields, error, attempt_no, subject
       FROM publish_batch_items
      WHERE id = $1 AND batch_id = $2`,
    [itemId, batchId],
  );
  return res.rows[0] ? toItemRow(res.rows[0]) : null;
}

// ===========================================================================
// 单 item 重试（§2.5）：仅 failed → pending（换 attempt_no、清 error/missing_fields），不动其余 item
// ===========================================================================

export type RetryItemOutcome =
  | { kind: 'requeued'; item: BatchItemRow; jobId: string; fenceToken: number }
  | { kind: 'not_found' }
  | { kind: 'forbidden' }
  | { kind: 'state_conflict' }; // item 非 failed（已 published / 在跑）→「这一项不需要重试」

/**
 * 受保护单 item 重试【单 PG 事务】（§2.5）。owner 经 publish_batches.owner_user_id 校验；
 *   仅 `state='failed'` 的 item 可重置（守门 UPDATE `WHERE state='failed'`，命中 0 行 → state_conflict「不需要重试」）。
 *   重置：state→'pending'、attempt_no+1、清 error/missing_fields；可携新发布入参（修过封面/价格后重试，覆盖 subject）。
 *   **不动其余 item、不重建批次、不改批次计数**（failed_count 在该 item 真正再次终态时由模板 B 自洽——
 *     重试成功 published 则该 item 从 failed→...→published：worker 走模板 B，但模板 B 防重 `state NOT IN(published,failed)`
 *     会挡住「failed→published」直接迁移。故重试【先把 item 复位 pending】（脱离终态），模板 B 才能再次计这一项）。
 *   计数自洽：复位时回滚该 item 之前计入的 failed_count（failed_count-1），使「pending 项不计入 processed」，
 *     重试再终态时模板 B 重新 +1，processed/total 与真值恒等（不漏不重，不双计）。
 *   入队：把 publish_batch job 重新置 queued + 换 fence + attempt+1（worker 据新 fence 续跑剩余/重试项），调用方据返回 fenceToken 入队。
 */
export async function retryBatchItemTx(
  txPool: TxPool,
  args: {
    batchId: string;
    itemId: string;
    ownerUserId: string;
    cover?: CoverInput;
    tiers?: TierInput[];
    visibility?: Visibility;
  },
): Promise<RetryItemOutcome> {
  return withTransaction(txPool, async (tx: Tx) => {
    // 读批（owner 守门）+ 读 item（存在性 / failed 闸前置分类，便于回不同 outcome）。
    const bRes = await tx.query<RawBatchRow & { owner_user_id: string }>(
      `SELECT id, owner_user_id, job_id, total, published_count, failed_count, processed_count, status
         FROM publish_batches WHERE id = $1`,
      [args.batchId],
    );
    const bRaw = bRes.rows[0];
    if (!bRaw) return { kind: 'not_found' };
    if (bRaw.owner_user_id !== args.ownerUserId) return { kind: 'forbidden' };

    const iRes = await tx.query<RawItemRow>(
      `SELECT id, batch_id, candidate_id, version_id, capability_id, idempotency_key,
              state, missing_fields, error, attempt_no, subject
         FROM publish_batch_items WHERE id = $1 AND batch_id = $2`,
      [args.itemId, args.batchId],
    );
    const iRaw = iRes.rows[0];
    if (!iRaw) return { kind: 'not_found' };
    if (iRaw.state !== 'failed') return { kind: 'state_conflict' };

    // 携新发布入参覆盖 subject（修过封面/价格后重试）；缺省沿用既有 subject。
    const prevInput: BatchItemPublishInput = iRaw.subject ?? {
      idempotencyKey: iRaw.idempotency_key,
    };
    const nextInput: BatchItemPublishInput = {
      ...prevInput,
      ...(args.cover ? { cover: args.cover } : {}),
      ...(args.tiers ? { tiers: args.tiers } : {}),
      ...(args.visibility ? { visibility: args.visibility } : {}),
    };

    // 守门复位：仅 failed → pending（命中 0 行 = 并发已变 → state_conflict）。
    const reset = await tx.query(
      `UPDATE publish_batch_items
          SET state = 'pending',
              error = NULL,
              missing_fields = NULL,
              attempt_no = attempt_no + 1,
              subject = $3::jsonb,
              updated_at = now()
        WHERE id = $1 AND batch_id = $2 AND state = 'failed'`,
      [args.itemId, args.batchId, JSON.stringify(nextInput)],
    );
    if ((reset.rowCount ?? 0) === 0) return { kind: 'state_conflict' };

    // 计数复位：回滚该 item 之前计入的 failed_count（让 processed 退回，重试再终态时模板 B 重新计入，不双计）。
    await tx.query(
      `UPDATE publish_batches
          SET failed_count = GREATEST(failed_count - 1, 0),
              status = 'running',
              updated_at = now()
        WHERE id = $1`,
      [args.batchId],
    );

    // 重新激活 publish_batch job：换 fence + attempt+1 + 置 queued（worker 据新 fence 续跑重试项；旧 fence 写回 0 行安全退出）。
    const jRes = await tx.query<{ fence_token: number }>(
      `UPDATE jobs
          SET status = 'queued',
              fence_token = fence_token + 1,
              attempt_no = attempt_no + 1,
              lease_owner = NULL,
              lease_until = NULL,
              finished_at = NULL,
              updated_at = now()
        WHERE id = $1
        RETURNING fence_token`,
      [bRaw.job_id],
    );
    const fenceToken = jRes.rows[0]?.fence_token ?? 1;

    const item = toItemRow({
      ...iRaw,
      state: 'pending',
      error: null,
      missing_fields: null,
      subject: nextInput,
    });
    return { kind: 'requeued', item, jobId: bRaw.job_id, fenceToken };
  });
}

export { withTransaction };
export type { TxPool };

// B-23 · 萃取 Job 创建（触发萃取 + 单候选重试 retry job）。30-step2-extract §2.1/§2.3。
//   两条路径共用「建 jobs(type=extract) 行 + BullMQ 入队」口径，殊途同归到 B-22 的 extract handler：
//     · 触发萃取（POST /snapshots/{id}/extract）：mode='extract'，subject_ref 记 snapshotId，
//       worker 携 snapshotId 只在该快照段集聚类、归纳全部候选（B-22）。
//     · 单候选重试（POST /candidates/{id}/retry）：**新建一个 retry job**（mode='single-candidate'，
//       subject_ref 记 snapshotId+candidateId），复用 B-22 的 extract handler 但只重识别该候选（Codex#4：
//       绝不在已 terminal 的原萃取 job 流上追加，而是建新 job + 新 fence + 新 eventsUrl）。
//
//   建 job 行：status='queued'、subject_ref 记萃取输入（snapshotId/mode/candidateId），fence_token 初值 1
//     （>0 表「需入队」；领租约时 DB 换发执行 fence，脊柱 §6.2）。progress 初始化为五项子任务全 pending
//     （永不裸转圈：连接即有清单可点亮，提取-03）。
//   入队失败【不删/不标 failed】——job 留 queued 交 staleQueued sweeper 按既有 fence 补投（与导入路径同口径，
//     不裸转圈、不假转圈）。返回完整 JobView（queued + 五项子任务 pending），前端立即转订阅 SSE。
//
//   **B-22 对接点（单候选模式）**：retry job 与普通 extract job 同 schema、同 fencing/重入队语义，无新表、无新 job type。
//     B-22 的 extract handler 据 subject_ref.mode 分流：'extract' = 全量聚类归纳；'single-candidate' = 仅就
//     subject_ref.candidateId 复用原 snapshot 段集重识别、受保护 UPDATE 该候选行（fence 取自本 retry job）。
import { SUBTASK_SEQUENCES, SSE_ROUTES, type JobView, type ProgressView } from '@cb/shared';
import type { QueuePort } from '@cb/shared';
import type { Queryable } from '../../platform/jobs/types.js';
// B-22 对接点：subject_ref 形态以 B-22 handler 的 ExtractSubjectRef 为唯一真源（handler 据 mode 分流）。
//   本模块（B-23 建 job）只生产 handler 能消费的 subject_ref，绝不另立形态。
import type { ExtractSubjectRef } from './job.js';

/**
 * 单候选同处重试上限（默认 2，对齐脊柱「LLM 调用重试 ≤2」+「同处两次仍失败落 escalate」，§2.3）。
 *   达上限后再次调本端点仍受理（仍建新 retry job），但 subject_ref.escalate=true → handler 再失败时
 *   error.action 升级 escalate（「转人工/反馈」带 traceId）。
 */
export const RETRY_ESCALATE_THRESHOLD = 2;

/** 初始 progress：五项子任务全 pending + 0%（永不裸转圈，提取-03，标准序见 SUBTASK_SEQUENCES.extract）。 */
export function initialExtractProgress(): ProgressView {
  return {
    percent: 0,
    phrase: '正在准备提取…',
    subtasks: SUBTASK_SEQUENCES.extract.map((s) => ({ ...s, status: 'pending' as const })),
    items: [],
  };
}

/** 据已建 job 字段组完整 JobView（queued + 五项子任务进度 + attemptNo/createdAt，不裸转圈）。 */
function toExtractJobView(fields: { id: string; attemptNo: number; createdAt: string }): JobView {
  return {
    id: fields.id,
    type: 'extract',
    status: 'queued',
    progress: initialExtractProgress(),
    attemptNo: fields.attemptNo,
    createdAt: fields.createdAt,
  };
}

/** 建 job 的 DB 产物（建完入队 + 组 JobView 用）。 */
export interface CreatedExtractJob {
  jobId: string;
  fenceToken: number;
  attemptNo: number;
  createdAt: string;
  /** 入队是否成功（失败留 queued 交 sweeper 补投；本字段仅观测/对账用）。 */
  enqueued: boolean;
  view: JobView;
}

/**
 * 受保护建 extract job 行（§11.A 模板②：INSERT 数据源内联属主校验 + 快照就绪闸）。
 *   建 job 与「快照属本人且已就绪（segment_count > 0）」绑定进同一条 INSERT...SELECT FROM raw_snapshots：
 *     - 快照不存在/非本人 → SELECT 无行 → INSERT 0 行 → 返回 null（调用方 404，不暴露存在性）。
 *     - 快照属本人但 segment_count=0（导入未就绪/无段可萃取）→ SELECT 无行（WHERE segment_count > 0）→ 0 行 →
 *       返回 'not_ready'（调用方 409 EXTRACT_SNAPSHOT_NOT_READY）。
 *   owner_user_id 取自 raw_snapshots 行（血缘焊死，不靠入参传 owner，杜绝越权写）。
 *   subject_ref 记 { snapshotId, mode:'extract' }，worker 据此只在该快照段集聚类（提取-33）。
 *
 *   草稿落点同事务回填（P0，Codex r4）：给了 draftId → 在【同一条 CTE】里把 extract_job_id + current_step='extract'
 *     焊到该草稿（owner 守卫 + 单次写 + current_step 永不倒退），不再 handler 层 best-effort 独立写。
 *     建 job 与草稿落点要么一起提交、要么一起回滚——续传指针绝不与 job 半落（已生成不丢、续传完整）。
 *     草稿守卫内联进 backfill 子句的 WHERE（owner_user_id=本人 AND status='active'）：非本人/非 active/不存在 →
 *     UPDATE 命中 0 行（job 仍建成，draftId 错配只是不回填，不挡萃取，job 才是真源）。
 */
export async function insertFullExtractJob(
  db: Queryable,
  snapshotId: string,
  ownerUserId: string,
  draftId?: string,
): Promise<
  | {
      kind: 'created';
      row: { id: string; fence_token: number; attempt_no: number; created_at: string };
    }
  | { kind: 'not_found' }
  | { kind: 'not_ready' }
> {
  // B-22 对接：mode='extract'（全量聚类归纳），携 snapshotId 只在该快照段集聚类（提取-33）。
  const subjectRef = JSON.stringify({ snapshotId, mode: 'extract' } satisfies ExtractSubjectRef);
  const progress = JSON.stringify(initialExtractProgress());
  // 属主 + 就绪闸内联进 INSERT 数据源（快照属本人 AND segment_count>0 才建 job）。
  // 给 draftId → 同一 CTE 再回填该草稿（new_job 产出 extract_job_id → 焊进 drafts，owner 守卫 + current_step 永不倒退）。
  const res = await db.query<{
    id: string;
    fence_token: number;
    attempt_no: number;
    created_at: string;
  }>(
    `WITH new_job AS (
        INSERT INTO jobs (type, status, owner_user_id, subject_ref, progress, fence_token)
        SELECT 'extract', 'queued', s.owner_user_id, $2::jsonb, $3::jsonb, 1
          FROM raw_snapshots s
         WHERE s.id = $1
           AND s.owner_user_id = $4
           AND s.segment_count > 0
        RETURNING id, fence_token, attempt_no, created_at
     ),
     draft_backfill AS (
        -- 同事务回填本草稿（P0）：extract_job_id 焊死 + current_step 推进到 'extract'（永不倒退：已过萃取的草稿不被打回）。
        --   current_step 永不倒退：仅当当前步序 ≤ extract(=1) 才置 'extract'（select/structure/publish 序更后，保留）。
        --   owner 守卫（draftId 客户端传入，必须独立守门）：owner_user_id=本人 AND status='active'；$5 NULL → 0 行（无草稿不回填）。
        UPDATE drafts d
           SET extract_job_id = nj.id,
               current_step = CASE
                                WHEN (CASE d.current_step
                                        WHEN 'import' THEN 0 WHEN 'extract' THEN 1 WHEN 'select' THEN 2
                                        WHEN 'structure' THEN 3 WHEN 'publish' THEN 4 ELSE 0 END) <= 1
                                THEN 'extract' ELSE d.current_step END,
               updated_at = now()
          FROM new_job nj
         WHERE d.id = $5
           AND d.owner_user_id = $4
           AND d.status = 'active'
        RETURNING d.id
     )
     SELECT id, fence_token, attempt_no, created_at FROM new_job`,
    [snapshotId, subjectRef, progress, ownerUserId, draftId ?? null],
  );
  const row = res.rows[0];
  if (row) return { kind: 'created', row };
  // 0 行：区分「不存在/非本人」与「存在但未就绪」（轻查属主，仅控制流分类，非写入）。
  const own = await db.query<{ ready: boolean }>(
    `SELECT (segment_count > 0) AS ready
       FROM raw_snapshots
      WHERE id = $1 AND owner_user_id = $2`,
    [snapshotId, ownerUserId],
  );
  if ((own.rowCount ?? 0) === 0) return { kind: 'not_found' };
  return { kind: 'not_ready' }; // 属本人但 segment_count=0
}

/**
 * 触发萃取（§2.1）：建 jobs(type=extract, mode=extract) + BullMQ 入队（殊途同归到 B-22 extract handler）。
 *   幂等第一道闸 Idempotency-Key（preHandler）已挡连点/刷新（提取-25）；本函数只在取得租约时被调一次。
 *   入队失败不回滚——job 已建成 queued，交 staleQueued sweeper 按既有 fence 补投（不裸转圈，与导入同口径）。
 *   draftId（P0，Codex r4）：本萃取由哪条草稿发起 → 同事务把 extract_job_id + current_step='extract' 焊到该草稿
 *     （insertFullExtractJob 的同一 CTE 内回填，owner 守卫 + 单次写），续传按 draftId 恢复 extractJobId 回断点。
 *   返回 created（含完整 JobView）/ not_found（404）/ not_ready（409）。
 */
export async function createFullExtractJob(
  db: Queryable,
  queue: Pick<QueuePort, 'enqueue'>,
  snapshotId: string,
  ownerUserId: string,
  draftId?: string,
): Promise<
  { kind: 'created'; job: CreatedExtractJob } | { kind: 'not_found' } | { kind: 'not_ready' }
> {
  const inserted = await insertFullExtractJob(db, snapshotId, ownerUserId, draftId);
  if (inserted.kind !== 'created') return inserted;
  const { row } = inserted;
  let enqueued = true;
  try {
    await queue.enqueue('extract', row.id as never, Number(row.fence_token));
  } catch {
    // 入队失败：job 已建成 queued，**不删/不标 failed**——交 staleQueued sweeper 按既有 fence 补投。
    enqueued = false;
  }
  const view = toExtractJobView({
    id: row.id,
    attemptNo: Number(row.attempt_no),
    createdAt: new Date(row.created_at).toISOString(),
  });
  return {
    kind: 'created',
    job: {
      jobId: row.id,
      fenceToken: Number(row.fence_token),
      attemptNo: Number(row.attempt_no),
      createdAt: new Date(row.created_at).toISOString(),
      enqueued,
      view,
    },
  };
}

/** retry job 建库结果（候选状态翻转 failed→generating + 新 retry job 同一事务 CTE 原子产出）。 */
export interface CreatedRetryJob {
  /** 新建 retry job id（全新 fence/流，前端改连其 eventsUrl）。 */
  retryJobId: string;
  /** 原萃取 job（候选归属/列表寻址，只读引用，§2.3 CandidateRetryAccepted.extractJobId）。 */
  extractJobId: string;
  fenceToken: number;
  attemptNo: number;
  createdAt: string;
  /** 候选累计重试次数（本次 +1 后；达上限语义见 §2.3）。 */
  retryCount: number;
  enqueued: boolean;
}

/**
 * retry job 建库分类：候选状态闸（仅 failed 可重试）。
 *   - created：受理重试（候选 failed→generating + 新 retry job）。
 *   - already_ready：候选已 ready（无需重试，409）。
 *   - locked：候选已 generating（重试在途，Codex r2#3）→ 路由 423 RESOURCE_LOCKED + action:'wait'（契约 §2.3）。
 *       场景：候选首轮萃取仍在 generating，或前一次重试在途，用【不同 Idempotency-Key】再点重试（同 key 由幂等层 423 拦）。
 *   - not_found：不存在 / 非本人（不暴露存在性，404）。
 */
export type CreateRetryJobResult =
  | { kind: 'created'; job: CreatedRetryJob }
  | { kind: 'not_found' }
  | { kind: 'already_ready' }
  | { kind: 'locked' };

/**
 * 单候选重试（§2.3，B-23 核心，Codex#4）：**新建 retry job** + 候选 failed→generating，**同一条 CTE 原子**。
 *
 *   绝不复用原萃取 job 的（已 terminal）流——原 job 已发 done、流已关、fence 终态。每次重试新建一个
 *   jobs(type=extract, mode='single-candidate')（全新 fence_token/流），结果经新 retry job 的 eventsUrl 推回。
 *
 *   单条 data-modifying CTE（杜绝两步「查后写」，对账安全、无 TOCTOU）：
 *     ① target：SELECT 该候选 WHERE owner=本人 AND status='failed' FOR UPDATE（守门 + 行锁）——
 *        命中 = 候选属本人且可重试；ready 候选/非本人/不存在 → target 空。
 *     ② new_job：INSERT INTO jobs SELECT 'extract','queued',... FROM target RETURNING id——
 *        **数据源是 target**，target 空 → INSERT 0 行 → 绝不建孤儿 retry job。
 *        subject_ref 记 { snapshotId（取自候选行）, mode:'single-candidate', candidateId, extractJobId }，
 *        worker 据此复用 B-22 extract handler 的单候选模式（只动这一行）。
 *     ③ flipped：**单次** UPDATE capability_candidates SET status='generating', retry_cnt=retry_cnt+1
 *        WHERE id=(SELECT id FROM target)——候选行本语句只改一次（status + retry_cnt 同写），返回新 retry_cnt。
 *   target 空（候选 ready/非本人/不存在）→ INSERT/UPDATE 均 0 行（全不发生）→ 据轻查分类 already_ready / not_found。
 *
 *   重试入队即 generating（行内进入「重试中」态，前端连新 eventsUrl 收回填，提取-19）。
 */
export async function createRetryJob(
  db: Queryable,
  queue: Pick<QueuePort, 'enqueue'>,
  candidateId: string,
  ownerUserId: string,
): Promise<CreateRetryJobResult> {
  const res = await db.query<{
    id: string;
    fence_token: number;
    attempt_no: number;
    created_at: string;
    retry_cnt: number;
    extract_job_id: string;
  }>(
    `WITH target AS (
        SELECT c.id, c.snapshot_id, c.owner_user_id, c.extract_job_id, c.retry_cnt, c.name
          FROM capability_candidates c
         WHERE c.id = $1
           AND c.owner_user_id = $2
           AND c.status = 'failed'
         FOR UPDATE
     ),
     new_job AS (
        -- B-22 对接：mode='single-candidate'（handler 单候选模式，ExtractSubjectRef.mode 唯一真源），
        --   candidateId 复用原 snapshot 段集只重识别这一行。
        --   escalate：本次重试后 retry_cnt（= 旧值+1）达上限 → handler 再失败时 action 升级 escalate（§2.3）。
        -- progress.items 注入该候选 generating 态（Codex r2#4）：retry 新流首帧 state_snapshot 即含该候选在生成，
        --   前端连上就有这一项在「重试中」、不裸转圈（硬规则①，契约 §2.3「先收含 generating 态的 state_snapshot」）。
        INSERT INTO jobs (type, status, owner_user_id, subject_ref, progress, fence_token)
        SELECT 'extract', 'queued', t.owner_user_id,
               jsonb_build_object(
                 'snapshotId', t.snapshot_id,
                 'mode', 'single-candidate',
                 'candidateId', t.id,
                 'escalate', (t.retry_cnt + 1) >= $4
               ),
               jsonb_set(
                 $3::jsonb,
                 '{items}',
                 jsonb_build_array(
                   jsonb_build_object(
                     'id', t.id,
                     'status', 'generating',
                     'isNew', false,
                     'name', to_jsonb(t.name)
                   )
                 )
               ), 1
          FROM target t
        RETURNING id, fence_token, attempt_no, created_at
     ),
     flipped AS (
        -- 候选立刻 failed→generating + retry_cnt+1（同一行只改一次，§11.A）；前端连新流收回填（提取-19）。
        UPDATE capability_candidates c
           SET status     = 'generating',
               error      = NULL,
               retry_cnt  = c.retry_cnt + 1,
               updated_at = now()
         WHERE c.id = (SELECT id FROM target)
        RETURNING c.retry_cnt
     )
     SELECT j.id, j.fence_token, j.attempt_no, j.created_at, f.retry_cnt,
            (SELECT extract_job_id FROM target) AS extract_job_id
       FROM new_job j, flipped f`,
    [candidateId, ownerUserId, JSON.stringify(initialExtractProgress()), RETRY_ESCALATE_THRESHOLD],
  );
  const row = res.rows[0];
  if (!row) {
    // target 空：候选 ready（无需重试）/ 非本人 / 不存在 → 轻查分类（仅控制流，非写入）。
    const cls = await db.query<{ status: string }>(
      `SELECT status FROM capability_candidates WHERE id = $1 AND owner_user_id = $2`,
      [candidateId, ownerUserId],
    );
    const status = cls.rows[0]?.status;
    if (status === undefined) return { kind: 'not_found' }; // 不存在/非本人（不暴露存在性）
    if (status === 'ready') return { kind: 'already_ready' }; // 已识别成功，无需重试（§2.3 409 CANDIDATE_ALREADY_READY）
    // status='generating'（重试/首轮萃取在途）：契约 §2.3「重试在途」=> 423 RESOURCE_LOCKED + action:'wait'（Codex r2#3）。
    //   同 Idempotency-Key 的在途由幂等层 423 拦；这里是用【不同 key】撞上在途态 → 返回 locked（路由 423/wait），不重复建 retry job。
    if (status === 'generating') return { kind: 'locked' };
    return { kind: 'not_found' }; // 其余未知态：兜底 not_found（不暴露、引导刷新对账）
  }
  let enqueued = true;
  try {
    await queue.enqueue('extract', row.id as never, Number(row.fence_token));
  } catch {
    enqueued = false;
  }
  return {
    kind: 'created',
    job: {
      retryJobId: row.id,
      extractJobId: row.extract_job_id,
      fenceToken: Number(row.fence_token),
      attemptNo: Number(row.attempt_no),
      createdAt: new Date(row.created_at).toISOString(),
      retryCount: Number(row.retry_cnt),
      enqueued,
    },
  };
}

/** eventsUrl 构造（前端直连 SSE，不裸转圈）：= /api/v1/jobs/{jobId}/events（脊柱 §5）。 */
export function jobEventsUrl(jobId: string): string {
  return SSE_ROUTES.jobEvents(jobId);
}

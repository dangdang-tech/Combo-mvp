// B-22/B-23 · 提取 Job handler（注册为 3A runner 的 extract JobHandler）。30-step2-extract §2.1/§3/§5。
//   两种模式（同一 JobHandler，按 subject_ref.mode 分流）：
//     ① 'extract'（默认，B-22）：读某 snapshot 的 session_segments → 经 3A LLM 网关分析/聚类/形成候选/评估/排序
//        → 五项子任务依次点亮 → 逐个浮现候选（item-appended，'刚浮现'语义）→ 候选/证据逐项落库（复合 FK 血缘）
//        → 同事务 outbox（extract 完成→通知）。单候选失败标错误态、不阻塞整体。
//     ② 'single-candidate'（B-23）：以【新 retry job】重识别一个候选（subject_ref.candidateId）。复用原 snapshot 段集，
//        只动该候选行（受保护，fence 取自新 retry job）；成功回 ready + 重写证据，再失败回 failed + 人话 error（无连坐）。
//
//  三条硬规则落地：
//    ① 永不裸转圈：五项子任务 reportSubtask 依次点亮 + reportProgress 量化文案「已浮现 X / Y 能力项」+ 逐个 appendItem；
//       未识别用占位骨架（前端据 done/total 渲染）；不等全部跑完（边生成边显示）。
//    ② 绝不裸露错误码：整体失败抛带 code 错误（runner 归一人话信封 + error/done 帧）；
//       单候选失败落 status=failed + 人话 ErrorBody（如「上游解析中断 · 段 5/9」），item-appended 推送，绝不裸 500/堆栈。
//    ③ 已生成不丢：每个候选 + 段级证据逐项受保护落库（fence CTE）；取消/接管换 fence → 写 0 行干净退出，已浮现候选保留；
//       同事务把「最终业务状态 + outbox 通知」原子提交（绝不另起事务吞失败）。
import {
  ErrorCode,
  SUBTASK_SEQUENCES,
  SSE_ROUTES,
  buildError,
  type CandidateItem,
  type ProgressView,
  type ErrorBody,
  type LlmGatewayPort,
  type NotifyExtractCompletedPayload,
  type ExtractDoneResult,
} from '@cb/shared';
import type {
  JobContext,
  JobHandler,
  JobResult,
  LeasedJob,
  Queryable,
} from '../../platform/jobs/types.js';
import { emitInTx, eventIdFor } from '../../platform/events/outbox.js';
import { withTransaction, type Tx, type TxPool } from '../../platform/events/db-tx.js';
import {
  readSnapshotSegments,
  insertReadyCandidateWithEvidenceInTx,
  insertFailedCandidateProtected,
  readCandidateForOwner,
  readAllCandidatesForJob,
  applyRetrySuccessInTx,
  applyRetryFailureProtected,
  CandidateLandingFencedOut,
  type CandidateRowForFinal,
} from './repo.js';
import {
  clusterSegments,
  scoreCandidates,
  nameOne,
  isEffectiveSessionForMock,
  nameSessionCapability,
  buildSessionMockCandidate,
  CandidateNameUnavailable,
  type NamedCandidate,
  type ScoredCandidate,
} from './cluster.js';

/** 抛带分类 code 的整体失败错误（runner.normalizeToErrorBody 据 code 归一人话信封，绝不裸露原始报错）。 */
function codedError(code: (typeof ErrorCode)[keyof typeof ErrorCode], message: string): Error {
  const e = new Error(message) as Error & { code: string };
  e.code = code;
  return e;
}

/**
 * subject_ref 形态（触发期 B-23 写入；create-extract-job.ts 是唯一生产者，本文件是唯一消费者）：
 *   - mode='extract'（默认，全量聚类归纳，B-22）：携 snapshotId，只在该快照段集聚类（提取-33）。
 *   - mode='single-candidate'（单候选重试，B-23）：携 snapshotId + candidateId + 原 extractJobId（只读引用），
 *     复用原 snapshot 段集重识别该候选（Codex#4：新 retry job + 新 fence/流，不碰原萃取 job 终态流）。
 */
export interface ExtractSubjectRef {
  mode?: 'extract' | 'single-candidate';
  snapshotId?: string;
  /** retry 模式：要重识别的候选 id（其 snapshot 段集只读复用）。 */
  candidateId?: string;
  /** retry 模式：原萃取 job（只读引用，§2.3 CandidateRetryAccepted.extractJobId）。 */
  extractJobId?: string;
  /** retry 模式：达上限后 action 升级 escalate（同处重试 ≥ 上限，§2.3）。 */
  escalate?: boolean;
}

/** 提取 handler 依赖面（注入便于 mock；worker 入口用真实 infra 装配）。 */
export interface ExtractHandlerDeps {
  /** worker 写库 / 受保护 fence CTE 用的 PG 句柄（与 runner 同库）。 */
  db: Queryable;
  /** 同事务 outbox（extract 完成 + 发通知同一 PG 事务，70 §2.1）。 */
  txPool: TxPool;
  /** 3A LLM 网关（无 key → degraded，单测注入 mock）。 */
  gateway: LlmGatewayPort;
}

/** 五项子任务标准序（SUBTASK_SEQUENCES.extract）。 */
const SUBTASKS = SUBTASK_SEQUENCES.extract;
export const EXTRACT_SUBTASK_KEYS = SUBTASKS.map((s) => s.key);

/** ScoredCandidate → 占位/失败前的 item 轻摘要骨架（前端逐个浮现单元，CandidateItem）。 */
function toItem(
  id: string,
  c: {
    name: string | null;
    intent?: string | null;
    type: string | null;
    confidence: string | null;
    segmentCount: number | null;
    scopeCoherence: number | null;
    splitSuggested: boolean | null;
  },
  opts: { status: 'ready' | 'failed'; isNew: boolean; error?: ErrorBody | null },
): CandidateItem {
  return {
    id,
    status: opts.status,
    isNew: opts.isNew,
    name: c.name,
    intent: c.intent ?? null,
    type: (c.type as CandidateItem['type']) ?? null,
    confidence: (c.confidence as CandidateItem['confidence']) ?? null,
    segmentCount: c.segmentCount,
    scopeCoherence: c.scopeCoherence,
    splitSuggested: c.splitSuggested,
    ...(opts.error !== undefined ? { error: opts.error } : {}),
  };
}

/** 量化进度文案（提取-07/08：「已浮现 X / Y 能力项…」）。 */
function appendedPhrase(done: number, total: number): string {
  return `已浮现 ${done} / ${total} 能力项…`;
}

/**
 * 终态计数与 items 从 DB 全量候选合并重建（Codex r3 P1：已生成不丢，硬规则③）。
 *   sweeper 接管重跑时，本 attempt 内存累加器只含本轮新 append 项；去重命中的旧 attempt 候选不在其中。
 *   故终态【从 DB 当前该 extract_job_id 全部候选重建】，并保留本 attempt 刚浮现项的 isNew=true（snapshot.items 据此区分「刚浮现」）。
 *   返回的 items 含全部已生成候选（旧+新）；ready/failed/total/置信分布从 DB 真源派生（与 outbox candidateCount / snapshot 一致）。
 */
function buildFinalFromDb(
  dbRows: CandidateRowForFinal[],
  attemptItems: CandidateItem[],
): {
  items: CandidateItem[];
  readyCount: number;
  failedCount: number;
  candidateCount: number;
} {
  // 本 attempt 刚浮现项（isNew=true）的 id 集合 → 合并时保留 isNew=true（snapshot 据此渲染「刚浮现」）。
  const freshIds = new Set(attemptItems.filter((it) => it.isNew === true).map((it) => it.id));
  let readyCount = 0;
  let failedCount = 0;
  const items: CandidateItem[] = [];
  for (const r of dbRows) {
    // 本萃取流只产 ready/failed 终态候选（单候选原子落库，绝不留 generating 半残）；防御性跳过任何异常 generating 行，
    //   不计入终态/不污染浮现列表（candidateCount = ready + failed，与契约一致）。
    if (r.status !== 'ready' && r.status !== 'failed') continue;
    if (r.status === 'ready') readyCount++;
    else failedCount++;
    items.push(
      toItem(
        r.id,
        {
          name: r.name,
          intent: r.intent,
          type: r.type,
          confidence: r.confidence,
          segmentCount: r.segmentCount,
          scopeCoherence: r.scopeCoherence,
          splitSuggested: r.splitSuggested,
        },
        {
          status: r.status,
          isNew: freshIds.has(r.id),
          ...(r.error != null ? { error: r.error as CandidateItem['error'] } : {}),
        },
      ),
    );
  }
  return { items, readyCount, failedCount, candidateCount: items.length };
}

/** 收尾完整 ProgressView（100% + 五项子任务全 done + 已浮现候选 items 不丢，硬规则③）。 */
function completedExtractProgress(
  items: CandidateItem[],
  total: number,
  metrics?: ProgressView['metrics'],
): ProgressView {
  return {
    percent: 100,
    phrase: total > 0 ? `已识别出 ${total} 个能力项` : '没有识别到可打包的能力项',
    done: total,
    total,
    unit: '能力项',
    ...(metrics ? { metrics } : {}),
    subtasks: SUBTASKS.map((s) => ({ ...s, status: 'done' as const })),
    items,
    slow: false,
  };
}

/**
 * 同事务收尾（Codex P0-3）：在【同一 PG 事务】里把「最终业务状态(completed) + job 结果 + outbox 通知」原子提交。
 *   completeJobInTx 0 行 = 已被 fence out（取消/接管换 fence）→ 抛哨兵 ROLLBACK（不发通知、不落 completed），
 *   外层据 instanceof 当 fence-out 优雅吞掉（不当业务失败重试，runner 兜）。
 */
class FinalizeFencedOut extends Error {
  constructor() {
    super('extract finalize fenced out (complete guard matched 0 rows); rolled back');
    this.name = 'FinalizeFencedOut';
  }
}

async function completeJobInTx(
  tx: Tx,
  jobId: string,
  fenceToken: number,
  result: unknown,
  finalProgress: ProgressView,
): Promise<boolean> {
  const res = await tx.query(
    `WITH guard AS (
        SELECT id FROM jobs
         WHERE id = $1 AND fence_token = $2 AND status = 'running'
         FOR UPDATE
     )
     UPDATE jobs j
        SET status      = 'completed',
            result      = $3::jsonb,
            progress    = $4::jsonb,
            error       = NULL,
            finished_at = now(),
            updated_at  = now()
       FROM guard
      WHERE j.id = guard.id`,
    [jobId, fenceToken, JSON.stringify(result ?? null), JSON.stringify(finalProgress)],
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * 同事务收尾（全量萃取 & 单候选重试共用，Codex P0-3 + Codex#5）：
 *   在【同一 PG 事务】里把「complete job + notify.extract_completed outbox」原子提交，与全量口径一致。
 *   retry job 也是 jobs(type=extract)，完成口径必须同源（70 §1 topic 表 aggregate_id=jobId；§7 NotifyExtractCompletedPayload）——
 *   event_id = extract_done:{jobId}:{attemptNo}（70 §2.3 模板，retry job 自己的 jobId/attemptNo，与原萃取 job 不撞）。
 *   返回 true = 已 finalized（runner 只发 done，不再二次落终态）；false = fence out（completeJobInTx 0 行 → ROLLBACK，不发通知/不发终态，交还 runner 兜）。
 *   非 fence-out 的事务异常 → 上抛 INTERNAL（runner 归一人话 + error/done，绝不另起事务吞失败）。
 */
async function finalizeExtractJob(args: {
  txPool: TxPool;
  job: LeasedJob;
  ctx: JobContext;
  result: unknown;
  finalProgress: ProgressView;
  candidateCount: number;
}): Promise<boolean> {
  const { txPool, job, ctx, result, finalProgress, candidateCount } = args;
  try {
    await withTransaction(txPool, async (tx) => {
      const completed = await completeJobInTx(tx, job.id, job.fenceToken, result, finalProgress);
      if (!completed) throw new FinalizeFencedOut(); // fence out → ROLLBACK，不发通知。
      const payload: NotifyExtractCompletedPayload = {
        recipientId: job.ownerUserId,
        link: SSE_ROUTES.jobEvents(job.id),
        traceId: ctx.traceId,
        occurredAt: new Date().toISOString(),
        jobId: job.id,
        attemptNo: job.attemptNo,
        candidateCount,
      };
      await emitInTx(tx, {
        eventId: eventIdFor.extractCompleted(job.id, job.attemptNo),
        topic: 'notify.extract_completed',
        aggregateId: job.id,
        payload,
        traceId: ctx.traceId,
      });
    });
    return true;
  } catch (err) {
    if (err instanceof FinalizeFencedOut) {
      return false; // fence-out：事务已 ROLLBACK，当作 fence-out 优雅处理（不发终态、不重试）。
    }
    throw codedError(
      ErrorCode.INTERNAL,
      `extract finalize tx failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * 提取 handler 工厂（注入依赖；worker 入口装配真实 infra，单测注入 mock）。
 */
export function createExtractHandler(deps: ExtractHandlerDeps): JobHandler {
  const { db, txPool, gateway } = deps;
  return {
    type: 'extract',
    async run(job: LeasedJob, ctx: JobContext): Promise<JobResult> {
      const subject = (job.subjectRef ?? {}) as ExtractSubjectRef;
      if (subject.mode === 'single-candidate') {
        return runRetry(deps, job, ctx, subject);
      }
      return runExtract({ db, txPool, gateway }, job, ctx, subject);
    },
  };
}

// ===========================================================================
// 模式①：完整萃取（B-22）
// ===========================================================================
async function runExtract(
  deps: ExtractHandlerDeps,
  job: LeasedJob,
  ctx: JobContext,
  subject: ExtractSubjectRef,
): Promise<JobResult> {
  const { db, txPool, gateway } = deps;
  const snapshotId = subject.snapshotId;
  if (!snapshotId) {
    // 无 snapshot 引用：触发期应已拦（§2.1），到此为内部不一致 → 整体失败（人话归一）。
    throw codedError(
      ErrorCode.EXTRACT_SNAPSHOT_NOT_READY,
      'extract subject_ref missing snapshotId',
    );
  }

  // —— analyze：读某 snapshot 的去敏段集（§5.2 只读去敏段，提取-31）——
  await ctx.reportSubtask('analyze', 'running');
  await ctx.reportProgress({ percent: 5, phrase: '正在分析会话段落…' });
  const segments = await readSnapshotSegments(db, snapshotId);
  await ctx.reportProgress({
    percent: 12,
    phrase: `已读取 ${segments.length} 段会话，开始分析…`,
    done: 0,
    total: 0,
    unit: '能力项',
    metrics: { analyzedSegments: segments.length, discoveredCandidates: 0 },
  });
  await ctx.reportSubtask('analyze', 'done');

  // —— cluster：聚类相似工作流（同一快照内，证据不跨快照）——
  await ctx.reportSubtask('cluster', 'running');
  const selectedSegments = segments.filter(isEffectiveSessionForMock).slice(0, 5);
  await ctx.reportSubtask('cluster', 'done');

  // —— form_candidates：形成候选能力（total 在此确定并稳定，提取-08；done 单调）——
  await ctx.reportSubtask('form', 'running');
  const total = selectedSegments.length;
  await ctx.reportProgress({
    percent: 25,
    phrase: total > 0 ? appendedPhrase(0, total) : '正在形成候选…',
    done: 0,
    total,
    unit: '能力项',
    metrics: { analyzedSegments: segments.length, discoveredCandidates: 0 },
  });
  await ctx.reportSubtask('form', 'done');

  // —— score：评估频率与可打包度（确定性打分）——
  await ctx.reportSubtask('score', 'running');
  await ctx.reportSubtask('score', 'done');

  // —— rank：按成功率排序（scoreCandidates 已按 reusability 降序）+ 逐个浮现落库 ——
  await ctx.reportSubtask('rank', 'running');

  const items: CandidateItem[] = []; // 收尾 finalProgress.items（已浮现不丢，硬规则③）。
  let readyCount = 0;
  let failedCount = 0;
  let anyDegradedNaming = false; // 任一候选命名走 LLM 降级 → done.result.degraded 诚实标（§10）。

  for (let i = 0; i < selectedSegments.length; i++) {
    if (ctx.isCancelled()) break; // 安全点：取消即停（已浮现候选保留）。
    const segment = selectedSegments[i]!;
    const summary = await nameSessionCapability(gateway, segment, {
      traceId: ctx.traceId,
      ...(job.ownerUserId ? { ownerUserId: job.ownerUserId } : {}),
    });
    const cand = buildSessionMockCandidate(segment, summary);

    // 单候选成败隔离：命名（LLM）或落库异常 → 该候选标 failed（人话 error），不抛、不阻塞其余（提取-17/29）。
    const outcome = await emitSessionMockCandidate(
      { db, txPool },
      job,
      ctx,
      snapshotId,
      cand,
      i,
      total,
    );
    if (outcome === 'fenced_out') break; // 被接管/取消：停在安全点，已浮现保留。
    if (outcome) {
      items.push(outcome.item);
      if (outcome.item.status === 'ready') readyCount++;
      else failedCount++;
      if (outcome.degradedNaming) anyDegradedNaming = true;
    }

    const done = readyCount + failedCount;
    await ctx.reportProgress({
      percent: 25 + Math.round((70 * (i + 1)) / Math.max(1, selectedSegments.length)),
      phrase: appendedPhrase(done, total),
      done,
      total,
      unit: '能力项',
      metrics: { analyzedSegments: segments.length, discoveredCandidates: done },
    });
  }
  await ctx.reportSubtask('rank', 'done');

  // —— 终态从 DB 全量候选合并重建（Codex r3 P1：已生成不丢，硬规则③）——
  //   sweeper 接管重跑时，本 attempt 内存累加器（items/readyCount/failedCount）只含本轮新 append 项；
  //   去重命中（(extract_job_id, slug)）的旧 attempt 候选不在其中。若只用内存累加器收尾 → 终态 snapshot.items/result/outbox
  //   candidateCount 会丢旧候选。故从【DB 当前该 extract_job_id 全部候选】（真源）重建 items 与计数（含旧+新）。
  const dbRows = await readAllCandidatesForJob(db, job.id);
  const merged = buildFinalFromDb(dbRows, items);
  // total：取本 attempt 草稿数与 DB 实际候选数的较大者——resume 时 DB 候选可能多于本轮草稿，保证收尾 done==total（不撕裂量化）。
  const finalTotal = Math.max(total, merged.candidateCount);

  // —— 同事务收尾：completed + outbox（extract 完成→通知），原子提交（Codex P0-3）——
  // degraded：LLM 命名降级（无 key/不稳）→ 诚实标 true（§10：degraded 仍完成、不裸 502；候选用确定性骨架兜底）。
  //   degraded 只表「质量降级地完成」，不阻塞、不报错——前端可据此提示「部分名称为自动生成」。
  //   ⚠️ degraded 是本 finalizing attempt 的命名降级信号（去重跳过的旧候选本轮无 LLM 调用）——honest 推迟项见返回说明。
  const candidateCount = merged.candidateCount;
  const result: ExtractDoneResult = {
    candidateCount,
    readyCount: merged.readyCount,
    failedCount: merged.failedCount,
    analyzedSegments: segments.length,
    degraded: anyDegradedNaming,
  };
  const finalMetrics: ProgressView['metrics'] = {
    analyzedSegments: segments.length,
    discoveredCandidates: merged.readyCount + merged.failedCount,
  };
  const finalProgress = completedExtractProgress(merged.items, finalTotal, finalMetrics);

  // —— 进度收尾帧必须在 finalize（置 completed）【之前】发（Codex r4 P1）——
  //   persistProgress 受保护写只允许 status='running'；一旦 finalize 把 job 置 completed，再 reportProgress 必 0 行
  //   → 抛 FencedOutError → handler 无法返回 finalized:true → SSE done 退化为无 result/progress 的 fence-out 兜底。
  //   故在 job 仍 running 时上报最终 100%（含 finalProgress.done==total、五项子任务全完成、已浮现 items 不丢），
  //   再 finalize（complete job + 同事务 outbox）。finalize 之后【绝不再】调 ctx.reportProgress——
  //   done 帧由 runner 依据本 handler 返回的 finalProgress 发出（result + 完整 progress，非兜底）。
  await ctx.reportProgress({
    percent: 100,
    phrase: finalProgress.phrase,
    done: finalTotal,
    total: finalTotal,
    unit: '能力项',
    metrics: finalMetrics,
  });

  const finalized = await finalizeExtractJob({
    txPool,
    job,
    ctx,
    result,
    finalProgress,
    candidateCount,
  });

  if (!finalized) {
    // fence out（completeJobInTx 0 行）：交还 runner 据 fence 兜（不发 done(completed)）。
    return { result };
  }
  return { result, finalized: true, finalProgress };
}

/** session-mock 单项落库：候选已经命名，只做原子插入 candidate + 其唯一 session evidence。 */
async function emitSessionMockCandidate(
  deps: { db: Queryable; txPool: TxPool },
  job: LeasedJob,
  ctx: JobContext,
  snapshotId: string,
  cand: NamedCandidate,
  index: number,
  totalCandidates: number,
): Promise<{ item: CandidateItem; degradedNaming: boolean } | 'fenced_out' | null> {
  const { db, txPool } = deps;
  const stuckAt = `段 ${index + 1} / ${totalCandidates}`;

  let atomic: Awaited<ReturnType<typeof insertReadyCandidateWithEvidenceInTx>>;
  try {
    atomic = await withTransaction(txPool, (tx) =>
      insertReadyCandidateWithEvidenceInTx({
        tx,
        jobId: job.id,
        fenceToken: job.fenceToken,
        snapshotId,
        candidate: {
          slug: cand.slug,
          name: cand.name,
          intent: cand.intent,
          type: cand.type,
          confidence: cand.confidence,
          segmentCount: cand.segmentCount,
          frequencyRatio: cand.frequencyRatio,
          reusability: cand.reusability,
          scopeCoherence: cand.scopeCoherence,
          splitSuggested: cand.splitSuggested,
          scope: cand.scope,
          reusabilityBreakdown: cand.reusabilityBreakdown,
        },
        segmentIds: cand.segments.map((s) => s.segmentId),
      }),
    );
  } catch (err) {
    if (err instanceof CandidateLandingFencedOut) return 'fenced_out';
    return persistFailedCandidate(db, ctx, job, snapshotId, cand, stuckAt);
  }

  if (atomic.kind === 'skipped') {
    if (ctx.isCancelled()) return 'fenced_out';
    return null;
  }

  const item = toItem(
    atomic.candidateId,
    {
      name: cand.name,
      intent: cand.intent,
      type: cand.type,
      confidence: cand.confidence,
      segmentCount: atomic.written,
      scopeCoherence: cand.scopeCoherence,
      splitSuggested: cand.splitSuggested,
    },
    { status: 'ready', isNew: true },
  );
  await ctx.appendItem(item);
  return { item, degradedNaming: cand.degradedNaming };
}

/**
 * 浮现一个候选（命名 + 候选/证据/段数原子落库 + item-appended）。单候选成败隔离：
 *   - 命名 LLM 真抛 → 该候选标 failed（人话 error），返回 failed item，**不抛**（不阻塞其余，提取-17/29）。
 *   - 候选 + 证据 + segment_count 回填用【同一事务】原子包住（Codex#4）：任一失败则整单 ROLLBACK、**绝不 append 半残 ready**
 *     （留 ready 但 evidence 缺失 / segmentCount ≠ 下钻条数会破坏 B-22 血缘）。证据/回填异常 → 改落 failed item（人话 error）。
 *   - 候选 INSERT 0 行（fence out / (job,slug) 去重）→ fence out（取消）返回 'fenced_out'（调用方据此停）；去重 → 返回 null（静默跳过，计数不翻倍）。
 *   - 成功（事务提交）→ ready item（segmentCount == 实际写入证据数，提取-34）。
 */
async function _emitOneCandidate(
  deps: { db: Queryable; txPool: TxPool; gateway: LlmGatewayPort },
  job: LeasedJob,
  ctx: JobContext,
  snapshotId: string,
  cand: ScoredCandidate,
  index: number,
  totalCandidates: number,
): Promise<{ item: CandidateItem; degradedNaming: boolean } | 'fenced_out' | null> {
  const { db, txPool, gateway } = deps;
  // 人话错误副文「上游解析中断 · 段 X/Y」：X = 本候选序号（1-based），Y = 候选总数。
  const stuckAt = `段 ${index + 1} / ${totalCandidates}`;

  // ① 命名（LLM degraded 不抛、用兜底名；真抛 → 落失败候选）。
  let named;
  try {
    named = await nameOne(gateway, cand, {
      traceId: ctx.traceId,
      ...(job.ownerUserId ? { ownerUserId: job.ownerUserId } : {}),
    });
  } catch (err) {
    if (err instanceof CandidateNameUnavailable) return null;
    return persistFailedCandidate(db, ctx, job, snapshotId, cand, stuckAt);
  }

  // ② 候选 + 证据 + segment_count 回填【同一事务原子】（Codex#4：失败不留半残 ready）。
  let atomic: Awaited<ReturnType<typeof insertReadyCandidateWithEvidenceInTx>>;
  try {
    atomic = await withTransaction(txPool, (tx) =>
      insertReadyCandidateWithEvidenceInTx({
        tx,
        jobId: job.id,
        fenceToken: job.fenceToken,
        snapshotId,
        candidate: {
          slug: cand.slug,
          name: named.name,
          intent: named.intent,
          type: cand.type,
          confidence: cand.confidence,
          segmentCount: cand.segmentCount,
          frequencyRatio: cand.frequencyRatio,
          reusability: cand.reusability,
          scopeCoherence: cand.scopeCoherence,
          splitSuggested: cand.splitSuggested,
          scope: cand.scope,
          reusabilityBreakdown: cand.reusabilityBreakdown,
        },
        segmentIds: cand.segments.map((s) => s.segmentId),
      }),
    );
  } catch (err) {
    // fence out（事务开头 guard 或回填 0 行 → 哨兵 ROLLBACK，候选/证据全不落）→ 停在安全点，不改落 failed（Codex r2#1：
    //   半途换 fence 不是「这一项识别失败」，是被接管/取消——已浮现保留、不污染、不裸 failed）。
    if (err instanceof CandidateLandingFencedOut) return 'fenced_out';
    // 候选/证据/回填任一【真抛错】（复合 FK 违反/DB 异常/命名）→ 事务已 ROLLBACK（无半残 ready）→ 改落 failed item（人话 error）。
    return persistFailedCandidate(db, ctx, job, snapshotId, cand, stuckAt);
  }

  if (atomic.kind === 'skipped') {
    // 候选 INSERT 0 行：fence out（取消）→ 停；(job,slug) 去重 → 静默跳过（计数不翻倍，提取-32）。
    if (ctx.isCancelled()) return 'fenced_out';
    return null;
  }

  // ③ item-appended（'刚浮现'：isNew=true；segmentCount = 同事务实际写入证据数，与下钻一致，提取-34）。
  const item = toItem(
    atomic.candidateId,
    {
      name: named.name,
      intent: named.intent,
      type: cand.type,
      confidence: cand.confidence,
      segmentCount: atomic.written,
      scopeCoherence: cand.scopeCoherence,
      splitSuggested: cand.splitSuggested,
    },
    { status: 'ready', isNew: true },
  );
  await ctx.appendItem(item);
  return { item, degradedNaming: named.degradedNaming };
}

/** 落一个失败态候选（status=failed + 人话 error）+ item-appended，返回 failed item（不抛，不阻塞其余）。 */
async function persistFailedCandidate(
  db: Queryable,
  ctx: JobContext,
  job: LeasedJob,
  snapshotId: string,
  cand: ScoredCandidate,
  stuckAt: string,
): Promise<{ item: CandidateItem; degradedNaming: boolean } | 'fenced_out' | null> {
  // 人话错误副文（提取-17/18）：userMessage 唯一可展示，details.stuckAt 渲染「上游解析中断 · 段 X/Y」。
  const errEnvelope = buildError(ErrorCode.EXTRACT_UPSTREAM_TIMEOUT, ctx.traceId, {
    userMessage: '这一项没能识别出来，可点重试。',
    action: 'retry',
    retriable: true,
    details: { stuckAt },
  }).error;
  const fallbackName = cand.clusterLabel === '未命名工作流' ? '未命名能力' : cand.clusterLabel;

  let failedId: string | null = null;
  try {
    failedId = await insertFailedCandidateProtected(db, {
      jobId: job.id,
      fenceToken: job.fenceToken,
      snapshotId,
      slug: cand.slug,
      name: fallbackName,
      error: errEnvelope,
    });
  } catch {
    return null; // 落失败候选自身又失败：静默跳过（绝不阻塞整体）。
  }
  if (!failedId) return null; // fence out / 去重 → 跳过。

  const item: CandidateItem = {
    id: failedId,
    status: 'failed',
    isNew: true,
    name: fallbackName,
    error: errEnvelope,
  };
  await ctx.appendItem(item); // 失败行也走 item-appended（前端「! 名称 · 错误副文」失败行，提取-17/18）。
  return { item, degradedNaming: false }; // 失败候选无命名产物；degraded 仅统计 ready 候选的 LLM 降级。
}

// ===========================================================================
// 模式②：单候选重试（B-23，新 retry job + 新流）
// ===========================================================================
async function runRetry(
  deps: ExtractHandlerDeps,
  job: LeasedJob,
  ctx: JobContext,
  subject: ExtractSubjectRef,
): Promise<JobResult> {
  const { db, gateway, txPool } = deps;
  const candidateId = subject.candidateId;
  if (!candidateId) {
    throw codedError(ErrorCode.INTERNAL, 'retry subject_ref missing candidateId');
  }

  // retry 流也走子任务/进度（永不裸转圈，硬规则①）；轻量序：仅点 form/score/rank（已聚类，复用原段集）。
  await ctx.reportSubtask('form', 'running');
  await ctx.reportProgress({ percent: 20, phrase: '正在重新识别这一项…' });

  const existing = await readCandidateForOwner(db, candidateId, job.ownerUserId);
  if (!existing) {
    throw codedError(ErrorCode.NOT_FOUND, 'retry candidate not found / not owner');
  }
  const snapshotId = existing.snapshotId;

  // 复用原 snapshot 段集，重新聚类，定位「与本候选 slug 同簇」的那一簇（按 slug 匹配；找不到取最相近）。
  const segments = await readSnapshotSegments(db, snapshotId);
  const scored = scoreCandidates(clusterSegments(segments), Date.now());
  const target = pickTargetCluster(scored, existing.slug);
  await ctx.reportSubtask('form', 'done');
  await ctx.reportSubtask('score', 'done');

  if (!target) {
    // 段集变化导致无可重识别簇：再失败（人话 error，提取-20），不裸码。failed 回写 0 行 → fence-out 退出（不 append/不 finalize，Codex r2#2）。
    return failRetryAndFinalize(deps, job, ctx, candidateId, subject.escalate ?? false);
  }

  await ctx.reportSubtask('rank', 'running');

  // 命名（LLM）：degraded 用兜底名（不抛）；真抛 → 再失败（人话 error）。
  let named;
  try {
    named = await nameOne(gateway, target, {
      traceId: ctx.traceId,
      ...(job.ownerUserId ? { ownerUserId: job.ownerUserId } : {}),
    });
  } catch {
    // 命名 LLM 真抛 → 再失败（人话 error）。failed 回写 0 行 → fence-out 退出（不 append/不 finalize，Codex r2#2）。
    return failRetryAndFinalize(deps, job, ctx, candidateId, subject.escalate ?? false);
  }

  // 同事务：回写 ready + 删旧证据 + 重写证据 + 回填 segment_count（§5.2，受保护，fence 取自新 retry job）。
  let ok = false;
  let landingFencedOut = false; // 事务 guard/回填 0 行 → 哨兵（Codex r2#1）：当 fence-out 干净退出，不落 failed。
  try {
    ok = await withTransaction(txPool, async (tx) =>
      applyRetrySuccessInTx({
        tx,
        retryJobId: job.id,
        fenceToken: job.fenceToken,
        candidateId,
        snapshotId,
        segmentIds: target.segments.map((s) => s.segmentId),
        fields: {
          name: named.name,
          intent: named.intent,
          type: target.type,
          confidence: target.confidence,
          frequencyRatio: target.frequencyRatio,
          reusability: target.reusability,
          scopeCoherence: target.scopeCoherence,
          splitSuggested: target.splitSuggested,
          scope: target.scope,
          reusabilityBreakdown: target.reusabilityBreakdown,
        },
      }),
    );
  } catch (err) {
    ok = false;
    if (err instanceof CandidateLandingFencedOut) landingFencedOut = true;
  }

  await ctx.reportSubtask('rank', 'done');

  if (!ok) {
    // fence out（retry job 被取消/接管换 fence）→ 干净退出（不改证据/不改 count）；交还 runner 兜（不发 done completed，不发通知）。
    //   两种 fence-out 信号：① 哨兵 landingFencedOut（事务 guard/回填 0 行）② ctx.isCancelled()（命名后写库前换 fence）。
    if (landingFencedOut || ctx.isCancelled())
      return { result: { candidateId, status: 'fenced_out' } };
    // 非 fence-out 的失败（如段集异常/DB 真抛错）→ 再失败（人话 error）。failed 回写 0 行 → fence-out 退出（不 append/不 finalize，Codex r2#2）。
    return failRetryAndFinalize(deps, job, ctx, candidateId, subject.escalate ?? false);
  }

  // 重试成功回填帧（同 candidateId、status=ready；前端原地把失败行替换为正常卡，提取-19）。
  const item = toItem(
    candidateId,
    {
      name: named.name,
      intent: named.intent,
      type: target.type,
      confidence: target.confidence,
      segmentCount: target.segments.length,
      scopeCoherence: target.scopeCoherence,
      splitSuggested: target.splitSuggested,
    },
    { status: 'ready', isNew: false, error: null },
  );
  await ctx.appendItem(item);
  return finalizeRetry(txPool, job, ctx, { candidateId, status: 'ready' });
}

/**
 * retry job 同事务收尾（Codex#5）：retry 也是 jobs(type=extract)，完成口径与全量一致——
 *   同事务 complete job + notify.extract_completed outbox（candidateCount=1，本次重识别的单个候选）。
 *   fence out（completeJobInTx 0 行）→ 不 finalized（交还 runner 兜，不发 done/通知，连接续流）。
 *   单候选重试失败（candidate 标 failed）≠ retry job 失败：retry job 仍 completed（其工作=「重识别这一项」已做完）。
 */
async function finalizeRetry(
  txPool: TxPool,
  job: LeasedJob,
  ctx: JobContext,
  result: { candidateId: string; status: 'ready' | 'failed' },
): Promise<JobResult> {
  // retry 流轻量：五项子任务全标 done（form/score/rank 已点亮，analyze/cluster 复用原段集视作已完成），100% 收尾。
  const finalProgress: ProgressView = {
    percent: 100,
    phrase: result.status === 'ready' ? '已重新识别这一项' : '这一项仍未能识别',
    done: 1,
    total: 1,
    unit: '能力项',
    subtasks: SUBTASKS.map((s) => ({ ...s, status: 'done' as const })),
    slow: false,
  };
  // —— 进度收尾帧必须在 finalize（置 completed）【之前】发（Codex r4 P1，与全量同修）——
  //   finalize 后 status=completed，再 reportProgress 命中 persistProgress 的 status='running' 守门 0 行 → FencedOutError
  //   → done 退化为 fence-out 兜底。故 running 时先上报最终 100%（done==total、子任务全 done），再 finalize；
  //   finalize 之后绝不再 reportProgress——done 帧由 runner 依据返回的 finalProgress 发（含 result + 完整 progress）。
  await ctx.reportProgress({
    percent: 100,
    phrase: finalProgress.phrase,
    done: 1,
    total: 1,
    unit: '能力项',
  });
  const finalized = await finalizeExtractJob({
    txPool,
    job,
    ctx,
    result,
    finalProgress,
    candidateCount: 1,
  });
  if (!finalized) return { result }; // fence out：交还 runner 兜（不发 done completed）。
  return { result, finalized: true, finalProgress };
}

/**
 * 重试再失败：受保护回写 failed + 人话 error（达上限升 escalate，提取-20/§2.3）+ item-appended（Codex r2#2）。
 *   绝不吞掉 failed 回写失败：
 *     - applyRetryFailureProtected 返回 false（0 行 = fence out / retry job 被接管换 fence）→ 返回 'fenced_out'：
 *       不 appendItem(failed)、调用方不 finalize completed（DB 仍 generating 却显示 failed 会撕裂状态——交还 runner 兜）。
 *     - applyRetryFailureProtected 真抛（DB 异常）→ 上抛：runner 归一人话 + 走 failed/重试（绝不另起事务吞失败、绝不假 finalize）。
 *     - 仅真正写成 failed（1 行）→ appendItem(failed) + 返回 'failed'（调用方据此 finalize completed）。
 */
async function reportRetryFailed(
  db: Queryable,
  ctx: JobContext,
  job: LeasedJob,
  candidateId: string,
  escalate: boolean,
): Promise<'failed' | 'fenced_out'> {
  const errEnvelope = buildError(ErrorCode.EXTRACT_UPSTREAM_TIMEOUT, ctx.traceId, {
    userMessage: escalate
      ? '这一项多次没能识别出来，可反馈给我们。'
      : '这一项没能识别出来，可点重试。',
    action: escalate ? 'escalate' : 'retry',
    retriable: true,
  }).error;
  // DB 异常【不吞】：直接上抛（让 runner 走 failed/重试，绝不 append/假 finalize，Codex r2#2）。
  const wrote = await applyRetryFailureProtected(db, {
    retryJobId: job.id,
    fenceToken: job.fenceToken,
    candidateId,
    error: errEnvelope,
  });
  if (!wrote) {
    // 0 行 = fence out（retry job 被取消/接管换 fence）：DB 没写成 failed → 不 append、不 finalize（避免「DB generating / 流显示 failed」撕裂）。
    return 'fenced_out';
  }
  const item: CandidateItem = {
    id: candidateId,
    status: 'failed',
    isNew: false,
    name: null,
    error: errEnvelope,
  };
  await ctx.appendItem(item);
  return 'failed';
}

/**
 * 重试再失败收尾分发（Codex r2#2）：据 reportRetryFailed 结果决定 finalize 还是 fence-out 退出。
 *   - 'failed'（DB 真写成 failed + 已 append）→ finalizeRetry(completed)（retry job 工作做完，候选标 failed）。
 *   - 'fenced_out'（failed 回写 0 行）→ 不 append/不 finalize，返回 fenced_out result（交还 runner 兜）。
 */
async function failRetryAndFinalize(
  deps: ExtractHandlerDeps,
  job: LeasedJob,
  ctx: JobContext,
  candidateId: string,
  escalate: boolean,
): Promise<JobResult> {
  const outcome = await reportRetryFailed(deps.db, ctx, job, candidateId, escalate);
  if (outcome === 'fenced_out') {
    return { result: { candidateId, status: 'fenced_out' } };
  }
  return finalizeRetry(deps.txPool, job, ctx, { candidateId, status: 'failed' });
}

/** 重试时定位目标簇：优先 slug 完全相等；否则取段集最相近（reusability 最高）的一簇兜底。 */
function pickTargetCluster(scored: ScoredCandidate[], slug: string): ScoredCandidate | undefined {
  const exact = scored.find((c) => c.slug === slug);
  if (exact) return exact;
  // slug 带去重后缀（-2/-3）→ 取前缀匹配。
  const base = slug.replace(/-\d+$/, '');
  const prefixed = scored.find((c) => c.slug === base || c.slug.startsWith(`${base}-`));
  return prefixed ?? scored[0];
}

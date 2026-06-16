// 通用 Job 执行 runner（B-10/B-11/B-12）。一个 job 一次执行的完整生命周期。
//   领租约 → 构造 JobContext（受保护 fence CTE 持久化 + redis_hot 流推帧）→ 跑 handler（周期续期 + 超时 + 取消检查）
//   → 受保护落终态（completed/failed）→ 推 done/error 帧。
// 三条硬规则落地：
//   ① 永不裸转圈：handler 经 ctx.report* 推「进度+子任务+边生成边显示」，runner 兜 percent 单调护栏。
//   ② 绝不裸露错误码：handler 抛错经 normalizeToErrorBody 归一为人话 ErrorBody（禁堆栈），落库 + error/done 帧。
//   ③ 已生成不丢：progress（含 items）持续受保护持久化；fence 失配（取消/重入队）→ 0 行 → 干净退出、保留已生成。
// fence 铁律（脊柱 §6.2/§11.A）：任何写回带 fence；rowCount=0 是正常控制流（已被接管），不报错不重试。
import {
  buildErrorWithCode,
  ErrorCode,
  isTerminalJobStatus,
  type ErrorBody,
  type ErrorCodeValue,
  type ProgressView,
  type SubtaskStatus,
} from '@cb/shared';
import type { Logger } from 'pino';
import type {
  JobContext,
  JobEventBridge,
  JobHandler,
  LeasedJob,
  ProgressUpdate,
  Queryable,
} from './types.js';
import {
  claimLease,
  completeJob,
  failJob,
  normalizeProgress,
  persistProgress,
  readJobStatus,
  renewLease,
  DEFAULT_LEASE_TTL_MS,
} from './repo.js';

/** 被 fence out（取消/重入队接管）的内部信号。runner 据此干净退出本 attempt（不是错误，硬规则③）。 */
export class FencedOutError extends Error {
  constructor() {
    super('fenced out: job is no longer owned by this attempt');
    this.name = 'FencedOutError';
  }
}

/** runner 配置（超时分级/续期/取消轮询）。 */
export interface RunnerOptions {
  leaseTtlMs?: number;
  /** 续期间隔（默认租约的 1/3，确保不过期）。 */
  renewIntervalMs?: number;
  /** 任务超时（JOB_TIMEOUT，脊柱 §6 / LLM 分级 40/45/60/180s 由 handler 内控；此为整体兜底）。 */
  timeoutMs?: number;
  /** 取消轮询间隔（runner 周期查 status/fence；handler 也可 ctx.isCancelled）。 */
  cancelPollMs?: number;
  /** 慢任务阈值（超过未完成 → slow_hint，脊柱 §5.3）。0 = 关闭。 */
  slowAfterMs?: number;
  leaseOwner: string;
  traceId: string;
}

/** runner 执行结论（供 worker 日志/对账）。 */
export type RunOutcome =
  | { kind: 'completed'; jobId: string }
  | { kind: 'failed'; jobId: string; code: ErrorCodeValue }
  | { kind: 'fenced_out'; jobId: string } // 被取消/重入队接管，安全退出（非错误）
  | { kind: 'not_claimed'; jobId: string }; // 没抢到租约（别的活跃实例持有）

/** 把任意 handler 抛出的错误归一成人话 ErrorBody（禁堆栈/原始报错，脊柱 §3/§11.B）。 */
export function normalizeToErrorBody(
  err: unknown,
  traceId: string,
): { code: ErrorCodeValue; body: ErrorBody } {
  // handler 可抛 { code: ErrorCodeValue } 形态显式指定分类；否则按超时/取消/通用归类。
  let code: ErrorCodeValue = ErrorCode.INTERNAL;
  if (err && typeof err === 'object' && 'code' in err) {
    const c = (err as { code: unknown }).code;
    if (typeof c === 'string' && c in ErrorCode) code = c as ErrorCodeValue;
  }
  if (err instanceof JobTimeoutError) code = ErrorCode.JOB_TIMEOUT;
  const { code: internalCode, envelope } = buildErrorWithCode(code, traceId);
  return { code: internalCode, body: envelope.error };
}

/** 超时信号（runner 整体兜底超时）。 */
export class JobTimeoutError extends Error {
  constructor() {
    super('job timed out');
    this.name = 'JobTimeoutError';
  }
}

/**
 * 执行一个 job 的完整生命周期。worker 的 BullMQ processor 调它（每次 job 触发一次）。
 *   - 领不到租约（别的活跃实例持有，或已终态）→ not_claimed（BullMQ 视作成功完成，不重试触发）。
 *   - 领到 → 跑 handler；handler 内经 ctx 推进度（受保护持久化 + 推流）。
 *   - fence 失配（取消/重入队接管）任意时刻 → fenced_out，干净退出、已生成保留。
 *   - handler 抛错 → failed（归一人话 ErrorBody，落库 + error/done 帧）。
 */
export async function runJob(
  db: Queryable,
  bridge: JobEventBridge,
  handler: JobHandler,
  jobId: string,
  opts: RunnerOptions,
  logger?: Logger,
): Promise<RunOutcome> {
  const leaseTtlMs = opts.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
  const log = logger?.child({ jobId, traceId: opts.traceId, leaseOwner: opts.leaseOwner });

  const leased = await claimLease(db, jobId, opts.leaseOwner, leaseTtlMs);
  if (!leased) {
    log?.info('job not claimed (held by active lease or terminal)');
    return { kind: 'not_claimed', jobId };
  }

  const abort = new AbortController();
  let cancelled = false;

  // —— 周期续期 + 取消检测（脊柱 §6.2）——
  const renewMs = opts.renewIntervalMs ?? Math.max(1_000, Math.floor(leaseTtlMs / 3));
  const cancelPollMs = opts.cancelPollMs ?? renewMs;
  const lifecycle = setInterval(
    () => {
      void (async () => {
        const stillMine = await renewLease(db, jobId, leased.fenceToken, leaseTtlMs).catch(
          () => true,
        );
        // renew 0 行 = fence 失配（被取消/重入队接管）→ 标取消、触发 abort，handler 在安全点停。
        if (!stillMine) {
          cancelled = true;
          abort.abort();
        }
      })();
    },
    Math.min(renewMs, cancelPollMs),
  );
  if (typeof lifecycle.unref === 'function') lifecycle.unref();

  // —— 慢任务提示（slow_hint，脊柱 §5.3）——
  const startedAt = Date.now();
  let slowTimer: ReturnType<typeof setTimeout> | undefined;

  const ctx = makeContext({
    db,
    bridge,
    leased,
    traceId: opts.traceId,
    abort,
    isCancelled: () => cancelled,
  });

  if (opts.slowAfterMs && opts.slowAfterMs > 0) {
    slowTimer = setTimeout(() => {
      void ctx.emitSlowHint('这一步比平时久一点，正在继续处理…', Date.now() - startedAt);
    }, opts.slowAfterMs);
    if (typeof slowTimer.unref === 'function') slowTimer.unref();
  }

  try {
    const handlerPromise = handler.run(leased, ctx);
    const result = opts.timeoutMs
      ? await withTimeout(handlerPromise, opts.timeoutMs, abort)
      : await handlerPromise;

    // handler 已自行在同事务把「最终业务状态 + job 结果 + outbox」原子提交（Codex P0-3）：
    //   runner 不再二次落终态，仅发 done 帧。done 用 handler 落的 finalProgress（缺则 ctx 累积镜像）。
    if (result.finalized) {
      const doneProgress = result.finalProgress ?? completedProgress(ctx.currentProgress());
      await bridge.publish(jobId, {
        event: 'done',
        payload: { status: 'completed', result: result.result ?? null, progress: doneProgress },
      });
      log?.info('job completed (finalized in-handler, same-tx outbox)');
      return { kind: 'completed', jobId };
    }

    // handler 完成：受保护落 completed（fence 守门）。
    // 用 ctx 的【最新累积 progress 镜像】（含 makeContext 内 report* 累积并已持久化的 items/subtasks/done/total），
    //   不是 leased.progress（领取时的旧快照）——否则会把已生成明细覆盖回旧值、只剩 percent=100（违反「已生成不丢」，Codex P1-new）。
    const finalProgress = completedProgress(ctx.currentProgress());
    const ok = await completeJob(
      db,
      jobId,
      leased.fenceToken,
      result.result ?? null,
      finalProgress,
    );
    if (!ok) {
      // fence 失配：被取消 或 被 sweeper 重入队接管，不覆盖。已生成产物保留（硬规则③）。
      log?.info('completion fenced out; left for new attempt');
      await publishFenceOutTerminal(db, bridge, jobId, log);
      return { kind: 'fenced_out', jobId };
    }
    await bridge.publish(jobId, {
      event: 'done',
      payload: { status: 'completed', result: result.result ?? null },
    });
    log?.info('job completed');
    return { kind: 'completed', jobId };
  } catch (err) {
    if (err instanceof FencedOutError || cancelled) {
      // 取消/接管：不写 failed（已是 cancelled 或将被新 attempt 接管）；已生成保留。
      log?.info({ err: String(err) }, 'job fenced out / cancelled mid-run; safe exit');
      await publishFenceOutTerminal(db, bridge, jobId, log);
      return { kind: 'fenced_out', jobId };
    }
    // 业务/超时失败：归一人话 ErrorBody（禁堆栈），受保护落 failed + 推 error/done 帧。
    const { code, body } = normalizeToErrorBody(err, opts.traceId);
    log?.error({ code, err }, 'job failed');
    const wrote = await failJob(db, jobId, leased.fenceToken, body);
    if (!wrote) {
      // 落 failed 时也被 fence out（极少：失败瞬间被取消 或 被重入队接管）→ 安全退出，不强写。
      await publishFenceOutTerminal(db, bridge, jobId, log);
      return { kind: 'fenced_out', jobId };
    }
    // error 帧 = 完整对外 ErrorEnvelope（脊柱 §5.3 / Codex#2）；done 帧也带它。
    await bridge.publish(jobId, { event: 'error', payload: { error: body } });
    await bridge.publish(jobId, {
      event: 'done',
      payload: { status: 'failed', error: { error: body } },
    });
    return { kind: 'failed', jobId, code };
  } finally {
    clearInterval(lifecycle);
    if (slowTimer) clearTimeout(slowTimer);
  }
}

/**
 * fence-out 后的终态推帧决策（Codex P1-4）。
 *   被 fence out 有两种来源，必须区分，否则前端误判：
 *     ① 真取消（status='cancelled'）：发 done(cancelled) 终态 → 前端关流（正确）。
 *     ② sweeper 重入队接管（status='running'，fence 已换，新 attempt 将续跑）：
 *        **不发终态** → 在线连接不关流、保留已生成、继续收新 attempt 的实时帧（硬规则①③）。
 *        旧实现对任意 fence-out 都发 done(cancelled)，会让接管场景下前端误以为取消并关流 —— 即本次修复点。
 *     ③ 已被别的 attempt 落 completed/failed：理论上罕见（同一 job 不会两 attempt 同时跑到终态），
 *        但若发生，照真状态发对应 done 终态（不强行 cancelled）。
 *   状态读不到（job 不存在等极端）→ 保守不发终态（宁可不关流靠 heartbeat/重连，也不误报取消）。
 */
async function publishFenceOutTerminal(
  db: Queryable,
  bridge: JobEventBridge,
  jobId: string,
  log?: Logger,
): Promise<void> {
  const status = await readJobStatus(db, jobId).catch(() => undefined);
  if (status === 'cancelled') {
    await bridge.publish(jobId, { event: 'done', payload: { status: 'cancelled' } });
    return;
  }
  if (status === 'completed' || status === 'failed') {
    // 别的 attempt 已落终态：照真状态发 done（不臆造 cancelled）。error 由那个 attempt 已推过。
    await bridge.publish(jobId, { event: 'done', payload: { status } });
    return;
  }
  // status='running'（重入队接管）/ queued / 读不到 → 不发终态，连接续流等新 attempt（不误报取消）。
  log?.info(
    { status },
    'fenced out by handoff (not cancelled); no terminal frame, stream stays open',
  );
}

/** completed 时把 progress 拉满（percent=100，子任务全 done），保留已生成 items（硬规则③）。 */
function completedProgress(prev: ProgressView): ProgressView {
  return {
    ...prev,
    percent: 100,
    phrase: prev.phrase && prev.percent >= 100 ? prev.phrase : '已完成',
    subtasks: prev.subtasks.map((s) => ({ ...s, status: 'done' as SubtaskStatus })),
    slow: false,
  };
}

interface MakeContextArgs {
  db: Queryable;
  bridge: JobEventBridge;
  leased: LeasedJob;
  traceId: string;
  abort: AbortController;
  isCancelled: () => boolean;
}

/** runner 内部用的 ctx：JobContext + 当前累积 progress 镜像 getter（落终态用最新镜像，Codex P1-new）。 */
type RunnerContext = JobContext & {
  /** 返回当前累积 progress 镜像（含 report* 累积的 items/subtasks/done/total）。落 completed 终态用它而非领取旧快照。 */
  currentProgress: () => ProgressView;
};

/**
 * 构造 JobContext：把 report* 同时落「受保护持久化（fence CTE）」+「推流（XADD 帧）」。
 *   维护本地 progress 镜像（percent 单调护栏 + 子任务/items 累积），每次 report 先更新镜像、受保护持久化、再推增量帧。
 *   持久化 0 行（fence 失配）→ 抛 FencedOutError，runner catch 后干净退出（已生成保留）。
 *   额外暴露 currentProgress()（runner 落 completed 终态用最新累积镜像，不覆盖回领取旧快照，Codex P1-new）。
 */
function makeContext(args: MakeContextArgs): RunnerContext {
  const { db, bridge, leased, traceId, abort, isCancelled } = args;
  // 本地 progress 镜像：从已落 progress 起步（断点续传），report 累积更新。
  const progress: ProgressView = normalizeProgress(leased.progress);

  async function persist(): Promise<void> {
    const ok = await persistProgress(db, leased.id, leased.fenceToken, progress);
    if (!ok) throw new FencedOutError(); // fence 失配：已被接管，停下（runner 兜已生成保留）。
  }

  return {
    jobId: leased.id,
    // 最新累积 progress 镜像（runner 内部用）：浅拷贝防外部改动镜像。
    currentProgress: (): ProgressView => ({
      ...progress,
      subtasks: progress.subtasks.map((s) => ({ ...s })),
      ...(Array.isArray(progress.items) ? { items: [...progress.items] } : {}),
    }),
    traceId,
    fenceToken: leased.fenceToken,
    attemptNo: leased.attemptNo,
    signal: abort.signal,
    isCancelled,

    async reportProgress(update: ProgressUpdate): Promise<void> {
      // percent 单调护栏（脊柱 §7：不倒退）。
      progress.percent = Math.max(progress.percent, clampPct(update.percent));
      progress.phrase = update.phrase;
      if (update.done !== undefined) progress.done = update.done;
      if (update.total !== undefined) progress.total = update.total;
      if (update.unit !== undefined) progress.unit = update.unit;
      if (update.slow !== undefined) progress.slow = update.slow;
      await persist();
      await bridge.publish(leased.id, {
        event: 'progress',
        payload: {
          percent: progress.percent,
          phrase: progress.phrase,
          ...(progress.done !== undefined ? { done: progress.done } : {}),
          ...(progress.total !== undefined ? { total: progress.total } : {}),
          ...(progress.unit !== undefined ? { unit: progress.unit } : {}),
        },
      });
    },

    async reportSubtask(key: string, status: SubtaskStatus, label?: string): Promise<void> {
      const existing = progress.subtasks.find((s) => s.key === key);
      if (existing) {
        existing.status = status;
        if (label) existing.label = label;
      } else {
        progress.subtasks.push({ key, label: label ?? key, status });
      }
      await persist();
      await bridge.publish(leased.id, { event: 'subtask', payload: { key, status } });
    },

    async appendItem(item: unknown): Promise<void> {
      // 边生成边显示：累积进 progress.items（已生成不丢，硬规则③）+ 推 item-appended 帧。
      // progress.items 仍存【裸 item】（state_snapshot.progress.items[] 直接是 CandidateItem 列表，30 §3.2）；
      //   但 SSE item-appended 帧 payload 契约形态为 `{ item: CandidateItem }`（30 §3.1/§3.4，前端按 data.item 分发）。
      if (!Array.isArray(progress.items)) progress.items = [];
      progress.items.push(item);
      await persist();
      await bridge.publish(leased.id, { event: 'item-appended', payload: { item } });
    },

    async emitField(event, payload): Promise<void> {
      // 字段流是纯增量帧（结构化 structure_state 由 40 域 worker 受保护写、不入 jobs.progress）。
      await bridge.publish(leased.id, { event, payload });
    },

    async emitSlowHint(phrase: string, elapsedMs: number): Promise<void> {
      progress.slow = true;
      // slow_hint 不强制持久化整 progress（避免与并发 report 抢写），仅标记 + 推帧。
      await bridge.publish(leased.id, { event: 'slow_hint', payload: { phrase, elapsedMs } });
    },
  };
}

function clampPct(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.min(100, Math.max(0, n));
}

/** 给 handler promise 套整体超时 + 触发 abort（handler 内 IO 可据 signal 尽早停）。 */
function withTimeout<T>(p: Promise<T>, ms: number, abort: AbortController): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => {
      abort.abort();
      reject(new JobTimeoutError());
    }, ms);
    if (typeof t.unref === 'function') t.unref();
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/** 守门：runner 不接管终态 job（防对终态 job 误启 attempt）。供 worker 入口/测试用。 */
export function isRunnableStatus(status: string): boolean {
  return !isTerminalJobStatus(status as never);
}

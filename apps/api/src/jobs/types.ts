// 任务执行运行时类型（B-10/B-11/B-12 执行层）。
//   - Queryable：pg.Pool/PoolClient 的最小子集（query 返回 { rows, rowCount }），便于单测 mock，无真 PG。
//   - JobHandler：各 STEP 具体 handler 的抽象（import/extract/structure/publish_batch 在 3B-3E 注册）。
//   - JobContext：runner 注入给 handler 的能力（推进度/子任务/边生成边显示项/字段流 + 取消检查 + traceId）。
//   写库铁律：所有对 jobs 及产物的写入走受保护 fence CTE（脊柱 §11.A），由 jobs/repo.ts 封装、handler 不裸写。
import type { JobType, JobStatus, ProgressView, SubtaskStatus, SSEEventType } from '@cb/shared';

/** pg.Pool / PoolClient 的最小查询面（单测可 mock，不依赖真 PG）。 */
export interface QueryResultLike<R = Record<string, unknown>> {
  rows: R[];
  rowCount: number | null;
}
export interface Queryable {
  query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResultLike<R>>;
}

/** 事件桥：worker 产出的帧经此进 redis_hot Streams（→ api SSE 端点下发，脊柱 §5/§11.D 流类型）。 */
export interface JobEventBridge {
  /** XADD 一帧到 job 流，返回 entry id（= SSE id，Last-Event-ID 续传用，70 §8.1）。失败不抛（尽力而为）。 */
  publish(jobId: string, frame: { event: SSEEventType; payload: unknown }): Promise<string | null>;
}

/** jobs 行（runner/repo 关心的列；与脊柱 §6.3 DDL 对齐）。 */
export interface JobRow {
  id: string;
  type: JobType;
  status: JobStatus;
  owner_user_id: string;
  subject_ref: unknown;
  progress: Partial<ProgressView> | null;
  attempt_no: number;
  fence_token: number;
}

/** 领取租约成功后交给 runner 的执行上下文核心标识（fence 是受保护写入的唯一令牌）。 */
export interface LeasedJob {
  id: string;
  type: JobType;
  ownerUserId: string;
  subjectRef: unknown;
  attemptNo: number;
  /** 本次执行持有的 fence_token；所有写回必带它（fence 不匹配 = 已被接管，0 行安全退出）。 */
  fenceToken: number;
  /** 续期前的已落 progress（断点续传：handler 据此从精确断点继续，已生成不丢，硬规则③）。 */
  progress: ProgressView;
}

/** handler 推进度的入参（量化文案 + 可选分子分母 + 单调 percent，脊柱 §7）。 */
export interface ProgressUpdate {
  percent: number;
  phrase: string;
  done?: number;
  total?: number;
  unit?: string;
  slow?: boolean;
}

/**
 * runner 注入给 handler 的运行时能力（永不裸转圈：handler 必须经此推进度/子任务/边生成边显示）。
 * 所有 report* 都做两件事：① 受保护 fence CTE 持久化进 jobs.progress（state_snapshot 真源、可恢复）；
 *                          ② XADD 增量帧到 redis_hot 流（在线页面即时收到，脊柱 §5）。
 * fence 失配（被 sweeper 重入队/取消）时持久化 0 行 → 抛 FencedOutError，runner 据此安全退出本 attempt。
 */
export interface JobContext {
  readonly jobId: string;
  readonly traceId: string;
  readonly fenceToken: number;
  readonly attemptNo: number;
  /** 总进度（脊柱 §7：percent 单调不倒退由 runner 兜底护栏）。 */
  reportProgress(update: ProgressUpdate): Promise<void>;
  /** 子任务点亮（脊柱 §7 标准序，按 key 改状态）。 */
  reportSubtask(key: string, status: SubtaskStatus, label?: string): Promise<void>;
  /** 边生成边显示：追加一项已生成摘要（候选/段/批量 item，硬规则③已生成不丢）。 */
  appendItem(item: unknown): Promise<void>;
  /**
   * 结构化字段流（field_start/field_delta/field_done/field_stuck + 数组逐项 item-appended + 字段级 error，脊柱 §5.3 / 40 §3.2/§3.4）。
   *   仅增量帧、不入 jobs.progress（结构化 structure_state 由 40 域 worker 受保护写、断点续传真源）。
   *   - item-appended：结构化 payload 为 `{ field, itemIndex, value }`（数组字段逐条浮现，40 §3.2）——
   *     与提取域 ctx.appendItem 的 `{ item }` 形态不同，故结构化数组项走本通道、不走 appendItem。
   *   - error：单【软】字段两次重试仍失败的【字段级】错误帧（payload = 完整对外 ErrorEnvelope，40 §3.4）。
   *     这与 runner 在 job 终止时发的 error/done【整 job 终态】帧不同——字段级失败后 job 仍可 completed，
   *     前端按 structure_state[field].status='failed' 渲染错误态 + 退路（§3.4，不整 job 转 failed）。
   */
  emitField(
    event: 'field_start' | 'field_delta' | 'field_done' | 'field_stuck' | 'item-appended' | 'error',
    payload: unknown,
  ): Promise<void>;
  /** 慢任务提示（slow_hint 帧，脊柱 §5.3）。 */
  emitSlowHint(phrase: string, elapsedMs: number): Promise<void>;
  /** 取消/被接管检查：handler 在安全点轮询；true = 应尽快停（已生成部分由 fence CTE 保留）。 */
  isCancelled(): boolean;
  /** 取消信号（AbortSignal，handler 可传给 LLM/IO 以尽早中断）。 */
  readonly signal: AbortSignal;
}

/** handler 执行结果（成功产物引用，落 jobs.result）。 */
export interface JobResult {
  result?: unknown;
  /**
   * handler 已在【自己的事务内】把「最终业务状态 + job 结果 + outbox」一并提交完成（Codex P0-3 同事务 outbox）。
   *   true → runner 不再调 completeJob（避免二次落终态）；仅发 done 帧。导入 handler 用它把
   *   completeJob + emitInTx 同一 PG 事务原子提交（成功整体成功、失败整体失败/重试，绝不另起事务吞失败）。
   *   未设/false → 旧路径：runner 负责受保护 completeJob（其它无同事务 outbox 需求的 handler 不受影响）。
   */
  finalized?: boolean;
  /** finalized 为 true 时 handler 落库的最终 progress（runner 据此发 done 帧；缺则用 ctx 累积镜像）。 */
  finalProgress?: ProgressView;
}

/**
 * Job 执行框架抽象（B-10）。各 STEP 的具体 handler（import/extract/structure/publish_batch）实现它，
 * 在 3B-3E 经 registry 注册。runner 负责生命周期/进度上报通道/错误归一/已生成不丢，handler 只写业务逻辑。
 */
export interface JobHandler {
  readonly type: JobType;
  /** 执行：用 ctx 推进度、产出产物（受保护写入由 ctx/repo 兜 fence）；返回结果引用或抛业务错误。 */
  run(job: LeasedJob, ctx: JobContext): Promise<JobResult>;
}

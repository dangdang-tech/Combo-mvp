// jobs 状态机 + JobView（脊柱 §6 / §9）。PG jobs 表是状态唯一真源，BullMQ 只触发。
import { z } from 'zod';
import { IdSchema, IsoDateTimeSchema } from './ids.js';
import { ErrorBodySchema } from './errors.js';
import { ProgressViewSchema } from './progress.js';

/** 任务类型。后两类（evaluate/runtime_gen）本期 schema 冻结、不注册 processor（脊柱 §6.3）。
 *  publish_batch 已随批量发布功能整体移除（2026-07-04，发布入口占位待 Task 重构）。 */
export const JobTypeSchema = z.enum(['import', 'extract', 'structure', 'evaluate', 'runtime_gen']);
export type JobType = z.infer<typeof JobTypeSchema>;

/** 本期实际注册 processor 的三类（脊柱 §6.3）。 */
export const ACTIVE_JOB_TYPES = ['import', 'extract', 'structure'] as const;

/**
 * BullMQ 队列命名空间前缀（生产端 Queue 与消费端 Worker 必须用同一值，否则 job 入队但 worker 收不到）。
 *   ⚠️ 队列名本身禁止含 ':'（BullMQ 用 ':' 做 Redis key 分隔，queue-base 会校验抛错）。
 *   故命名空间走 BullMQ 的 `prefix` 选项，队列名只留 jobType；Redis key 仍是 `cb:<jobType>:...`。
 *   抽成共享常量供生产端/消费端共同引用，杜绝前缀漂移。
 */
export const QUEUE_PREFIX = 'cb' as const;

/** 任务状态机（脊柱 §6.1）。running→completed/failed/cancelled 为终态、不可逆。 */
export const JobStatusSchema = z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']);
export type JobStatus = z.infer<typeof JobStatusSchema>;

/** 终态集合（脊柱 §6.1）。 */
export const TERMINAL_JOB_STATUSES = ['completed', 'failed', 'cancelled'] as const;
export function isTerminalJobStatus(s: JobStatus): boolean {
  return (TERMINAL_JOB_STATUSES as readonly string[]).includes(s);
}

export const JobViewSchema = z.object({
  id: IdSchema,
  type: JobTypeSchema,
  status: JobStatusSchema,
  progress: ProgressViewSchema,
  result: z.unknown().optional(),
  /** 失败时人话错误（非堆栈），= ErrorEnvelope['error']。 */
  error: ErrorBodySchema.optional(),
  attemptNo: z.number().int(),
  createdAt: IsoDateTimeSchema,
  startedAt: IsoDateTimeSchema.optional(),
  finishedAt: IsoDateTimeSchema.optional(),
});
export type JobView = z.infer<typeof JobViewSchema>;

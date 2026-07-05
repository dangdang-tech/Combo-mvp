// SSE 帧协议：任务进度流的线上格式，「永不裸转圈」的机制保证。
// 连接首帧发 state_snapshot 全量，之后增量 progress / item-appended，终止只发一次 done。
import { z } from 'zod';
import { ProgressViewSchema } from './progress.js';
import { ErrorEnvelopeSchema } from './errors.js';

/** SSE event 类型。item-appended 用于「边提取边显示」逐个推出能力项摘要。 */
export const SSEEventTypeSchema = z.enum([
  'state_snapshot',
  'progress',
  'item-appended',
  'slow_hint',
  'error',
  'done',
  'heartbeat',
]);
export type SSEEventType = z.infer<typeof SSEEventTypeSchema>;

export const SSE_EVENT_TYPES = SSEEventTypeSchema.options;

/** 单帧形态：id 供断线重连（Last-Event-ID）；payload 进 data: 字段。 */
export interface SSEFrame<P = unknown> {
  id: string;
  event: SSEEventType;
  payload: P;
}

/** state_snapshot：连接首帧 / 重连超窗时的全量进度。 */
export const StateSnapshotPayloadSchema = z.object({
  progress: ProgressViewSchema,
});
export type StateSnapshotPayload = z.infer<typeof StateSnapshotPayloadSchema>;

export const ProgressPayloadSchema = z.object({
  percent: z.number().min(0).max(100),
  phrase: z.string(),
  done: z.number().int().optional(),
  total: z.number().int().optional(),
  unit: z.string().optional(),
});
export type ProgressPayload = z.infer<typeof ProgressPayloadSchema>;

export const SlowHintPayloadSchema = z.object({
  phrase: z.string(),
  elapsedMs: z.number().int(),
});
export type SlowHintPayload = z.infer<typeof SlowHintPayloadSchema>;

/** error 帧 payload：完整对外 ErrorEnvelope，与非 2xx HTTP body 同形态，前端一处解包通吃。 */
export const ErrorFramePayloadSchema = ErrorEnvelopeSchema;
export type ErrorFramePayload = z.infer<typeof ErrorFramePayloadSchema>;

/** done 帧：任务终止统一终止帧。失败时 error 携完整对外信封。 */
export const DonePayloadSchema = z.object({
  status: z.enum(['succeeded', 'failed']),
  result: z.unknown().optional(),
  error: ErrorEnvelopeSchema.optional(),
});
export type DonePayload = z.infer<typeof DonePayloadSchema>;

export const HeartbeatPayloadSchema = z.object({ ts: z.number().int() });
export type HeartbeatPayload = z.infer<typeof HeartbeatPayloadSchema>;

/** SSE 默认心跳间隔（毫秒）。 */
export const SSE_HEARTBEAT_INTERVAL_MS = 15_000;

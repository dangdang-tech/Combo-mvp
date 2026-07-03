// SSE 帧协议（脊柱 §5）：永不裸转圈的核心机制。12 帧 + 三型 state_snapshot。
import { z } from 'zod';
import { JobStatusSchema } from './jobs.js';
import { ProgressMetricsSchema, ProgressViewSchema } from './progress.js';
import { StructureStateSchema } from './structure-state.js';
import { ErrorEnvelopeSchema } from './errors.js';

/** 12 个 SSE event 类型（脊柱 §5.3）。item-appended 用连字符；field_* 用下划线。 */
export const SSEEventTypeSchema = z.enum([
  'state_snapshot',
  'progress',
  'subtask',
  'item-appended',
  'field_start',
  'field_delta',
  'field_done',
  'field_stuck',
  'slow_hint',
  'error',
  'done',
  'heartbeat',
]);
export type SSEEventType = z.infer<typeof SSEEventTypeSchema>;

/** 全部 12 帧类型常量数组（供守门/校验「无新增帧」）。 */
export const SSE_EVENT_TYPES = SSEEventTypeSchema.options;

/** SSE 流类型三型（脊柱 §9）。session = Runtime 预留（B-40），本期无可调用端点。 */
export const SSEStreamKindSchema = z.enum(['job', 'structure', 'session']);
export type SSEStreamKind = z.infer<typeof SSEStreamKindSchema>;

/** 单帧形态：id = Redis Stream entry id（Last-Event-ID 用）；payload 进 data: 字段。 */
export const SSEFrameSchema = z.object({
  id: z.string(),
  event: SSEEventTypeSchema,
  payload: z.unknown(),
});
export interface SSEFrame<P = unknown> {
  id: string;
  event: SSEEventType;
  payload: P;
}

/** state_snapshot 三型全量（脊柱 §5.2）。连接首帧 / 重连超窗。 */
export const StateSnapshotPayloadSchema = z.object({
  kind: SSEStreamKindSchema,
  progress: ProgressViewSchema.optional().describe('kind=job'),
  structureState: StructureStateSchema.optional().describe('kind=structure'),
});
export type StateSnapshotPayload = z.infer<typeof StateSnapshotPayloadSchema>;

/** progress 帧 payload（脊柱 §5.3）。 */
export const ProgressPayloadSchema = z.object({
  percent: z.number().min(0).max(100),
  phrase: z.string(),
  done: z.number().int().optional(),
  total: z.number().int().optional(),
  unit: z.string().optional(),
  metrics: ProgressMetricsSchema.optional(),
});
export type ProgressPayload = z.infer<typeof ProgressPayloadSchema>;

/** field_stuck 帧 payload（脊柱 §5.3）：卡住三退路。 */
export const FieldStuckPayloadSchema = z.object({
  field: z.string(),
  elapsedMs: z.number().int(),
  options: z.array(z.enum(['continue', 'regen', 'wait'])),
});
export type FieldStuckPayload = z.infer<typeof FieldStuckPayloadSchema>;

/** slow_hint 帧 payload（脊柱 §5.3）。 */
export const SlowHintPayloadSchema = z.object({
  phrase: z.string(),
  elapsedMs: z.number().int(),
});
export type SlowHintPayload = z.infer<typeof SlowHintPayloadSchema>;

/**
 * error 帧 payload（脊柱 §5.3 / Codex#2）：**完整对外 ErrorEnvelope**（`{ error: {...} }`），
 * 不是裸 ErrorBody —— 与非 2xx HTTP body 同形态，前端一处解包逻辑通吃 HTTP/SSE 失败（D1：不含 code）。
 */
export const ErrorFramePayloadSchema = ErrorEnvelopeSchema;
export type ErrorFramePayload = z.infer<typeof ErrorFramePayloadSchema>;

/**
 * done 帧 payload（脊柱 §5.3）：任务终止统一终止帧。
 * 失败时 `error` 携**完整对外 ErrorEnvelope**（与 error 帧同形态，Codex#2），不含 code（D1）。
 */
export const DonePayloadSchema = z.object({
  status: JobStatusSchema,
  result: z.unknown().optional(),
  error: ErrorEnvelopeSchema.optional(),
});
export type DonePayload = z.infer<typeof DonePayloadSchema>;

/** heartbeat 帧 payload（脊柱 §5.5，默认 15s）。 */
export const HeartbeatPayloadSchema = z.object({ ts: z.number().int() });
export type HeartbeatPayload = z.infer<typeof HeartbeatPayloadSchema>;

/** SSE 默认心跳间隔（毫秒，脊柱 §5.5）。 */
export const SSE_HEARTBEAT_INTERVAL_MS = 15_000;

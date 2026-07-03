// 70 · 事件 / 基础设施域（B-13~B-16/B-35）。import 脊柱 §9，不重定义。
import { z } from 'zod';
import { IdSchema, SlugSchema, IsoDateTimeSchema, TraceIdSchema } from '../core/ids.js';
import { PageQuerySchema } from '../core/pagination.js';

// ---------- outbox / topic ----------
export const OutboxTopicSchema = z.enum([
  'capability.published',
  'capability.unpublished',
  'notify.import_completed',
  'notify.extract_completed',
  'notify.publish_completed',
  'notify.review_decided',
  'usage.metering', // B-36 冻结，本期不产生
  'runtime.session_event', // B-40 冻结，本期不产生
]);
export type OutboxTopic = z.infer<typeof OutboxTopicSchema>;

export const TopicClassSchema = z.enum(['lifecycle', 'notify', 'metering', 'runtime']);
export type TopicClass = z.infer<typeof TopicClassSchema>;

/** 本期实际产生的 topic（脊柱 §7：仅 capability.* 与 notify.*）。 */
export const ACTIVE_OUTBOX_TOPICS: OutboxTopic[] = [
  'capability.published',
  'capability.unpublished',
  'notify.import_completed',
  'notify.extract_completed',
  'notify.publish_completed',
  'notify.review_decided',
];

/** topic → class 映射（70 §1）。 */
export const TOPIC_CLASS: Record<OutboxTopic, TopicClass> = {
  'capability.published': 'lifecycle',
  'capability.unpublished': 'lifecycle',
  'notify.import_completed': 'notify',
  'notify.extract_completed': 'notify',
  'notify.publish_completed': 'notify',
  'notify.review_decided': 'notify',
  'usage.metering': 'metering',
  'runtime.session_event': 'runtime',
};

export const OutboxEventSchema = z.object({
  id: IdSchema,
  seq: z.number().int(),
  eventId: z.string().describe('业务幂等键'),
  topic: OutboxTopicSchema,
  aggregateId: IdSchema,
  payload: z.unknown(),
  traceId: TraceIdSchema.optional(),
  createdAt: IsoDateTimeSchema,
});
export interface OutboxEvent<P = unknown> {
  id: string;
  seq: number;
  eventId: string;
  topic: OutboxTopic;
  aggregateId: string;
  payload: P;
  traceId?: string;
  createdAt: string;
}

// ---------- consumer / dead_events ----------
/**
 * MarketplaceProjection 合并流的单 cursor key（P0-2）：lifecycle 的 capability.published/unpublished
 * 共用这【一行】cursor，按合并 seq 单调推进保上架/下架严格全局顺序，故 cursor.topic 列写的是
 * 合并字面量 `capability.*`（不是任一真实 OutboxTopic）。registry.ts 的 MARKETPLACE_LIFECYCLE_CURSOR_TOPIC
 * 与本字面量一致（同一真源）。
 */
export const MERGED_LIFECYCLE_CURSOR_TOPIC = 'capability.*' as const;

/**
 * consumer_cursors.topic 列的合法取值（P1 修复）：notify 子 topic 用真实 OutboxTopic、各拆一行游标；
 * lifecycle 合并流用合并字面量 `capability.*` 共用一行游标（P0-2）。schema 因此须容纳合并 key，
 * 否则与运行时写入的 cursor topic 冲突。
 */
export const ConsumerCursorTopicSchema = OutboxTopicSchema.or(
  z.literal(MERGED_LIFECYCLE_CURSOR_TOPIC),
);
export type ConsumerCursorTopic = z.infer<typeof ConsumerCursorTopicSchema>;

export const ConsumerCursorSchema = z.object({
  consumerName: z.string(),
  topic: ConsumerCursorTopicSchema,
  lastSeq: z.number().int(),
  lastEventId: z.string().optional(),
  updatedAt: IsoDateTimeSchema,
});
export type ConsumerCursor = z.infer<typeof ConsumerCursorSchema>;

export const DeadEventStatusSchema = z.enum(['dead', 'retrying', 'resolved']);
export type DeadEventStatus = z.infer<typeof DeadEventStatusSchema>;

export const DeadEventSchema = z.object({
  id: IdSchema,
  consumerName: z.string(),
  topic: OutboxTopicSchema,
  eventId: z.string(),
  outboxSeq: z.number().int(),
  attempts: z.number().int(),
  status: DeadEventStatusSchema,
  nextRetryAt: IsoDateTimeSchema.optional(),
  createdAt: IsoDateTimeSchema,
  resolvedAt: IsoDateTimeSchema.optional(),
});
export type DeadEvent = z.infer<typeof DeadEventSchema>;

// ---------- 通知（B-35）----------
export const NotificationKindSchema = z.enum([
  'import_completed',
  'extract_completed',
  'publish_completed',
  'review_decided',
]);
export type NotificationKind = z.infer<typeof NotificationKindSchema>;

export const NotificationChannelSchema = z.enum(['inapp', 'lark', 'email']);
export type NotificationChannel = z.infer<typeof NotificationChannelSchema>;

export const NotificationViewSchema = z.object({
  id: IdSchema,
  kind: NotificationKindSchema,
  title: z.string().describe('人话（禁错误码/堆栈）'),
  body: z.string().optional(),
  link: z.string().optional().describe('把人带回完成态'),
  readAt: IsoDateTimeSchema.nullable().optional(),
  createdAt: IsoDateTimeSchema,
});
export type NotificationView = z.infer<typeof NotificationViewSchema>;

export const NotificationsListQuerySchema = PageQuerySchema.extend({
  filter: z.enum(['unread', 'all']).optional().describe('默认 all'),
});
export type NotificationsListQuery = z.infer<typeof NotificationsListQuerySchema>;

// ---------- outbox payload schema（70 §7）----------
export const CapabilityPublishedPayloadSchema = z.object({
  capabilityId: IdSchema,
  versionId: IdSchema,
  slug: SlugSchema,
  manifestHash: z.string(),
  reviewStatus: z.enum(['alpha_pending', 'published']),
  isRollback: z.boolean(),
  ownerUserId: IdSchema,
  traceId: TraceIdSchema,
  occurredAt: IsoDateTimeSchema,
});
export type CapabilityPublishedPayload = z.infer<typeof CapabilityPublishedPayloadSchema>;

export const CapabilityUnpublishedPayloadSchema = z.object({
  capabilityId: IdSchema,
  reason: z.literal('review_rejected_no_prev'),
  ownerUserId: IdSchema,
  traceId: TraceIdSchema,
  occurredAt: IsoDateTimeSchema,
});
export type CapabilityUnpublishedPayload = z.infer<typeof CapabilityUnpublishedPayloadSchema>;

const NotifyBaseSchema = z.object({
  recipientId: IdSchema,
  link: z.string(),
  traceId: TraceIdSchema,
  occurredAt: IsoDateTimeSchema,
});

export const NotifyImportCompletedPayloadSchema = NotifyBaseSchema.extend({
  jobId: IdSchema,
  attemptNo: z.number().int(),
  snapshotId: z.string(),
  segmentCount: z.number().int(),
});
export type NotifyImportCompletedPayload = z.infer<typeof NotifyImportCompletedPayloadSchema>;

export const NotifyExtractCompletedPayloadSchema = NotifyBaseSchema.extend({
  jobId: IdSchema,
  attemptNo: z.number().int(),
  candidateCount: z.number().int(),
});
export type NotifyExtractCompletedPayload = z.infer<typeof NotifyExtractCompletedPayloadSchema>;

export const NotifyPublishCompletedPayloadSchema = NotifyBaseSchema.extend({
  versionId: IdSchema,
  capabilityId: IdSchema,
  reviewStatus: z.literal('alpha_pending'),
});
export type NotifyPublishCompletedPayload = z.infer<typeof NotifyPublishCompletedPayloadSchema>;

export const NotifyReviewDecidedPayloadSchema = NotifyBaseSchema.extend({
  capabilityId: IdSchema,
  versionId: IdSchema,
  decision: z.enum(['approved', 'rejected']),
  rejectReason: z.string().optional(),
});
export type NotifyReviewDecidedPayload = z.infer<typeof NotifyReviewDecidedPayloadSchema>;

// ---------- 冻结 payload（B-36 / B-40，本期不产生）----------
export const UsageMeteringPayloadSchema = z.object({
  sessionId: z.string(),
  turn: z.number().int(),
  attempt: z.number().int(),
  consumerKey: z.string(),
  tokens: z.number().int(),
  costMicros: z.number().int(),
  revenueMicros: z.number().int(),
  mode: z.enum(['trial', 'paid']),
  traceId: TraceIdSchema,
  occurredAt: IsoDateTimeSchema,
});
export type UsageMeteringPayload = z.infer<typeof UsageMeteringPayloadSchema>;

export const RuntimeSessionEventPayloadSchema = z.object({
  sessionId: z.string(),
  commandId: z.string().optional(),
  phase: z.string(),
  traceId: TraceIdSchema,
  occurredAt: IsoDateTimeSchema,
});
export type RuntimeSessionEventPayload = z.infer<typeof RuntimeSessionEventPayloadSchema>;

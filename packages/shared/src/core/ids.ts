// 通用 ID 与命名（脊柱 §9 / §1.3）。对外 ID 一律 string（UUID v7）。
import { z } from 'zod';

/** UUID v7 字符串，对外一律 string（脊柱 §1.3）。zod 层只校验非空字符串，不强校验 UUID 形态以兼容测试夹具。 */
export const IdSchema = z.string().min(1).describe('对外字符串 ID（UUID v7）');

export type Id = z.infer<typeof IdSchema>;
export type UserId = Id;
export type JobId = Id;
export type SnapshotId = Id;
export type CapabilityId = Id;
export type VersionId = Id;
export type CandidateId = Id;
export type BatchId = Id;
export type DraftId = Id;

/** capabilities.slug：URL 安全、创建后不可变（脊柱 §1.3）。 */
export const SlugSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'slug 必须是小写字母数字 + 连字符')
  .describe('不可变业务 slug，URL 安全');
export type Slug = z.infer<typeof SlugSchema>;

/** UUID v7 / ULID，贯穿日志/Sentry/outbox/SSE（脊柱 §3.4）。 */
export const TraceIdSchema = z.string().min(1).describe('traceId（UUID v7 / ULID）');
export type TraceId = z.infer<typeof TraceIdSchema>;

/** ISO 8601 时间字符串。 */
export const IsoDateTimeSchema = z.string().datetime({ offset: true }).describe('ISO 8601 时间');
export type IsoDateTime = z.infer<typeof IsoDateTimeSchema>;

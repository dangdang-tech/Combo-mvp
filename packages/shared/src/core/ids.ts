// 通用 ID 与时间：对外 ID 一律 string（UUID v7）。
import { z } from 'zod';

/** UUID v7 字符串。zod 层只校验非空字符串，不强校验 UUID 形态以兼容测试夹具。 */
export const IdSchema = z.string().min(1).describe('对外字符串 ID（UUID v7）');
export type Id = z.infer<typeof IdSchema>;

/** UUID v7 / ULID，贯穿日志/SSE/排障。 */
export const TraceIdSchema = z.string().min(1).describe('traceId（UUID v7 / ULID）');
export type TraceId = z.infer<typeof TraceIdSchema>;

/** ISO 8601 时间字符串。 */
export const IsoDateTimeSchema = z.string().datetime({ offset: true }).describe('ISO 8601 时间');
export type IsoDateTime = z.infer<typeof IsoDateTimeSchema>;

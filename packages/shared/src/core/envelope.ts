// 统一响应包络（脊柱 §2）。轻包络 { data, meta? }，占位语义 meta.placeholders（§2.2）。
import { z } from 'zod';
import { TraceIdSchema } from './ids.js';
import { PageMetaSchema, type PageMeta } from './pagination.js';

/** meta：永远可选字段集合，新增 meta 字段不算破坏性变更（脊柱 §2.1）。 */
export const MetaSchema = z.object({
  traceId: TraceIdSchema.optional(),
  page: PageMetaSchema.optional(),
  /** usage 置空占位：{ field: "暂无数据 / 上线后填充" }（脊柱 §2.2）。 */
  placeholders: z.record(z.string(), z.string()).optional(),
  /** 外部 AI degraded 软标记（脊柱 §10）。 */
  degraded: z.boolean().optional(),
});
export type Meta = z.infer<typeof MetaSchema>;

export interface Envelope<T> {
  data: T;
  meta?: Meta;
}

export interface Paginated<T> {
  data: T[];
  meta: Meta & { page: PageMeta };
}

/** 单体成功包络 schema 工厂。 */
export function envelopeSchema<T extends z.ZodTypeAny>(data: T) {
  return z.object({ data, meta: MetaSchema.optional() });
}

/** 集合成功包络 schema 工厂（meta.page 必填）。 */
export function paginatedSchema<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    data: z.array(item),
    meta: MetaSchema.extend({ page: PageMetaSchema }),
  });
}

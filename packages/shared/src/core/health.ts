// 健康检查契约（脊柱 §10 / O-04）。/health（liveness）+ /ready（readiness，查五依赖）。
import { z } from 'zod';

export const HealthStatusSchema = z.enum(['ok', 'degraded', 'down']);
export type HealthStatus = z.infer<typeof HealthStatusSchema>;

/** 五 required 依赖 + llm（仅 degraded、不计入 ready，脊柱 §10.2）。 */
export const DependencyNameSchema = z.enum([
  'db',
  'redis_queue',
  'redis_hot',
  'minio',
  'logto',
  'llm',
]);
export type DependencyName = z.infer<typeof DependencyNameSchema>;

export const DependencyHealthSchema = z.object({
  name: DependencyNameSchema,
  status: HealthStatusSchema,
  required: z.boolean().describe('是否计入 /ready'),
});
export type DependencyHealth = z.infer<typeof DependencyHealthSchema>;

export const ReadyViewSchema = z.object({
  status: HealthStatusSchema.describe(
    '任一 required 依赖 down → down；llm degraded → degraded 但 ready=true',
  ),
  ready: z.boolean(),
  dependencies: z.array(DependencyHealthSchema),
});
export type ReadyView = z.infer<typeof ReadyViewSchema>;

/** /health（liveness）响应。 */
export const HealthViewSchema = z.object({ status: z.literal('ok') });
export type HealthView = z.infer<typeof HealthViewSchema>;

/** 计入 /ready 的 required 依赖（脊柱 §10.2）。llm 不在此列。 */
export const REQUIRED_DEPENDENCIES = ['db', 'redis_queue', 'redis_hot', 'minio', 'logto'] as const;

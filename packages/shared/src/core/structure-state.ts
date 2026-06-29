// structure_state（脊柱 §9）：结构化字段级真源；详定义在结构化域契约（40）。
// 断点续传精度靠它（贯穿-28）：每软字段已生成值/状态/卡住时长 + 硬字段锁定值。
import { z } from 'zod';
import { IdSchema } from './ids.js';
import { ErrorBodySchema } from './errors.js';

/** locked = 硬字段平台锁定（脊柱 §9）。 */
export const FieldStatusSchema = z.enum([
  'pending',
  'generating',
  'done',
  'stuck',
  'failed',
  'locked',
]);
export type FieldStatus = z.infer<typeof FieldStatusSchema>;

// —— 软字段键（7 个，§2.5）——
//   定义在 core（脊柱 §9）：FieldState 的字段级失败错误（details.field）须强约束 ∈ SoftFieldKey（硬字段锁定不报
//   字段级失败，§2.2/§3.4）；故软字段键的真源下沉到 core，domains/structure.ts 直接 re-export（避免 core→domains
//   循环依赖）。HardFieldKey / Manifest 等 manifest 结构仍在 domains/structure.ts。
export const SoftFieldKeySchema = z.enum([
  'name',
  'tagline',
  'role',
  'goal',
  'instructions',
  'skill_set',
  'starter_prompts',
]);
export type SoftFieldKey = z.infer<typeof SoftFieldKeySchema>;
/** 软字段标准序（7 个）。 */
export const SOFT_FIELD_KEYS: SoftFieldKey[] = SoftFieldKeySchema.options;

/**
 * 结构化字段级失败错误体的【专用 schema】（§3.4 / Codex r2 P1）。
 *   基于通用 ErrorBodySchema（仍无 code，D1），但收紧 `details.field` 必须 ∈ SoftFieldKey：
 *     - 硬字段（id/version/status/inputs/output/boundaries）锁定不参与生成 → 永不落字段级失败（§2.2/§3.4）；
 *     - 未知字段同样拒绝（杜绝把任意 details.field 当字段级错误持久化）。
 *   `details` 仍是开放 record（可带 attempts 等可安全展示补充），仅当 `field` 键存在时强校验其值 ∈ SoftFieldKey。
 *   FieldStateSchema.error 接入本 schema；worker 落 failed 态写 field.error 用本类型（details.field 由其填 SoftFieldKey）。
 */
export const FieldFailureErrorBodySchema = ErrorBodySchema.refine(
  (e) => {
    const field = e.details?.['field'];
    // details 无 field 键 → 不约束（仍合法：error 体不强制带 field）；有 field 键 → 其值必须 ∈ SoftFieldKey。
    if (field === undefined) return true;
    return SoftFieldKeySchema.safeParse(field).success;
  },
  {
    message: '字段级失败错误体 details.field 必须是软字段（拒绝硬字段/未知字段，§2.2/§3.4）',
    path: ['details', 'field'],
  },
);
export type FieldFailureErrorBody = z.infer<typeof FieldFailureErrorBodySchema>;

export const FieldStateSchema = z.object({
  field: z.string(),
  status: FieldStatusSchema,
  value: z.unknown().optional().describe('已生成值（已落库，断点续传回显）'),
  stuckMs: z.number().int().optional(),
  // 字段级累计失败次数（结构化 Job 内部重试 + 端点 F regen 跨调用累计，§3.4）。默认/缺省视作 0。
  // 持久化进 structure_state，让「经 F regen 累计两次失败→错误态」跨调用成立（否则每次 regen 都全新 2 次预算）。
  attempts: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('字段级累计失败次数（跨 job/跨端点F调用；缺省视作 0）'),
  // 字段级失败错误体（§3.4，断线重连 snapshot 回显错误态 + 退路）。持久化进 structure_state 的是
  // 无 code 的对外 ErrorEnvelope['error']（与 SSE error 帧内层 / 对外信封一致，D1：不含 code）。
  // 专用 schema（Codex r2 P1）：details.field 强约束 ∈ SoftFieldKey（硬字段锁定不报字段级失败，§2.2/§3.4）。
  error: FieldFailureErrorBodySchema.optional().describe(
    '字段级失败错误体（无 code；details.field ∈ SoftFieldKey）',
  ),
});
export type FieldState = z.infer<typeof FieldStateSchema>;

export const StructureStateSchema = z.object({
  versionId: IdSchema,
  fields: z.array(FieldStateSchema).describe('软字段 + 硬字段(locked)'),
  doneCount: z.number().int(),
  totalCount: z.number().int(),
});
export type StructureState = z.infer<typeof StructureStateSchema>;

// 40 · STEP③选择 + STEP④结构化域（B-24/B-25/B-26）。import 脊柱 §9，不重定义。
import { z } from 'zod';
import { IdSchema, SlugSchema } from '../core/ids.js';
import { StructureStateSchema, SoftFieldKeySchema } from '../core/structure-state.js';

// ===== manifest 软硬分层（§2）=====
// SoftFieldKey 的真源已下沉到 core/structure-state.ts（FieldState.error.details.field 须强约束 ∈ SoftFieldKey，
//   §3.4 / Codex r2 P1；core 不可 import domains，故下沉避免循环）。此处 re-export 保持公共 API（@cb/shared）不变。
export { SoftFieldKeySchema, SOFT_FIELD_KEYS, type SoftFieldKey } from '../core/structure-state.js';

export const HardFieldKeySchema = z.enum([
  'id',
  'version',
  'status',
  'inputs',
  'output',
  'boundaries',
]);
export type HardFieldKey = z.infer<typeof HardFieldKeySchema>;

/** 硬字段标准序（6 类，平台锁定）。 */
export const HARD_FIELD_KEYS: HardFieldKey[] = HardFieldKeySchema.options;

// ===== 硬字段内部结构 =====
export const InputFieldSchema = z.object({
  key: z.string(),
  label: z.string(),
  type: z.enum(['string', 'text', 'enum', 'number']),
  required: z.boolean(),
  options: z.array(z.string()).optional(),
  derivedFrom: z.literal('instructions'),
});
export type InputField = z.infer<typeof InputFieldSchema>;

export const InputSchemaSchema = z.object({ fields: z.array(InputFieldSchema) });
export type InputSchema = z.infer<typeof InputSchemaSchema>;

export const OutputTypeSchema = z.enum(['text', 'structured', 'score', 'checklist']);
export type OutputType = z.infer<typeof OutputTypeSchema>;

export const OutputSpecSchema = z.object({ type: OutputTypeSchema });
export type OutputSpec = z.infer<typeof OutputSpecSchema>;

export const BoundariesSchema = z.object({
  riskLevel: z.enum(['low', 'medium', 'high']),
  redLines: z.array(z.string()),
});
export type Boundaries = z.infer<typeof BoundariesSchema>;

// ===== manifest（扁平存）=====
export const ManifestSchema = z.object({
  id: z.string(),
  version: z.string(),
  status: z.literal('draft'),
  inputs: InputSchemaSchema,
  output: OutputSpecSchema,
  boundaries: BoundariesSchema,
  name: z.string(),
  tagline: z.string(),
  role: z.string(),
  goal: z.string(),
  instructions: z.string(),
  skill_set: z.array(z.string()),
  starter_prompts: z.array(z.string()),
});
export type Manifest = z.infer<typeof ManifestSchema>;

export const ManifestViewSchema = z.object({
  versionId: IdSchema,
  capabilityId: IdSchema,
  slug: SlugSchema,
  manifest: ManifestSchema,
  locked: z.array(HardFieldKeySchema),
  structureState: StructureStateSchema,
});
export type ManifestView = z.infer<typeof ManifestViewSchema>;

// ===== STEP③/STEP② 选择草稿（端点 G，drafts.selection 权威形态）=====
// 选择模型（P0-1 子集化，§5.2/§5.3）：
//   · single（candidateId）—— 逐个选定一个候选（§5.3「逐个选定」）。
//   · subset（candidateIds: [≥1]）—— 勾选 N 项（N<total 或 N==total 都合法，§5.2「批量勾选 N 项」）。
//     「全部发布」不再是独立模式，只是 subset==该 snapshot 全部 ready 候选的特例（§5.3）。
//   后端 patchSelection 只校验 candidateIds ⊆ 本人该 snapshot 的 ready 候选、非空——【不再要求 == 全 ready】，
//   故 STEP② 勾选任意子集（N<total）都能持久化、不再 PATCH 400 卡死（Codex r6 P1）。
// 兼容/迁移（§schema 同步）：旧持久化草稿/旧前端仍可能发 mode='all'（candidateIds）——保留 'all' 为
//   subset 的【向后兼容别名】（语义等同 subset：⊆ ready、非空），既不破坏已存草稿续传、也不破坏未迁移前端编译。
//   新写一律用 subset；'all' 只读兼容，验证/落库按 subset 同口径处理。
export const SelectionDraftSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('single'), candidateId: IdSchema }),
  // subset 至少一个候选（.min(1)）：空选不是合法子集，否则可存「ready 数量为 0」的伪选择草稿（Codex P1-3）。
  z.object({ mode: z.literal('subset'), candidateIds: z.array(IdSchema).min(1) }),
  // 'all'：向后兼容别名（语义 = subset；旧草稿/未迁移前端续命，新写用 subset），同 .min(1) 非空约束。
  z.object({ mode: z.literal('all'), candidateIds: z.array(IdSchema).min(1) }),
]);
export type SelectionDraft = z.infer<typeof SelectionDraftSchema>;

/** 选择是否多选（subset 或兼容别名 all）——逐个选定单个走 single。 */
export function isSubsetSelection(
  s: SelectionDraft,
): s is { mode: 'subset' | 'all'; candidateIds: string[] } {
  return s.mode === 'subset' || s.mode === 'all';
}

/** 规范化为 candidateIds（single→[一个]，subset/all→原数组）；供后端校验/建批统一取候选集。 */
export function selectionCandidateIds(s: SelectionDraft): string[] {
  return s.mode === 'single' ? [s.candidateId] : s.candidateIds;
}

export const PatchSelectionBodySchema = z.object({ selection: SelectionDraftSchema });
export type PatchSelectionBody = z.infer<typeof PatchSelectionBodySchema>;

// ===== 端点 I/O =====
/**
 * **恰好三选一**：sourceCandidateId / capabilityId / fromVersionId（Codex#7，§2.4）。
 * 三个 source 字段必须**有且仅有一个**存在——零个或多于一个都拒（不仅是「fromVersionId 不与前两者并存」，
 * 也禁 `{sourceCandidateId, capabilityId}` 这种两者并存）。三分支语义：
 * ① `sourceCandidateId` 从候选新建首版；② `capabilityId` published 后建新版本；
 * ③ `fromVersionId` 被拒重发派生新 draft（从本人 review_rejected 版复制软字段）。
 */
export const CreateCapabilityBodySchema = z
  .object({
    sourceCandidateId: IdSchema.optional(),
    capabilityId: IdSchema.optional(),
    fromVersionId: IdSchema.optional(),
    draftId: IdSchema.optional(),
  })
  .refine(
    (b) =>
      [b.sourceCandidateId, b.capabilityId, b.fromVersionId].filter((v) => v !== undefined)
        .length === 1,
    {
      message: 'sourceCandidateId / capabilityId / fromVersionId 必须恰好三选一（有且仅有一个）',
    },
  );
export type CreateCapabilityBody = z.infer<typeof CreateCapabilityBodySchema>;

export const CreateCapabilityResultSchema = z.object({
  capabilityId: IdSchema,
  versionId: IdSchema,
  slug: SlugSchema,
  version: z.string(),
  manifest: ManifestSchema,
  structureState: StructureStateSchema,
});
export type CreateCapabilityResult = z.infer<typeof CreateCapabilityResultSchema>;

export const StartStructureBodySchema = z.object({
  fields: z.array(SoftFieldKeySchema).optional(),
});
export type StartStructureBody = z.infer<typeof StartStructureBodySchema>;

export const StartStructureResultSchema = z.object({
  jobId: IdSchema,
  versionId: IdSchema,
  eventsUrl: z.string(),
  structureState: StructureStateSchema,
});
export type StartStructureResult = z.infer<typeof StartStructureResultSchema>;

export const PatchManifestBodySchema = z.object({
  name: z.string().optional(),
  tagline: z.string().optional(),
  role: z.string().optional(),
  goal: z.string().optional(),
  instructions: z.string().optional(),
  skill_set: z.array(z.string()).optional(),
  starter_prompts: z.array(z.string()).optional(),
});
export type PatchManifestBody = z.infer<typeof PatchManifestBodySchema>;

export const RegenerateFieldBodySchema = z.object({
  reason: z.enum(['stuck', 'manual']).optional(),
});
export type RegenerateFieldBody = z.infer<typeof RegenerateFieldBodySchema>;

export const RegenerateFieldResultSchema = z.object({
  jobId: IdSchema,
  field: SoftFieldKeySchema,
  eventsUrl: z.string(),
});
export type RegenerateFieldResult = z.infer<typeof RegenerateFieldResultSchema>;

// ===== SSE 字段流 payload（本域具体化脊柱 §5.3；字段级 field 一律 SoftFieldKey）=====
export const FieldStartPayloadSchema = z.object({
  field: SoftFieldKeySchema,
  index: z.number().int(),
  total: z.number().int(),
});
export type FieldStartPayload = z.infer<typeof FieldStartPayloadSchema>;

export const FieldDeltaPayloadSchema = z.object({
  field: SoftFieldKeySchema,
  deltaText: z.string(),
  itemIndex: z.number().int().optional(),
});
export type FieldDeltaPayload = z.infer<typeof FieldDeltaPayloadSchema>;

export const FieldDonePayloadSchema = z.object({
  field: SoftFieldKeySchema,
  value: z.union([z.string(), z.array(z.string())]),
});
export type FieldDonePayload = z.infer<typeof FieldDonePayloadSchema>;

export const FieldItemAppendedPayloadSchema = z.object({
  field: SoftFieldKeySchema,
  itemIndex: z.number().int(),
  value: z.string(),
});
export type FieldItemAppendedPayload = z.infer<typeof FieldItemAppendedPayloadSchema>;

/** 本域收紧脊柱 FieldStuckPayload.field 为 SoftFieldKey（硬字段永不发 field_stuck）。 */
export const StructureFieldStuckPayloadSchema = z.object({
  field: SoftFieldKeySchema,
  elapsedMs: z.number().int(),
  options: z.array(z.enum(['continue', 'regen', 'wait'])),
});
export type StructureFieldStuckPayload = z.infer<typeof StructureFieldStuckPayloadSchema>;

/** 字段级失败：error 帧内层 error.details 形态（硬字段不报字段级生成错误）。 */
export const StructureFieldFailedDetailsSchema = z.object({
  field: SoftFieldKeySchema,
  attempts: z.number().int(),
});
export type StructureFieldFailedDetails = z.infer<typeof StructureFieldFailedDetailsSchema>;

// drafts / 断点续传状态机（脊柱 §8）。五步任一步可存草稿，续传回精确断点。
import { z } from 'zod';
import { IdSchema, IsoDateTimeSchema } from './ids.js';

/** step 五枚举（脊柱 §8.2）。select 是纯前端步（不调模型不写库）。 */
export const DraftStepSchema = z.enum(['import', 'extract', 'select', 'structure', 'publish']);
export type DraftStep = z.infer<typeof DraftStepSchema>;

/** 草稿状态机（脊柱 §8.3）。 */
export const DraftStatusSchema = z.enum(['active', 'completed', 'abandoned']);
export type DraftStatus = z.infer<typeof DraftStatusSchema>;

/**
 * 草稿 bootstrap 请求体（POST /drafts，脊柱 §8）。
 *   title 可选（草稿条可读标题，区分多条；缺省后端置 NULL，前端可后续据导入/能力名补）。
 *   owner 取登录态、不由客户端传；current_step/status 由后端固定初值（import/active），不接受客户端置入。
 */
export const CreateDraftBodySchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
  })
  .strict();
export type CreateDraftBody = z.infer<typeof CreateDraftBodySchema>;

export const DraftViewSchema = z.object({
  id: IdSchema,
  status: DraftStatusSchema,
  currentStep: DraftStepSchema,
  stepProgress: z
    .object({ percent: z.number().min(0).max(100), phrase: z.string() })
    .describe('草稿条「结构化中 60%」'),
  title: z.string().optional(),
  snapshotId: IdSchema.optional(),
  extractJobId: IdSchema.optional(),
  selection: z.unknown().optional(),
  versionId: IdSchema.optional(),
  capabilityId: IdSchema.optional(),
  batchId: IdSchema.optional(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type DraftView = z.infer<typeof DraftViewSchema>;

// 30 · STEP② 提取域（B-22/B-23）。import 脊柱 §9，不重定义。
import { z } from 'zod';
import { IdSchema, IsoDateTimeSchema } from '../core/ids.js';
import { JobStatusSchema } from '../core/jobs.js';
import { ErrorBodySchema } from '../core/errors.js';
import { PageQuerySchema } from '../core/pagination.js';

// ---------- 枚举 ----------
export const CandidateStatusSchema = z.enum(['generating', 'ready', 'failed']);
export type CandidateStatus = z.infer<typeof CandidateStatusSchema>;

/** 提取-10。 */
export const CapabilityTypeSchema = z.enum(['core-workflow', 'recurring', 'occasional']);
export type CapabilityType = z.infer<typeof CapabilityTypeSchema>;

/** 提取-09/12。 */
export const ConfidenceSchema = z.enum(['high', 'med', 'low']);
export type Confidence = z.infer<typeof ConfidenceSchema>;

// ---------- 候选适用范围 / 可复用拆解 ----------
export const CandidateScopeSchema = z.object({
  language: z.string().optional(),
  domain: z.string().optional(),
  inputType: z.string().optional(),
  scale: z.string().optional(),
  preconditions: z.array(z.string()).optional(),
  outOfScope: z.array(z.string()).optional(),
});
export type CandidateScope = z.infer<typeof CandidateScopeSchema>;

export const ReusabilityBreakdownSchema = z.object({
  frequency: z.number().optional(),
  crossProject: z.number().optional(),
  recency: z.number().optional(),
  timeCost: z.number().optional(),
});
export type ReusabilityBreakdown = z.infer<typeof ReusabilityBreakdownSchema>;

// ---------- 候选全量视图（列表项 & 单体）----------
export const CandidateViewSchema = z.object({
  id: IdSchema,
  extractJobId: IdSchema,
  snapshotId: IdSchema,
  status: CandidateStatusSchema,
  name: z.string().nullable(),
  intent: z.string().nullable(),
  slug: z.string(),
  type: CapabilityTypeSchema.nullable(),
  confidence: ConfidenceSchema.nullable(),
  segmentCount: z.number().int().nullable(),
  frequencyRatio: z.number().nullable(),
  reusability: z.number().nullable(),
  scopeCoherence: z.number().nullable(),
  splitSuggested: z.boolean().nullable(),
  scope: CandidateScopeSchema.nullable(),
  reusabilityBreakdown: ReusabilityBreakdownSchema.nullable().optional(),
  error: ErrorBodySchema.nullable().describe('failed 时人话错误（非堆栈）'),
  retryCount: z.number().int(),
  createdAt: IsoDateTimeSchema,
});
export type CandidateView = z.infer<typeof CandidateViewSchema>;

// ---------- 候选轻摘要（SSE item-appended & state_snapshot.progress.items[]）----------
export const CandidateItemSchema = z.object({
  id: IdSchema,
  status: CandidateStatusSchema,
  isNew: z.boolean().optional(),
  name: z.string().nullable(),
  intent: z.string().nullable().optional(),
  type: CapabilityTypeSchema.nullable().optional(),
  confidence: ConfidenceSchema.nullable().optional(),
  segmentCount: z.number().int().nullable().optional(),
  scopeCoherence: z.number().nullable().optional(),
  splitSuggested: z.boolean().nullable().optional(),
  error: ErrorBodySchema.nullable().optional(),
});
export type CandidateItem = z.infer<typeof CandidateItemSchema>;

/**
 * SSE `item-appended` 帧 payload 契约形态（30 §3.1/§3.4）：恒为 `{ item: CandidateItem }`。
 *   前端按 `data.item` 分发逐个浮现的候选/失败行/重试回填（绝不推裸 item，否则前端取不到，B-22/B-23 断）。
 *   注意 `state_snapshot.progress.items[]` 存的是【裸 CandidateItem 列表】（30 §3.2），与本帧 payload 不同形态。
 */
export const ItemAppendedPayloadSchema = z.object({
  item: CandidateItemSchema,
});
export type ItemAppendedPayload = z.infer<typeof ItemAppendedPayloadSchema>;

// ---------- 段级证据视图 ----------
export const CandidateEvidenceViewSchema = z.object({
  id: IdSchema,
  candidateId: IdSchema,
  segmentId: IdSchema,
  snapshotId: IdSchema,
  title: z.string().nullable(),
  source: z.string().nullable(),
  quote: z.string().nullable().describe('去敏后片段（提取-31，不含隐私原文）'),
  happenedAt: IsoDateTimeSchema.nullable(),
  project: z.string().nullable(),
});
export type CandidateEvidenceView = z.infer<typeof CandidateEvidenceViewSchema>;

// ---------- 请求 / 响应 ----------
export const ExtractCreateRequestSchema = z.object({
  // 本萃取由哪条草稿发起（续传指针，P0/Codex r4）：给了即建 extract job 同事务回填 drafts.extract_job_id +
  //   current_step='extract'（owner 守卫 + 单次写 + 永不倒退）。续传按 draftId 读 DraftView.extractJobId 回断点。
  //   draftId 入 request_hash → 同 key 必同 draftId（刷新复用同 key 回放首次萃取，提取-25）。
  draftId: IdSchema.optional(),
  options: z
    .object({
      engine: z.enum(['v3-singlepass', 'crune-deterministic', 'llm-oneshot']).optional(),
    })
    .optional(),
});
export type ExtractCreateRequest = z.infer<typeof ExtractCreateRequestSchema>;

export const ExtractJobAcceptedSchema = z.object({
  jobId: IdSchema,
  snapshotId: IdSchema,
  status: JobStatusSchema,
  eventsUrl: z.string(),
});
export type ExtractJobAccepted = z.infer<typeof ExtractJobAcceptedSchema>;

export const CandidateRetryAcceptedSchema = z.object({
  candidateId: IdSchema,
  extractJobId: IdSchema.describe('原萃取 job（只读引用）'),
  retryJobId: IdSchema.describe('本次重试新建的 job（全新 fence/流）'),
  status: z.literal('generating'),
  retryCount: z.number().int(),
  eventsUrl: z.string().describe('= /api/v1/jobs/{retryJobId}/events（新流）'),
});
export type CandidateRetryAccepted = z.infer<typeof CandidateRetryAcceptedSchema>;

export const CandidateListQuerySchema = PageQuerySchema.extend({
  status: z.string().optional().describe('"ready,failed"'),
});
export type CandidateListQuery = z.infer<typeof CandidateListQuerySchema>;

/** 列候选 meta 扩展：置信分布摘要（提取-12）。 */
export const ConfidenceSummarySchema = z.object({
  high: z.number().int(),
  med: z.number().int(),
  low: z.number().int(),
});
export type ConfidenceSummary = z.infer<typeof ConfidenceSummarySchema>;

/** done.result（萃取完成产物摘要）。 */
export const ExtractDoneResultSchema = z.object({
  candidateCount: z.number().int().describe('0 → 空态（提取-26）'),
  readyCount: z.number().int(),
  failedCount: z.number().int(),
  analyzedSegments: z.number().int().describe('结果横幅段数（提取-08）'),
  degraded: z.boolean().describe('LLM degraded 完成（脊柱 §10）'),
});
export type ExtractDoneResult = z.infer<typeof ExtractDoneResultSchema>;

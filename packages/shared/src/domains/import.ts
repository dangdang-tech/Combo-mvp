// 20 · STEP① 导入域（B-17~B-21）。import 脊柱 §9，不重定义。
import { z } from 'zod';
import { IdSchema, IsoDateTimeSchema } from '../core/ids.js';
import { JobViewSchema } from '../core/jobs.js';

// ---------- 来源 ----------
export const ImportSourceSchema = z.enum(['claude', 'codex', 'mixed']);
export type ImportSource = z.infer<typeof ImportSourceSchema>;

// ---------- 直传路径（B-20）----------
export const PresignRequestSchema = z.object({
  parts: z.array(
    z.object({
      clientPartId: z.string(),
      sizeBytes: z.number().int().nonnegative(),
      contentSha256: z.string().optional(),
    }),
  ),
  source: ImportSourceSchema,
  totalBytes: z.number().int().nonnegative(),
});
export type PresignRequest = z.infer<typeof PresignRequestSchema>;

export const PresignResultSchema = z.object({
  uploadId: z.string(),
  bucket: z.literal('agora-raw'),
  parts: z.array(
    z.object({
      clientPartId: z.string(),
      url: z.string(),
      s3Key: z.string(),
      expiresAt: IsoDateTimeSchema,
    }),
  ),
});
export type PresignResult = z.infer<typeof PresignResultSchema>;

export const CreateImportJobRequestSchema = z.object({
  uploadId: z.string(),
  source: ImportSourceSchema,
  draftId: IdSchema.optional(),
});
export type CreateImportJobRequest = z.infer<typeof CreateImportJobRequestSchema>;

export const ImportJobSnapshotViewSchema = z.object({
  job: JobViewSchema,
  eventsUrl: z.string(),
  draftId: IdSchema.optional(),
  snapshotId: IdSchema.optional(),
});
export type ImportJobSnapshotView = z.infer<typeof ImportJobSnapshotViewSchema>;

// ---------- 本机助手路径（B-21）----------
export const PairResultSchema = z.object({
  pairId: z.string(),
  pairingCode: z.string(),
  command: z.string(),
  curlOneLiner: z.string().describe("恒 'curl -fsSL agora.app/import | sh'（导入-03/24）"),
  expiresAt: IsoDateTimeSchema,
});
export type PairResult = z.infer<typeof PairResultSchema>;

/**
 * 上传协议元数据（Codex P0-1/P1-5）：pairId/partIndex/totalParts/contentSha256 走 **query string**（preHandler 友好）。
 *   pairId 走 query 供 PairAuth 定位 import_pairings 行（preHandler 不解析 multipart body，Codex P0-1）；
 *   partIndex/contentSha256 供 per-part 幂等键 + 完整性校验（Codex P1-5）。原文字节走 multipart 文件域。
 */
export const ConnectUploadFormSchema = z.object({
  pairId: z
    .string()
    .describe('query：定位 import_pairings 行（再校验码 hash），失败计数按 pairId 成立'),
  source: ImportSourceSchema,
  partIndex: z.number().int().nonnegative().describe('query：分片序号（0 起）'),
  totalParts: z.number().int().positive().optional().describe('query：期望分片总数，齐全才建 job'),
  contentSha256: z.string().optional().describe('query：本片内容 hash（per-part 幂等键 + 完整性）'),
});
export type ConnectUploadForm = z.infer<typeof ConnectUploadFormSchema>;

/**
 * 判别联合（Codex#14）：uploading 不含 jobId，job_created 必含 jobId/eventsUrl/jobView。
 *   job_created 携带完整 JobView（queued + 五项子任务 pending + attemptNo/createdAt），前端初始态不裸转圈（Codex P1-7）。
 */
export const ConnectUploadResultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('uploading'),
    pairId: z.string(),
    uploadedParts: z.number().int(),
    totalParts: z.number().int().optional(),
  }),
  z.object({
    status: z.literal('job_created'),
    pairId: z.string(),
    jobId: IdSchema,
    eventsUrl: z.string(),
    jobView: JobViewSchema,
  }),
]);
export type ConnectUploadResult = z.infer<typeof ConnectUploadResultSchema>;

export const PairPhaseSchema = z.enum(['waiting', 'uploading', 'job_created', 'expired']);
export type PairPhase = z.infer<typeof PairPhaseSchema>;

export const PairStatusViewSchema = z.object({
  pairId: z.string(),
  phase: PairPhaseSchema,
  jobId: IdSchema.optional(),
  eventsUrl: z
    .string()
    .optional()
    .describe('phase=job_created 时给出，= /api/v1/jobs/{jobId}/events'),
  uploadedParts: z.number().int().optional(),
  totalParts: z.number().int().optional(),
});
export type PairStatusView = z.infer<typeof PairStatusViewSchema>;

// ---------- 进度落库卡（SSE item-appended / progress.items[]）----------
export const ImportedSegmentBriefSchema = z.object({
  segmentId: IdSchema,
  dateLabel: z.string(),
  title: z.string(),
  messageCount: z.number().int(),
  status: z.enum(['importing', 'imported']),
});
export type ImportedSegmentBrief = z.infer<typeof ImportedSegmentBriefSchema>;

// ---------- 去敏报告（B-17，对外口径）----------
export const RedactionCategorySchema = z.enum([
  'phone',
  'api_key',
  'email',
  'id_card',
  'bank_card',
  'ip',
  'secret_other',
]);
export type RedactionCategory = z.infer<typeof RedactionCategorySchema>;

export const RedactionReportViewSchema = z.object({
  applied: z.literal(true),
  totalRedactions: z.number().int(),
  byCategory: z.array(
    z.object({
      category: RedactionCategorySchema,
      count: z.number().int(),
      label: z.string(),
    }),
  ),
  rulesetVersion: z.string(),
});
export type RedactionReportView = z.infer<typeof RedactionReportViewSchema>;

// ---------- 快照视图（B-19）----------
export const SnapshotViewSchema = z.object({
  id: IdSchema,
  ownerUserId: IdSchema,
  source: ImportSourceSchema,
  sources: z.array(ImportSourceSchema),
  stats: z.object({
    segmentCount: z.number().int(),
    messageCount: z.number().int(),
    timeSpan: z.object({ from: z.string(), to: z.string() }).nullable(),
    projectCount: z.number().int(),
  }),
  redaction: RedactionReportViewSchema,
  createdAt: IsoDateTimeSchema,
  supersededBySnapshotId: IdSchema.nullable().optional(),
});
export type SnapshotView = z.infer<typeof SnapshotViewSchema>;

export const SnapshotSegmentViewSchema = z.object({
  segmentId: IdSchema,
  dateLabel: z.string(),
  title: z.string(),
  messageCount: z.number().int(),
  project: z.string().optional(),
  readOnly: z.literal(true),
});
export type SnapshotSegmentView = z.infer<typeof SnapshotSegmentViewSchema>;

export const SnapshotListItemSchema = z.object({
  id: IdSchema,
  source: ImportSourceSchema,
  segmentCount: z.number().int(),
  createdAt: IsoDateTimeSchema,
  isLatest: z.boolean(),
  supersededBySnapshotId: IdSchema.nullable().optional(),
});
export type SnapshotListItem = z.infer<typeof SnapshotListItemSchema>;

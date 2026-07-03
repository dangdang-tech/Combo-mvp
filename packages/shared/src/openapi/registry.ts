// OpenAPI 3.1 注册表（B-07）：zod schema 即真源，web 端据此 codegen TS client。
// 这里把核心脊柱类型 + 各域 DTO 注册为命名 components/schemas。
import { OpenAPIRegistry, extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

extendZodWithOpenApi(z);

import {
  MetaSchema,
  PageMetaSchema,
  ErrorEnvelopeSchema,
  ErrorActionSchema,
  ProgressViewSchema,
  SubtaskViewSchema,
  JobViewSchema,
  JobStatusSchema,
  JobTypeSchema,
  SSEFrameSchema,
  SSEEventTypeSchema,
  StateSnapshotPayloadSchema,
  DonePayloadSchema,
  StructureStateSchema,
  FieldStateSchema,
  DraftViewSchema,
  CreateDraftBodySchema,
  ReadyViewSchema,
  HealthViewSchema,
} from '../core/index.js';

import { MeViewSchema, LogoutResultSchema, RoleSchema } from '../domains/auth.js';
import {
  PresignRequestSchema,
  PresignResultSchema,
  CreateImportJobRequestSchema,
  PairResultSchema,
  PairStatusViewSchema,
  ConnectUploadResultSchema,
  SnapshotViewSchema,
  SnapshotSegmentViewSchema,
  SnapshotListItemSchema,
  RedactionReportViewSchema,
} from '../domains/import.js';
import {
  CandidateViewSchema,
  CandidateItemSchema,
  CandidateEvidenceViewSchema,
  ExtractJobAcceptedSchema,
  CandidateRetryAcceptedSchema,
  ExtractDoneResultSchema,
  ConfidenceSummarySchema,
} from '../domains/extract.js';
import {
  ManifestSchema,
  ManifestViewSchema,
  SelectionDraftSchema,
  PatchSelectionBodySchema,
  CreateCapabilityBodySchema,
  CreateCapabilityResultSchema,
  StartStructureBodySchema,
  StartStructureResultSchema,
  PatchManifestBodySchema,
  RegenerateFieldResultSchema,
} from '../domains/structure.js';
import {
  PublishVersionBodySchema,
  PublishResultSchema,
  MarketCardSchema,
  PublicationViewSchema,
  CreatePublishBatchBodySchema,
  PublishBatchViewSchema,
  ReviewBodySchema,
} from '../domains/publish.js';
import {
  DashboardSummarySchema,
  DashboardMetricsSchema,
  TokenTrendSchema,
  DashboardCapabilityRowSchema,
  CreatorProfileSchema,
  ProfileSectionErrorSchema,
  FollowResultSchema,
  LikeResultSchema,
} from '../domains/dashboard.js';
import { NotificationViewSchema } from '../domains/events.js';

/** 全局单例注册表。registerSchemas() 幂等填充 components。 */
export const registry = new OpenAPIRegistry();

/** 命名 schema 表：每项 = OpenAPI components/schemas 一个命名组件。 */
const NAMED_SCHEMAS: Array<[string, z.ZodTypeAny]> = [
  // —— 脊柱 §9 ——
  ['Meta', MetaSchema],
  ['PageMeta', PageMetaSchema],
  ['ErrorEnvelope', ErrorEnvelopeSchema],
  ['ErrorAction', ErrorActionSchema],
  ['ProgressView', ProgressViewSchema],
  ['SubtaskView', SubtaskViewSchema],
  ['JobView', JobViewSchema],
  ['JobStatus', JobStatusSchema],
  ['JobType', JobTypeSchema],
  ['SSEFrame', SSEFrameSchema],
  ['SSEEventType', SSEEventTypeSchema],
  ['StateSnapshotPayload', StateSnapshotPayloadSchema],
  ['DonePayload', DonePayloadSchema],
  ['StructureState', StructureStateSchema],
  ['FieldState', FieldStateSchema],
  ['DraftView', DraftViewSchema],
  ['CreateDraftBody', CreateDraftBodySchema],
  ['ReadyView', ReadyViewSchema],
  ['HealthView', HealthViewSchema],
  // —— Auth 10 ——
  ['Role', RoleSchema],
  ['MeView', MeViewSchema],
  ['LogoutResult', LogoutResultSchema],
  // —— 导入 20 ——
  ['PresignRequest', PresignRequestSchema],
  ['PresignResult', PresignResultSchema],
  ['CreateImportJobRequest', CreateImportJobRequestSchema],
  ['PairResult', PairResultSchema],
  ['PairStatusView', PairStatusViewSchema],
  ['ConnectUploadResult', ConnectUploadResultSchema],
  ['SnapshotView', SnapshotViewSchema],
  ['SnapshotSegmentView', SnapshotSegmentViewSchema],
  ['SnapshotListItem', SnapshotListItemSchema],
  ['RedactionReportView', RedactionReportViewSchema],
  // —— 提取 30 ——
  ['CandidateView', CandidateViewSchema],
  ['CandidateItem', CandidateItemSchema],
  ['CandidateEvidenceView', CandidateEvidenceViewSchema],
  ['ExtractJobAccepted', ExtractJobAcceptedSchema],
  ['CandidateRetryAccepted', CandidateRetryAcceptedSchema],
  ['ExtractDoneResult', ExtractDoneResultSchema],
  ['ConfidenceSummary', ConfidenceSummarySchema],
  // —— 结构化 40 ——
  ['Manifest', ManifestSchema],
  ['ManifestView', ManifestViewSchema],
  ['SelectionDraft', SelectionDraftSchema],
  ['PatchSelectionBody', PatchSelectionBodySchema],
  ['CreateCapabilityBody', CreateCapabilityBodySchema],
  ['CreateCapabilityResult', CreateCapabilityResultSchema],
  ['StartStructureBody', StartStructureBodySchema],
  ['StartStructureResult', StartStructureResultSchema],
  ['PatchManifestBody', PatchManifestBodySchema],
  ['RegenerateFieldResult', RegenerateFieldResultSchema],
  // —— 发布 50 ——
  ['PublishVersionBody', PublishVersionBodySchema],
  ['PublishResult', PublishResultSchema],
  ['MarketCard', MarketCardSchema],
  ['PublicationView', PublicationViewSchema],
  ['CreatePublishBatchBody', CreatePublishBatchBodySchema],
  ['PublishBatchView', PublishBatchViewSchema],
  ['ReviewBody', ReviewBodySchema],
  // —— 工作台/主页 60 ——
  ['DashboardSummary', DashboardSummarySchema],
  ['DashboardMetrics', DashboardMetricsSchema],
  ['TokenTrend', TokenTrendSchema],
  ['DashboardCapabilityRow', DashboardCapabilityRowSchema],
  ['CreatorProfile', CreatorProfileSchema],
  ['ProfileSectionError', ProfileSectionErrorSchema],
  ['FollowResult', FollowResultSchema],
  ['LikeResult', LikeResultSchema],
  // —— 通知 70 ——
  ['NotificationView', NotificationViewSchema],
];

let registered = false;

/** 把全部命名 schema 注册进 registry（幂等）。返回 registry 供 generator 用。 */
export function registerSchemas(): OpenAPIRegistry {
  if (registered) return registry;
  for (const [name, schema] of NAMED_SCHEMAS) {
    registry.register(name, schema);
  }
  registered = true;
  return registry;
}

/** 已注册的 schema 名清单（供守门/文档）。 */
export const REGISTERED_SCHEMA_NAMES: string[] = NAMED_SCHEMAS.map(([name]) => name);

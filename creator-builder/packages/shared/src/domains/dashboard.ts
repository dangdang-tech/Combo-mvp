// 60 · 工作台 + 个人主页 + 社交域（B-32/B-33/B-34）。import 脊柱 §9，不重定义。
import { z } from 'zod';
import { IdSchema, SlugSchema, IsoDateTimeSchema } from '../core/ids.js';

// ===== 工作台（B-32）=====
export const MetricKeySchema = z.enum([
  'published',
  'invocationsTotal',
  'spendThisMonth',
  'activeConsumers',
]);
export type MetricKey = z.infer<typeof MetricKeySchema>;

export const DashboardSummarySchema = z.object({
  title: z.string(),
  publishedCount: z.number().int(),
  monthlyInvocations: z.number().int().nullable().describe('usage 占位'),
  summaryTemplate: z.string(),
});
export type DashboardSummary = z.infer<typeof DashboardSummarySchema>;

export const MetricCardSchema = z.object({
  key: MetricKeySchema,
  label: z.string(),
  value: z.number().nullable(),
  deltaPercent: z.number().nullable(),
  deltaDirection: z.enum(['up', 'down', 'flat']).nullable(),
  unit: z.string().optional(),
});
export type MetricCard = z.infer<typeof MetricCardSchema>;

export const RangeSchema = z.enum(['7d', '30d', 'all']);
export type Range = z.infer<typeof RangeSchema>;

export const DashboardMetricsSchema = z.object({
  range: RangeSchema,
  cards: z.array(MetricCardSchema),
});
export type DashboardMetrics = z.infer<typeof DashboardMetricsSchema>;

export const TrendPointSchema = z.object({
  date: IsoDateTimeSchema,
  value: z.number().nullable(),
});
export type TrendPoint = z.infer<typeof TrendPointSchema>;

export const TokenTrendSchema = z.object({
  range: RangeSchema,
  metric: z.enum(['tokens', 'invocations']),
  points: z.array(TrendPointSchema),
  peak: TrendPointSchema.nullable(),
  empty: z.boolean(),
});
export type TokenTrend = z.infer<typeof TokenTrendSchema>;

export const CapabilityReviewStatusSchema = z.enum([
  'alpha_pending',
  'published',
  'review_rejected',
  'draft',
  'unpublished',
]);
export type CapabilityReviewStatus = z.infer<typeof CapabilityReviewStatusSchema>;

export const DashboardCapabilityRowSchema = z.object({
  capabilityId: IdSchema,
  versionId: IdSchema,
  slug: SlugSchema,
  name: z.string(),
  tagline: z.string(),
  reviewStatus: CapabilityReviewStatusSchema,
  statusLabel: z.string(),
  rejectReason: z.string().nullable(),
  retryEditable: z.boolean(),
  monthlyInvocations: z.number().int().nullable(),
  spendSparkline: z.array(TrendPointSchema).nullable(),
  revenueMicros: z.number().int().nullable(),
  actions: z.object({
    trial: z.object({ enabled: z.literal(false), hint: z.literal('本期未开放') }),
    edit: z.boolean(),
    more: z.boolean(),
  }),
  publishedAt: IsoDateTimeSchema.nullable(),
  updatedAt: IsoDateTimeSchema,
});
export type DashboardCapabilityRow = z.infer<typeof DashboardCapabilityRowSchema>;

// ===== 个人主页（B-33）=====
export const ProfileSectionKeySchema = z.enum([
  'hero',
  'metrics',
  'density',
  'heatmap',
  'network',
  'works',
]);
export type ProfileSectionKey = z.infer<typeof ProfileSectionKeySchema>;

export const ProfileHeroSchema = z.object({
  avatarUrl: z.string().nullable(),
  displayName: z.string(),
  identityTags: z.array(z.string()),
  bio: z.string(),
  social: z.object({
    following: z.number().int(),
    followers: z.number().int(),
    likes: z.number().int(),
    viewerIsFollowing: z.boolean().nullable(),
  }),
});
export type ProfileHero = z.infer<typeof ProfileHeroSchema>;

export const ProfileMetricsBandSchema = z.object({
  capabilityCount: z.number().int(),
  domainCount: z.number().int(),
  totalInvocations: z.number().int().nullable(),
  hottestTopic: z.object({ name: z.string().nullable(), heatValue: z.number().nullable() }),
  readonly: z.literal(true),
});
export type ProfileMetricsBand = z.infer<typeof ProfileMetricsBandSchema>;

export const DensityRankRowSchema = z.object({
  rank: z.number().int(),
  capabilityId: IdSchema,
  slug: SlugSchema,
  name: z.string(),
  densityScore: z.number(),
  supportingSegments: z.number().int(),
  trend: z.enum(['up', 'down', 'flat']),
  readonly: z.literal(true),
});
export type DensityRankRow = z.infer<typeof DensityRankRowSchema>;

export const ProfileDensitySliceSchema = z.object({
  rows: z.array(DensityRankRowSchema),
  hasMore: z.boolean(),
});
export type ProfileDensitySlice = z.infer<typeof ProfileDensitySliceSchema>;

export const HeatmapCellSchema = z.object({
  date: z.string(),
  count: z.number().int(),
  level: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
});
export type HeatmapCell = z.infer<typeof HeatmapCellSchema>;

export const ProfileHeatmapSchema = z.object({
  range: z.enum(['half_year', 'year']),
  start: z.string(),
  end: z.string(),
  cells: z.array(HeatmapCellSchema),
  maxCount: z.number().int(),
  enabled: z.boolean(),
});
export type ProfileHeatmap = z.infer<typeof ProfileHeatmapSchema>;

export const NetworkEdgeBasisSchema = z.enum(['session_cooccur', 'tag_overlap']);
export type NetworkEdgeBasis = z.infer<typeof NetworkEdgeBasisSchema>;

export const NetworkNodeSchema = z.object({
  capabilityId: IdSchema,
  slug: SlugSchema,
  name: z.string(),
  size: z.number(),
  isCenter: z.boolean(),
});
export type NetworkNode = z.infer<typeof NetworkNodeSchema>;

export const NetworkEdgeSchema = z.object({
  source: IdSchema,
  target: IdSchema,
  weight: z.number(),
  basis: NetworkEdgeBasisSchema,
});
export type NetworkEdge = z.infer<typeof NetworkEdgeSchema>;

export const ProfileNetworkSchema = z.object({
  nodes: z.array(NetworkNodeSchema),
  edges: z.array(NetworkEdgeSchema),
  thumbnailOnly: z.literal(true),
});
export type ProfileNetwork = z.infer<typeof ProfileNetworkSchema>;

export const WorkCardSchema = z.object({
  capabilityId: IdSchema,
  versionId: IdSchema,
  slug: SlugSchema,
  coverUrl: z.string().nullable(),
  name: z.string(),
  invocations: z.number().int().nullable(),
});
export type WorkCard = z.infer<typeof WorkCardSchema>;

export const ProfileWorksSliceSchema = z.object({
  cards: z.array(WorkCardSchema),
  hasMore: z.boolean(),
});
export type ProfileWorksSlice = z.infer<typeof ProfileWorksSliceSchema>;

/**
 * 主聚合分区局部失败标记（60 §2.7，主页-17，Codex#r3 P1）。某分区数据源失败时该分区字段置 null，
 *   并在此标注分区级错误（前端据此对该分区出局部错误条 + 走子端点重试，已成功分区照常渲染，整页不崩）。
 *   - section：失败的分区键。
 *   - retriable：恒 true（分区子端点可重试，密度/热力图/网络/作品墙天然独立）。
 */
export const ProfileSectionErrorSchema = z.object({
  section: ProfileSectionKeySchema,
  retriable: z.boolean(),
});
export type ProfileSectionError = z.infer<typeof ProfileSectionErrorSchema>;

export const CreatorProfileSchema = z.object({
  creatorId: IdSchema,
  slug: SlugSchema,
  sectionsOrder: z.array(ProfileSectionKeySchema),
  // hero 来自 creator_profiles 基行（404 门已过），核心身份分区，恒在。
  hero: ProfileHeroSchema,
  // 以下分区数据源可能各自失败（局部失败不连坐，§2.7）：失败 → null + sectionErrors 标记，整页仍 200。
  metrics: ProfileMetricsBandSchema.nullable(),
  density: ProfileDensitySliceSchema.nullable(),
  heatmap: ProfileHeatmapSchema.nullable(),
  network: ProfileNetworkSchema.nullable(),
  works: ProfileWorksSliceSchema.nullable(),
  heatmapEnabled: z.boolean(),
  // 分区级错误标记（空数组 = 全分区成功）。前端据此渲染局部错误 + 重试，不整页崩（主页-17）。
  sectionErrors: z.array(ProfileSectionErrorSchema),
});
export type CreatorProfile = z.infer<typeof CreatorProfileSchema>;

// ===== 社交（B-34）=====
export const FollowResultSchema = z.object({
  creatorId: IdSchema,
  following: z.boolean(),
  followersCount: z.number().int(),
});
export type FollowResult = z.infer<typeof FollowResultSchema>;

export const LikeResultSchema = z.object({
  capabilityId: IdSchema,
  liked: z.boolean(),
  likesCount: z.number().int(),
});
export type LikeResult = z.infer<typeof LikeResultSchema>;

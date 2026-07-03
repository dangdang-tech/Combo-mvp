// runtime 试用端 ↔ 试用前端 的 API 契约（DTO + zod）。浏览器安全（仅 zod，无 node 依赖）。
//   后端 apps/runtime 与前端 apps/runtime-web 共用本文件；与 authoring 无关。
//   设计原则：instructions / manifestHash 等服务端机密绝不进任何下发 DTO（见 skill-package.ts PublicCapabilityView）。
import { z } from 'zod';
import { PublicCapabilityViewSchema } from './skill-package.js';

// ── 产物（artifact）形态：类 Claude Artifacts 的四种渲染器 ──
//   html       → 沙箱 iframe 预览（旗舰，最像 Claude 网页产物）
//   markdown   → 富文本渲染
//   code       → 高亮 + 复制
//   structured → output.type=structured/score/checklist 的结构化渲染（JSON 驱动）
export const ArtifactKindSchema = z.enum(['html', 'markdown', 'code', 'structured']);
export type ArtifactKind = z.infer<typeof ArtifactKindSchema>;

export const ChatRoleSchema = z.enum(['user', 'assistant']);
export type ChatRole = z.infer<typeof ChatRoleSchema>;

export const RuntimeSessionModeSchema = z.enum(['consume', 'trial']);
export type RuntimeSessionMode = z.infer<typeof RuntimeSessionModeSchema>;

export const RunStatusSchema = z.enum(['queued', 'running', 'interrupted', 'failed', 'completed']);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const RunStageStatusSchema = z.enum(['pending', 'running', 'completed', 'failed']);
export type RunStageStatus = z.infer<typeof RunStageStatusSchema>;

export const RunStageSchema = z.object({
  key: z.string(),
  label: z.string(),
  status: RunStageStatusSchema,
});
export type RunStage = z.infer<typeof RunStageSchema>;

export const TrialProcessStateSchema = z.object({
  steps: z.array(RunStageSchema),
  currentKey: z.string().nullable(),
});
export type TrialProcessState = z.infer<typeof TrialProcessStateSchema>;

export const LockedElementSchema = z.object({
  artifactKey: z.string(),
  cardId: z.string().optional(),
  elementKey: z.string(),
  value: z.union([z.string(), z.number(), z.array(z.string())]),
});
export type LockedElement = z.infer<typeof LockedElementSchema>;

export const RunContentPartSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('text'),
    text: z.string(),
  }),
  z.object({
    type: z.literal('image'),
    url: z.string().url().optional(),
    mimeType: z.string().optional(),
    data: z.string().optional(),
    alt: z.string().optional(),
  }),
]);
export type RunContentPart = z.infer<typeof RunContentPartSchema>;

// 助手消息引用的 artifact（指向 runtime_artifacts 的某个版本，渲染成对话气泡里的卡片）。
export const ArtifactRefSchema = z.object({
  artifactKey: z.string(),
  version: z.number().int(),
  kind: ArtifactKindSchema,
  title: z.string(),
});
export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;

// 对话消息（UI 形态，从 pi 转录派生 + 落 runtime_messages）。
export const RuntimeMessageSchema = z.object({
  id: z.string(),
  runId: z.string().nullable(),
  seq: z.number().int(),
  role: ChatRoleSchema,
  text: z.string(),
  artifacts: z.array(ArtifactRefSchema),
  createdAt: z.string(),
});
export type RuntimeMessage = z.infer<typeof RuntimeMessageSchema>;

// artifact 单个版本（面板渲染 + 版本切换）。
export const ArtifactVersionSchema = z.object({
  artifactKey: z.string(),
  version: z.number().int(),
  kind: ArtifactKindSchema,
  title: z.string(),
  language: z.string().nullable(),
  content: z.string(),
  createdAt: z.string(),
});
export type ArtifactVersion = z.infer<typeof ArtifactVersionSchema>;

// artifact 全量（含历史版本，面板左上角版本切换用）。
export const RuntimeArtifactSchema = z.object({
  artifactKey: z.string(),
  kind: ArtifactKindSchema,
  title: z.string(),
  latestVersion: z.number().int(),
  versions: z.array(ArtifactVersionSchema),
});
export type RuntimeArtifact = z.infer<typeof RuntimeArtifactSchema>;

// 会话元信息。
export const RuntimeSessionMetaSchema = z.object({
  id: z.string(),
  capabilityId: z.string(),
  slug: z.string(),
  version: z.string(),
  mode: RuntimeSessionModeSchema,
  title: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type RuntimeSessionMeta = z.infer<typeof RuntimeSessionMetaSchema>;

// 试用市集列表项（轻量，由 marketplace_listings.card 投影出）。
export const RuntimeCapabilityListItemSchema = z.object({
  capabilityId: z.string(),
  slug: z.string(),
  name: z.string(),
  tagline: z.string(),
  typeLabel: z.string(),
  byline: z.string(),
});
export type RuntimeCapabilityListItem = z.infer<typeof RuntimeCapabilityListItemSchema>;

// ─────────────────────────── 端点 I/O ───────────────────────────

// GET /runtime/capabilities → 市集列表
export const RuntimeCapabilityListSchema = z.object({
  items: z.array(RuntimeCapabilityListItemSchema),
});
export type RuntimeCapabilityList = z.infer<typeof RuntimeCapabilityListSchema>;

// POST /runtime/sessions
export const CreateSessionBodySchema = z.object({
  slugOrId: z.string().min(1).optional(),
  title: z.string().optional(),
  mode: RuntimeSessionModeSchema.optional(),
  runGrant: z.string().optional(),
  intake: z.record(z.string()).optional(),
});
export type CreateSessionBody = z.infer<typeof CreateSessionBodySchema>;

export const CreateTrialChainSessionBodySchema = z.object({
  slugOrId: z.string().min(1).optional(),
  versionId: z.string().min(1).optional(),
  title: z.string().optional(),
  runGrant: z.string().optional(),
  intake: z.record(z.string()).optional(),
});
export type CreateTrialChainSessionBody = z.infer<typeof CreateTrialChainSessionBodySchema>;

// GET /runtime/sessions → 会话列表（续话侧栏）
export const RuntimeSessionListItemSchema = z.object({
  id: z.string(),
  slug: z.string(),
  mode: RuntimeSessionModeSchema,
  title: z.string(),
  capabilityName: z.string(),
  updatedAt: z.string(),
});
export type RuntimeSessionListItem = z.infer<typeof RuntimeSessionListItemSchema>;

export const RuntimeSessionListSchema = z.object({
  items: z.array(RuntimeSessionListItemSchema),
});
export type RuntimeSessionList = z.infer<typeof RuntimeSessionListSchema>;

// GET /runtime/sessions/:id → 会话详情（含能力公开视图 + 历史消息 + 产物）
export const SessionDetailSchema = z.object({
  session: RuntimeSessionMetaSchema,
  capability: PublicCapabilityViewSchema,
  messages: z.array(RuntimeMessageSchema),
  artifacts: z.array(RuntimeArtifactSchema),
});
export type SessionDetail = z.infer<typeof SessionDetailSchema>;

export const SessionMessagesPageSchema = z.object({
  items: z.array(RuntimeMessageSchema),
  nextCursor: z.string().nullable(),
});
export type SessionMessagesPage = z.infer<typeof SessionMessagesPageSchema>;

export const UpdateSessionBodySchema = z.object({
  title: z.string().min(1).max(80).optional(),
});
export type UpdateSessionBody = z.infer<typeof UpdateSessionBodySchema>;

export const TrialChainSchema = z.object({
  capabilityId: z.string(),
  sessions: z.array(RuntimeSessionListItemSchema),
});
export type TrialChain = z.infer<typeof TrialChainSchema>;

export const RunInputSchema = z.object({
  contentParts: z.array(RunContentPartSchema).min(1),
  lockedElements: z.array(LockedElementSchema).optional(),
});
export type RunInput = z.infer<typeof RunInputSchema>;

export const RuntimeRunSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  status: RunStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().nullable(),
});
export type RuntimeRun = z.infer<typeof RuntimeRunSchema>;

export const CreateRunResultSchema = z.object({
  run: RuntimeRunSchema,
  eventsUrl: z.string(),
});
export type CreateRunResult = z.infer<typeof CreateRunResultSchema>;

export const InterruptRunResultSchema = z.object({
  run: RuntimeRunSchema,
});
export type InterruptRunResult = z.infer<typeof InterruptRunResultSchema>;

// 发消息走 AG-UI 标准协议（POST /runtime/agui，body=RunAgentInput，回 AG-UI 事件流）：
//   text 走 TEXT_MESSAGE_*，产物走 STATE_DELTA（agent.state.artifacts）。线协议类型由 @ag-ui/core 提供，
//   不在本契约里另立自定义 SSE 事件（旧的 ChatSseEvent/SendMessageBody 已随迁移移除）。

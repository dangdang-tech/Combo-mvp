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
  slugOrId: z.string().min(1),
  title: z.string().optional(),
});
export type CreateSessionBody = z.infer<typeof CreateSessionBodySchema>;

// GET /runtime/sessions → 会话列表（续话侧栏）
export const RuntimeSessionListItemSchema = z.object({
  id: z.string(),
  slug: z.string(),
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

// 发消息走 AG-UI 标准协议（POST /runtime/agui，body=RunAgentInput，回 AG-UI 事件流）：
//   text 走 TEXT_MESSAGE_*，产物走 STATE_DELTA（agent.state.artifacts）。线协议类型由 @ag-ui/core 提供，
//   不在本契约里另立自定义 SSE 事件（旧的 ChatSseEvent/SendMessageBody 已随迁移移除）。

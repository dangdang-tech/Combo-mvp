// 试用域：会话 / 消息 / 产物的对外形态（runtime 服务的 HTTP 契约）。
// 消息 content 存 pi agent 的原生消息格式；它的严格 schema 校验在 runtime 侧
// （runtime 依赖 pi 包，对齐其类型），共享层只做「是数组」的形状约束透传。
import { z } from 'zod';
import { IdSchema, IsoDateTimeSchema } from '../core/ids.js';

export const SessionStatusSchema = z.enum(['active', 'closed']);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

export const MessageRoleSchema = z.enum(['user', 'assistant', 'tool']);
export type MessageRole = z.infer<typeof MessageRoleSchema>;

export const MessageStatusSchema = z.enum(['completed', 'failed']);
export type MessageStatus = z.infer<typeof MessageStatusSchema>;

// ---------- 请求 ----------
export const CreateSessionBodySchema = z.object({ capabilityId: IdSchema }).strict();
export type CreateSessionBody = z.infer<typeof CreateSessionBodySchema>;

export const SendMessageBodySchema = z.object({ text: z.string().min(1).max(20_000) }).strict();
export type SendMessageBody = z.infer<typeof SendMessageBodySchema>;

// ---------- 视图 ----------
export const SessionViewSchema = z.object({
  id: IdSchema,
  capabilityId: IdSchema,
  title: z.string().optional(),
  status: SessionStatusSchema,
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type SessionView = z.infer<typeof SessionViewSchema>;

export const MessageViewSchema = z.object({
  id: IdSchema,
  seq: z.number().int(),
  role: MessageRoleSchema,
  /** pi 原生分块内容（文本/工具调用/工具结果块数组），严格校验在 runtime 侧。 */
  content: z.array(z.unknown()),
  status: MessageStatusSchema,
  createdAt: IsoDateTimeSchema,
});
export type MessageView = z.infer<typeof MessageViewSchema>;

export const ArtifactViewSchema = z.object({
  id: IdSchema,
  kind: z.string(),
  title: z.string().optional(),
  updatedAt: IsoDateTimeSchema,
});
export type ArtifactView = z.infer<typeof ArtifactViewSchema>;

/** 会话详情：一次请求把聊天流和画布恢复出来所需的全部。 */
export const SessionDetailSchema = z.object({
  session: SessionViewSchema,
  capability: z.object({
    id: IdSchema,
    name: z.string(),
    summary: z.string(),
    kind: z.string(),
  }),
  messages: z.array(MessageViewSchema),
  artifacts: z.array(ArtifactViewSchema),
});
export type SessionDetail = z.infer<typeof SessionDetailSchema>;

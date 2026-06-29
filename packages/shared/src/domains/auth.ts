// 10 · Auth / Logto 域（B-08）。import 脊柱 §9，不重定义。
import { z } from 'zod';
import { IdSchema, IsoDateTimeSchema } from '../core/ids.js';

// ---------- 角色 ----------
// creator/consumer = 单账号双业务角色（10-auth §6.1）；reviewer = Alpha 人工评审角色（50-publish §2.6，Codex#7）：
// 评审端点专用、与创作者隔离（创作者不可评审自己），独立 Logto 角色映射（见 infra）。
export const RoleSchema = z.enum(['creator', 'consumer', 'reviewer']);
export type Role = z.infer<typeof RoleSchema>;

export const UserStatusSchema = z.enum(['active', 'disabled']);
export type UserStatus = z.infer<typeof UserStatusSchema>;

// ---------- 请求 query ----------
export const LoginQuerySchema = z.object({
  returnTo: z.string().startsWith('/').max(512).optional().describe('站内回跳路径，缺省 /creator'),
  prompt: z.enum(['magic_link', 'github']).optional(),
});
export type LoginQuery = z.infer<typeof LoginQuerySchema>;

export const CallbackQuerySchema = z.object({
  code: z.string().optional(),
  state: z.string().optional(),
  error: z.string().optional(),
  error_description: z.string().optional(),
});
export type CallbackQuery = z.infer<typeof CallbackQuerySchema>;

// ---------- /me 视图 ----------
export const MeViewSchema = z.object({
  id: IdSchema,
  logtoUserId: z.string().describe('OIDC sub'),
  account: z.string().describe('展示账号（发布署名取此，发布-05）'),
  email: z.string().email().nullable(),
  roles: z.array(RoleSchema),
  status: UserStatusSchema,
  hasProfile: z.boolean(),
  creatorId: IdSchema.describe('= id，主页 /creators/{creatorId}/profile 寻址'),
  createdAt: IsoDateTimeSchema,
  lastLoginAt: IsoDateTimeSchema.nullable(),
});
export type MeView = z.infer<typeof MeViewSchema>;

// ---------- 登出 ----------
export const LogoutResultSchema = z.object({
  loggedOut: z.literal(true),
  logoutUrl: z.string().url().optional().describe('Logto RP-initiated logout，前端可选跳转'),
});
export type LogoutResult = z.infer<typeof LogoutResultSchema>;

// ---------- 匿名身份（share_token 路径；本期仅解析、usage 置空）----------
export interface AnonymousIdentity {
  consumerKey: string;
  shareToken: string;
}

// ---------- 鉴权上下文（中间件注入，非对外响应体）----------
export interface AuthContext {
  userId: string;
  logtoUserId: string;
  roles: Role[];
  account: string;
  authSource: 'cookie' | 'bearer';
  anonymous?: AnonymousIdentity;
}

// ---------- 中间件守卫标识（路由声明用，§4.3）----------
export type AuthGuard =
  | { mode: 'requireAuth' }
  | { mode: 'requireRole'; role: Role }
  | { mode: 'optionalAuth' };

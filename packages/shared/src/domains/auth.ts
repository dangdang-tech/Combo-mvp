// 登录域：Logto OIDC 登录换本地用户。
import { z } from 'zod';
import { IdSchema, IsoDateTimeSchema } from '../core/ids.js';

/** 角色。当前只有 creator；权限模型扩展时加值。 */
export const RoleSchema = z.enum(['creator']);
export type Role = z.infer<typeof RoleSchema>;

// ---------- 请求 query ----------
export const LoginQuerySchema = z.object({
  returnTo: z.string().startsWith('/').max(512).optional().describe('站内回跳路径'),
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
  account: z.string(),
  email: z.string().email().nullable(),
  roles: z.array(RoleSchema),
  createdAt: IsoDateTimeSchema,
  lastLoginAt: IsoDateTimeSchema.nullable(),
});
export type MeView = z.infer<typeof MeViewSchema>;

// ---------- 登出 ----------
export const LogoutResultSchema = z.object({
  loggedOut: z.literal(true),
  logoutUrl: z.string().url().optional().describe('外部认证服务的登出地址，前端可选跳转'),
});
export type LogoutResult = z.infer<typeof LogoutResultSchema>;

// ---------- 鉴权上下文（中间件注入，非对外响应体）----------
export interface AuthContext {
  userId: string;
  account: string;
  roles: Role[];
}

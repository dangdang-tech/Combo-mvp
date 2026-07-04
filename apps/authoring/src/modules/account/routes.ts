// 登录域路由。
//   GET  /auth/login    发起登录（302 跳 Logto，PKCE+state+nonce）—— 无鉴权
//   GET  /auth/callback OIDC 回调换会话 —— 无鉴权（GET，OAuth code/state 自带一次性）
//   POST /auth/logout   登出 —— bestEffortAuth（未登录/上游不可达均放行，handler 始终清 cookie + 200 幂等）
//   GET  /me            当前登录用户 —— requireAuth
import type { FastifyInstance } from 'fastify';
import { bestEffortAuth, requireAuth } from '../../platform/middleware/auth.js';
import { registerEndpoints, type EndpointDecl } from '../../platform/http/_helpers.js';
import {
  callbackHandler,
  devLoginHandler,
  loginHandler,
  logoutHandler,
  meHandler,
} from './handlers.js';

export const ACCOUNT_ENDPOINTS: EndpointDecl[] = [
  { method: 'GET', url: '/auth/login', handler: loginHandler() },
  { method: 'GET', url: '/auth/callback', handler: callbackHandler() },
  {
    method: 'POST',
    url: '/auth/logout',
    preHandlers: [bestEffortAuth()],
    handler: logoutHandler(),
  },
  { method: 'GET', url: '/me', preHandlers: [requireAuth()], handler: meHandler() },
];

export async function registerAccountRoutes(scoped: FastifyInstance): Promise<void> {
  registerEndpoints(scoped, ACCOUNT_ENDPOINTS);
}

/**
 * 仅 dev/test 种子登录端点（安全双守卫，不进 ALL_ENDPOINTS）。
 * 只在 devLoginAvailable 时由 app.ts 条件注册（生产/开关关 → 端点不存在 404）。
 */
export const DEV_ACCOUNT_ENDPOINTS: EndpointDecl[] = [
  { method: 'POST', url: '/auth/dev-login', handler: devLoginHandler() },
];

export async function registerDevAccountRoutes(scoped: FastifyInstance): Promise<void> {
  registerEndpoints(scoped, DEV_ACCOUNT_ENDPOINTS);
}

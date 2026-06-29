// 10 · Auth / Logto 域路由（B-08，10-auth §3）。真实 Logto OIDC 登录流 + cb_session 会话层。
//   GET  /auth/login    发起登录（302 跳 Logto，PKCE+state+nonce）—— 无鉴权
//   GET  /auth/callback OIDC 回调换会话（校 state→换 token→验 id_token→provision→种 cb_session→302 回站内，
//                       失败带 opaque failureId）—— 无鉴权（GET，OAuth code/state 自带一次性）
//   POST /auth/logout   登出（10-auth §3.3：鉴权 best-effort——已登录解会话/未登录或上游不可达均放行，
//                       handler 始终清 cookie + 200 幂等，绝不被 401/503 拦）
//                       —— bestEffortAuth；脊柱 §4.1 唯一豁免 Idempotency-Key（会话销毁、无产物）
//   GET  /me            当前登录用户（10-auth §3.4）—— requireAuth
import type { FastifyInstance } from 'fastify';
import { bestEffortAuth, requireAuth } from '../middleware/auth.js';
import { registerEndpoints, type EndpointDecl } from './_helpers.js';
import {
  callbackHandler,
  devLoginHandler,
  loginHandler,
  logoutHandler,
  meHandler,
} from './auth-handlers.js';

export const AUTH_ENDPOINTS: EndpointDecl[] = [
  { method: 'GET', url: '/auth/login', handler: loginHandler() }, // 无鉴权
  { method: 'GET', url: '/auth/callback', handler: callbackHandler() }, // 无鉴权（GET 回调）
  // logout = best-effort 鉴权（10-auth §3.3/:145/:153）：未登录 / token 无效 / Logto·JWKS 不可达，
  //   都不被 401/503 拦——handler 始终先清 cb_session + cb_auth_tx 并返 200（幂等）。
  {
    method: 'POST',
    url: '/auth/logout',
    preHandlers: [bestEffortAuth()],
    handler: logoutHandler(),
  }, // Idempotency 豁免（§4.1）
  { method: 'GET', url: '/me', preHandlers: [requireAuth()], handler: meHandler() },
];

export async function registerAuthRoutes(scoped: FastifyInstance): Promise<void> {
  registerEndpoints(scoped, AUTH_ENDPOINTS);
}

/**
 * 仅 dev/test 种子登录端点（安全双守卫，绝不进 ALL_ENDPOINTS / 契约集 / 生产）。
 *   POST /auth/dev-login —— 无 Logto 浏览器登录即拿有效会话（无幂等守卫：dev 专用工具，非契约写命令）。
 * 故意不并入 AUTH_ENDPOINTS：契约端点数（routes.test 守门 54）不含它；它只在 devLoginAvailable 时
 *   由 app.ts 条件注册（生产/开关关 → 端点不存在 404）。handler 内再兜一层双守卫（不可用即 404）。
 */
export const DEV_AUTH_ENDPOINTS: EndpointDecl[] = [
  { method: 'POST', url: '/auth/dev-login', handler: devLoginHandler() },
];

/** 条件注册 dev-login（仅 devLoginAvailable 时由 app.ts 调用；不可用则根本不注册 → 404）。 */
export async function registerDevAuthRoutes(scoped: FastifyInstance): Promise<void> {
  registerEndpoints(scoped, DEV_AUTH_ENDPOINTS);
}

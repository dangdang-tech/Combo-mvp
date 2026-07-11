// 浏览器来源边界：生产只信任 OIDC 回调 URI 所属的 canonical origin；
// dev/test 额外放行仓库中两个 Vite 前端的固定本地 origin。
//
// CORS 只决定浏览器能否读取响应，不能阻止简单跨源请求执行。因此，任何会变更
// 会话 Cookie 的 POST 端点还必须挂 requireTrustedMutationOrigin，在 handler 前主动拒绝
// 跨站 / 未获准的同站跨源请求。无 Origin 且无可疑 Fetch Metadata 的服务端/CLI 请求保留兼容。
import { ErrorCode } from '@cb/shared';
import type { FastifyRequest, preHandlerHookHandler } from 'fastify';
import type { Env } from '../config/env.js';
import { sendError } from './_helpers.js';

type BrowserOriginEnv = Pick<Env, 'LOGTO_REDIRECT_URI' | 'NODE_ENV'>;

const LOCAL_DEV_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:5174',
  'http://127.0.0.1:5174',
] as const;

const FETCH_SITES = new Set(['cross-site', 'same-origin', 'same-site', 'none']);

/** LOGTO_REDIRECT_URI 是部署现有的 canonical browser URL 真源，不另造公开域名配置。 */
export function canonicalBrowserOrigin(env: BrowserOriginEnv): string {
  try {
    const url = new URL(env.LOGTO_REDIRECT_URI);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('bad protocol');
    return url.origin;
  } catch {
    // 启动期失败关闭；错误只指向配置 key，不回显配置值。
    throw new Error('[browser-origin] LOGTO_REDIRECT_URI 必须是绝对 HTTP(S) URL');
  }
}

/** 生产只返回 canonical origin；本地端口仅在 development/test 生效。 */
export function allowedBrowserOrigins(env: BrowserOriginEnv): ReadonlySet<string> {
  const allowed = new Set([canonicalBrowserOrigin(env)]);
  if (env.NODE_ENV !== 'production') {
    for (const origin of LOCAL_DEV_ORIGINS) allowed.add(origin);
  }
  return allowed;
}

/** @fastify/cors origin callback：无 Origin 请求继续工作，但绝不反射任意浏览器 Origin。 */
export function corsOriginPolicy(env: BrowserOriginEnv) {
  const allowed = allowedBrowserOrigins(env);
  return (
    origin: string | undefined,
    callback: (error: Error | null, allow: boolean) => void,
  ): void => {
    // false 只关闭本次请求的 CORS 响应头，不会中断无 Origin 的服务端/CLI 请求。
    callback(null, origin !== undefined && allowed.has(origin));
  };
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Cookie 变更请求的服务端判定：
 * - 浏览器带 Origin 时必须命中精确白名单；生产白名单只有 canonical origin。
 * - Sec-Fetch-Site=cross-site 永远拒绝；same-site 只有带获准 Origin 才能通过（dev 代理兼容）。
 * - 无 Origin 的 server/CLI 与 same-origin/none 请求兼容；若 Fetch Metadata 声明跨源则拒绝。
 */
export function isTrustedMutationRequest(req: FastifyRequest): boolean {
  const origin = singleHeader(req.headers.origin);
  const rawFetchSite = singleHeader(req.headers['sec-fetch-site']);
  const fetchSite = rawFetchSite?.toLowerCase();

  // 重复/非字符串 Origin，以及伪造或未来未知的 Fetch Metadata 都失败关闭。
  if (req.headers.origin !== undefined && origin === undefined) return false;
  if (rawFetchSite !== undefined && (fetchSite === undefined || !FETCH_SITES.has(fetchSite))) {
    return false;
  }
  if (fetchSite === 'cross-site') return false;

  if (origin !== undefined) {
    return allowedBrowserOrigins(req.server.infra.env).has(origin);
  }

  // 浏览器若明确说是 same-site 却省略 Origin，不能伪装成 CLI。
  return fetchSite !== 'same-site';
}

/** 会话 Cookie 变更端点的前置守卫；对外只返回既有安全错误信封。 */
export function requireTrustedMutationOrigin(): preHandlerHookHandler {
  return async function (req, reply) {
    if (isTrustedMutationRequest(req)) return;

    req.log.warn(
      { code: ErrorCode.FORBIDDEN, traceId: req.id },
      'blocked untrusted cookie mutation request',
    );
    return sendError(req, reply, ErrorCode.FORBIDDEN);
  };
}

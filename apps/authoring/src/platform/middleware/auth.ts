// 鉴权中间件。
//   - 普通 HTTP 守卫：requireAuth —— token 来源 Authorization: Bearer 优先，否则会话 Cookie，
//     同一套 JWT 校验；验签通过 → provision（查/建 users）→ 注入 req.auth（userId = 业务 users.id）。
//   - SSE 专用守卫：requireSseAuth —— 仅接受【同源 Cookie 会话】，显式拒绝 Authorization 头 /
//     query-string token；失败在【建流前】返 HTTP ErrorEnvelope。
//   - bestEffortAuth：logout 专用「永不拦」——任何失败一律放行（logout 语义是无论如何清会话）。
//   - 失败只出 ErrorEnvelope（绝不裸露 JWT/OIDC 原始报错）；owner 校验由各 handler 内做。
import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import type { AuthContext } from '@cb/shared';
import { ErrorCode } from '@cb/shared';
import { sendError } from '../http/_helpers.js';
import { verifyLogtoJwt, type VerifiedToken } from '../infra/logto.js';
import { devLoginAvailable, verifyDevSession } from '../infra/dev-session.js';

/**
 * provision 依赖反转：查/建 users 属账号业务域，platform 只声明所需函数形状，
 * 实现由组合根接线（bootstrap/app.ts 以 app.decorate('provisionUser', …) 注入 account 域实现）。
 */
export interface ProvisionUserInput {
  /** OIDC sub（去重键）。 */
  logtoUserId: string;
  /** 展示账号候选（撞名由实现方消歧）。 */
  account: string;
  email: string | null;
  roles: AuthContext['roles'];
}
export type ProvisionUserFn = (
  input: ProvisionUserInput,
) => Promise<{ id: string; account: string; roles: AuthContext['roles'] }>;

declare module 'fastify' {
  interface FastifyInstance {
    /** 组合根注入的用户 provision 实现（见 bootstrap/app.ts）。 */
    provisionUser: ProvisionUserFn;
  }
}

/** 会话 Cookie 名（HttpOnly + Secure(prod) + SameSite=Lax 承载 access_token）。 */
export const SESSION_COOKIE = 'cb_session';

/** 从请求取 token（Bearer 头优先，否则会话 Cookie）。普通 HTTP 用。 */
function extractToken(req: FastifyRequest): { token: string; source: 'bearer' | 'cookie' } | null {
  const authz = req.headers.authorization;
  if (authz && authz.startsWith('Bearer ')) {
    return { token: authz.slice('Bearer '.length).trim(), source: 'bearer' };
  }
  const cookieToken = req.cookies?.[SESSION_COOKIE];
  if (cookieToken) return { token: cookieToken, source: 'cookie' };
  return null;
}

/**
 * 鉴权解析结果：
 *   - 'ok'：验签 + provision 成功（userId = 业务 users.id，非 Logto sub）。
 *   - 'anonymous'：无 token → 401。
 *   - 'invalid'：token 无效 → 401。
 *   - 'upstream_unavailable'：JWKS/Logto 不可达（验不了 ≠ token 无效）→ 503。
 *   - 'internal'：provision DB 异常等 → 500。
 */
type AuthResolution =
  | { kind: 'ok'; ctx: AuthContext }
  | { kind: 'anonymous' }
  | { kind: 'invalid' }
  | { kind: 'upstream_unavailable' }
  | { kind: 'internal' };

/** 验签通过 → provision（查/建 users）→ 构造 AuthContext（userId 与 owner 校验同源）。 */
async function buildAuthContext(
  req: FastifyRequest,
  verified: VerifiedToken,
): Promise<AuthResolution> {
  try {
    const provisioned = await req.server.provisionUser({
      logtoUserId: verified.sub,
      account: verified.account,
      email: verified.email,
      roles: verified.roles,
    });
    const ctx: AuthContext = {
      userId: provisioned.id,
      account: provisioned.account,
      roles: provisioned.roles,
    };
    return { kind: 'ok', ctx };
  } catch {
    return { kind: 'internal' };
  }
}

/**
 * dev-only 会话验证分支（仅 dev/test 种子登录，安全双守卫）：仅当 devLoginAvailable(env) 时，
 * 对「不是有效 Logto JWT」的 token 尝试以 app 侧 HS256 dev 密钥验签，通过则走同一条 provision。
 * 生产路径完全不进入；不可用返回 null，调用方按原判定（invalid → 401）。
 */
async function tryDevAuth(req: FastifyRequest, token: string): Promise<AuthResolution | null> {
  const env = req.server.infra.env;
  if (!devLoginAvailable(env)) return null;
  const dev = await verifyDevSession(token, env);
  if (dev.kind === 'invalid') return null;
  return buildAuthContext(req, {
    sub: dev.claims.sub,
    roles: dev.claims.roles,
    account: dev.claims.account,
    email: dev.claims.email,
  });
}

/** 解析 AuthContext（Bearer/Cookie 双来源，或 SSE 场景仅 Cookie）。 */
async function resolveAuth(req: FastifyRequest, cookieOnly = false): Promise<AuthResolution> {
  const extracted = cookieOnly
    ? req.cookies?.[SESSION_COOKIE]
      ? { token: req.cookies[SESSION_COOKIE]!, source: 'cookie' as const }
      : null
    : extractToken(req);
  if (!extracted) return { kind: 'anonymous' };
  const verified = await verifyLogtoJwt(extracted.token, req.server.infra.env);
  if (verified.kind === 'upstream_unavailable') return { kind: 'upstream_unavailable' };
  if (verified.kind === 'invalid') {
    const dev = await tryDevAuth(req, extracted.token);
    return dev ?? { kind: 'invalid' };
  }
  return buildAuthContext(req, verified.token);
}

/** 把非 ok 的鉴权解析结果统一落对应 ErrorEnvelope（401/500/503）。 */
function replyForResolution(
  req: FastifyRequest,
  reply: FastifyReply,
  resolution: Exclude<AuthResolution, { kind: 'ok' }>,
): FastifyReply {
  switch (resolution.kind) {
    case 'upstream_unavailable':
      return sendError(req, reply, ErrorCode.AUTH_UPSTREAM_UNAVAILABLE);
    case 'internal':
      return sendError(req, reply, ErrorCode.INTERNAL);
    default:
      return sendError(req, reply, ErrorCode.UNAUTHENTICATED);
  }
}

/** requireAuth：必须有有效 token，否则按解析态落 401/503/500。 */
export function requireAuth(): preHandlerHookHandler {
  return async (req, reply) => {
    const resolution = await resolveAuth(req);
    if (resolution.kind !== 'ok') return replyForResolution(req, reply, resolution);
    req.auth = resolution.ctx;
  };
}

/**
 * bestEffortAuth：logout 专用「永不拦」鉴权。能解出会话则注入 req.auth；
 * 任何失败一律放行、绝不回错误信封（logout 的语义是无论如何清会话并返成功）。
 */
export function bestEffortAuth(): preHandlerHookHandler {
  return async (req) => {
    try {
      const resolution = await resolveAuth(req);
      if (resolution.kind === 'ok') req.auth = resolution.ctx;
    } catch {
      // 防御性兜底：绝不让 logout 因鉴权抛错而清不了 cookie。
    }
  };
}

/**
 * requireSseAuth：SSE 端点专用守卫。仅接受【同源 Cookie 会话】；带 Authorization 头或
 * query token 视为不合规来源 → 401（不静默回落 Cookie，防混用绕过）。失败在建流前 HTTP 返回。
 */
export function requireSseAuth(): preHandlerHookHandler {
  return async (req, reply) => {
    const hasBearer =
      typeof req.headers.authorization === 'string' &&
      req.headers.authorization.startsWith('Bearer ');
    const q = req.query as { token?: string; access_token?: string } | undefined;
    if (hasBearer || Boolean(q?.token || q?.access_token)) {
      return sendError(req, reply, ErrorCode.UNAUTHENTICATED);
    }
    const resolution = await resolveAuth(req, true);
    if (resolution.kind !== 'ok') return replyForResolution(req, reply, resolution);
    req.auth = resolution.ctx;
  };
}

/** owner 可见性断言：在 requireAuth 之后，handler 内断言资源属当前用户。 */
export function isOwner(req: FastifyRequest, ownerUserId: string): boolean {
  return req.auth?.userId === ownerUserId;
}

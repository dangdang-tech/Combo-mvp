// 鉴权中间件：验创作端同一个登录 Cookie（cb_session），同一个库查 users 解出 userId。
//   - 与 authoring 的差异（有意为之）：runtime 不 provision——用户由创作端登录时建；
//     token 验签通过但 users 无此人 → 按未登录处理（先去创作端登录一次）。
//   - requireAuth：Bearer 头优先，否则 Cookie；requireSseAuth：仅同源 Cookie，
//     显式拒绝 Authorization 头 / query token（防混用绕过），失败在建流前 HTTP 返回。
//   - 失败只出 ErrorEnvelope；owner 校验由各 handler 内做。
import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { ErrorCode, RoleSchema, type AuthContext, type Role } from '@cb/shared';
import { sendError } from '../http/_helpers.js';
import type { Queryable } from '../infra/db.js';
import { verifyLogtoJwt, type VerifiedToken } from '../infra/logto.js';
import { devLoginAvailable, verifyDevSession } from '../infra/dev-session.js';

/** 会话 Cookie 名（authoring 登录后写入；两端共享同一浏览器会话）。 */
export const SESSION_COOKIE = 'cb_session';

type AuthResolution =
  | { kind: 'ok'; ctx: AuthContext }
  | { kind: 'anonymous' }
  | { kind: 'invalid' }
  | { kind: 'upstream_unavailable' }
  | { kind: 'internal' };

/** 从请求取 token（Bearer 头优先，否则会话 Cookie）。普通 HTTP 用。 */
function extractToken(req: FastifyRequest): string | null {
  const authz = req.headers.authorization;
  if (authz && authz.startsWith('Bearer ')) return authz.slice('Bearer '.length).trim();
  const cookieToken = req.cookies?.[SESSION_COOKIE];
  return cookieToken ?? null;
}

/** raw string[] → Role[]（RoleSchema 过滤，空则回落 creator）。 */
function parseRoles(raw: string[] | null | undefined): Role[] {
  const out: Role[] = [];
  for (const r of raw ?? []) {
    const parsed = RoleSchema.safeParse(r);
    if (parsed.success && !out.includes(parsed.data)) out.push(parsed.data);
  }
  return out.length > 0 ? out : ['creator'];
}

/** 验签通过 → 查 users（不建）→ 构造 AuthContext（userId = 业务 users.id，非 sub）。 */
async function buildAuthContext(
  db: Queryable,
  verified: Pick<VerifiedToken, 'sub'>,
): Promise<AuthResolution> {
  try {
    const res = await db.query<{ id: string; account: string; roles: string[] }>(
      `SELECT id, account, roles FROM users WHERE logto_user_id = $1 LIMIT 1`,
      [verified.sub],
    );
    const row = res.rows[0];
    // runtime 不 provision：库里没有这个人 = 从未在创作端登录过 → 按未登录处理。
    if (!row) return { kind: 'invalid' };
    return {
      kind: 'ok',
      ctx: { userId: row.id, account: row.account, roles: parseRoles(row.roles) },
    };
  } catch {
    return { kind: 'internal' };
  }
}

/** dev 验证兜底分支：仅双守卫开启、且 Logto 判定 invalid 后才尝试（生产完全不进入）。 */
async function tryDevAuth(req: FastifyRequest, token: string): Promise<AuthResolution | null> {
  const { env, db } = req.server.infra;
  if (!devLoginAvailable(env)) return null;
  const dev = await verifyDevSession(token, env);
  if (dev.kind === 'invalid') return null;
  return buildAuthContext(db, { sub: dev.claims.sub });
}

/** 解析 AuthContext（Bearer/Cookie 双来源，或 SSE 场景仅 Cookie）。 */
async function resolveAuth(req: FastifyRequest, cookieOnly = false): Promise<AuthResolution> {
  const token = cookieOnly ? (req.cookies?.[SESSION_COOKIE] ?? null) : extractToken(req);
  if (!token) return { kind: 'anonymous' };
  const verified = await verifyLogtoJwt(token, req.server.infra.env);
  if (verified.kind === 'upstream_unavailable') return { kind: 'upstream_unavailable' };
  if (verified.kind === 'invalid') {
    const dev = await tryDevAuth(req, token);
    return dev ?? { kind: 'invalid' };
  }
  return buildAuthContext(req.server.infra.db, verified.token);
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

/** requireAuth：必须有有效登录态，否则按解析态落 401/503/500。 */
export function requireAuth(): preHandlerHookHandler {
  return async (req, reply) => {
    const resolution = await resolveAuth(req);
    if (resolution.kind !== 'ok') return replyForResolution(req, reply, resolution);
    req.auth = resolution.ctx;
  };
}

/**
 * requireSseAuth：SSE 端点专用守卫。仅接受【同源 Cookie 会话】；带 Authorization 头或
 * query token 视为不合规来源 → 401（不静默回落 Cookie）。失败在建流前 HTTP 返回。
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

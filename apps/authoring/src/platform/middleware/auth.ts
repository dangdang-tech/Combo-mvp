// B-08 · 鉴权中间件（10-auth §4 / 脊柱 §11.C，Codex#4）。
//   - 普通 HTTP 守卫：requireAuth / requireRole('creator') / optionalAuth（10-auth §4.3）；
//     token 来源 Authorization: Bearer 优先，否则会话 Cookie（10-auth §3.4），同一套 JWT 校验。
//   - SSE 专用守卫：requireSseAuth —— 仅接受【同源 Cookie 会话】，
//     拒绝 Authorization 头 / query-string token（脊柱 §11.C）；失败在【建流前】返 HTTP ErrorEnvelope。
//   - 失败只出 ErrorEnvelope（绝不裸露 JWT/OIDC 原始报错，脊柱 §11.B）。
//   - owner 校验由各 handler 内做（10-auth §6.3），本文件给 isOwner/replyForbiddenOwner 工具。
import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import type { AuthContext, Role } from '@cb/shared';
import { buildError, ErrorCode } from '@cb/shared';
import { verifyLogtoJwt, type VerifiedToken } from '../infra/logto.js';
import { provisionUser } from '../infra/users-repo.js';
import { devLoginAvailable, verifyDevSession } from '../infra/dev-session.js';

/** 会话 Cookie 名（10-auth §2：HttpOnly + Secure + SameSite=Lax 承载 access_token）。 */
export const SESSION_COOKIE = 'cb_session';

/** 从请求取 token（Bearer 头优先，否则会话 Cookie；10-auth §3.4）。普通 HTTP 用。 */
function extractToken(req: FastifyRequest): { token: string; source: 'bearer' | 'cookie' } | null {
  const authz = req.headers.authorization;
  if (authz && authz.startsWith('Bearer ')) {
    return { token: authz.slice('Bearer '.length).trim(), source: 'bearer' };
  }
  const cookieToken = req.cookies?.[SESSION_COOKIE];
  if (cookieToken) return { token: cookieToken, source: 'cookie' };
  return null;
}

/** 仅取会话 Cookie token（SSE 用：禁 Authorization / 禁 query token，脊柱 §11.C）。 */
function extractCookieOnlyToken(req: FastifyRequest): { token: string; source: 'cookie' } | null {
  const cookieToken = req.cookies?.[SESSION_COOKIE];
  if (cookieToken) return { token: cookieToken, source: 'cookie' };
  return null;
}

/**
 * 鉴权解析结果（区分四态，对应 10-auth §4.4 错误用例）：
 *   - 'ok'：验签 + provision 成功，带 AuthContext（userId = 业务 users.id）。
 *   - 'anonymous'：无 token（optionalAuth 降级；requireAuth 转 401）。
 *   - 'invalid'：token 无效 → 401 UNAUTHENTICATED。
 *   - 'disabled'：账号被禁用（users.status='disabled'）→ 403 FORBIDDEN（账号不可用）。
 *   - 'upstream_unavailable'：JWKS/Logto 不可达（验不了，非 token 无效，Codex#3）→ 503 AUTH_UPSTREAM_UNAVAILABLE。
 *   - 'internal'：provision DB 异常等内部错误 → 500（绝不裸露，脊柱 §11.B）。
 */
type AuthResolution =
  | { kind: 'ok'; ctx: AuthContext }
  | { kind: 'anonymous' }
  | { kind: 'invalid' }
  | { kind: 'disabled' }
  | { kind: 'upstream_unavailable' }
  | { kind: 'internal' };

/**
 * 验签通过 → provision（查/建 users）→ 构造 AuthContext（10-auth §4.2/§7，Codex#1）。
 * 关键：AuthContext.userId = 业务 users.id（非 Logto sub），与 owner 校验（jobs.owner_user_id /
 *   capabilities.creator_user_id 这些 UUID）同源；sub 只放 logtoUserId。
 */
async function buildAuthContext(
  req: FastifyRequest,
  verified: VerifiedToken,
  source: 'bearer' | 'cookie',
): Promise<AuthResolution> {
  try {
    const provisioned = await provisionUser(req.server.infra.db, {
      logtoUserId: verified.sub,
      account: verified.account,
      email: verified.email,
      // verified.roles 已是 logto.ts 用 RoleSchema 过滤+去重后的 Role[]（无 raw string 强转）。
      roles: verified.roles,
    });
    // 账号被禁用：验签 OK 但不可用（10-auth §4.4 → 403）。
    if (provisioned.status === 'disabled') return { kind: 'disabled' };
    const ctx: AuthContext = {
      userId: provisioned.id, // 业务 users.id（非 sub）——owner 校验真源（Codex#1）
      logtoUserId: verified.sub,
      roles: provisioned.roles, // 以库内（= Logto 同步）为权威
      account: provisioned.account,
      authSource: source,
    };
    return { kind: 'ok', ctx };
  } catch {
    // provision DB 异常：绝不裸露（脊柱 §11.B），交中间件出 500 信封。
    return { kind: 'internal' };
  }
}

/**
 * dev-only 会话验证分支（仅 dev/test 种子登录，安全双守卫）：
 *   仅当 devLoginAvailable(env) 为 true（NODE_ENV≠prod 且 DEV_LOGIN_ENABLED=true 且有 DEV_SESSION_SECRET）时，
 *   对「不是有效 Logto JWT」的 token 尝试以 app 侧 HS256 dev 密钥验签。验通过则 provision 解出
 *   userId+roles，构造与真实会话【等价】的 AuthContext（同样过 provisionUser、同样 owner 校验真源）。
 * 生产路径【完全不进入】（devLoginAvailable 恒 false）；不可用时返回 null，调用方按原 Logto 判定（invalid → 401）。
 */
async function tryDevAuth(
  req: FastifyRequest,
  token: string,
  source: 'bearer' | 'cookie',
): Promise<AuthResolution | null> {
  const env = req.server.infra.env;
  if (!devLoginAvailable(env)) return null; // 双守卫：生产/开关关一律不走 dev 分支
  const dev = await verifyDevSession(token, env);
  if (dev.kind === 'invalid') return null; // 既非有效 Logto 也非有效 dev token → 交回原 invalid 路径
  // dev 会话等价真实会话：同样 provision → 同源 users.id + 库内权威角色。
  return buildAuthContext(
    req,
    {
      sub: dev.claims.sub,
      roles: dev.claims.roles,
      account: dev.claims.account,
      email: dev.claims.email,
    },
    source,
  );
}

/** 解析 AuthContext（普通 HTTP：Bearer/Cookie 双来源）。 */
async function resolveAuth(req: FastifyRequest): Promise<AuthResolution> {
  const extracted = extractToken(req);
  if (!extracted) return { kind: 'anonymous' };
  const verified = await verifyLogtoJwt(extracted.token, req.server.infra.env);
  if (verified.kind === 'upstream_unavailable') return { kind: 'upstream_unavailable' };
  if (verified.kind === 'invalid') {
    // dev-only 兜底分支（双守卫；生产恒不走）：Logto 判 invalid 时尝试验 dev token。
    const dev = await tryDevAuth(req, extracted.token, extracted.source);
    return dev ?? { kind: 'invalid' };
  }
  return buildAuthContext(req, verified.token, extracted.source);
}

/** 解析 AuthContext（SSE：仅同源 Cookie，禁 Bearer/query token，脊柱 §11.C）。 */
async function resolveSseAuth(req: FastifyRequest): Promise<AuthResolution> {
  const extracted = extractCookieOnlyToken(req);
  if (!extracted) return { kind: 'anonymous' };
  const verified = await verifyLogtoJwt(extracted.token, req.server.infra.env);
  if (verified.kind === 'upstream_unavailable') return { kind: 'upstream_unavailable' };
  if (verified.kind === 'invalid') {
    // dev-only 兜底分支：SSE 同样仅认同源 Cookie（extractCookieOnlyToken 已守门），dev token 走 cookie。
    const dev = await tryDevAuth(req, extracted.token, extracted.source);
    return dev ?? { kind: 'invalid' };
  }
  return buildAuthContext(req, verified.token, extracted.source);
}

/** 401 未登录信封（escalate，前端跳登录）。 */
function send401(req: FastifyRequest, reply: FastifyReply): void {
  reply.code(401).send(buildError(ErrorCode.UNAUTHENTICATED, req.id));
}

/** 403 无权限信封（escalate）。 */
function send403(req: FastifyRequest, reply: FastifyReply, userMessage?: string): void {
  reply.code(403).send(buildError(ErrorCode.FORBIDDEN, req.id, userMessage ? { userMessage } : {}));
}

/** 503 鉴权上游不可达信封（验不了 ≠ token 无效，10-auth §4.4 / Codex#3）。 */
function send503Upstream(req: FastifyRequest, reply: FastifyReply): void {
  reply.code(503).send(buildError(ErrorCode.AUTH_UPSTREAM_UNAVAILABLE, req.id));
}

/** 500 内部错误信封（provision DB 异常兜底；绝不裸露，脊柱 §11.B）。 */
function send500(req: FastifyRequest, reply: FastifyReply): void {
  reply.code(500).send(buildError(ErrorCode.INTERNAL, req.id));
}

/** 账号被禁用 403（10-auth §4.4，带 traceId）。 */
function send403Disabled(req: FastifyRequest, reply: FastifyReply): void {
  send403(req, reply, '账号当前不可用，请联系支持。');
}

/**
 * 把非 ok 的鉴权解析结果统一落对应 ErrorEnvelope（401/403/500/503）。
 * requireAuth / requireRole / requireSseAuth 共用；anonymous 在各守卫按语义处理（不在此）。
 */
function replyForResolution(
  req: FastifyRequest,
  reply: FastifyReply,
  resolution: Exclude<AuthResolution, { kind: 'ok' }>,
): FastifyReply {
  switch (resolution.kind) {
    case 'upstream_unavailable':
      send503Upstream(req, reply);
      return reply;
    case 'disabled':
      send403Disabled(req, reply);
      return reply;
    case 'internal':
      send500(req, reply);
      return reply;
    case 'anonymous':
    case 'invalid':
    default:
      send401(req, reply);
      return reply;
  }
}

/** requireAuth：必须有有效 token，否则按解析态落 401/403/503/500（10-auth §4.3/§4.4）。 */
export function requireAuth(): preHandlerHookHandler {
  return async (req, reply) => {
    const resolution = await resolveAuth(req);
    if (resolution.kind !== 'ok') return replyForResolution(req, reply, resolution);
    req.auth = resolution.ctx;
  };
}

/** requireRole(role)：requireAuth + 断言角色，否则 403（10-auth §4.3）。 */
export function requireRole(role: Role): preHandlerHookHandler {
  return async (req, reply) => {
    const resolution = await resolveAuth(req);
    if (resolution.kind !== 'ok') return replyForResolution(req, reply, resolution);
    if (!resolution.ctx.roles.includes(role)) {
      send403(req, reply);
      return reply;
    }
    req.auth = resolution.ctx;
  };
}

/**
 * optionalAuth：有有效 token 解 ctx，无 token 不报错（公开主页 / 匿名 share_token，10-auth §4.3）。
 *   - 无 token（anonymous）/ token 无效（invalid）：不报错，降级匿名（匿名身份由 handler 按 share_token 填）。
 *   - 上游不可达 / 账号禁用 / 内部错误：仍按错误信封落（这些不是「正常匿名」，应显式失败）。
 */
export function optionalAuth(): preHandlerHookHandler {
  return async (req, reply) => {
    const resolution = await resolveAuth(req);
    if (resolution.kind === 'ok') {
      req.auth = resolution.ctx;
      return;
    }
    // 无 token / token 无效 → 降级匿名（不报错，公开读路径放行）。
    if (resolution.kind === 'anonymous' || resolution.kind === 'invalid') return;
    // 上游不可达 / 禁用 / 内部错误：显式失败（不静默放行）。
    return replyForResolution(req, reply, resolution);
  };
}

/**
 * bestEffortAuth（10-auth §3.3，Codex r2 P0）：logout 专用「永不拦」鉴权。
 *   - 能解出会话则注入 req.auth（handler 可据此带 Logto end_session）；
 *   - 任何失败一律【放行】、绝不回错误信封——含 token 无效 / 上游不可达（JWKS 不可达）/ 账号禁用 / 内部错误。
 *   与 optionalAuth 的差别：optionalAuth 在「上游不可达 / 禁用 / 内部错误」时仍显式失败（503/403/500），
 *   会让 logout 在 Logto/JWKS 不可达时先被 503 拦、清不了 cookie，违反 logout 200 幂等清 cookie 契约。
 *   bestEffortAuth 把这些都吞掉：logout 的语义是「无论如何都清会话并返成功」，鉴权只是「锦上添花」。
 *   仍是一个 preHandler（满足写命令守卫链守门 routes.test），但承诺永不短路 / 永不抛。
 */
export function bestEffortAuth(): preHandlerHookHandler {
  return async (req) => {
    try {
      const resolution = await resolveAuth(req);
      if (resolution.kind === 'ok') req.auth = resolution.ctx;
      // 其余一切（anonymous / invalid / upstream_unavailable / disabled / internal）：放行，不回错误信封。
    } catch {
      // resolveAuth 已收口异常为分类结果，理论不抛；防御性兜底——绝不让 logout 因鉴权抛错而清不了 cookie。
    }
  };
}

/**
 * requireSseAuth（脊柱 §11.C，Codex#4）：SSE 端点专用守卫。
 *   - 仅接受【同源 Cookie 会话】；显式【拒绝】Authorization 头 / query-string token。
 *   - 鉴权失败在【建流前】返 HTTP 401 ErrorEnvelope（不走 SSE error 帧）。
 *   - 带 Authorization 头或 query token 视为不合规来源 → 同样 401（不静默回落 Cookie，防混用绕过）。
 * owner/资源权限校验由 handler 在建流前做（脊柱 §11.C：建流前 HTTP 失败）。
 */
export function requireSseAuth(): preHandlerHookHandler {
  return async (req, reply) => {
    // 显式拒绝非 Cookie 来源（Authorization 头 / query token），不静默回落。
    const hasBearer =
      typeof req.headers.authorization === 'string' &&
      req.headers.authorization.startsWith('Bearer ');
    const q = req.query as { token?: string; access_token?: string } | undefined;
    const hasQueryToken = Boolean(q?.token || q?.access_token);
    if (hasBearer || hasQueryToken) {
      // 来源不合规：SSE 只认同源 Cookie（脊柱 §11.C）。
      send401(req, reply);
      return reply;
    }
    const resolution = await resolveSseAuth(req);
    if (resolution.kind !== 'ok') return replyForResolution(req, reply, resolution);
    req.auth = resolution.ctx;
  };
}

/**
 * requireReviewer（50-publish §2.6，Codex#7）：评审端点专用守卫。
 *   - requireAuth + 断言 'reviewer' 角色（创作者无 reviewer 角色 → 403）。
 *   - 禁创作者自审：查被评审能力体 owner（capabilities.creator_user_id），== 评审者 userId → 403
 *     （「评审动作不暴露给创作者本人对自己能力放行」，50 §2.6）。
 *   capabilityId 从 path 取（POST /publications/:capabilityId/review）。
 */
export function requireReviewer(): preHandlerHookHandler {
  return async (req, reply) => {
    const resolution = await resolveAuth(req);
    if (resolution.kind !== 'ok') return replyForResolution(req, reply, resolution);
    const ctx = resolution.ctx;
    if (!ctx.roles.includes('reviewer')) {
      send403(req, reply);
      return reply;
    }
    // 禁自审：查被评审能力体的 creator，命中即拒（创作者不可评审自己）。
    const { capabilityId } = req.params as { capabilityId?: string };
    if (capabilityId) {
      let creatorUserId: string | undefined;
      try {
        const res = await req.server.infra.db.query<{ creator_user_id: string }>(
          'SELECT creator_user_id FROM capabilities WHERE id = $1',
          [capabilityId],
        );
        creatorUserId = res.rows[0]?.creator_user_id;
      } catch {
        send500(req, reply);
        return reply;
      }
      // 能力体不存在 → 404（不暴露存在性给越权者前先过角色，此处资源缺失走 NOT_FOUND）。
      if (creatorUserId === undefined) {
        reply.code(404).send(buildError(ErrorCode.NOT_FOUND, req.id));
        return reply;
      }
      if (creatorUserId === ctx.userId) {
        // 创作者评审自己 → 403（50 §2.6）。
        send403(req, reply, '不能评审自己的内容。');
        return reply;
      }
    }
    req.auth = ctx;
  };
}

/**
 * owner 可见性断言（10-auth §6.3）：在 requireAuth 之后，handler 内断言资源属当前用户。
 * 不匹配 → 抛可被错误处理器转 403 的标记（或 handler 直接 reply）。返回 boolean 供 handler 决策。
 */
export function isOwner(req: FastifyRequest, ownerUserId: string): boolean {
  return req.auth?.userId === ownerUserId;
}

/** owner 校验失败便捷回复（人话「你没有权限查看这个内容」）。 */
export function replyForbiddenOwner(req: FastifyRequest, reply: FastifyReply): void {
  send403(req, reply, '你没有权限查看这个内容。');
}

// 10 · Auth / Logto 域 handler（B-08，10-auth §3）：登录流真实链路 + cb_session 会话层。
//   GET  /auth/login    → 302 跳 Logto 授权端点（PKCE S256 + state + nonce，落短时 auth_tx cookie）。
//   GET  /auth/callback → 校 state、code 换 token、验 id_token（aud=LOGTO_APP_ID + nonce）、
//                         验 access_token（aud=LOGTO_AUDIENCE）、首登 provision、种 cb_session、302 回站内。
//   POST /auth/logout   → 清 cb_session（+ 可选 Logto end_session URL），200 Envelope（未登录幂等成功）。
//   GET  /me            → requireAuth：读 MeView（creatorId=users.id + 角色 + hasProfile）。
//
// 会话模型（cb_session）：HttpOnly + Secure(prod) + SameSite=Lax Cookie，【承载 Logto access_token（JWT）】
//   （10-auth §2「会话 Cookie 承载 access_token」）。requireAuth / requireSseAuth 从 cb_session 取出该 JWT
//   走同一套 verifyLogtoJwt（infra/logto.ts）→ provision → AuthContext，故 callback 种的会话能被后续受保护
//   端点 / 同源 Cookie SSE 鉴权直接识别（无需独立会话存储）。Bearer JWT（API client）与之并存、Bearer 优先。
//
// 失败口径（脊柱 §11.B / 10-auth §3.2）：callback 失败一律 302 回 /login?failureId=<opaque>（随机短串，不带内部
//   code / OIDC 原始报错 / 上游状态）；服务端把 failureId → 内部 code + traceId 落日志。login 上游不可达走 escalate。
import type { FastifyReply, FastifyRequest, RouteHandlerMethod } from 'fastify';
import {
  buildError,
  buildErrorWithCode,
  ErrorCode,
  RoleSchema,
  type Envelope,
  type LogoutResult,
  type MeView,
  type Role,
} from '@cb/shared';
import { provisionUser, readMeRow } from '../../platform/infra/users-repo.js';
import { verifyLogtoIdToken, verifyLogtoJwt } from '../../platform/infra/logto.js';
import {
  DEFAULT_DEV_USER,
  DEV_SESSION_MAX_AGE,
  devLoginAvailable,
  signDevSession,
} from '../../platform/infra/dev-session.js';
import {
  buildAuthorizeUrl,
  buildLogoutUrl,
  exchangeCodeForToken,
  pkceChallengeS256,
  randomToken,
  readNonceFromIdToken,
  sanitizeReturnTo,
  type AuthTx,
} from '../../platform/infra/logto-oidc.js';
import { SESSION_COOKIE } from '../../platform/middleware/auth.js';

/** 短时登录事务 Cookie 名（10-auth §3.1：HttpOnly，TTL ≤10min，存 state/nonce/code_verifier/returnTo）。 */
export const AUTH_TX_COOKIE = 'cb_auth_tx';

/** auth_tx cookie TTL（秒）：≤10min（10-auth §3.1）。 */
const AUTH_TX_MAX_AGE = 600;

/** cb_session cookie TTL（秒）：会话 Cookie 承载 access_token，给到 8h（token 自带 exp，过期由验签拦）。 */
const SESSION_MAX_AGE = 8 * 60 * 60;

/** 登录失败重定向落点（10-auth §3.2：/login?failureId=<opaque>）。 */
const LOGIN_PATH = '/login';

/** 是否生产（决定 Cookie Secure）。 */
function isProd(req: FastifyRequest): boolean {
  return req.server.infra.env.NODE_ENV === 'production';
}

/** auth_tx cookie 写入选项（HttpOnly + SameSite=Lax + 短 TTL；回调用 path /api/v1/auth 收窄即可，但用 / 稳妥）。 */
function authTxCookieOpts(req: FastifyRequest) {
  return {
    httpOnly: true,
    secure: isProd(req),
    sameSite: 'lax' as const,
    path: '/',
    maxAge: AUTH_TX_MAX_AGE,
  };
}

/** cb_session cookie 写入选项（10-auth §2：HttpOnly + Secure(prod) + SameSite=Lax）。 */
function sessionCookieOpts(req: FastifyRequest) {
  return {
    httpOnly: true,
    secure: isProd(req),
    sameSite: 'lax' as const,
    path: '/',
    maxAge: SESSION_MAX_AGE,
  };
}

/** 清 cookie 选项（与写入的 path/属性对齐，确保浏览器真删）。 */
function clearCookieOpts(req: FastifyRequest) {
  return {
    httpOnly: true,
    secure: isProd(req),
    sameSite: 'lax' as const,
    path: '/',
  };
}

/** 读 auth_tx（回调比对 state/nonce + 取 code_verifier/returnTo）；缺失/畸形 → null。 */
function readAuthTx(req: FastifyRequest): AuthTx | null {
  const raw = req.cookies?.[AUTH_TX_COOKIE];
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<AuthTx>;
    if (
      typeof parsed.state === 'string' &&
      typeof parsed.nonce === 'string' &&
      typeof parsed.codeVerifier === 'string' &&
      typeof parsed.returnTo === 'string'
    ) {
      return {
        state: parsed.state,
        nonce: parsed.nonce,
        codeVerifier: parsed.codeVerifier,
        returnTo: parsed.returnTo,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 失败重定向（10-auth §3.2，脊柱 §11.B Codex#11）：302 回 /login?failureId=<opaque>。
 *   - failureId = 随机短串（不含内部 code）；内部 code + traceId 落日志（经 traceId 关联排障）。
 *   - 绝不把内部 code / OIDC 原始 error / 上游状态进 URL；清 auth_tx（事务已终结）。
 */
function redirectFailure(
  req: FastifyRequest,
  reply: FastifyReply,
  internalCode: (typeof ErrorCode)[keyof typeof ErrorCode],
): FastifyReply {
  const failureId = randomToken(12);
  // 内部 code + traceId + failureId 落日志（对外只出 opaque failureId）。
  req.log.warn(
    { code: internalCode, traceId: req.id, failureId },
    'auth callback failed (opaque failureId to client)',
  );
  reply.clearCookie(AUTH_TX_COOKIE, clearCookieOpts(req));
  reply.redirect(`${LOGIN_PATH}?failureId=${encodeURIComponent(failureId)}`, 302);
  return reply;
}

// ===========================================================================
// GET /auth/login — 发起登录（302 跳 Logto，10-auth §3.1）
// ===========================================================================

/**
 * 发起登录：生成 state/nonce/PKCE，落短时 auth_tx cookie，302 到 Logto 授权端点。
 *   - returnTo 经白名单（仅站内相对路径，防 open redirect）；非法降级 /creator。
 *   - discovery 不可达（拉不到 authorization_endpoint）→ 失败重定向（escalate 类，不在 URL 暴露内部错）。
 */
export function loginHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const env = req.server.infra.env;
    const q = req.query as { returnTo?: string; prompt?: string };
    const returnTo = sanitizeReturnTo(q.returnTo);

    const state = randomToken();
    const nonce = randomToken();
    const codeVerifier = randomToken();
    const codeChallenge = pkceChallengeS256(codeVerifier);

    const authorizeUrl = await buildAuthorizeUrl({
      env,
      state,
      nonce,
      codeChallenge,
      ...(q.prompt ? { prompt: q.prompt } : {}),
    });
    // 上游不可达（discovery 拉不到）：不裸返 JSON 错、不暴露内部错；按失败重定向语义回登录页。
    if (!authorizeUrl) {
      req.log.warn(
        { code: ErrorCode.AUTH_UPSTREAM_UNAVAILABLE, traceId: req.id },
        'auth login: discovery unreachable',
      );
      reply.redirect(LOGIN_PATH, 302);
      return reply;
    }

    const tx: AuthTx = { state, nonce, codeVerifier, returnTo };
    reply.setCookie(AUTH_TX_COOKIE, JSON.stringify(tx), authTxCookieOpts(req));
    reply.redirect(authorizeUrl, 302);
    return reply;
  };
}

// ===========================================================================
// GET /auth/callback — OIDC 回调换会话（302 回站内，10-auth §3.2）
// ===========================================================================

/**
 * 回调换会话：校 state → code 换 token → 验 id_token(nonce) → 首登 provision → 种 cb_session → 302 回 returnTo。
 *   失败一律 302 回 /login?failureId=<opaque>（不带内部 code / OIDC 原始报错，§3.2 / 脊柱 §11.B）：
 *     - Logto 取消授权 error=access_denied → AUTH_CONSENT_DENIED。
 *     - state 不匹配 / auth_tx 缺失过期 → AUTH_STATE_MISMATCH。
 *     - code 换 token 失败 / id_token 校验不过 → AUTH_CALLBACK_FAILED。
 *     - token 端点不可达 / 超时 → AUTH_UPSTREAM_UNAVAILABLE。
 */
export function callbackHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const env = req.server.infra.env;
    const q = req.query as {
      code?: string;
      state?: string;
      error?: string;
      error_description?: string;
    };

    // 1) Logto 侧错误（用户取消授权等）：失败重定向（不透传 OIDC 原始 error/description）。
    if (q.error) {
      return redirectFailure(req, reply, ErrorCode.AUTH_CONSENT_DENIED);
    }

    const tx = readAuthTx(req);
    // 2) state 校验（CSRF）：auth_tx 缺失/过期 或 state 不匹配 → AUTH_STATE_MISMATCH。
    if (!tx || !q.state || q.state !== tx.state || !q.code) {
      return redirectFailure(req, reply, ErrorCode.AUTH_STATE_MISMATCH);
    }

    // 3) code + code_verifier 换 token。
    const exchanged = await exchangeCodeForToken(env, q.code, tx.codeVerifier);
    if (exchanged.kind === 'upstream_unavailable') {
      return redirectFailure(req, reply, ErrorCode.AUTH_UPSTREAM_UNAVAILABLE);
    }
    if (exchanged.kind === 'failed') {
      return redirectFailure(req, reply, ErrorCode.AUTH_CALLBACK_FAILED);
    }

    // 4) 验 id_token（若有）：JWKS + iss + aud(=LOGTO_APP_ID) + exp（verifyLogtoIdToken）+ nonce 比对（§3.2 步 3）。
    //    id_token 的 aud 是 client_id（LOGTO_APP_ID），与 access_token 的 aud（API resource）职责分开——
    //    必须用 verifyLogtoIdToken，绝不能用 verifyLogtoJwt（那校 LOGTO_AUDIENCE，生产 id_token 恒不过）。
    if (exchanged.idToken) {
      const idVerify = await verifyLogtoIdToken(exchanged.idToken, env);
      if (idVerify.kind === 'upstream_unavailable') {
        return redirectFailure(req, reply, ErrorCode.AUTH_UPSTREAM_UNAVAILABLE);
      }
      if (idVerify.kind === 'invalid') {
        return redirectFailure(req, reply, ErrorCode.AUTH_CALLBACK_FAILED);
      }
      const idNonce = readNonceFromIdToken(exchanged.idToken);
      if (idNonce !== tx.nonce) {
        return redirectFailure(req, reply, ErrorCode.AUTH_CALLBACK_FAILED);
      }
    }

    // 5) 用 access_token 验签取身份（aud = API resource，verifyLogtoJwt）：cb_session 承载的就是它，
    //    用与受保护路由中间件同一套验签，保证种进 cookie 的 token 后续能被认（aud 口径一致）。
    const accessVerify = await verifyLogtoJwt(exchanged.accessToken, env);
    if (accessVerify.kind === 'upstream_unavailable') {
      return redirectFailure(req, reply, ErrorCode.AUTH_UPSTREAM_UNAVAILABLE);
    }
    if (accessVerify.kind === 'invalid') {
      return redirectFailure(req, reply, ErrorCode.AUTH_CALLBACK_FAILED);
    }

    // 6) 首登 upsert provision（按 logto_user_id=sub 查/建 users，§7）。
    try {
      await provisionUser(req.server.infra.db, {
        logtoUserId: accessVerify.token.sub,
        account: accessVerify.token.account,
        email: accessVerify.token.email,
        roles: accessVerify.token.roles,
      });
    } catch {
      // provision DB 异常：不裸露（脊柱 §11.B），按上游不可达语义失败重定向（可重试）。
      return redirectFailure(req, reply, ErrorCode.AUTH_UPSTREAM_UNAVAILABLE);
    }

    // 7) 种 cb_session（承载 access_token JWT），清 auth_tx，302 回站内 returnTo。
    reply.setCookie(SESSION_COOKIE, exchanged.accessToken, sessionCookieOpts(req));
    reply.clearCookie(AUTH_TX_COOKIE, clearCookieOpts(req));
    reply.redirect(tx.returnTo, 302);
    return reply;
  };
}

// ===========================================================================
// POST /auth/logout — 登出（200 Envelope，10-auth §3.3）
// ===========================================================================

/**
 * 登出：清 cb_session（+ 可选 Logto end_session URL），200 Envelope<{loggedOut:true}>。
 *   - optionalAuth：未登录调用同样 200（幂等，不报 401）。
 *   - logoutUrl 可选（前端可再跳 Logto 结束 IdP 会话）；拉不到则只清本地会话（不阻塞）。
 */
export function logoutHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const env = req.server.infra.env;
    // 清会话 Cookie（已登录或未登录都执行，幂等）。
    reply.clearCookie(SESSION_COOKIE, clearCookieOpts(req));
    // 兜带清残留 auth_tx（防中断的登录事务遗留）。
    reply.clearCookie(AUTH_TX_COOKIE, clearCookieOpts(req));

    const logoutUrl = await buildLogoutUrl(env);
    const result: LogoutResult = logoutUrl ? { loggedOut: true, logoutUrl } : { loggedOut: true };
    const body: Envelope<LogoutResult> = { data: result, meta: { traceId: req.id } };
    reply.code(200).send(body);
    return reply;
  };
}

// ===========================================================================
// GET /me — 当前登录用户（requireAuth，10-auth §3.4）
// ===========================================================================

/**
 * 当前登录用户视图（MeView）：requireAuth 已注入 req.auth；按 userId 读 users 行 + hasProfile。
 *   creatorId = id（主页 /creators/{creatorId}/profile 寻址）；profile 全字段不在此（属主页域）。
 */
export function meHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const userId = req.auth?.userId;
    if (!userId) {
      // 理论不可达（requireAuth 守门）；防御性 401。
      const { code, envelope } = buildErrorWithCode(ErrorCode.UNAUTHENTICATED, req.id);
      req.log.warn({ code, traceId: req.id }, 'me: missing auth context after requireAuth');
      reply.code(401).send(envelope);
      return reply;
    }

    let row;
    try {
      row = await readMeRow(req.server.infra.db, userId);
    } catch {
      const { code, envelope } = buildErrorWithCode(ErrorCode.INTERNAL, req.id);
      req.log.error({ code, traceId: req.id }, 'me: readMeRow failed');
      reply.code(500).send(envelope);
      return reply;
    }
    // 找不到（理论不可达，requireAuth 已 provision）→ 当作登录态失效让前端重登。
    if (!row) {
      const { code, envelope } = buildErrorWithCode(ErrorCode.UNAUTHENTICATED, req.id);
      req.log.warn({ code, traceId: req.id }, 'me: user row not found for authed userId');
      reply.code(401).send(envelope);
      return reply;
    }

    const me: MeView = {
      id: row.id,
      logtoUserId: row.logtoUserId,
      account: row.account,
      email: row.email,
      roles: row.roles,
      status: row.status,
      hasProfile: row.hasProfile,
      creatorId: row.id, // = id（主页寻址）
      createdAt: row.createdAt,
      lastLoginAt: row.lastLoginAt,
    };
    const body: Envelope<MeView> = { data: me, meta: { traceId: req.id } };
    reply.code(200).send(body);
    return reply;
  };
}

// ===========================================================================
// POST /auth/dev-login — 仅 dev/test 种子登录（live 测试拿有效会话跑主链路，10-auth 外挂）
// ===========================================================================

/** dev-login 请求体（全可选）：指定测试用户 email + role；缺省 = seeded 测试创作者 Wayne / creator。 */
interface DevLoginBody {
  email?: string;
  account?: string;
  role?: string;
  roles?: string[];
}

/**
 * 解析 dev-login body 的角色（RoleSchema 过滤，单 role 或 roles[] 都接受；缺省 creator）。
 *   非法/未知角色被丢弃；全空则回落默认创作者角色（绝不强转 raw string，与全局口径一致）。
 */
function resolveDevRoles(body: DevLoginBody): Role[] {
  const candidates: string[] = [];
  if (typeof body.role === 'string') candidates.push(body.role);
  if (Array.isArray(body.roles)) {
    for (const r of body.roles) if (typeof r === 'string') candidates.push(r);
  }
  const seen = new Set<Role>();
  const out: Role[] = [];
  for (const c of candidates) {
    const parsed = RoleSchema.safeParse(c);
    if (parsed.success && !seen.has(parsed.data)) {
      seen.add(parsed.data);
      out.push(parsed.data);
    }
  }
  return out.length > 0 ? out : DEFAULT_DEV_USER.roles;
}

/**
 * 仅 dev/test 种子登录（安全双守卫，绝不上生产）：
 *   - 仅当 devLoginAvailable(env)（NODE_ENV≠prod 且 DEV_LOGIN_ENABLED=true 且有 DEV_SESSION_SECRET）才工作；
 *     否则当作【不存在】返 404 NOT_FOUND（不暴露端点存在性——routes 也只在可用时注册，此处再兜一层）。
 *   - body 可指定 email/role（缺省 seeded 测试创作者 Wayne / creator）；provisionUser 建/取 users 行；
 *     用 app 侧 DEV_SESSION_SECRET 签 HS256 dev 会话写 cb_session cookie（httpOnly/sameSite），返 MeView。
 *   - cb_session 承载的是 dev token（非 Logto JWT）；requireAuth/SSE 的 dev 验证分支（同双守卫）认它。
 * ErrorEnvelope 无 code（D1）；复用 provisionUser/readMeRow/MeView，不另造抽象。
 */
export function devLoginHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const env = req.server.infra.env;
    // 双守卫兜底：不可用即「不存在」（404），绝不在生产/关闭态签发会话。
    if (!devLoginAvailable(env)) {
      const { code, envelope } = buildErrorWithCode(ErrorCode.NOT_FOUND, req.id);
      req.log.warn({ code, traceId: req.id }, 'dev-login hit while unavailable (guarded)');
      reply.code(404).send(envelope);
      return reply;
    }

    const body = (req.body ?? {}) as DevLoginBody;
    const email =
      typeof body.email === 'string' && body.email.trim()
        ? body.email.trim()
        : DEFAULT_DEV_USER.email;
    const account =
      typeof body.account === 'string' && body.account.trim()
        ? body.account.trim()
        : DEFAULT_DEV_USER.account;
    const roles = resolveDevRoles(body);
    // 稳定 sub（去重键）：默认 Wayne 用固定 sub；自定义 email 派生稳定 sub，复登命中同一 users 行。
    const sub =
      email === DEFAULT_DEV_USER.email ? DEFAULT_DEV_USER.sub : `dev|${email.toLowerCase()}`;

    // provision（建/取 users 行）：与真实登录同一条 provisionUser，得业务 users.id（owner 真源）。
    let provisioned;
    try {
      provisioned = await provisionUser(req.server.infra.db, {
        logtoUserId: sub,
        account,
        email,
        roles,
      });
    } catch {
      const { code, envelope } = buildErrorWithCode(ErrorCode.INTERNAL, req.id);
      req.log.error({ code, traceId: req.id }, 'dev-login: provisionUser failed');
      reply.code(500).send(envelope);
      return reply;
    }
    if (provisioned.status === 'disabled') {
      reply
        .code(403)
        .send(
          buildError(ErrorCode.FORBIDDEN, req.id, { userMessage: '账号当前不可用，请联系支持。' }),
        );
      return reply;
    }

    // 签 dev 会话（HS256，DEV_SESSION_SECRET）写 cb_session（与 callback 同 cookie 名/属性）。
    const token = await signDevSession(env, {
      sub,
      roles: provisioned.roles, // 以库内（provision 回写）为权威
      account: provisioned.account,
      email,
    });
    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      secure: isProd(req), // dev/test 下非 prod → false（http localhost 可用）
      sameSite: 'lax',
      path: '/',
      maxAge: DEV_SESSION_MAX_AGE,
    });

    // 返 MeView（与 /me 同视图）：前端/测试拿到会话后即可读身份。
    let row;
    try {
      row = await readMeRow(req.server.infra.db, provisioned.id);
    } catch {
      const { code, envelope } = buildErrorWithCode(ErrorCode.INTERNAL, req.id);
      req.log.error({ code, traceId: req.id }, 'dev-login: readMeRow failed');
      reply.code(500).send(envelope);
      return reply;
    }
    if (!row) {
      const { code, envelope } = buildErrorWithCode(ErrorCode.INTERNAL, req.id);
      req.log.error({ code, traceId: req.id }, 'dev-login: user row missing after provision');
      reply.code(500).send(envelope);
      return reply;
    }
    const me: MeView = {
      id: row.id,
      logtoUserId: row.logtoUserId,
      account: row.account,
      email: row.email,
      roles: row.roles,
      status: row.status,
      hasProfile: row.hasProfile,
      creatorId: row.id,
      createdAt: row.createdAt,
      lastLoginAt: row.lastLoginAt,
    };
    const resBody: Envelope<MeView> = { data: me, meta: { traceId: req.id } };
    reply.code(200).send(resBody);
    return reply;
  };
}

// 10 · Auth 登录流 + cb_session 会话层自检（B-08，10-auth §3.1/§3.2/§3.3/§3.4）。
//   无真实 Logto/PG：mock logto-oidc（discovery/authorize/token 换/nonce）+ verifyLogtoJwt + provisionUser/readMeRow。
//   覆盖：
//     login   → 302 带 state/nonce/PKCE（落 auth_tx cookie），上游不可达降级 302（不裸返 JSON 错）。
//     callback→ 校 state + 换 token + 验 id_token(nonce) + provision + 种 cb_session + 302 回 returnTo；
//               失败一律 302 /login?failureId=<opaque>（无内部 code / 无 OIDC 原始报错）。
//     logout  → 200 Envelope<{loggedOut:true}> 清 cb_session（含未登录幂等）。
//     me      → 200 Envelope<MeView>（creatorId=userId）。
//     会话层贯穿 → callback 种的 cb_session 能被 requireAuth / requireSseAuth 经同套验签识别。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type * as LogtoOidcModule from '../platform/infra/logto-oidc.js';

// —— mock OIDC 流（discovery/authorize/token 换/nonce/PKCE）——
const buildAuthorizeUrlMock = vi.fn();
const exchangeCodeForTokenMock = vi.fn();
const buildLogoutUrlMock = vi.fn();
const readNonceFromIdTokenMock = vi.fn();
vi.mock('../platform/infra/logto-oidc.js', async () => {
  const actual = await vi.importActual<typeof LogtoOidcModule>('../platform/infra/logto-oidc.js');
  return {
    ...actual, // randomToken / pkceChallengeS256 / sanitizeReturnTo 用真实实现
    buildAuthorizeUrl: (...a: unknown[]) => buildAuthorizeUrlMock(...a),
    exchangeCodeForToken: (...a: unknown[]) => exchangeCodeForTokenMock(...a),
    buildLogoutUrl: (...a: unknown[]) => buildLogoutUrlMock(...a),
    readNonceFromIdToken: (...a: unknown[]) => readNonceFromIdTokenMock(...a),
  };
});

// —— mock 验签 + 仓储 ——
//   verifyLogtoJwt（access_token，aud=LOGTO_AUDIENCE）与 verifyLogtoIdToken（id_token，aud=LOGTO_APP_ID）
//   两支分开 mock，断言 callback 对 id_token 走 IdToken 支、对 access_token 走 Jwt 支（职责分开，Codex r2 P0）。
const verifyMock = vi.fn();
const verifyIdMock = vi.fn();
const provisionMock = vi.fn();
const readMeRowMock = vi.fn();
vi.mock('../platform/infra/logto.js', () => ({
  verifyLogtoJwt: (...a: unknown[]) => verifyMock(...a),
  verifyLogtoIdToken: (...a: unknown[]) => verifyIdMock(...a),
}));
vi.mock('../platform/infra/users-repo.js', () => ({
  provisionUser: (...a: unknown[]) => provisionMock(...a),
  readMeRow: (...a: unknown[]) => readMeRowMock(...a),
}));

const { loginHandler, callbackHandler, logoutHandler, meHandler, AUTH_TX_COOKIE } =
  await import('../modules/account/handlers.js');
const { SESSION_COOKIE } = await import('../platform/middleware/auth.js');

// ---------------------------------------------------------------------------
// mock req/reply（捕获 redirect / setCookie / clearCookie / send / code）
// ---------------------------------------------------------------------------
interface Sent {
  code?: number;
  body?: unknown;
  redirectUrl?: string;
  redirectCode?: number;
  cookies: Record<string, { value: string; opts?: Record<string, unknown> }>;
  cleared: Set<string>;
}

function makeReply(): { reply: FastifyReply; sent: Sent } {
  const sent: Sent = { cookies: {}, cleared: new Set() };
  const reply = {
    code: vi.fn(function (this: unknown, c: number) {
      sent.code = c;
      return this;
    }),
    send: vi.fn((b: unknown) => {
      sent.body = b;
      return reply;
    }),
    redirect: vi.fn((url: string, code?: number) => {
      sent.redirectUrl = url;
      sent.redirectCode = code;
      return reply;
    }),
    setCookie: vi.fn((name: string, value: string, opts?: Record<string, unknown>) => {
      sent.cookies[name] = { value, ...(opts ? { opts } : {}) };
      return reply;
    }),
    clearCookie: vi.fn((name: string) => {
      sent.cleared.add(name);
      return reply;
    }),
  } as unknown as FastifyReply;
  return { reply, sent };
}

function makeReq(
  opts: {
    query?: Record<string, unknown>;
    cookies?: Record<string, string>;
    auth?: { userId: string };
    env?: Record<string, unknown>;
  } = {},
): FastifyRequest {
  return {
    id: 'trace-authflow',
    query: opts.query ?? {},
    cookies: opts.cookies ?? {},
    headers: {},
    params: {},
    ...(opts.auth ? { auth: opts.auth } : {}),
    log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
    server: {
      infra: {
        db: { query: vi.fn() },
        env: { NODE_ENV: 'test', ...(opts.env ?? {}) },
      },
    },
  } as unknown as FastifyRequest;
}

beforeEach(() => {
  buildAuthorizeUrlMock.mockReset();
  exchangeCodeForTokenMock.mockReset();
  buildLogoutUrlMock.mockReset();
  readNonceFromIdTokenMock.mockReset();
  verifyMock.mockReset();
  verifyIdMock.mockReset();
  provisionMock.mockReset();
  readMeRowMock.mockReset();
});

// ===========================================================================
// GET /auth/login
// ===========================================================================
describe('GET /auth/login (10-auth §3.1)', () => {
  it('302 跳授权 URL，落 auth_tx cookie（含 state/nonce/code_verifier/returnTo）', async () => {
    buildAuthorizeUrlMock.mockResolvedValue(
      'http://logto/oidc/auth?client_id=x&state=S&nonce=N&code_challenge=C',
    );
    const req = makeReq({ query: { returnTo: '/creator/dashboard' } });
    const { reply, sent } = makeReply();
    await (loginHandler() as (r: FastifyRequest, rep: FastifyReply) => Promise<unknown>)(
      req,
      reply,
    );

    expect(sent.redirectCode).toBe(302);
    expect(sent.redirectUrl).toContain('http://logto/oidc/auth');
    // auth_tx 落短时 HttpOnly cookie。
    const tx = sent.cookies[AUTH_TX_COOKIE];
    expect(tx).toBeTruthy();
    expect(tx!.opts?.httpOnly).toBe(true);
    expect(tx!.opts?.sameSite).toBe('lax');
    const parsed = JSON.parse(tx!.value) as Record<string, string>;
    expect(parsed.state).toBeTruthy();
    expect(parsed.nonce).toBeTruthy();
    expect(parsed.codeVerifier).toBeTruthy();
    expect(parsed.returnTo).toBe('/creator/dashboard');
    // buildAuthorizeUrl 入参带 PKCE challenge + state + nonce。
    const callArg = buildAuthorizeUrlMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(callArg.state).toBe(parsed.state);
    expect(callArg.nonce).toBe(parsed.nonce);
    expect(callArg.codeChallenge).toBeTruthy();
  });

  it('外站 returnTo（open redirect）降级为 /creator（白名单）', async () => {
    buildAuthorizeUrlMock.mockResolvedValue('http://logto/oidc/auth?x=1');
    const req = makeReq({ query: { returnTo: 'https://evil.com/phish' } });
    const { reply, sent } = makeReply();
    await (loginHandler() as never as (r: FastifyRequest, rep: FastifyReply) => Promise<unknown>)(
      req,
      reply,
    );
    const tx = JSON.parse(sent.cookies[AUTH_TX_COOKIE]!.value) as Record<string, string>;
    expect(tx.returnTo).toBe('/creator');
  });

  it('discovery 不可达（authorize URL 拉不到）→ 仍 302 降级回 /login，不裸返 JSON 错', async () => {
    buildAuthorizeUrlMock.mockResolvedValue(null);
    const req = makeReq();
    const { reply, sent } = makeReply();
    await (loginHandler() as never as (r: FastifyRequest, rep: FastifyReply) => Promise<unknown>)(
      req,
      reply,
    );
    expect(sent.redirectCode).toBe(302);
    expect(sent.redirectUrl).toBe('/login');
    expect(sent.code).toBeUndefined(); // 不是 JSON 错误响应
    expect(sent.cookies[AUTH_TX_COOKIE]).toBeUndefined(); // 没换到 URL 不落 tx
  });
});

// ===========================================================================
// GET /auth/callback
// ===========================================================================
describe('GET /auth/callback (10-auth §3.2)', () => {
  /** 落一个有效 auth_tx cookie 的请求工具。 */
  function reqWithTx(
    query: Record<string, unknown>,
    tx: { state: string; nonce: string; codeVerifier: string; returnTo: string },
  ): FastifyRequest {
    return makeReq({ query, cookies: { [AUTH_TX_COOKIE]: JSON.stringify(tx) } });
  }

  const goodTx = {
    state: 'state-abc',
    nonce: 'nonce-xyz',
    codeVerifier: 'verifier-123',
    returnTo: '/creator',
  };

  it('成功：校 state→换 token→验 id_token(aud=APP_ID,nonce)→验 access_token(aud=AUDIENCE)→provision→种 cb_session→302 回 returnTo', async () => {
    exchangeCodeForTokenMock.mockResolvedValue({
      kind: 'ok',
      accessToken: 'access.jwt.token',
      idToken: 'id.jwt.token',
    });
    // id_token 走 verifyLogtoIdToken（aud=LOGTO_APP_ID）：验签 OK。
    verifyIdMock.mockResolvedValue({
      kind: 'ok',
      token: { sub: 'logto-sub-1', roles: ['creator'], account: 'wayne', email: 'w@e.com' },
    });
    // access_token 走 verifyLogtoJwt（aud=LOGTO_AUDIENCE）：验签 OK，取身份种会话。
    verifyMock.mockResolvedValue({
      kind: 'ok',
      token: { sub: 'logto-sub-1', roles: ['creator'], account: 'wayne', email: 'w@e.com' },
    });
    readNonceFromIdTokenMock.mockReturnValue('nonce-xyz');
    provisionMock.mockResolvedValue({
      id: 'uuid-user-1',
      status: 'active',
      roles: ['creator'],
      account: 'wayne',
    });

    const req = reqWithTx({ code: 'auth-code', state: 'state-abc' }, goodTx);
    const { reply, sent } = makeReply();
    await (
      callbackHandler() as never as (r: FastifyRequest, rep: FastifyReply) => Promise<unknown>
    )(req, reply);

    // 职责分开（Codex r2 P0）：id_token 走 verifyLogtoIdToken，access_token 走 verifyLogtoJwt——绝不互换。
    expect(verifyIdMock).toHaveBeenCalledWith('id.jwt.token', expect.anything());
    expect(verifyIdMock).not.toHaveBeenCalledWith('access.jwt.token', expect.anything());
    expect(verifyMock).toHaveBeenCalledWith('access.jwt.token', expect.anything());
    expect(verifyMock).not.toHaveBeenCalledWith('id.jwt.token', expect.anything());

    // 种 cb_session = access_token（会话承载 JWT，10-auth §2）。
    const session = sent.cookies[SESSION_COOKIE];
    expect(session?.value).toBe('access.jwt.token');
    expect(session?.opts?.httpOnly).toBe(true);
    expect(session?.opts?.sameSite).toBe('lax');
    // 清 auth_tx + 302 回 returnTo。
    expect(sent.cleared.has(AUTH_TX_COOKIE)).toBe(true);
    expect(sent.redirectCode).toBe(302);
    expect(sent.redirectUrl).toBe('/creator');
    // provision 用 sub。
    expect(provisionMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ logtoUserId: 'logto-sub-1' }),
    );
  });

  it('id_token aud 不符（verifyLogtoIdToken→invalid）→ failureId 重定向，不种会话（access_token 不被误用验 id_token）', async () => {
    exchangeCodeForTokenMock.mockResolvedValue({
      kind: 'ok',
      accessToken: 'access.jwt.token',
      idToken: 'id.jwt.token',
    });
    // id_token 验签判无效（如 aud != LOGTO_APP_ID）——必须由 verifyLogtoIdToken 判定。
    verifyIdMock.mockResolvedValue({ kind: 'invalid' });
    const req = reqWithTx({ code: 'c', state: 'state-abc' }, goodTx);
    const { reply, sent } = makeReply();
    await (
      callbackHandler() as never as (r: FastifyRequest, rep: FastifyReply) => Promise<unknown>
    )(req, reply);
    expect(verifyIdMock).toHaveBeenCalledWith('id.jwt.token', expect.anything());
    expect(sent.redirectUrl).toMatch(/^\/login\?failureId=/);
    expect(sent.cookies[SESSION_COOKIE]).toBeUndefined(); // id_token 不过 → 不种会话
    expect(verifyMock).not.toHaveBeenCalled(); // id_token 没过就不进 access_token 验签
  });

  it('state 不匹配 → 302 /login?failureId=<opaque>（无内部 code / 无 OIDC 原始报错）', async () => {
    const req = reqWithTx({ code: 'c', state: 'WRONG-state' }, goodTx);
    const { reply, sent } = makeReply();
    await (
      callbackHandler() as never as (r: FastifyRequest, rep: FastifyReply) => Promise<unknown>
    )(req, reply);
    expect(sent.redirectCode).toBe(302);
    expect(sent.redirectUrl).toMatch(/^\/login\?failureId=/);
    // 绝不带内部 code（AUTH_STATE_MISMATCH 等）/ 状态码。
    expect(sent.redirectUrl).not.toMatch(/AUTH_|code=|\b[1-5]\d{2}\b/);
    expect(exchangeCodeForTokenMock).not.toHaveBeenCalled(); // state 没过不换 token
  });

  it('auth_tx 缺失（cookie 过期）→ failureId 重定向', async () => {
    const req = makeReq({ query: { code: 'c', state: 'state-abc' } }); // 无 auth_tx cookie
    const { reply, sent } = makeReply();
    await (
      callbackHandler() as never as (r: FastifyRequest, rep: FastifyReply) => Promise<unknown>
    )(req, reply);
    expect(sent.redirectUrl).toMatch(/^\/login\?failureId=/);
  });

  it('Logto 取消授权（error=access_denied）→ failureId 重定向（不透传 OIDC error）', async () => {
    const req = reqWithTx({ error: 'access_denied', error_description: 'User cancelled' }, goodTx);
    const { reply, sent } = makeReply();
    await (
      callbackHandler() as never as (r: FastifyRequest, rep: FastifyReply) => Promise<unknown>
    )(req, reply);
    expect(sent.redirectUrl).toMatch(/^\/login\?failureId=/);
    expect(sent.redirectUrl).not.toContain('access_denied');
    expect(sent.redirectUrl).not.toContain('cancelled');
  });

  it('code 换 token 失败（4xx）→ failureId 重定向（AUTH_CALLBACK_FAILED，无 code）', async () => {
    exchangeCodeForTokenMock.mockResolvedValue({ kind: 'failed' });
    const req = reqWithTx({ code: 'bad-code', state: 'state-abc' }, goodTx);
    const { reply, sent } = makeReply();
    await (
      callbackHandler() as never as (r: FastifyRequest, rep: FastifyReply) => Promise<unknown>
    )(req, reply);
    expect(sent.redirectUrl).toMatch(/^\/login\?failureId=/);
    expect(sent.cookies[SESSION_COOKIE]).toBeUndefined(); // 没种会话
  });

  it('token 端点不可达 → failureId 重定向（AUTH_UPSTREAM_UNAVAILABLE，escalate；仍无 code）', async () => {
    exchangeCodeForTokenMock.mockResolvedValue({ kind: 'upstream_unavailable' });
    const req = reqWithTx({ code: 'c', state: 'state-abc' }, goodTx);
    const { reply, sent } = makeReply();
    await (
      callbackHandler() as never as (r: FastifyRequest, rep: FastifyReply) => Promise<unknown>
    )(req, reply);
    expect(sent.redirectUrl).toMatch(/^\/login\?failureId=/);
    expect(sent.redirectUrl).not.toMatch(/\b[1-5]\d{2}\b/);
  });

  it('id_token nonce 不匹配 → failureId 重定向（防重放）', async () => {
    exchangeCodeForTokenMock.mockResolvedValue({
      kind: 'ok',
      accessToken: 'a.jwt',
      idToken: 'id.jwt',
    });
    // id_token 验签 OK（aud=APP_ID 走 verifyLogtoIdToken），但 nonce 比对不过。
    verifyIdMock.mockResolvedValue({
      kind: 'ok',
      token: { sub: 's', roles: ['creator'], account: 'a', email: null },
    });
    readNonceFromIdTokenMock.mockReturnValue('DIFFERENT-nonce'); // != tx.nonce
    const req = reqWithTx({ code: 'c', state: 'state-abc' }, goodTx);
    const { reply, sent } = makeReply();
    await (
      callbackHandler() as never as (r: FastifyRequest, rep: FastifyReply) => Promise<unknown>
    )(req, reply);
    expect(sent.redirectUrl).toMatch(/^\/login\?failureId=/);
    expect(sent.cookies[SESSION_COOKIE]).toBeUndefined();
    expect(verifyMock).not.toHaveBeenCalled(); // nonce 没过不进 access_token 验签
  });

  it('provision DB 异常 → failureId 重定向（不裸露，按上游不可达可重试）', async () => {
    exchangeCodeForTokenMock.mockResolvedValue({
      kind: 'ok',
      accessToken: 'a.jwt',
      idToken: null, // 无 id_token：跳过 nonce 校验，直接验 access_token
    });
    verifyMock.mockResolvedValue({
      kind: 'ok',
      token: { sub: 's', roles: ['creator'], account: 'a', email: null },
    });
    provisionMock.mockRejectedValue(new Error('db down'));
    const req = reqWithTx({ code: 'c', state: 'state-abc' }, goodTx);
    const { reply, sent } = makeReply();
    await (
      callbackHandler() as never as (r: FastifyRequest, rep: FastifyReply) => Promise<unknown>
    )(req, reply);
    expect(sent.redirectUrl).toMatch(/^\/login\?failureId=/);
    expect(sent.cookies[SESSION_COOKIE]).toBeUndefined();
  });
});

// ===========================================================================
// POST /auth/logout
// ===========================================================================
describe('POST /auth/logout (10-auth §3.3)', () => {
  it('已登录 → 200 Envelope<{loggedOut:true}> 清 cb_session（含 logoutUrl）', async () => {
    buildLogoutUrlMock.mockResolvedValue('http://logto/oidc/session/end?client_id=x');
    const req = makeReq({ auth: { userId: 'u1' }, cookies: { [SESSION_COOKIE]: 'sess.jwt' } });
    const { reply, sent } = makeReply();
    await (logoutHandler() as never as (r: FastifyRequest, rep: FastifyReply) => Promise<unknown>)(
      req,
      reply,
    );
    expect(sent.code).toBe(200);
    expect(sent.cleared.has(SESSION_COOKIE)).toBe(true);
    const body = sent.body as { data: { loggedOut: boolean; logoutUrl?: string } };
    expect(body.data.loggedOut).toBe(true);
    expect(body.data.logoutUrl).toContain('session/end');
  });

  it('未登录 → 同样 200 幂等成功（不报 401）', async () => {
    buildLogoutUrlMock.mockResolvedValue(null);
    const req = makeReq(); // 无 auth、无 cookie
    const { reply, sent } = makeReply();
    await (logoutHandler() as never as (r: FastifyRequest, rep: FastifyReply) => Promise<unknown>)(
      req,
      reply,
    );
    expect(sent.code).toBe(200);
    expect(sent.cleared.has(SESSION_COOKIE)).toBe(true);
    const body = sent.body as { data: { loggedOut: boolean; logoutUrl?: string } };
    expect(body.data.loggedOut).toBe(true);
    expect(body.data.logoutUrl).toBeUndefined(); // 拉不到 end_session 不带
  });

  it('带 cb_session 但 Logto end_session 不可达 → 仍 200 清两 cookie（handler 先清再 best-effort 拉 URL）', async () => {
    // handler 始终先清 cookie 再拉 logoutUrl；上游不可达 buildLogoutUrl 返 null（不抛），照常 200 清 cookie。
    buildLogoutUrlMock.mockResolvedValue(null);
    const req = makeReq({ cookies: { [SESSION_COOKIE]: 'cb.jwt' } });
    const { reply, sent } = makeReply();
    await (logoutHandler() as never as (r: FastifyRequest, rep: FastifyReply) => Promise<unknown>)(
      req,
      reply,
    );
    expect(sent.code).toBe(200);
    expect(sent.cleared.has(SESSION_COOKIE)).toBe(true);
    expect(sent.cleared.has(AUTH_TX_COOKIE)).toBe(true); // 兜带清残留 auth_tx
    const body = sent.body as { data: { loggedOut: boolean; logoutUrl?: string } };
    expect(body.data.loggedOut).toBe(true);
    expect(body.data.logoutUrl).toBeUndefined();
  });
});

// ===========================================================================
// GET /me
// ===========================================================================
describe('GET /me (10-auth §3.4)', () => {
  it('200 Envelope<MeView>（creatorId=userId，含 roles/hasProfile）', async () => {
    readMeRowMock.mockResolvedValue({
      id: 'uuid-user-1',
      logtoUserId: 'logto-sub-1',
      account: 'wayne',
      email: 'w@e.com',
      roles: ['creator'],
      status: 'active',
      hasProfile: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      lastLoginAt: '2026-06-01T00:00:00.000Z',
    });
    const req = makeReq({ auth: { userId: 'uuid-user-1' } });
    const { reply, sent } = makeReply();
    await (meHandler() as never as (r: FastifyRequest, rep: FastifyReply) => Promise<unknown>)(
      req,
      reply,
    );
    expect(sent.code).toBe(200);
    const body = sent.body as { data: Record<string, unknown> };
    expect(body.data.id).toBe('uuid-user-1');
    expect(body.data.creatorId).toBe('uuid-user-1'); // = id
    expect(body.data.roles).toEqual(['creator']);
    expect(body.data.hasProfile).toBe(true);
    expect(readMeRowMock).toHaveBeenCalledWith(expect.anything(), 'uuid-user-1');
  });

  it('readMeRow 抛错 → 500 ErrorEnvelope（无 code，D1）', async () => {
    readMeRowMock.mockRejectedValue(new Error('db down'));
    const req = makeReq({ auth: { userId: 'u1' } });
    const { reply, sent } = makeReply();
    await (meHandler() as never as (r: FastifyRequest, rep: FastifyReply) => Promise<unknown>)(
      req,
      reply,
    );
    expect(sent.code).toBe(500);
    expect((sent.body as { error: Record<string, unknown> }).error).not.toHaveProperty('code');
  });

  it('用户行不存在（理论不可达）→ 401 让前端重登（无 code）', async () => {
    readMeRowMock.mockResolvedValue(null);
    const req = makeReq({ auth: { userId: 'u-ghost' } });
    const { reply, sent } = makeReply();
    await (meHandler() as never as (r: FastifyRequest, rep: FastifyReply) => Promise<unknown>)(
      req,
      reply,
    );
    expect(sent.code).toBe(401);
    expect((sent.body as { error: Record<string, unknown> }).error).not.toHaveProperty('code');
  });
});

// ===========================================================================
// 会话层贯穿：callback 种的 cb_session 能被 requireAuth / requireSseAuth 经同套验签识别
// ===========================================================================
describe('cb_session 会话层贯穿（10-auth §2/§4 / §5）', () => {
  it('cb_session cookie（= access_token）被 requireAuth 经 verifyLogtoJwt 识别 → AuthContext', async () => {
    const { requireAuth } = await import('../platform/middleware/auth.js');
    verifyMock.mockResolvedValue({
      kind: 'ok',
      token: { sub: 'sub-session', roles: ['creator'], account: 'w', email: null },
    });
    provisionMock.mockResolvedValue({
      id: 'uuid-session',
      status: 'active',
      roles: ['creator'],
      account: 'w',
    });
    // 浏览器路径：无 Bearer 头，仅 cb_session cookie（= callback 种的 access_token）。
    const req = makeReq({ cookies: { [SESSION_COOKIE]: 'access.jwt.from.callback' } });
    const { reply, sent } = makeReply();
    await requireAuth()(req, reply, () => {});
    expect(sent.code).toBeUndefined(); // 放行
    expect(req.auth?.userId).toBe('uuid-session');
    // 验签拿到的就是 cb_session 里的 token。
    expect(verifyMock).toHaveBeenCalledWith('access.jwt.from.callback', expect.anything());
  });

  it('cb_session cookie 被 requireSseAuth 识别（同源 Cookie 鉴权，禁 Bearer/query）', async () => {
    const { requireSseAuth } = await import('../platform/middleware/auth.js');
    verifyMock.mockResolvedValue({
      kind: 'ok',
      token: { sub: 'sub-sse', roles: ['creator'], account: 'w', email: null },
    });
    provisionMock.mockResolvedValue({
      id: 'uuid-sse',
      status: 'active',
      roles: ['creator'],
      account: 'w',
    });
    const req = makeReq({ cookies: { [SESSION_COOKIE]: 'access.jwt.sse' } });
    const { reply, sent } = makeReply();
    await requireSseAuth()(req, reply, () => {});
    expect(sent.code).toBeUndefined();
    expect(req.auth?.userId).toBe('uuid-sse');
    expect(verifyMock).toHaveBeenCalledWith('access.jwt.sse', expect.anything());
  });
});

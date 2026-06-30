// 仅 dev/test 种子登录自检（安全双守卫为第一位）。无真实 Logto/PG：mock provisionUser/readMeRow + 真 jose 签验。
//   覆盖：
//     1) devLoginAvailable 双守卫真值表（生产/开关/密钥任一不满足 → false）；
//     2) sign→verify 往返（dev 会话验签通过解出 sub+roles，等价真实会话身份）；
//     3) requireAuth/requireSseAuth 接受 dev 会话（走 dev 兜底分支 → provision → AuthContext）；
//     4) dev-login handler 签发会话写 cb_session + 返 MeView；角色/owner（userId=users.id）正确；
//     5) 生产守卫（反向破坏可测）：NODE_ENV=production 时 devLoginAvailable=false、端点 handler 返 404、
//        中间件 dev 分支【不验】（dev token 仍被判 401）——去掉守卫则生产可登录，本组应转红。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Env } from '../platform/config/env.js';
import {
  DEFAULT_DEV_USER,
  devLoginAvailable,
  signDevSession,
  verifyDevSession,
} from '../platform/infra/dev-session.js';

// —— mock DB 仓储（无真 PG）：provisionUser/readMeRow，被中间件与 handler 共用 ——
const provisionMock = vi.fn();
const readMeRowMock = vi.fn();
vi.mock('../platform/infra/users-repo.js', () => ({
  provisionUser: (...args: unknown[]) => provisionMock(...args),
  readMeRow: (...args: unknown[]) => readMeRowMock(...args),
}));

// —— mock Logto 验签：dev 登录的 token 不是 Logto JWT，恒判 invalid，逼中间件走 dev 兜底分支 ——
const verifyLogtoMock = vi.fn();
vi.mock('../platform/infra/logto.js', () => ({
  verifyLogtoJwt: (...args: unknown[]) => verifyLogtoMock(...args),
}));

const { requireAuth, requireSseAuth, SESSION_COOKIE } = await import('../platform/middleware/auth.js');
const { devLoginHandler } = await import('../modules/account/handlers.js');

const SECRET = 'dev-secret-for-tests-0123456789';

/** 构造 dev/test 可用 env（双守卫满足）。 */
function devEnv(overrides: Partial<Env> = {}): Env {
  return {
    NODE_ENV: 'test',
    DEV_LOGIN_ENABLED: true,
    DEV_SESSION_SECRET: SECRET,
    LOGTO_ISSUER: 'http://localhost:3001/oidc',
    LOGTO_AUDIENCE: '',
    LOGTO_JWKS_URI: 'http://localhost:3001/oidc/jwks',
    ...overrides,
  } as unknown as Env;
}

function makeReq(opts: {
  env: Env;
  cookieToken?: string;
  bearerToken?: string;
  body?: unknown;
}): FastifyRequest {
  const headers: Record<string, string> = {};
  if (opts.bearerToken) headers.authorization = `Bearer ${opts.bearerToken}`;
  return {
    id: 'trace-dev',
    headers,
    cookies: opts.cookieToken ? { [SESSION_COOKIE]: opts.cookieToken } : {},
    params: {},
    query: {},
    body: opts.body,
    log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
    server: { infra: { db: { query: vi.fn() }, env: opts.env } },
  } as unknown as FastifyRequest;
}

function makeReply(): {
  reply: FastifyReply;
  sent: {
    code?: number;
    body?: unknown;
    cookies: Record<string, { value: string; opts: unknown }>;
  };
} {
  const sent = {
    code: undefined as number | undefined,
    body: undefined as unknown,
    cookies: {} as Record<string, { value: string; opts: unknown }>,
  };
  const reply = {
    code(c: number) {
      sent.code = c;
      return this;
    },
    send(b: unknown) {
      sent.body = b;
      return this;
    },
    setCookie(name: string, value: string, opts: unknown) {
      sent.cookies[name] = { value, opts };
      return this;
    },
    header() {
      return this;
    },
  } as unknown as FastifyReply;
  return { reply, sent };
}

beforeEach(() => {
  provisionMock.mockReset();
  readMeRowMock.mockReset();
  verifyLogtoMock.mockReset();
  // dev token 永远不是有效 Logto JWT → 逼中间件走 dev 兜底分支。
  verifyLogtoMock.mockResolvedValue({ kind: 'invalid' });
});

// ===========================================================================
// 1) 双守卫真值表
// ===========================================================================
describe('devLoginAvailable 双守卫（安全第一）', () => {
  it('dev + 开关开 + 有密钥 → 可用', () => {
    expect(devLoginAvailable(devEnv())).toBe(true);
  });
  it('生产 → 不可用（即便开关开 + 有密钥，守卫 1）', () => {
    expect(devLoginAvailable(devEnv({ NODE_ENV: 'production' }))).toBe(false);
  });
  it('开关关 → 不可用（守卫 2）', () => {
    expect(devLoginAvailable(devEnv({ DEV_LOGIN_ENABLED: false }))).toBe(false);
  });
  it('无密钥 → 不可用（即便开关开）', () => {
    expect(devLoginAvailable(devEnv({ DEV_SESSION_SECRET: '' }))).toBe(false);
  });
});

// ===========================================================================
// 2) sign → verify 往返
// ===========================================================================
describe('dev 会话签验往返（HS256，本地对称，无远端依赖）', () => {
  it('签发 → 验签通过，解出 sub/roles/account/email', async () => {
    const env = devEnv();
    const token = await signDevSession(env, {
      sub: 'dev|wayne',
      roles: ['creator'],
      account: 'wayne',
      email: 'wayne@dev.local',
    });
    const res = await verifyDevSession(token, env);
    expect(res.kind).toBe('ok');
    if (res.kind === 'ok') {
      expect(res.claims.sub).toBe('dev|wayne');
      expect(res.claims.roles).toEqual(['creator']);
      expect(res.claims.account).toBe('wayne');
      expect(res.claims.email).toBe('wayne@dev.local');
    }
  });

  it('换密钥验签 → invalid（密钥不符，绝不接受）', async () => {
    const token = await signDevSession(devEnv(), {
      sub: 'dev|x',
      roles: ['creator'],
      account: 'x',
      email: null,
    });
    const res = await verifyDevSession(token, devEnv({ DEV_SESSION_SECRET: 'other-secret-zzz' }));
    expect(res.kind).toBe('invalid');
  });

  it('畸形 token → invalid（不裸抛）', async () => {
    const res = await verifyDevSession('not.a.jwt', devEnv());
    expect(res.kind).toBe('invalid');
  });

  it('未知角色被 RoleSchema 丢弃（不强转）', async () => {
    const env = devEnv();
    // 直接构造含未知角色的 token（绕过 signDevSession 的类型约束用 unknown 注入 payload）。
    const token = await signDevSession(env, {
      sub: 'dev|r',
      roles: ['creator', 'consumer'],
      account: 'r',
      email: null,
    });
    const res = await verifyDevSession(token, env);
    expect(res.kind).toBe('ok');
    if (res.kind === 'ok') expect(res.claims.roles).toEqual(['creator', 'consumer']);
  });
});

// ===========================================================================
// 3) requireAuth / requireSseAuth 接受 dev 会话
// ===========================================================================
describe('中间件 dev 验证分支（dev 会话等价真实会话）', () => {
  it('requireAuth：cb_session 是 dev token → provision → AuthContext.userId=users.id（非 sub）', async () => {
    const env = devEnv();
    const token = await signDevSession(env, {
      sub: 'dev|wayne',
      roles: ['creator'],
      account: 'wayne',
      email: 'wayne@dev.local',
    });
    provisionMock.mockResolvedValue({
      id: 'uuid-users-1',
      status: 'active',
      roles: ['creator'],
      account: 'wayne',
    });
    const req = makeReq({ env, cookieToken: token });
    const { reply, sent } = makeReply();
    await requireAuth()(req, reply);
    expect(sent.code).toBeUndefined(); // 放行
    expect(req.auth?.userId).toBe('uuid-users-1'); // owner 真源 = users.id
    expect(req.auth?.userId).not.toBe('dev|wayne'); // 绝非 sub
    expect(req.auth?.logtoUserId).toBe('dev|wayne');
    expect(req.auth?.roles).toEqual(['creator']);
    // dev 会话同样过 provisionUser（与真实会话同一条建/取 users 路径）。
    expect(provisionMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ logtoUserId: 'dev|wayne', email: 'wayne@dev.local' }),
    );
  });

  it('requireSseAuth：同源 Cookie 的 dev token 被接受（建流前放行）', async () => {
    const env = devEnv();
    const token = await signDevSession(env, {
      sub: 'dev|wayne',
      roles: ['creator'],
      account: 'wayne',
      email: null,
    });
    provisionMock.mockResolvedValue({
      id: 'uuid-sse-1',
      status: 'active',
      roles: ['creator'],
      account: 'wayne',
    });
    const req = makeReq({ env, cookieToken: token });
    const { reply, sent } = makeReply();
    await requireSseAuth()(req, reply);
    expect(sent.code).toBeUndefined();
    expect(req.auth?.userId).toBe('uuid-sse-1');
  });

  it('requireSseAuth：dev token 走 Authorization Bearer → 401（SSE 仅认同源 Cookie，不走 dev 分支）', async () => {
    const env = devEnv();
    const token = await signDevSession(env, {
      sub: 'dev|wayne',
      roles: ['creator'],
      account: 'wayne',
      email: null,
    });
    const req = makeReq({ env, bearerToken: token });
    const { reply, sent } = makeReply();
    await requireSseAuth()(req, reply);
    expect(sent.code).toBe(401); // 非 Cookie 来源被 SSE 守卫显式拒绝
    expect(provisionMock).not.toHaveBeenCalled();
  });

  it('开关关：dev token 不被中间件接受 → 401（dev 分支不走）', async () => {
    const env = devEnv({ DEV_LOGIN_ENABLED: false });
    // token 仍用有密钥的 env 签（合法 dev token），但验证 env 开关关。
    const token = await signDevSession(devEnv(), {
      sub: 'dev|wayne',
      roles: ['creator'],
      account: 'wayne',
      email: null,
    });
    const req = makeReq({ env, cookieToken: token });
    const { reply, sent } = makeReply();
    await requireAuth()(req, reply);
    expect(sent.code).toBe(401);
    expect(provisionMock).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// 4) dev-login handler：签发会话 + MeView + 角色
// ===========================================================================
describe('POST /auth/dev-login handler', () => {
  it('默认（无 body）→ 种子创作者 Wayne / creator：种 cb_session（httpOnly/lax）+ 返 MeView', async () => {
    const env = devEnv();
    provisionMock.mockResolvedValue({
      id: 'uuid-wayne',
      status: 'active',
      roles: ['creator'],
      account: 'wayne',
    });
    readMeRowMock.mockResolvedValue({
      id: 'uuid-wayne',
      logtoUserId: DEFAULT_DEV_USER.sub,
      account: 'wayne',
      email: DEFAULT_DEV_USER.email,
      roles: ['creator'],
      status: 'active',
      hasProfile: false,
      createdAt: '2026-06-01T00:00:00.000Z',
      lastLoginAt: '2026-06-01T00:00:00.000Z',
    });
    const req = makeReq({ env });
    const { reply, sent } = makeReply();
    await devLoginHandler().call(undefined, req, reply);
    expect(sent.code).toBe(200);
    // provision 用默认 Wayne sub/email/role。
    expect(provisionMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        logtoUserId: DEFAULT_DEV_USER.sub,
        email: DEFAULT_DEV_USER.email,
        roles: ['creator'],
      }),
    );
    // 种了 cb_session（httpOnly + sameSite=lax + path /）。
    const ck = sent.cookies[SESSION_COOKIE];
    expect(ck).toBeTruthy();
    const opts = ck!.opts as { httpOnly: boolean; sameSite: string; path: string };
    expect(opts.httpOnly).toBe(true);
    expect(opts.sameSite).toBe('lax');
    expect(opts.path).toBe('/');
    // 种进 cookie 的 token 能被 verifyDevSession 验回（自洽）。
    const verified = await verifyDevSession(ck!.value, env);
    expect(verified.kind).toBe('ok');
    // 返 MeView：creatorId = id（owner/主页寻址真源）。
    const body = sent.body as { data: { creatorId: string; roles: string[] }; meta: unknown };
    expect(body.data.creatorId).toBe('uuid-wayne');
    expect(body.data.roles).toEqual(['creator']);
    // D1：对外信封/视图绝不含 code。
    expect(JSON.stringify(sent.body)).not.toMatch(/"code"/);
  });

  it('指定 email + role=reviewer → provision 用该身份；MeView 角色正确', async () => {
    const env = devEnv();
    provisionMock.mockResolvedValue({
      id: 'uuid-rev',
      status: 'active',
      roles: ['reviewer'],
      account: 'rev',
    });
    readMeRowMock.mockResolvedValue({
      id: 'uuid-rev',
      logtoUserId: 'dev|rev@dev.local',
      account: 'rev',
      email: 'rev@dev.local',
      roles: ['reviewer'],
      status: 'active',
      hasProfile: false,
      createdAt: '2026-06-01T00:00:00.000Z',
      lastLoginAt: null,
    });
    const req = makeReq({ env, body: { email: 'rev@dev.local', role: 'reviewer' } });
    const { reply, sent } = makeReply();
    await devLoginHandler().call(undefined, req, reply);
    expect(sent.code).toBe(200);
    expect(provisionMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ email: 'rev@dev.local', roles: ['reviewer'] }),
    );
    const body = sent.body as { data: { roles: string[] } };
    expect(body.data.roles).toEqual(['reviewer']);
  });

  it('非法 role → 丢弃后回落默认 creator（绝不强转 raw string）', async () => {
    const env = devEnv();
    provisionMock.mockResolvedValue({
      id: 'uuid-z',
      status: 'active',
      roles: ['creator'],
      account: 'z',
    });
    readMeRowMock.mockResolvedValue({
      id: 'uuid-z',
      logtoUserId: 'dev|z@dev.local',
      account: 'z',
      email: 'z@dev.local',
      roles: ['creator'],
      status: 'active',
      hasProfile: false,
      createdAt: '2026-06-01T00:00:00.000Z',
      lastLoginAt: null,
    });
    const req = makeReq({ env, body: { email: 'z@dev.local', role: 'superadmin' } });
    const { reply, sent } = makeReply();
    await devLoginHandler().call(undefined, req, reply);
    expect(sent.code).toBe(200);
    expect(provisionMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ roles: ['creator'] }),
    );
  });

  it('provision DB 异常 → 500（绝不裸露 code）', async () => {
    const env = devEnv();
    provisionMock.mockRejectedValue(new Error('db down'));
    const req = makeReq({ env });
    const { reply, sent } = makeReply();
    await devLoginHandler().call(undefined, req, reply);
    expect(sent.code).toBe(500);
    expect(JSON.stringify(sent.body)).not.toMatch(/"code"/);
    expect(sent.cookies[SESSION_COOKIE]).toBeUndefined(); // 失败不种会话
  });
});

// ===========================================================================
// 5) 生产守卫（反向破坏可测）：去掉守卫则生产可登录 → 本组转红
// ===========================================================================
describe('生产守卫（安全第一，反向破坏）', () => {
  it('NODE_ENV=production → devLoginAvailable=false（守卫 1）', () => {
    expect(devLoginAvailable(devEnv({ NODE_ENV: 'production' }))).toBe(false);
  });

  it('生产：dev-login handler 返 404（端点当作不存在，不签发会话）', async () => {
    const env = devEnv({ NODE_ENV: 'production' });
    const req = makeReq({ env });
    const { reply, sent } = makeReply();
    await devLoginHandler().call(undefined, req, reply);
    expect(sent.code).toBe(404);
    expect(sent.cookies[SESSION_COOKIE]).toBeUndefined(); // 绝不在生产签发会话
    expect(provisionMock).not.toHaveBeenCalled();
    expect(JSON.stringify(sent.body)).not.toMatch(/"code"/);
  });

  it('生产：中间件 dev 分支【不验】dev token → 401（合法 dev token 在生产也被拒）', async () => {
    // token 用 dev 密钥签（结构合法的 dev 会话），但在生产 env 下验证。
    const token = await signDevSession(devEnv(), {
      sub: 'dev|wayne',
      roles: ['creator'],
      account: 'wayne',
      email: null,
    });
    const env = devEnv({ NODE_ENV: 'production' });
    const req = makeReq({ env, cookieToken: token });
    const { reply, sent } = makeReply();
    await requireAuth()(req, reply);
    // 生产路径完全不走 dev 分支：Logto 判 invalid 后无兜底 → 401。
    expect(sent.code).toBe(401);
    expect(provisionMock).not.toHaveBeenCalled();
  });
});

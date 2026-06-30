// logout best-effort 鉴权自检（10-auth §3.3/:145/:153，Codex r2 P0）：
//   POST /auth/logout 的 preHandler 必须【永不拦】——未登录、token 无效、Logto/JWKS 不可达，都不发
//   401/503，一律放行进 handler，由 handler 始终清 cookie + 200（幂等）。这才符合「上游不可达也清 cookie」。
//   无真实 Logto/PG：mock verifyLogtoJwt + provisionUser，取 AUTH_ENDPOINTS 里 logout 的 preHandler，
//   用各态 mock req 驱动它，断言【绝不发任何错误信封、放行】（= bestEffortAuth 行为，非 optionalAuth）。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';

const verifyMock = vi.fn();
const provisionMock = vi.fn();
vi.mock('../platform/infra/logto.js', () => ({
  verifyLogtoJwt: (...args: unknown[]) => verifyMock(...args),
}));
vi.mock('../platform/infra/users-repo.js', () => ({
  provisionUser: (...args: unknown[]) => provisionMock(...args),
}));

const { AUTH_ENDPOINTS } = await import('../modules/account/index.js');

function logoutPreHandler() {
  const ep = AUTH_ENDPOINTS.find((e) => e.method === 'POST' && e.url === '/auth/logout');
  if (!ep) throw new Error('logout endpoint not registered');
  const handlers = ep.preHandlers ?? [];
  expect(handlers.length).toBeGreaterThan(0); // 仍带守卫（写命令守卫链不破，routes.test 守门一致）
  return handlers[0];
}

function makeReq(opts: { bearer?: boolean; session?: string } = {}): FastifyRequest {
  const cookies: Record<string, string> = {};
  if (opts.session) cookies.cb_session = opts.session;
  return {
    id: 'trace-logout',
    headers: opts.bearer ? { authorization: 'Bearer good.jwt' } : {},
    cookies,
    params: {},
    query: {},
    server: { infra: { db: { query: vi.fn() }, env: {} } },
  } as unknown as FastifyRequest;
}

function makeReply(): { reply: FastifyReply; sent: { code?: number; body?: unknown } } {
  const sent: { code?: number; body?: unknown } = {};
  const reply = {
    code: vi.fn(function (this: unknown, c: number) {
      sent.code = c;
      return this;
    }),
    send: vi.fn((b: unknown) => {
      sent.body = b;
      return reply;
    }),
  } as unknown as FastifyReply;
  return { reply, sent };
}

beforeEach(() => {
  verifyMock.mockReset();
  provisionMock.mockReset();
});

describe('POST /auth/logout = best-effort 鉴权（Codex r2 P0）', () => {
  it('无 token 调 logout → 不被 401 拦、放行进 handler 语义（幂等成功）', async () => {
    const pre = logoutPreHandler();
    const req = makeReq({ bearer: false }); // 无 token
    const { reply, sent } = makeReply();
    await pre(req, reply, () => {});
    expect(sent.code).toBeUndefined(); // 关键：绝不发 401（不拦无 token）
    expect(req.auth).toBeUndefined(); // 未登录降级匿名（无 AuthContext）
    expect(verifyMock).not.toHaveBeenCalled(); // 无 token 不进验签
  });

  it('已登录调 logout → 解析 AuthContext 并放行（清会话语义可拿到 userId）', async () => {
    verifyMock.mockResolvedValue({
      kind: 'ok',
      token: { sub: 'sub-logout', roles: ['creator'], account: 'w', email: null },
    });
    provisionMock.mockResolvedValue({
      id: 'uuid-logout',
      status: 'active',
      roles: ['creator'],
      account: 'w',
    });
    const pre = logoutPreHandler();
    const req = makeReq({ bearer: true });
    const { reply, sent } = makeReply();
    await pre(req, reply, () => {});
    expect(sent.code).toBeUndefined(); // 放行
    expect(req.auth?.userId).toBe('uuid-logout');
  });

  it('带 cb_session 但 token 无效 → 仍放行、不发 401（清 cookie 不被拦）', async () => {
    verifyMock.mockResolvedValue({ kind: 'invalid' });
    const pre = logoutPreHandler();
    const req = makeReq({ session: 'stale.jwt' });
    const { reply, sent } = makeReply();
    await pre(req, reply, () => {});
    expect(sent.code).toBeUndefined(); // 不发任何错误信封
    expect(req.auth).toBeUndefined();
  });

  it('带 cb_session 但 Logto/JWKS 不可达 → 仍放行、绝不发 503（关键：上游不可达也清 cookie）', async () => {
    // optionalAuth 在此会回 503 把 logout 拦死、清不了 cookie；bestEffortAuth 必须吞掉、放行。
    verifyMock.mockResolvedValue({ kind: 'upstream_unavailable' });
    const pre = logoutPreHandler();
    const req = makeReq({ session: 'cb.jwt' });
    const { reply, sent } = makeReply();
    await pre(req, reply, () => {});
    expect(sent.code).toBeUndefined(); // 绝不 503（否则 handler 进不去、清不了 cookie）
    expect(sent.body).toBeUndefined();
    expect(req.auth).toBeUndefined();
  });
});

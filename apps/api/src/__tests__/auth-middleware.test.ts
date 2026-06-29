// 鉴权中间件自检（10-auth §4.2/§4.4，Codex#1/#3）：userId=users.id 映射 + 上游不可达 503 + 禁用 403。
//   无真实 Logto/PG：mock verifyLogtoJwt（区分 ok/invalid/upstream_unavailable）+ mock provisionUser。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';

const verifyMock = vi.fn();
const provisionMock = vi.fn();
vi.mock('../infra/logto.js', () => ({
  verifyLogtoJwt: (...args: unknown[]) => verifyMock(...args),
}));
vi.mock('../infra/users-repo.js', () => ({
  provisionUser: (...args: unknown[]) => provisionMock(...args),
}));

const { requireAuth, requireRole, optionalAuth } = await import('../middleware/auth.js');

function makeReq(opts: { bearer?: boolean } = { bearer: true }): FastifyRequest {
  return {
    id: 'trace-auth',
    headers: opts.bearer ? { authorization: 'Bearer good.jwt' } : {},
    cookies: {},
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

describe('auth middleware (Codex#1/#3)', () => {
  it('验签 OK → AuthContext.userId = 业务 users.id（非 sub），logtoUserId = sub', async () => {
    verifyMock.mockResolvedValue({
      kind: 'ok',
      token: { sub: 'logto-sub-xyz', roles: ['creator'], account: 'wayne', email: 'w@e.com' },
    });
    provisionMock.mockResolvedValue({
      id: 'uuid-users-99',
      status: 'active',
      roles: ['creator'],
      account: 'wayne',
    });
    const req = makeReq();
    const { reply, sent } = makeReply();
    await requireAuth()(req, reply);
    expect(sent.code).toBeUndefined(); // 放行
    expect(req.auth?.userId).toBe('uuid-users-99'); // 业务 users.id
    expect(req.auth?.userId).not.toBe('logto-sub-xyz'); // 绝非 sub
    expect(req.auth?.logtoUserId).toBe('logto-sub-xyz'); // sub 放 logtoUserId
    // provision 用 sub 作 logtoUserId 入参（按 logto_user_id=sub 查/建）。
    expect(provisionMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ logtoUserId: 'logto-sub-xyz', email: 'w@e.com' }),
    );
  });

  it('JWKS/Logto 上游不可达 → 503 AUTH_UPSTREAM_UNAVAILABLE（区分 401，escalate）', async () => {
    verifyMock.mockResolvedValue({ kind: 'upstream_unavailable' });
    const req = makeReq();
    const { reply, sent } = makeReply();
    await requireAuth()(req, reply);
    expect(sent.code).toBe(503);
    const body = sent.body as { error: { action: string } };
    expect(body.error).not.toHaveProperty('code'); // D1
    expect(body.error.action).toBe('escalate');
    expect(provisionMock).not.toHaveBeenCalled(); // 上游不可达不查库
  });

  it('token 无效 → 401', async () => {
    verifyMock.mockResolvedValue({ kind: 'invalid' });
    const req = makeReq();
    const { reply, sent } = makeReply();
    await requireAuth()(req, reply);
    expect(sent.code).toBe(401);
  });

  it('账号被禁用（users.status=disabled）→ 403（验签 OK 但不可用）', async () => {
    verifyMock.mockResolvedValue({
      kind: 'ok',
      token: { sub: 'sub-banned', roles: ['creator'], account: 'b', email: null },
    });
    provisionMock.mockResolvedValue({
      id: 'uuid-banned',
      status: 'disabled',
      roles: ['creator'],
      account: 'b',
    });
    const req = makeReq();
    const { reply, sent } = makeReply();
    await requireAuth()(req, reply);
    expect(sent.code).toBe(403);
  });

  it('provision DB 异常 → 500（绝不裸露）', async () => {
    verifyMock.mockResolvedValue({
      kind: 'ok',
      token: { sub: 'sub-x', roles: ['creator'], account: 'x', email: null },
    });
    provisionMock.mockRejectedValue(new Error('db down'));
    const req = makeReq();
    const { reply, sent } = makeReply();
    await requireAuth()(req, reply);
    expect(sent.code).toBe(500);
    expect((sent.body as { error: Record<string, unknown> }).error).not.toHaveProperty('code');
  });

  it('requireRole(creator)：有 creator 角色放行；缺则 403', async () => {
    verifyMock.mockResolvedValue({
      kind: 'ok',
      token: { sub: 'sub-c', roles: ['consumer'], account: 'c', email: null },
    });
    provisionMock.mockResolvedValue({
      id: 'uuid-c',
      status: 'active',
      roles: ['consumer'], // 无 creator
      account: 'c',
    });
    const req = makeReq();
    const { reply, sent } = makeReply();
    await requireRole('creator')(req, reply);
    expect(sent.code).toBe(403);
  });

  it('optionalAuth：上游不可达仍显式失败（503），不静默放行', async () => {
    verifyMock.mockResolvedValue({ kind: 'upstream_unavailable' });
    const req = makeReq();
    const { reply, sent } = makeReply();
    await optionalAuth()(req, reply);
    expect(sent.code).toBe(503);
  });

  it('optionalAuth：无 token → 不报错、降级匿名（不发信封）', async () => {
    const req = makeReq({ bearer: false });
    const { reply, sent } = makeReply();
    await optionalAuth()(req, reply);
    expect(sent.code).toBeUndefined();
    expect(req.auth).toBeUndefined();
    expect(verifyMock).not.toHaveBeenCalled();
  });
});

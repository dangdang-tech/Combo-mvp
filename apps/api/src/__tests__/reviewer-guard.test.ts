// reviewer 评审守卫自检（50-publish §2.6，Codex#7）：reviewer 角色门禁 + 禁创作者自审。
//   无真实 Logto/PG：mock verifyLogtoJwt（返已验签身份）+ mock provisionUser（返业务 users.id + roles），
//   再用 mock req 驱动 requireReviewer，验证角色拒绝 / 自审拒绝 / 正常放行三态。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';

// —— mock 鉴权底座：verifyLogtoJwt 返已验签 token；provisionUser 返业务用户（id+roles+status）——
const verifyMock = vi.fn();
const provisionMock = vi.fn();
vi.mock('../infra/logto.js', () => ({
  verifyLogtoJwt: (...args: unknown[]) => verifyMock(...args),
}));
vi.mock('../infra/users-repo.js', () => ({
  provisionUser: (...args: unknown[]) => provisionMock(...args),
}));

// 在 mock 之后导入被测守卫（确保拿到 mock 版本依赖）。
const { requireReviewer } = await import('../middleware/auth.js');

function makeReq(
  capabilityCreatorId: string | undefined,
  opts: { capabilityId?: string } = {},
): { req: FastifyRequest; dbQuery: ReturnType<typeof vi.fn> } {
  const dbQuery = vi.fn(async (_sql: string, _params: unknown[]) => {
    if (capabilityCreatorId === undefined) return { rows: [] };
    return { rows: [{ creator_user_id: capabilityCreatorId }] };
  });
  const req = {
    id: 'trace-rev',
    headers: { authorization: 'Bearer good.jwt.token' },
    cookies: {},
    params: { capabilityId: opts.capabilityId ?? 'cap-1' },
    server: { infra: { db: { query: dbQuery }, env: {} } },
  } as unknown as FastifyRequest;
  return { req, dbQuery };
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

describe('requireReviewer (50 §2.6, Codex#7)', () => {
  it('非 reviewer 角色（仅 creator）→ 403 FORBIDDEN', async () => {
    verifyMock.mockResolvedValue({
      kind: 'ok',
      token: { sub: 'logto-creator', roles: ['creator'], account: 'c', email: null },
    });
    provisionMock.mockResolvedValue({
      id: 'user-creator',
      status: 'active',
      roles: ['creator'],
      account: 'c',
    });
    const { req } = makeReq('user-other');
    const { reply, sent } = makeReply();
    await requireReviewer()(req, reply);
    expect(sent.code).toBe(403);
    expect((sent.body as { error: Record<string, unknown> }).error).not.toHaveProperty('code'); // D1
    expect(req.auth).toBeUndefined(); // 未放行
  });

  it('reviewer 评审自己的能力（creator == 自己）→ 403（禁自审）', async () => {
    verifyMock.mockResolvedValue({
      kind: 'ok',
      token: { sub: 'logto-rev', roles: ['reviewer', 'creator'], account: 'r', email: null },
    });
    provisionMock.mockResolvedValue({
      id: 'user-rev',
      status: 'active',
      roles: ['reviewer', 'creator'],
      account: 'r',
    });
    // 被评审能力体的 creator == 评审者本人 → 自审，拒。
    const { req } = makeReq('user-rev');
    const { reply, sent } = makeReply();
    await requireReviewer()(req, reply);
    expect(sent.code).toBe(403);
    expect((sent.body as { error: { userMessage: string } }).error.userMessage).toContain('自己');
    expect(req.auth).toBeUndefined();
  });

  it('reviewer 评审他人能力 → 放行（req.auth 注入业务 users.id）', async () => {
    verifyMock.mockResolvedValue({
      kind: 'ok',
      token: { sub: 'logto-rev', roles: ['reviewer'], account: 'r', email: null },
    });
    provisionMock.mockResolvedValue({
      id: 'user-rev',
      status: 'active',
      roles: ['reviewer'],
      account: 'r',
    });
    const { req } = makeReq('user-someone-else');
    const { reply, sent } = makeReply();
    await requireReviewer()(req, reply);
    expect(sent.code).toBeUndefined(); // 未发错误信封 = 放行
    expect(req.auth?.userId).toBe('user-rev'); // 业务 users.id（非 sub）
    expect(req.auth?.roles).toContain('reviewer');
  });

  it('被评审能力体不存在 → 404', async () => {
    verifyMock.mockResolvedValue({
      kind: 'ok',
      token: { sub: 'logto-rev', roles: ['reviewer'], account: 'r', email: null },
    });
    provisionMock.mockResolvedValue({
      id: 'user-rev',
      status: 'active',
      roles: ['reviewer'],
      account: 'r',
    });
    const { req } = makeReq(undefined); // 查不到 capability
    const { reply, sent } = makeReply();
    await requireReviewer()(req, reply);
    expect(sent.code).toBe(404);
  });

  it('token 无效 → 401（不放行评审）', async () => {
    verifyMock.mockResolvedValue({ kind: 'invalid' });
    const { req } = makeReq('user-other');
    const { reply, sent } = makeReply();
    await requireReviewer()(req, reply);
    expect(sent.code).toBe(401);
  });
});

// B-34 · 社交域 handler 自检（60 §3）。重点（契约）：
//   · 鉴权 requireAuth：未登录（无 req.auth）→ 401 escalate（任意已登录用户可写，但未登录被拒，§3.5）；
//   · 自己关注自己 → 422 SOCIAL_SELF_FOLLOW（change_input）；
//   · 目标不存在（创作者/能力）→ 404 change_input（不暴露存在性）；
//   · 成功 → 200 Envelope<FollowResult/LikeResult>（following/liked + 真实计数）；
//   · 幂等（handler 层被执行第二次的边界）：重复 POST/DELETE 不重复增减计数（following/liked 稳定）；
//   · ErrorEnvelope 绝不含 code（D1）；所有失败均 {userMessage, action, retriable, traceId}。
//   注：路由层 Idempotency-Key 回放由中间件承担（已在 idempotency 中间件单测覆盖）；此处验「即便真执行第二次，repo 也不重复计数」。
import { describe, it, expect } from 'vitest';
import type { RouteHandlerMethod } from 'fastify';
import {
  followHandler,
  unfollowHandler,
  likeHandler,
  unlikeHandler,
} from '../routes/social-handlers.js';

// ---------------------------------------------------------------------------
// 忠实内存 PG（与 social-repo.test 同口径，handler 经 asTxPool(req.server.infra.db) 用）。
//   asTxPool 期望 infra.db 是 pg.Pool（带 connect()）；这里直接给一个带 connect()+query() 的对象。
// ---------------------------------------------------------------------------
interface ProfileRow {
  followers_count: number;
  following_count: number;
  likes_count: number;
}
class FakeDb {
  users = new Set<string>();
  capabilities = new Map<string, string>();
  profiles = new Map<string, ProfileRow>();
  follows = new Set<string>();
  likes = new Set<string>();
  /** 注入 query 异常（测 500 收口）。 */
  throwOnInsert = false;

  seedProfile(id: string, init: Partial<ProfileRow> = {}): string {
    this.users.add(id);
    this.profiles.set(id, {
      followers_count: init.followers_count ?? 0,
      following_count: init.following_count ?? 0,
      likes_count: init.likes_count ?? 0,
    });
    return id;
  }
  seedUser(id: string): string {
    this.users.add(id);
    return id;
  }
  seedCapability(capId: string, ownerId: string): string {
    this.capabilities.set(capId, ownerId);
    return capId;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async query(sql: string, params: unknown[] = []): Promise<{ rows: any[]; rowCount: number }> {
    const s = sql.trim();
    if (/^(BEGIN|COMMIT|ROLLBACK)/i.test(s)) return { rows: [], rowCount: 0 };
    if (/SELECT EXISTS/i.test(s) && /FROM users/i.test(s))
      return { rows: [{ exists: this.users.has(params[0] as string) }], rowCount: 1 };
    // follow/unfollow 目标存在性（Codex r1#3）：查 creator_profiles，不是 users。
    if (/SELECT EXISTS/i.test(s) && /FROM creator_profiles/i.test(s))
      return { rows: [{ exists: this.profiles.has(params[0] as string) }], rowCount: 1 };
    if (/SELECT creator_user_id FROM capabilities/i.test(s)) {
      const owner = this.capabilities.get(params[0] as string);
      return { rows: owner ? [{ creator_user_id: owner }] : [], rowCount: owner ? 1 : 0 };
    }
    if (/SELECT followers_count FROM creator_profiles/i.test(s)) {
      const p = this.profiles.get(params[0] as string);
      return { rows: p ? [{ followers_count: p.followers_count }] : [], rowCount: p ? 1 : 0 };
    }
    if (/SELECT likes_count FROM creator_profiles/i.test(s)) {
      const p = this.profiles.get(params[0] as string);
      return { rows: p ? [{ likes_count: p.likes_count }] : [], rowCount: p ? 1 : 0 };
    }
    if (/INSERT INTO follows/i.test(s)) {
      if (this.throwOnInsert) throw new Error('boom');
      const key = `${params[0]}|${params[1]}`;
      if (this.follows.has(key)) return { rows: [], rowCount: 0 };
      this.follows.add(key);
      return { rows: [], rowCount: 1 };
    }
    if (/DELETE FROM follows/i.test(s)) {
      const had = this.follows.delete(`${params[0]}|${params[1]}`);
      return { rows: [], rowCount: had ? 1 : 0 };
    }
    if (/INSERT INTO likes/i.test(s)) {
      if (this.throwOnInsert) throw new Error('boom');
      const key = `${params[0]}|${params[1]}`;
      if (this.likes.has(key)) return { rows: [], rowCount: 0 };
      this.likes.add(key);
      return { rows: [], rowCount: 1 };
    }
    if (/DELETE FROM likes/i.test(s)) {
      const had = this.likes.delete(`${params[0]}|${params[1]}`);
      return { rows: [], rowCount: had ? 1 : 0 };
    }
    if (/UPDATE creator_profiles/i.test(s)) {
      const p = this.profiles.get(params[0] as string);
      if (!p) return { rows: [], rowCount: 0 };
      if (/followers_count = followers_count \+ 1/i.test(s)) p.followers_count += 1;
      else if (/followers_count = GREATEST/i.test(s))
        p.followers_count = Math.max(p.followers_count - 1, 0);
      else if (/following_count = following_count \+ 1/i.test(s)) p.following_count += 1;
      else if (/following_count = GREATEST/i.test(s))
        p.following_count = Math.max(p.following_count - 1, 0);
      else if (/likes_count = likes_count \+ 1/i.test(s)) p.likes_count += 1;
      else if (/likes_count = GREATEST/i.test(s)) p.likes_count = Math.max(p.likes_count - 1, 0);
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`unexpected SQL: ${s.slice(0, 60)}`);
  }
  // asTxPool(pool) 用：pool.connect() → PoolClient（query + release）。
  async connect() {
    return { query: (sql: string, p?: unknown[]) => this.query(sql, p), release: () => undefined };
  }
}

interface Sent {
  code: number;
  body: unknown;
}
function makeReqReply(opts: { userId?: string; params?: Record<string, string>; db: FakeDb }) {
  const sent: Sent = { code: 0, body: undefined };
  const reply = {
    code(c: number) {
      sent.code = c;
      return this;
    },
    send(b: unknown) {
      sent.body = b;
      return this;
    },
  };
  const req = {
    id: 'trace-soc',
    auth: opts.userId ? { userId: opts.userId } : undefined,
    params: opts.params ?? {},
    headers: {},
    server: { infra: { db: opts.db } },
  };
  return { req, reply, sent };
}
async function call(h: RouteHandlerMethod, ctx: ReturnType<typeof makeReqReply>): Promise<void> {
  await (h as (req: unknown, reply: unknown) => Promise<unknown>).call(
    undefined,
    ctx.req,
    ctx.reply,
  );
}
function assertNoCode(body: unknown): void {
  expect(JSON.stringify(body)).not.toMatch(/"code"/);
}
function dataOf<T>(body: unknown): T {
  return (body as { data: T }).data;
}
function errOf(body: unknown): {
  action: string;
  userMessage: string;
  retriable: boolean;
  traceId: string;
} {
  return (
    body as { error: { action: string; userMessage: string; retriable: boolean; traceId: string } }
  ).error;
}

// ===========================================================================
// follow / unfollow
// ===========================================================================
describe('followHandler (§3.1)', () => {
  it('成功 → 200 Envelope<FollowResult>（following:true + followersCount），无 code', async () => {
    const db = new FakeDb();
    db.seedProfile('creator', { followers_count: 2 });
    db.seedProfile('viewer');
    const ctx = makeReqReply({ userId: 'viewer', params: { creatorId: 'creator' }, db });
    await call(followHandler(), ctx);
    expect(ctx.sent.code).toBe(200);
    const r = dataOf<{ creatorId: string; following: boolean; followersCount: number }>(
      ctx.sent.body,
    );
    expect(r).toEqual({ creatorId: 'creator', following: true, followersCount: 3 });
    assertNoCode(ctx.sent.body);
  });

  it('未登录（无 req.auth）→ 401 escalate，无 code', async () => {
    const db = new FakeDb();
    const ctx = makeReqReply({ params: { creatorId: 'creator' }, db });
    await call(followHandler(), ctx);
    expect(ctx.sent.code).toBe(401);
    expect(errOf(ctx.sent.body).action).toBe('escalate');
    assertNoCode(ctx.sent.body);
  });

  it('关注自己 → 422 SOCIAL_SELF_FOLLOW（change_input，「不能关注自己」），无 code，未写 follows', async () => {
    const db = new FakeDb();
    db.seedProfile('me');
    const ctx = makeReqReply({ userId: 'me', params: { creatorId: 'me' }, db });
    await call(followHandler(), ctx);
    expect(ctx.sent.code).toBe(422);
    expect(errOf(ctx.sent.body).action).toBe('change_input');
    expect(errOf(ctx.sent.body).userMessage).toBe('不能关注自己。');
    assertNoCode(ctx.sent.body);
    expect(db.follows.size).toBe(0);
  });

  it('目标创作者不存在 → 404 change_input，无 code', async () => {
    const db = new FakeDb();
    db.seedProfile('viewer');
    const ctx = makeReqReply({ userId: 'viewer', params: { creatorId: 'ghost' }, db });
    await call(followHandler(), ctx);
    expect(ctx.sent.code).toBe(404);
    expect(errOf(ctx.sent.body).action).toBe('change_input');
    assertNoCode(ctx.sent.body);
  });

  it('幂等：重复 POST follow（handler 真执行第二次）→ 仍 200、following:true、followersCount 不翻倍', async () => {
    const db = new FakeDb();
    db.seedProfile('creator', { followers_count: 0 });
    db.seedProfile('viewer');
    const c1 = makeReqReply({ userId: 'viewer', params: { creatorId: 'creator' }, db });
    await call(followHandler(), c1);
    const c2 = makeReqReply({ userId: 'viewer', params: { creatorId: 'creator' }, db });
    await call(followHandler(), c2);
    expect(c2.sent.code).toBe(200);
    const r2 = dataOf<{ following: boolean; followersCount: number }>(c2.sent.body);
    expect(r2.following).toBe(true);
    expect(r2.followersCount).toBe(1); // 不重复计数
    expect(db.profiles.get('creator')!.followers_count).toBe(1);
  });

  it('内部异常 → 500 retry，无 code（绝不甩堆栈）', async () => {
    const db = new FakeDb();
    db.seedProfile('creator');
    db.seedProfile('viewer');
    db.throwOnInsert = true;
    const ctx = makeReqReply({ userId: 'viewer', params: { creatorId: 'creator' }, db });
    await call(followHandler(), ctx);
    expect(ctx.sent.code).toBe(500);
    expect(errOf(ctx.sent.body).action).toBe('retry');
    assertNoCode(ctx.sent.body);
  });
});

describe('unfollowHandler (§3.2)', () => {
  it('成功取关 → 200 following:false + followersCount，无 code', async () => {
    const db = new FakeDb();
    db.seedProfile('creator');
    db.seedProfile('viewer');
    db.follows.add('viewer|creator');
    db.profiles.get('creator')!.followers_count = 1;
    db.profiles.get('viewer')!.following_count = 1;
    const ctx = makeReqReply({ userId: 'viewer', params: { creatorId: 'creator' }, db });
    await call(unfollowHandler(), ctx);
    expect(ctx.sent.code).toBe(200);
    const r = dataOf<{ following: boolean; followersCount: number }>(ctx.sent.body);
    expect(r.following).toBe(false);
    expect(r.followersCount).toBe(0);
    assertNoCode(ctx.sent.body);
  });

  it('幂等：重复 DELETE（已无关系）→ 200 following:false、followersCount 不减成负数', async () => {
    const db = new FakeDb();
    db.seedProfile('creator', { followers_count: 0 });
    db.seedProfile('viewer');
    const ctx = makeReqReply({ userId: 'viewer', params: { creatorId: 'creator' }, db });
    await call(unfollowHandler(), ctx);
    expect(ctx.sent.code).toBe(200);
    expect(dataOf<{ followersCount: number }>(ctx.sent.body).followersCount).toBe(0);
  });

  it('未登录 → 401，无 code', async () => {
    const db = new FakeDb();
    const ctx = makeReqReply({ params: { creatorId: 'creator' }, db });
    await call(unfollowHandler(), ctx);
    expect(ctx.sent.code).toBe(401);
    assertNoCode(ctx.sent.body);
  });
});

// ===========================================================================
// like / unlike
// ===========================================================================
describe('likeHandler (§3.3)', () => {
  it('成功 → 200 Envelope<LikeResult>（liked:true + likesCount），无 code', async () => {
    const db = new FakeDb();
    db.seedProfile('creator', { likes_count: 7 });
    db.seedUser('liker');
    db.seedCapability('cap1', 'creator');
    const ctx = makeReqReply({ userId: 'liker', params: { capabilityId: 'cap1' }, db });
    await call(likeHandler(), ctx);
    expect(ctx.sent.code).toBe(200);
    expect(
      dataOf<{ capabilityId: string; liked: boolean; likesCount: number }>(ctx.sent.body),
    ).toEqual({
      capabilityId: 'cap1',
      liked: true,
      likesCount: 8,
    });
    assertNoCode(ctx.sent.body);
  });

  it('能力不存在 → 404 change_input，无 code', async () => {
    const db = new FakeDb();
    db.seedUser('liker');
    const ctx = makeReqReply({ userId: 'liker', params: { capabilityId: 'ghost' }, db });
    await call(likeHandler(), ctx);
    expect(ctx.sent.code).toBe(404);
    expect(errOf(ctx.sent.body).action).toBe('change_input');
    assertNoCode(ctx.sent.body);
  });

  it('自赞（点赞自己名下能力）→ 422 change_input，无 code，未写 likes（Codex r1#3）', async () => {
    const db = new FakeDb();
    db.seedProfile('creator', { likes_count: 3 });
    db.seedCapability('cap1', 'creator');
    const ctx = makeReqReply({ userId: 'creator', params: { capabilityId: 'cap1' }, db });
    await call(likeHandler(), ctx);
    expect(ctx.sent.code).toBe(422);
    expect(errOf(ctx.sent.body).action).toBe('change_input');
    expect(db.likes.size).toBe(0);
    expect(db.profiles.get('creator')!.likes_count).toBe(3);
    assertNoCode(ctx.sent.body);
  });

  it('未登录 → 401，无 code', async () => {
    const db = new FakeDb();
    const ctx = makeReqReply({ params: { capabilityId: 'cap1' }, db });
    await call(likeHandler(), ctx);
    expect(ctx.sent.code).toBe(401);
    assertNoCode(ctx.sent.body);
  });

  it('幂等：重复 POST like → 仍 200、liked:true、likesCount 不翻倍', async () => {
    const db = new FakeDb();
    db.seedProfile('creator', { likes_count: 0 });
    db.seedUser('liker');
    db.seedCapability('cap1', 'creator');
    const c1 = makeReqReply({ userId: 'liker', params: { capabilityId: 'cap1' }, db });
    await call(likeHandler(), c1);
    const c2 = makeReqReply({ userId: 'liker', params: { capabilityId: 'cap1' }, db });
    await call(likeHandler(), c2);
    expect(dataOf<{ likesCount: number }>(c2.sent.body).likesCount).toBe(1);
    expect(db.profiles.get('creator')!.likes_count).toBe(1);
  });
});

describe('unlikeHandler (§3.4)', () => {
  it('成功取消 → 200 liked:false + likesCount，无 code', async () => {
    const db = new FakeDb();
    db.seedProfile('creator', { likes_count: 1 });
    db.seedUser('liker');
    db.seedCapability('cap1', 'creator');
    db.likes.add('liker|cap1');
    const ctx = makeReqReply({ userId: 'liker', params: { capabilityId: 'cap1' }, db });
    await call(unlikeHandler(), ctx);
    expect(ctx.sent.code).toBe(200);
    const r = dataOf<{ liked: boolean; likesCount: number }>(ctx.sent.body);
    expect(r.liked).toBe(false);
    expect(r.likesCount).toBe(0);
    assertNoCode(ctx.sent.body);
  });

  it('幂等：重复取消 → likesCount 不减成负数', async () => {
    const db = new FakeDb();
    db.seedProfile('creator', { likes_count: 0 });
    db.seedUser('liker');
    db.seedCapability('cap1', 'creator');
    const ctx = makeReqReply({ userId: 'liker', params: { capabilityId: 'cap1' }, db });
    await call(unlikeHandler(), ctx);
    expect(dataOf<{ likesCount: number }>(ctx.sent.body).likesCount).toBe(0);
  });
});

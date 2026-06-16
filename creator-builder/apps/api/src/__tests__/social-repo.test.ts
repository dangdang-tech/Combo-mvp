// B-34 · 社交写仓储单测（60 §3 / §4.2-4.3）。忠实 mock 的内存 PG（follows/likes/creator_profiles/users/capabilities）：
//   - follow/unfollow/like/unlike 幂等（重复 INSERT/DELETE 不重复增减计数）；
//   - 计数正确（粉丝/获赞冗余列与去重写入同事务、GREATEST 兜底不破 CHECK>=0）；
//   - 去重键（PK 唯一约束）→ ON CONFLICT DO NOTHING、changed 仅在真插入/真删除时 true；
//   - 目标不存在（创作者/能力）→ SocialTargetNotFound（handler 转 404，不暴露存在性）；
//   - 非创作者关注者无 creator_profiles 行 → following_count 防御式 no-op（不强建 profile 行）；
//   - readSocialCounts / readViewerIsFollowing 读模型供个人主页 Hero 复用。
//   - 反向破坏：去掉去重键（让 INSERT 总成功）→ 计数翻倍，断言能抓到（证明断言非空跑）。
import { describe, it, expect } from 'vitest';
import {
  follow,
  unfollow,
  like,
  unlike,
  readSocialCounts,
  readViewerIsFollowing,
  SocialTargetNotFound,
  SocialSelfLike,
} from '../social/social-repo.js';
import type { TxPool, TxConn } from '../events/db-tx.js';
import type { Queryable } from '../jobs/types.js';

// ---------------------------------------------------------------------------
// 忠实内存 PG（最小化建模 follows/likes/creator_profiles/users/capabilities 的去重键 + 计数列）。
//   query() 按 SQL 关键字派发；INSERT ... ON CONFLICT DO NOTHING 用 Set 去重键模拟（真插入 rowCount=1，否则 0）。
//   UPDATE creator_profiles ... WHERE user_id 命中行才 +/-（防御式 no-op = 无该 profile 行时 rowCount 0）。
// ---------------------------------------------------------------------------
interface ProfileRow {
  followers_count: number;
  following_count: number;
  likes_count: number;
}

class FakeDb {
  users = new Set<string>();
  capabilities = new Map<string, string>(); // capabilityId -> creator_user_id
  profiles = new Map<string, ProfileRow>(); // user_id -> counts
  follows = new Set<string>(); // `${follower}|${followee}`
  likes = new Set<string>(); // `${user}|${capability}`
  /** 反向破坏开关：true → follows/likes 不去重（每次 INSERT 都「成功」），用于证明去重断言非空跑。 */
  breakDedup = false;

  seedUser(id: string): string {
    this.users.add(id);
    return id;
  }
  seedProfile(id: string, init: Partial<ProfileRow> = {}): string {
    this.users.add(id);
    this.profiles.set(id, {
      followers_count: init.followers_count ?? 0,
      following_count: init.following_count ?? 0,
      likes_count: init.likes_count ?? 0,
    });
    return id;
  }
  seedCapability(capId: string, ownerId: string): string {
    this.capabilities.set(capId, ownerId);
    return capId;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async query(sql: string, params: unknown[] = []): Promise<{ rows: any[]; rowCount: number }> {
    const s = sql.trim();
    // 事务控制语句（withTransaction 发的 BEGIN/COMMIT/ROLLBACK）。
    if (/^(BEGIN|COMMIT|ROLLBACK)/i.test(s)) return { rows: [], rowCount: 0 };

    // 存在性：SELECT EXISTS (... FROM users ...)（保留兼容；本期写路径已改查 creator_profiles）。
    if (/SELECT EXISTS/i.test(s) && /FROM users/i.test(s)) {
      const id = params[0] as string;
      return { rows: [{ exists: this.users.has(id) }], rowCount: 1 };
    }
    // follow/unfollow 目标存在性（Codex r1#3）：SELECT EXISTS (... FROM creator_profiles ...)。
    if (/SELECT EXISTS/i.test(s) && /FROM creator_profiles/i.test(s)) {
      const id = params[0] as string;
      return { rows: [{ exists: this.profiles.has(id) }], rowCount: 1 };
    }
    // viewerIsFollowing：SELECT EXISTS (... FROM follows ...)
    if (/SELECT EXISTS/i.test(s) && /FROM follows/i.test(s)) {
      const [follower, followee] = params as [string, string];
      return { rows: [{ exists: this.follows.has(`${follower}|${followee}`) }], rowCount: 1 };
    }
    // 能力 owner：SELECT creator_user_id FROM capabilities
    if (/SELECT creator_user_id FROM capabilities/i.test(s)) {
      const owner = this.capabilities.get(params[0] as string);
      return { rows: owner ? [{ creator_user_id: owner }] : [], rowCount: owner ? 1 : 0 };
    }
    // 计数读：followers_count / likes_count / 三计数。
    if (/SELECT followers_count, following_count, likes_count/i.test(s)) {
      const p = this.profiles.get(params[0] as string);
      return { rows: p ? [p] : [], rowCount: p ? 1 : 0 };
    }
    if (/SELECT followers_count FROM creator_profiles/i.test(s)) {
      const p = this.profiles.get(params[0] as string);
      return { rows: p ? [{ followers_count: p.followers_count }] : [], rowCount: p ? 1 : 0 };
    }
    if (/SELECT likes_count FROM creator_profiles/i.test(s)) {
      const p = this.profiles.get(params[0] as string);
      return { rows: p ? [{ likes_count: p.likes_count }] : [], rowCount: p ? 1 : 0 };
    }

    // INSERT INTO follows ... ON CONFLICT DO NOTHING
    if (/INSERT INTO follows/i.test(s)) {
      const key = `${params[0]}|${params[1]}`;
      if (!this.breakDedup && this.follows.has(key)) return { rows: [], rowCount: 0 };
      this.follows.add(key);
      return { rows: [], rowCount: 1 };
    }
    if (/DELETE FROM follows/i.test(s)) {
      const key = `${params[0]}|${params[1]}`;
      const had = this.follows.delete(key);
      return { rows: [], rowCount: had ? 1 : 0 };
    }
    if (/INSERT INTO likes/i.test(s)) {
      const key = `${params[0]}|${params[1]}`;
      if (!this.breakDedup && this.likes.has(key)) return { rows: [], rowCount: 0 };
      this.likes.add(key);
      return { rows: [], rowCount: 1 };
    }
    if (/DELETE FROM likes/i.test(s)) {
      const key = `${params[0]}|${params[1]}`;
      const had = this.likes.delete(key);
      return { rows: [], rowCount: had ? 1 : 0 };
    }

    // UPDATE creator_profiles SET ... WHERE user_id = $1（防御式：无 profile 行 → rowCount 0）。
    if (/UPDATE creator_profiles/i.test(s)) {
      const id = params[0] as string;
      const p = this.profiles.get(id);
      if (!p) return { rows: [], rowCount: 0 };
      if (/followers_count = followers_count \+ 1/i.test(s)) p.followers_count += 1;
      else if (/followers_count = GREATEST\(followers_count - 1, 0\)/i.test(s))
        p.followers_count = Math.max(p.followers_count - 1, 0);
      else if (/following_count = following_count \+ 1/i.test(s)) p.following_count += 1;
      else if (/following_count = GREATEST\(following_count - 1, 0\)/i.test(s))
        p.following_count = Math.max(p.following_count - 1, 0);
      else if (/likes_count = likes_count \+ 1/i.test(s)) p.likes_count += 1;
      else if (/likes_count = GREATEST\(likes_count - 1, 0\)/i.test(s))
        p.likes_count = Math.max(p.likes_count - 1, 0);
      return { rows: [], rowCount: 1 };
    }

    throw new Error(`unexpected SQL in fake: ${s.slice(0, 60)}`);
  }
}

/** 把 FakeDb 适配成 TxPool（每个事务复用同一 FakeDb 实例 = 同一「连接」/同一份内存表）。 */
function asPool(db: FakeDb): TxPool {
  return {
    async connect(): Promise<TxConn> {
      return {
        query: (sql: string, p?: unknown[]) => db.query(sql, p) as never,
        release: () => undefined,
      };
    },
  };
}
function asQueryable(db: FakeDb): Queryable {
  return { query: (sql: string, p?: unknown[]) => db.query(sql, p) as never };
}

// ===========================================================================
// follow / unfollow
// ===========================================================================
describe('follow（去重键 + 同事务计数）', () => {
  it('首次关注 → changed:true，被关注者 followers_count+1、关注者 following_count+1', async () => {
    const db = new FakeDb();
    db.seedProfile('creator', { followers_count: 5 });
    db.seedProfile('viewer', { following_count: 2 });
    const r = await follow(asPool(db), 'viewer', 'creator');
    expect(r.changed).toBe(true);
    expect(r.followersCount).toBe(6);
    expect(db.profiles.get('creator')!.followers_count).toBe(6);
    expect(db.profiles.get('viewer')!.following_count).toBe(3);
    expect(db.follows.has('viewer|creator')).toBe(true);
  });

  it('幂等：重复关注（同对）→ changed:false，计数不再增（仍 6），followersCount 回放真实值', async () => {
    const db = new FakeDb();
    db.seedProfile('creator', { followers_count: 5 });
    db.seedProfile('viewer');
    await follow(asPool(db), 'viewer', 'creator'); // 6
    const r2 = await follow(asPool(db), 'viewer', 'creator'); // 重复
    expect(r2.changed).toBe(false);
    expect(r2.followersCount).toBe(6); // 不翻倍、不重复加
    expect(db.profiles.get('creator')!.followers_count).toBe(6);
  });

  it('关注者无 creator_profiles 行（非创作者）→ following_count 防御式 no-op，不报错、不强建 profile', async () => {
    const db = new FakeDb();
    db.seedProfile('creator', { followers_count: 0 });
    db.seedUser('plain-user'); // 无 profile 行
    const r = await follow(asPool(db), 'plain-user', 'creator');
    expect(r.changed).toBe(true);
    expect(r.followersCount).toBe(1); // 被关注者计数照常 +1
    expect(db.profiles.has('plain-user')).toBe(false); // 不为非创作者强建 profile
  });

  it('被关注者无 creator_profiles 行（无主页）→ SocialTargetNotFound（404 不暴露存在性），未写 follows（Codex r1#3）', async () => {
    const db = new FakeDb();
    db.seedProfile('viewer');
    db.seedUser('plain-user'); // 仅 users 行、无 creator_profiles（无主页）→ 不可被关注
    // 关注没有主页的普通 user → 404（不再静默 no-op 计数后 200）。
    await expect(follow(asPool(db), 'viewer', 'plain-user')).rejects.toBeInstanceOf(
      SocialTargetNotFound,
    );
    // 完全不存在的目标同样 404。
    await expect(follow(asPool(db), 'viewer', 'ghost')).rejects.toBeInstanceOf(
      SocialTargetNotFound,
    );
    expect(db.follows.size).toBe(0);
  });

  it('反向破坏：关掉去重键 → 重复关注计数翻倍（证明幂等断言非空跑）', async () => {
    const db = new FakeDb();
    db.breakDedup = true;
    db.seedProfile('creator', { followers_count: 0 });
    db.seedProfile('viewer');
    await follow(asPool(db), 'viewer', 'creator');
    const r2 = await follow(asPool(db), 'viewer', 'creator');
    // 无去重 → 第二次也「真插入」→ 计数被多加（=2），与幂等期望（应为 1）相反 → 断言能抓到回归。
    expect(r2.followersCount).toBe(2);
  });
});

describe('unfollow（去重键 + 同事务计数 + GREATEST 兜底）', () => {
  it('取关已关注 → changed:true，followers_count-1、following_count-1', async () => {
    const db = new FakeDb();
    db.seedProfile('creator');
    db.seedProfile('viewer');
    await follow(asPool(db), 'viewer', 'creator'); // followers 1, following 1
    const r = await unfollow(asPool(db), 'viewer', 'creator');
    expect(r.changed).toBe(true);
    expect(r.followersCount).toBe(0);
    expect(db.profiles.get('viewer')!.following_count).toBe(0);
    expect(db.follows.has('viewer|creator')).toBe(false);
  });

  it('幂等：重复取关（已无关系）→ changed:false，计数不再减（GREATEST 不破 CHECK>=0）', async () => {
    const db = new FakeDb();
    db.seedProfile('creator', { followers_count: 0 });
    db.seedProfile('viewer', { following_count: 0 });
    const r = await unfollow(asPool(db), 'viewer', 'creator'); // 无关系
    expect(r.changed).toBe(false);
    expect(r.followersCount).toBe(0); // 不减成负数
    expect(db.profiles.get('creator')!.followers_count).toBe(0);
  });

  it('被关注者不存在 → SocialTargetNotFound', async () => {
    const db = new FakeDb();
    db.seedProfile('viewer');
    await expect(unfollow(asPool(db), 'viewer', 'ghost')).rejects.toBeInstanceOf(
      SocialTargetNotFound,
    );
  });
});

// ===========================================================================
// like / unlike
// ===========================================================================
describe('like（能力 owner 获赞 + 去重键 + 同事务计数）', () => {
  it('首次点赞 → changed:true，能力所属创作者 likes_count+1', async () => {
    const db = new FakeDb();
    db.seedProfile('creator', { likes_count: 10 });
    db.seedUser('liker');
    db.seedCapability('cap1', 'creator');
    const r = await like(asPool(db), 'liker', 'cap1');
    expect(r.changed).toBe(true);
    expect(r.likesCount).toBe(11);
    expect(db.profiles.get('creator')!.likes_count).toBe(11);
    expect(db.likes.has('liker|cap1')).toBe(true);
  });

  it('幂等：重复点赞同能力 → changed:false，likes_count 不再增（仍 11）', async () => {
    const db = new FakeDb();
    db.seedProfile('creator', { likes_count: 10 });
    db.seedUser('liker');
    db.seedCapability('cap1', 'creator');
    await like(asPool(db), 'liker', 'cap1'); // 11
    const r2 = await like(asPool(db), 'liker', 'cap1'); // 重复
    expect(r2.changed).toBe(false);
    expect(r2.likesCount).toBe(11);
  });

  it('两个不同用户点赞同能力 → likes_count +2（计数为该能力获赞总和）', async () => {
    const db = new FakeDb();
    db.seedProfile('creator', { likes_count: 0 });
    db.seedUser('u1');
    db.seedUser('u2');
    db.seedCapability('cap1', 'creator');
    await like(asPool(db), 'u1', 'cap1');
    const r = await like(asPool(db), 'u2', 'cap1');
    expect(r.likesCount).toBe(2);
  });

  it('能力不存在 → SocialTargetNotFound（404），未写 likes', async () => {
    const db = new FakeDb();
    db.seedUser('liker');
    await expect(like(asPool(db), 'liker', 'ghost-cap')).rejects.toBeInstanceOf(
      SocialTargetNotFound,
    );
    expect(db.likes.size).toBe(0);
  });

  it('禁自赞：creator 点赞自己名下能力 → SocialSelfLike（422），未写 likes、未改计数（Codex r1#3）', async () => {
    const db = new FakeDb();
    db.seedProfile('creator', { likes_count: 5 });
    db.seedCapability('cap1', 'creator'); // owner === userId
    await expect(like(asPool(db), 'creator', 'cap1')).rejects.toBeInstanceOf(SocialSelfLike);
    expect(db.likes.size).toBe(0);
    expect(db.profiles.get('creator')!.likes_count).toBe(5); // 计数未动
  });

  it('计数 RETURNING 强不变量：owner 无 profile 行 → 计数 UPDATE 命中 0 行 → 报错（不静默 no-op，Codex r1#3）', async () => {
    const db = new FakeDb();
    // 能力 owner 是 plain user（无 creator_profiles 行）：likes_count UPDATE 命中 0 行。
    db.seedUser('liker');
    db.seedUser('ownerNoProfile');
    db.seedCapability('cap1', 'ownerNoProfile');
    await expect(like(asPool(db), 'liker', 'cap1')).rejects.toThrow(/affected no row/);
  });
});

describe('unlike（去重键 + 同事务计数 + GREATEST）', () => {
  it('取消已点赞 → changed:true，likes_count-1', async () => {
    const db = new FakeDb();
    db.seedProfile('creator');
    db.seedUser('liker');
    db.seedCapability('cap1', 'creator');
    await like(asPool(db), 'liker', 'cap1'); // 1
    const r = await unlike(asPool(db), 'liker', 'cap1');
    expect(r.changed).toBe(true);
    expect(r.likesCount).toBe(0);
    expect(db.likes.has('liker|cap1')).toBe(false);
  });

  it('幂等：重复取消（已无）→ changed:false，likes_count 不减成负数', async () => {
    const db = new FakeDb();
    db.seedProfile('creator', { likes_count: 0 });
    db.seedUser('liker');
    db.seedCapability('cap1', 'creator');
    const r = await unlike(asPool(db), 'liker', 'cap1');
    expect(r.changed).toBe(false);
    expect(r.likesCount).toBe(0);
  });
});

// ===========================================================================
// 读模型（供个人主页 Hero / 工作台复用）
// ===========================================================================
describe('readSocialCounts / readViewerIsFollowing（计数供 profile 复用）', () => {
  it('readSocialCounts → 直读冗余列三计数', async () => {
    const db = new FakeDb();
    db.seedProfile('creator', { followers_count: 12, following_count: 3, likes_count: 99 });
    const c = await readSocialCounts(asQueryable(db), 'creator');
    expect(c).toEqual({ followers: 12, following: 3, likes: 99 });
  });

  it('readSocialCounts：无 profile 行 → 全 0（计数口径，存在性由 handler 单独判）', async () => {
    const db = new FakeDb();
    expect(await readSocialCounts(asQueryable(db), 'nobody')).toEqual({
      followers: 0,
      following: 0,
      likes: 0,
    });
  });

  it('readViewerIsFollowing：匿名 → null；自看 → null；已关注 → true；未关注 → false', async () => {
    const db = new FakeDb();
    db.seedProfile('creator');
    db.seedProfile('viewer');
    await follow(asPool(db), 'viewer', 'creator');
    expect(await readViewerIsFollowing(asQueryable(db), 'creator', null)).toBeNull();
    expect(await readViewerIsFollowing(asQueryable(db), 'creator', 'creator')).toBeNull();
    expect(await readViewerIsFollowing(asQueryable(db), 'creator', 'viewer')).toBe(true);
    expect(await readViewerIsFollowing(asQueryable(db), 'creator', 'stranger')).toBe(false);
  });
});

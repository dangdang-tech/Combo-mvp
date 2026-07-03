// B-34 · 社交（follows / likes）写仓储（60-dashboard-profile §3 / §4.2-4.3）。
//   - follow/unfollow、like/unlike：纯逻辑，注入 TxPool（单连接事务），便于 mock 单测、无真 PG。
//   - 三重防重复计数（§3.5 末注 / §4.2 末注）：
//       ① UNIQUE 去重键（follows PK(follower,followee)、likes PK(user,capability)）；
//       ② INSERT ... ON CONFLICT DO NOTHING（真插入才算「首次」，rowCount=1）；
//       ③ 计数 UPDATE 仅当真正插入/删除时执行，且与去重写入【同一事务】原子提交；
//     叠加路由层 Idempotency-Key（脊柱 §4 中间件）= 第四道防线（回放首次结果）。
//   - 社交计数维护在 creator_profiles 冗余列（followers_count/following_count/likes_count），
//     供个人主页 Hero 身份区直读（§2.1，profile-repo.readProfileBase 同一份冗余列）。
//   - 防御式计数 UPDATE：WHERE user_id 命中 0 行（该用户无 creator_profiles 行，如非创作者关注者）则
//     静默 no-op——不在本模块强建 profile 行（creator_profiles 创建归属他域），只维护已存在的名片计数。
//   - owner/业务校验（自己不能关注自己）由 handler 在 requireAuth 之后判定（§3.5，与鉴权角色无关）。
import type { Tx, TxPool } from '../../platform/events/db-tx.js';
import { withTransaction } from '../../platform/events/db-tx.js';
import type { Queryable } from '../../platform/jobs/types.js';

/** 关注写结果（计数为被关注者更新后的真实粉丝数）。 */
export interface FollowOutcome {
  /** 本次是否真正改变了关系（true=新建/删除生效；false=重复操作无副作用，幂等回放语义）。 */
  changed: boolean;
  /** 被关注者（creator）更新后的粉丝数（冗余列；无 profile 行 → 0）。 */
  followersCount: number;
}

/** 点赞写结果（计数为该能力所属创作者更新后的获赞数）。 */
export interface LikeOutcome {
  changed: boolean;
  /** 该能力所属创作者更新后的获赞数（冗余列；owner 无 profile 行 → 0）。 */
  likesCount: number;
}

/** 目标不存在（被关注创作者无主页 / 被点赞能力不存在）→ handler 转 404（不暴露存在性，§3.5）。 */
export class SocialTargetNotFound extends Error {
  constructor() {
    super('social target not found');
    this.name = 'SocialTargetNotFound';
  }
}

/** 自赞（creator 点赞自己名下能力）→ handler 转 422（禁自赞，与「关注自己」同口径，§3.5）。 */
export class SocialSelfLike extends Error {
  constructor() {
    super('cannot like own capability');
    this.name = 'SocialSelfLike';
  }
}

/**
 * 计数维护后强不变量校验（Codex r1#3）：creator 必有 creator_profiles 行（FK 1:1 user），
 *   故被关注者/能力 owner 的计数 UPDATE 必须命中 1 行；命中 0 行 = 数据不一致（如 profile 缺失），
 *   绝不静默放过（否则计数 no-op 但仍 200 = 计数失真）。被关注者 owner 计数为权威列，必须 RETURNING 确认。
 */
function assertCounted(rowCount: number | null | undefined, what: string): void {
  if ((rowCount ?? 0) < 1) {
    throw new Error(
      `social count update affected no row (${what}); profile row missing/inconsistent`,
    );
  }
}

/** 读某创作者更新后的粉丝数（事务内，计数 UPDATE 之后）。无 profile 行 → 0。 */
async function readFollowersCount(tx: Tx, creatorId: string): Promise<number> {
  const res = await tx.query<{ followers_count: number }>(
    `SELECT followers_count FROM creator_profiles WHERE user_id = $1`,
    [creatorId],
  );
  return res.rows[0]?.followers_count ?? 0;
}

/** 读某创作者更新后的获赞数（事务内）。无 profile 行 → 0。 */
async function readLikesCount(tx: Tx, creatorId: string): Promise<number> {
  const res = await tx.query<{ likes_count: number }>(
    `SELECT likes_count FROM creator_profiles WHERE user_id = $1`,
    [creatorId],
  );
  return res.rows[0]?.likes_count ?? 0;
}

/**
 * 关注：INSERT follows ON CONFLICT DO NOTHING → 仅真插入时 followee.followers_count+1、
 *   follower.following_count+1，同事务原子提交。
 *   被关注目标必须是【有主页的创作者】（creator_profiles 行存在，Codex r1#3）：只校验 users 不够，
 *   会让人关注没有主页的普通 user、计数 no-op 却仍 200。无 profile → 404（不暴露存在性，§3.5）。
 *   被关注者粉丝数 UPDATE 用 RETURNING 强不变量（必命中 1 行，否则报错，不静默 no-op）。
 */
export async function follow(
  pool: TxPool,
  followerId: string,
  followeeId: string,
): Promise<FollowOutcome> {
  return withTransaction(pool, async (tx) => {
    // 被关注目标必须是有主页的创作者（creator_profiles，不是任意 users）；无 → 404（§3.5，Codex r1#3）。
    const exists = await tx.query<{ exists: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM creator_profiles WHERE user_id = $1) AS exists`,
      [followeeId],
    );
    if (!exists.rows[0]?.exists) throw new SocialTargetNotFound();

    const ins = await tx.query(
      `INSERT INTO follows (follower_id, followee_id)
       VALUES ($1, $2)
       ON CONFLICT (follower_id, followee_id) DO NOTHING`,
      [followerId, followeeId],
    );
    const changed = (ins.rowCount ?? 0) > 0;
    if (changed) {
      // 被关注者粉丝数 +1。RETURNING 确认确实改了行（creator 必有 profile；命中 0 行 = 不一致 → 报错）。
      const upd = await tx.query(
        `UPDATE creator_profiles SET followers_count = followers_count + 1, updated_at = now()
          WHERE user_id = $1 RETURNING user_id`,
        [followeeId],
      );
      assertCounted(upd.rowCount, 'follow.followers_count');
      // 关注者关注数 +1（仅当关注者本身有 profile 行，如其也是创作者；否则 no-op，不强建 profile）。
      await tx.query(
        `UPDATE creator_profiles SET following_count = following_count + 1, updated_at = now()
          WHERE user_id = $1`,
        [followerId],
      );
    }
    const followersCount = await readFollowersCount(tx, followeeId);
    return { changed, followersCount };
  });
}

/**
 * 取关：DELETE follows → 仅真删除时 followee.followers_count-1、follower.following_count-1
 *   （GREATEST(...,0) 兜底不破 CHECK>=0），同事务原子提交。重复取关（已无行）→ changed:false、计数不动。
 *   目标不存在校验同 follow（404 不暴露存在性）；重复取关本身不报错（幂等回放语义）。
 */
export async function unfollow(
  pool: TxPool,
  followerId: string,
  followeeId: string,
): Promise<FollowOutcome> {
  return withTransaction(pool, async (tx) => {
    // 取关目标同样必须是有主页的创作者（creator_profiles）；无 → 404（与 follow 同口径，Codex r1#3）。
    const exists = await tx.query<{ exists: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM creator_profiles WHERE user_id = $1) AS exists`,
      [followeeId],
    );
    if (!exists.rows[0]?.exists) throw new SocialTargetNotFound();

    const del = await tx.query(`DELETE FROM follows WHERE follower_id = $1 AND followee_id = $2`, [
      followerId,
      followeeId,
    ]);
    const changed = (del.rowCount ?? 0) > 0;
    if (changed) {
      // 被关注者粉丝数 -1（GREATEST 不破 CHECK>=0）。RETURNING 确认确实改了行（creator 必有 profile）。
      const upd = await tx.query(
        `UPDATE creator_profiles
            SET followers_count = GREATEST(followers_count - 1, 0), updated_at = now()
          WHERE user_id = $1 RETURNING user_id`,
        [followeeId],
      );
      assertCounted(upd.rowCount, 'unfollow.followers_count');
      await tx.query(
        `UPDATE creator_profiles
            SET following_count = GREATEST(following_count - 1, 0), updated_at = now()
          WHERE user_id = $1`,
        [followerId],
      );
    }
    const followersCount = await readFollowersCount(tx, followeeId);
    return { changed, followersCount };
  });
}

/**
 * 点赞能力：先查该能力所属创作者（capabilities.creator_user_id；不存在 → 404）→
 *   禁自赞（owner === userId → 422 SocialSelfLike，与「关注自己」同口径，§3.5，Codex r1#3）→
 *   INSERT likes ON CONFLICT DO NOTHING → 仅真插入时该创作者 likes_count+1（名下能力获赞总和，§2.1），
 *   同事务原子提交。likes_count UPDATE 用 RETURNING 强不变量（必命中 1 行）。返回 owner 更新后的获赞数。
 */
export async function like(
  pool: TxPool,
  userId: string,
  capabilityId: string,
): Promise<LikeOutcome> {
  return withTransaction(pool, async (tx) => {
    const owner = await readCapabilityOwnerTx(tx, capabilityId);
    if (owner === null) throw new SocialTargetNotFound();
    // 禁自赞：creator 不能点赞自己名下能力（422，handler 转 SOCIAL_SELF_FOLLOW 文案口径，Codex r1#3）。
    if (owner === userId) throw new SocialSelfLike();

    const ins = await tx.query(
      `INSERT INTO likes (user_id, capability_id)
       VALUES ($1, $2)
       ON CONFLICT (user_id, capability_id) DO NOTHING`,
      [userId, capabilityId],
    );
    const changed = (ins.rowCount ?? 0) > 0;
    if (changed) {
      // 该能力所属创作者获赞数 +1（likes_count = 名下能力获赞总和）。RETURNING 确认确实改了行。
      const upd = await tx.query(
        `UPDATE creator_profiles SET likes_count = likes_count + 1, updated_at = now()
          WHERE user_id = $1 RETURNING user_id`,
        [owner],
      );
      assertCounted(upd.rowCount, 'like.likes_count');
    }
    const likesCount = await readLikesCount(tx, owner);
    return { changed, likesCount };
  });
}

/**
 * 取消点赞：DELETE likes → 仅真删除时该能力所属创作者 likes_count-1（GREATEST 兜底）。
 *   重复取消（已无行）→ changed:false、计数不动。能力不存在 → 404。
 */
export async function unlike(
  pool: TxPool,
  userId: string,
  capabilityId: string,
): Promise<LikeOutcome> {
  return withTransaction(pool, async (tx) => {
    const owner = await readCapabilityOwnerTx(tx, capabilityId);
    if (owner === null) throw new SocialTargetNotFound();
    // 禁自赞同口径（自己从未能赞自己，取消自赞也按 422 拒，避免错误改 owner 计数，Codex r1#3）。
    if (owner === userId) throw new SocialSelfLike();

    const del = await tx.query(`DELETE FROM likes WHERE user_id = $1 AND capability_id = $2`, [
      userId,
      capabilityId,
    ]);
    const changed = (del.rowCount ?? 0) > 0;
    if (changed) {
      // owner 获赞数 -1（GREATEST 兜底）。RETURNING 确认确实改了行（creator 必有 profile）。
      const upd = await tx.query(
        `UPDATE creator_profiles
            SET likes_count = GREATEST(likes_count - 1, 0), updated_at = now()
          WHERE user_id = $1 RETURNING user_id`,
        [owner],
      );
      assertCounted(upd.rowCount, 'unlike.likes_count');
    }
    const likesCount = await readLikesCount(tx, owner);
    return { changed, likesCount };
  });
}

/** 查能力所属创作者（事务内）。能力不存在 → null（handler 转 404）。 */
async function readCapabilityOwnerTx(tx: Tx, capabilityId: string): Promise<string | null> {
  const res = await tx.query<{ creator_user_id: string }>(
    `SELECT creator_user_id FROM capabilities WHERE id = $1`,
    [capabilityId],
  );
  return res.rows[0]?.creator_user_id ?? null;
}

// ===========================================================================
// 社交计数读模型（供个人主页 Hero 身份区 / 工作台复用，§2.1）
// ===========================================================================

/** 创作者社交计数（关注/粉丝/获赞，真实冗余列，非 usage）。 */
export interface SocialCounts {
  following: number;
  followers: number;
  likes: number;
}

/**
 * 读某创作者社交三计数（直读 creator_profiles 冗余列，不实时 COUNT(*)，§3 末注）。
 *   无 profile 行（非创作者）→ 全 0（个人主页不存在则 handler 走 404，此函数只负责计数口径）。
 *   与 profile-repo.readProfileBase 同一份冗余列；本写域负责事务内维护、本读函数供外域复用。
 */
export async function readSocialCounts(db: Queryable, creatorId: string): Promise<SocialCounts> {
  const res = await db.query<{
    followers_count: number;
    following_count: number;
    likes_count: number;
  }>(
    `SELECT followers_count, following_count, likes_count
       FROM creator_profiles WHERE user_id = $1`,
    [creatorId],
  );
  const row = res.rows[0];
  return {
    following: row?.following_count ?? 0,
    followers: row?.followers_count ?? 0,
    likes: row?.likes_count ?? 0,
  };
}

/** 当前查看者是否已关注该创作者（§2.1 viewerIsFollowing）。匿名/自看 → null。 */
export async function readViewerIsFollowing(
  db: Queryable,
  creatorId: string,
  viewerId: string | null,
): Promise<boolean | null> {
  if (!viewerId) return null;
  if (viewerId === creatorId) return null;
  const res = await db.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM follows WHERE follower_id = $1 AND followee_id = $2
     ) AS exists`,
    [viewerId, creatorId],
  );
  return res.rows[0]?.exists ?? false;
}

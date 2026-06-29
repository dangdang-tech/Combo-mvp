// 60 个人主页全六分区聚合自检（B-33，60-dashboard-profile §2，主页-01~26）。忠实假 PG，无真 PG/Docker。
//   覆盖：六分区数据齐全 + 顺序固定；社交计数真实；密度真实段数；热力图聚合；网络 session/tag 共现不依赖 embedding；
//        作品墙单源过滤/回退；usage 占位 null + placeholders；对外只读不下钻不带经营维度；访客同视图；空态；404；聚合/分区失败。
import { describe, it, expect } from 'vitest';
import {
  readCreatorProfile,
  readDensityPage,
  readHeatmap,
  readNetwork,
  readWorksPage,
  readViewerIsFollowing,
  PROFILE_SECTIONS_ORDER,
} from '../profile/profile-repo.js';
import {
  CreatorProfileSchema,
  encodeIdCursor,
  decodeIdCursor,
  InvalidCursorError,
} from '@cb/shared';
import {
  ProfileFakeDb,
  seedProfile,
  seedPublishedCapability,
  seedRejectedCapability,
  seedSupport,
  seedCooccurrence,
} from './profile-fakes.js';

const TODAY = new Date('2026-06-15T12:00:00.000Z');
// 趋势近半窗界（today - 91 天 = 2026-03-16）。
const RECENT = '2026-05-01T00:00:00.000Z';
const OLD = '2026-01-01T00:00:00.000Z';

describe('readCreatorProfile — 六分区全量首屏（主页-01/02/03）', () => {
  it('六分区齐全、sectionsOrder 固定顺序、schema 通过', async () => {
    const db = new ProfileFakeDb();
    const creatorId = seedProfile(db, { followers_count: 12, following_count: 3, likes_count: 88 });
    const a = seedPublishedCapability(db, creatorId, {
      name: '需求炼金师',
      tags: ['保险', '增长'],
    });
    seedSupport(db, creatorId, a.slug, [RECENT, RECENT, OLD]);

    const res = await readCreatorProfile(db, creatorId, null, TODAY);
    expect(res).not.toBeNull();
    const p = res!.profile;
    expect(p.sectionsOrder).toEqual(PROFILE_SECTIONS_ORDER);
    expect(p.sectionsOrder).toEqual(['hero', 'metrics', 'density', 'heatmap', 'network', 'works']);
    // 六分区都在。
    expect(p.hero).toBeTruthy();
    expect(p.metrics).toBeTruthy();
    expect(p.density).toBeTruthy();
    expect(p.heatmap).toBeTruthy();
    expect(p.network).toBeTruthy();
    expect(p.works).toBeTruthy();
    expect(CreatorProfileSchema.safeParse(p).success).toBe(true);
  });

  it('① Hero 社交计数真实（非 usage，主页-02/21）', async () => {
    const db = new ProfileFakeDb();
    const creatorId = seedProfile(db, {
      display_name: '韦恩',
      identity_tags: ['保险经纪', '增长黑客'],
      bio: '把对话炼成能力',
      followers_count: 1024,
      following_count: 56,
      likes_count: 7777,
    });
    const res = await readCreatorProfile(db, creatorId, null, TODAY);
    const hero = res!.profile.hero;
    expect(hero.displayName).toBe('韦恩');
    expect(hero.identityTags).toEqual(['保险经纪', '增长黑客']);
    expect(hero.bio).toBe('把对话炼成能力');
    // 真实计数（精确整数透传）。
    expect(hero.social.followers).toBe(1024);
    expect(hero.social.following).toBe(56);
    expect(hero.social.likes).toBe(7777);
    // 匿名访客 viewerIsFollowing=null（不影响只读，主页-13）。
    expect(hero.social.viewerIsFollowing).toBeNull();
  });

  it('② 指标带真实项（能力点数/知识领域数/最热主题名）+ usage 占位（主页-03/04/26）', async () => {
    const db = new ProfileFakeDb();
    const creatorId = seedProfile(db);
    const a = seedPublishedCapability(db, creatorId, {
      name: '需求炼金师',
      tags: ['保险', '增长'],
    });
    const b = seedPublishedCapability(db, creatorId, { name: '保单分析师', tags: ['保险'] });
    seedSupport(db, creatorId, a.slug, [RECENT, RECENT, RECENT]); // a 段数更多 → 密度榜首
    seedSupport(db, creatorId, b.slug, [OLD]);

    const res = await readCreatorProfile(db, creatorId, null, TODAY);
    const m = res!.profile.metrics;
    expect(m.capabilityCount).toBe(2); // 真实：上墙能力数
    expect(m.domainCount).toBe(2); // distinct tags：保险/增长
    expect(m.hottestTopic.name).toBe('需求炼金师'); // 真实：密度榜首名
    // usage 占位：恒 null。
    expect(m.totalInvocations).toBeNull();
    expect(m.hottestTopic.heatValue).toBeNull();
    // 只读硬约束（主页-04）。
    expect(m.readonly).toBe(true);
  });

  it('③ 密度榜真实支撑段数 + 趋势（主页-05/08，首屏前 3 + hasMore）', async () => {
    const db = new ProfileFakeDb();
    const creatorId = seedProfile(db);
    for (let i = 0; i < 5; i += 1) {
      const c = seedPublishedCapability(db, creatorId, { name: `能力${i}`, slug: `cap-slug-${i}` });
      // 段数递减：i=0 最多。近半窗多 → up。
      seedSupport(db, creatorId, c.slug, Array(5 - i).fill(RECENT));
    }
    const res = await readCreatorProfile(db, creatorId, null, TODAY);
    const d = res!.profile.density;
    expect(d.rows).toHaveLength(3); // 首屏前 3（主页-05）
    expect(d.hasMore).toBe(true); // 共 5 → 展开更多（主页-06）
    // 真实支撑段数（信任货币）：榜首 5 段。
    expect(d.rows[0]!.supportingSegments).toBe(5);
    expect(d.rows[0]!.rank).toBe(1);
    expect(d.rows[0]!.densityScore).toBe(100);
    expect(d.rows[0]!.trend).toBe('up'); // 全在近半窗
    expect(d.rows.every((r) => r.readonly === true)).toBe(true); // 只读无管理（主页-08）
  });

  it('④ 热力图按 happened_at 聚合（不依赖 usage，主页-09）', async () => {
    const db = new ProfileFakeDb();
    const creatorId = seedProfile(db);
    const a = seedPublishedCapability(db, creatorId, { name: 'x' });
    // 同一天 3 段 + 另一天 1 段。
    seedSupport(db, creatorId, a.slug, [
      '2026-06-15T01:00:00.000Z',
      '2026-06-15T05:00:00.000Z',
      '2026-06-15T09:00:00.000Z',
      '2026-06-10T00:00:00.000Z',
    ]);
    const res = await readCreatorProfile(db, creatorId, null, TODAY);
    const hm = res!.profile.heatmap;
    expect(hm.enabled).toBe(true);
    const d15 = hm.cells.find((c) => c.date === '2026-06-15');
    expect(d15?.count).toBe(3);
    expect(hm.maxCount).toBe(3);
    // 隐私：格子仅 date/count/level。
    expect(Object.keys(hm.cells[0]!).sort()).toEqual(['count', 'date', 'level']);
  });

  it('④ 热力图开关关闭（主页-20）→ enabled:false + 空 cells，其余分区不乱', async () => {
    const db = new ProfileFakeDb();
    const creatorId = seedProfile(db, { heatmap_enabled: false });
    const a = seedPublishedCapability(db, creatorId, { name: 'x' });
    seedSupport(db, creatorId, a.slug, ['2026-06-15T01:00:00.000Z']);
    const res = await readCreatorProfile(db, creatorId, null, TODAY);
    expect(res!.profile.heatmapEnabled).toBe(false);
    expect(res!.profile.heatmap.enabled).toBe(false);
    expect(res!.profile.heatmap.cells).toEqual([]);
    // sectionsOrder 仍含 heatmap 占位键（前端据 enabled 跳过渲染）。
    expect(res!.profile.sectionsOrder).toContain('heatmap');
    // 其余分区仍在。
    expect(res!.profile.works.cards).toHaveLength(1);
  });

  it('⑤ 网络 session 共现（同 snapshot 命中多能力，不依赖 embedding，主页-10）', async () => {
    const db = new ProfileFakeDb();
    const creatorId = seedProfile(db);
    const a = seedPublishedCapability(db, creatorId, { name: 'A', slug: 'sa' });
    const b = seedPublishedCapability(db, creatorId, { name: 'B', slug: 'sb' });
    // A、B 在同一 snapshot 命中 → session_cooccur 边。
    seedCooccurrence(db, creatorId, [a.slug, b.slug]);
    const res = await readCreatorProfile(db, creatorId, null, TODAY);
    const net = res!.profile.network;
    expect(net.thumbnailOnly).toBe(true);
    const sessionEdge = net.edges.find((e) => e.basis === 'session_cooccur');
    expect(sessionEdge).toBeTruthy();
    expect([sessionEdge!.source, sessionEdge!.target].sort()).toEqual(
      [a.capabilityId, b.capabilityId].sort(),
    );
  });

  it('⑤ 网络 tag 共现（tags 重叠，不依赖 embedding，主页-10）', async () => {
    const db = new ProfileFakeDb();
    const creatorId = seedProfile(db);
    seedPublishedCapability(db, creatorId, { name: 'A', slug: 'sa', tags: ['保险', '增长'] });
    seedPublishedCapability(db, creatorId, { name: 'B', slug: 'sb', tags: ['保险'] });
    const res = await readCreatorProfile(db, creatorId, null, TODAY);
    const tagEdge = res!.profile.network.edges.find((e) => e.basis === 'tag_overlap');
    expect(tagEdge).toBeTruthy();
    expect(tagEdge!.weight).toBe(1); // 重叠 1 个 tag（保险）
  });

  it('⑥ 作品墙单源过滤：被拒下架不上墙（主页-23）', async () => {
    const db = new ProfileFakeDb();
    const creatorId = seedProfile(db);
    seedPublishedCapability(db, creatorId, { name: '上架能力' });
    seedRejectedCapability(db, creatorId, { name: '被拒能力' }); // review_rejected → 不上墙
    const res = await readCreatorProfile(db, creatorId, null, TODAY);
    const cards = res!.profile.works.cards;
    expect(cards).toHaveLength(1);
    expect(cards[0]!.name).toBe('上架能力');
    // 被拒能力名绝不出现。
    expect(cards.some((c) => c.name === '被拒能力')).toBe(false);
  });

  it('⑥ 作品墙 usage 占位：invocations 恒 null；name/cover 真实（主页-11/19）', async () => {
    const db = new ProfileFakeDb();
    const creatorId = seedProfile(db);
    seedPublishedCapability(db, creatorId, { name: '需求炼金师', coverUrl: 'cover.png' });
    const res = await readCreatorProfile(db, creatorId, null, TODAY);
    const card = res!.profile.works.cards[0]!;
    expect(card.invocations).toBeNull();
    expect(card.name).toBe('需求炼金师');
    expect(card.coverUrl).toBe('cover.png');
  });

  it('⑥ 作品墙首屏切片带后端铸造 nextCursor（hasMore 时；前端据此真追加，Codex r1#5）', async () => {
    const db = new ProfileFakeDb();
    const creatorId = seedProfile(db);
    // 播 WORKS_SLICE_LIMIT(24) + 1 = 25 张上墙卡 → 首屏切 24、hasMore=true、带 nextCursor。
    for (let i = 0; i < 25; i++) {
      seedPublishedCapability(db, creatorId, {
        name: `能力${i}`,
        createdAt: `2026-06-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`,
      });
    }
    const res = await readCreatorProfile(db, creatorId, null, TODAY);
    const works = res!.profile.works;
    expect(works.cards).toHaveLength(24);
    expect(works.hasMore).toBe(true);
    expect(works.nextCursor).toBeTruthy();
    // cursor 不透明编码（脊柱 §2.3），解码锚 = 首屏末位卡 capabilityId（与 readWorksPage 同一编码）。
    expect(decodeIdCursor(works.nextCursor!)).toBe(
      works.cards[works.cards.length - 1]!.capabilityId,
    );
  });

  it('⑥ 作品墙首屏切片无更多 → nextCursor=null（hasMore=false）', async () => {
    const db = new ProfileFakeDb();
    const creatorId = seedProfile(db);
    seedPublishedCapability(db, creatorId, { name: '唯一能力' });
    const res = await readCreatorProfile(db, creatorId, null, TODAY);
    expect(res!.profile.works.hasMore).toBe(false);
    expect(res!.profile.works.nextCursor).toBeNull();
  });

  it('usage 占位键齐全（totalInvocations / hottestTopic.heatValue / works.invocations）', async () => {
    const db = new ProfileFakeDb();
    const creatorId = seedProfile(db);
    seedPublishedCapability(db, creatorId, { name: 'x' });
    const res = await readCreatorProfile(db, creatorId, null, TODAY);
    expect(res!.usagePlaceholderKeys).toContain('totalInvocations');
    expect(res!.usagePlaceholderKeys).toContain('hottestTopic.heatValue');
    expect(res!.usagePlaceholderKeys).toContain('works.invocations');
  });

  it('对外只读不下钻不带经营维度（主页-04/25/26）：无收益/成本/钱/草稿/上传字段', async () => {
    const db = new ProfileFakeDb();
    const creatorId = seedProfile(db);
    seedPublishedCapability(db, creatorId, { name: 'x' });
    const res = await readCreatorProfile(db, creatorId, null, TODAY);
    const serialized = JSON.stringify(res!.profile);
    // 公开口径绝不含经营/钱维度关键字。
    for (const banned of [
      'revenue',
      'spend',
      'cost',
      'micros',
      'draft',
      'upload',
      'reviewStatus',
      'review_rejected',
    ]) {
      expect(serialized.includes(banned)).toBe(false);
    }
    // 指标带 readonly 硬信号。
    expect(res!.profile.metrics.readonly).toBe(true);
  });

  it('访客视角 == 本人视角（同一张公开名片，主页-13）—— 仅 viewerIsFollowing 不同', async () => {
    const db = new ProfileFakeDb();
    const creatorId = seedProfile(db, { followers_count: 5 });
    seedPublishedCapability(db, creatorId, { name: 'x' });
    const viewerId = 'viewer-1';
    db.follows.push({ follower_id: viewerId, followee_id: creatorId });

    const asGuest = await readCreatorProfile(db, creatorId, null, TODAY);
    const asViewer = await readCreatorProfile(db, creatorId, viewerId, TODAY);
    // 除 viewerIsFollowing 外，数据一致。
    const stripFollow = (p: { hero: { social: { viewerIsFollowing: boolean | null } } }) => {
      const clone = JSON.parse(JSON.stringify(p));
      clone.hero.social.viewerIsFollowing = '__';
      return clone;
    };
    expect(stripFollow(asGuest!.profile)).toEqual(stripFollow(asViewer!.profile));
    expect(asGuest!.profile.hero.social.viewerIsFollowing).toBeNull(); // 匿名
    expect(asViewer!.profile.hero.social.viewerIsFollowing).toBe(true); // 已关注
  });

  it('空态新创作者（主页-14）：各分区空但不报错', async () => {
    const db = new ProfileFakeDb();
    const creatorId = seedProfile(db);
    const res = await readCreatorProfile(db, creatorId, null, TODAY);
    const p = res!.profile;
    expect(p.metrics.capabilityCount).toBe(0);
    expect(p.metrics.hottestTopic.name).toBeNull(); // 无主题
    expect(p.density.rows).toEqual([]);
    expect(p.density.hasMore).toBe(false);
    expect(p.heatmap.cells).toEqual([]);
    expect(p.network.nodes).toEqual([]);
    expect(p.network.edges).toEqual([]);
    expect(p.works.cards).toEqual([]);
  });

  it('creatorId 不存在 → null（handler 404，不下钻不暴露存在性，§2.7）', async () => {
    const db = new ProfileFakeDb();
    const res = await readCreatorProfile(db, 'nope', null, TODAY);
    expect(res).toBeNull();
  });

  it('全分区成功 → sectionErrors 为空（无连坐标记）', async () => {
    const db = new ProfileFakeDb();
    const creatorId = seedProfile(db);
    seedPublishedCapability(db, creatorId, { name: 'x' });
    const res = await readCreatorProfile(db, creatorId, null, TODAY);
    expect(res!.profile.sectionErrors).toEqual([]);
    expect(CreatorProfileSchema.safeParse(res!.profile).success).toBe(true);
  });
});

// ===========================================================================
// 分区局部失败不连坐（60 §2.7，主页-17，Codex#r3 P1）：次要分区源失败，核心分区仍成功
// ===========================================================================
describe('主聚合分区不连坐（§2.7，主页-17）', () => {
  function seedFull(db: ProfileFakeDb): string {
    const creatorId = seedProfile(db, { followers_count: 9 });
    const a = seedPublishedCapability(db, creatorId, { name: '需求炼金师', tags: ['保险'] });
    const b = seedPublishedCapability(db, creatorId, { name: '保单分析师', tags: ['保险'] });
    seedSupport(db, creatorId, a.slug, [RECENT, RECENT]);
    seedSupport(db, creatorId, b.slug, [RECENT]);
    seedCooccurrence(db, creatorId, [a.slug, b.slug]);
    return creatorId;
  }

  it('热力图 + 网络分区源失败 → 这两区 null + sectionErrors；hero/metrics/density/works 仍齐全（核心不连坐）', async () => {
    const db = new ProfileFakeDb();
    const creatorId = seedFull(db);
    db.throwOnSources.add('heatmap');
    db.throwOnSources.add('hits'); // 网络共现源
    const res = await readCreatorProfile(db, creatorId, null, TODAY);
    expect(res).not.toBeNull();
    const p = res!.profile;
    // 失败分区：null + 标记。
    expect(p.heatmap).toBeNull();
    expect(p.network).toBeNull();
    const failed = p.sectionErrors.map((e) => e.section).sort();
    expect(failed).toEqual(['heatmap', 'network']);
    expect(p.sectionErrors.every((e) => e.retriable === true)).toBe(true);
    // 核心分区不连坐：hero/metrics/density/works 仍齐全（真实值）。
    expect(p.hero).toBeTruthy();
    expect(p.metrics).not.toBeNull();
    expect(p.metrics!.capabilityCount).toBe(2);
    expect(p.density).not.toBeNull();
    expect(p.density!.rows.length).toBeGreaterThan(0);
    expect(p.works).not.toBeNull();
    expect(p.works!.cards.length).toBe(2);
    // 整页 schema 仍通过（nullable 分区合法）。
    expect(CreatorProfileSchema.safeParse(p).success).toBe(true);
  });

  it('viewerFollowing 失败 → hero 仍在（viewerIsFollowing 退化 null，不连坐）', async () => {
    const db = new ProfileFakeDb();
    const creatorId = seedFull(db);
    db.follows.push({ follower_id: 'v1', followee_id: creatorId });
    db.throwOnSources.add('viewerFollowing');
    const res = await readCreatorProfile(db, creatorId, 'v1', TODAY);
    expect(res!.profile.hero).toBeTruthy();
    expect(res!.profile.hero.social.viewerIsFollowing).toBeNull(); // 退化，不连坐 hero 本体
    expect(res!.profile.hero.social.followers).toBe(9); // hero 真实计数仍在
    // viewerFollowing 不是六分区之一，不进 sectionErrors。
    expect(res!.profile.sectionErrors).toEqual([]);
  });

  it('caps 脊柱源失败 → metrics/density/works/network 全 null + 标记；hero/heatmap 仍在', async () => {
    const db = new ProfileFakeDb();
    const creatorId = seedFull(db);
    db.throwOnSources.add('caps');
    const res = await readCreatorProfile(db, creatorId, null, TODAY);
    const p = res!.profile;
    expect(p.metrics).toBeNull();
    expect(p.density).toBeNull();
    expect(p.works).toBeNull();
    expect(p.network).toBeNull();
    const failed = p.sectionErrors.map((e) => e.section).sort();
    expect(failed).toEqual(['density', 'metrics', 'network', 'works']);
    // hero（基行）+ heatmap（独立源）不连坐。
    expect(p.hero).toBeTruthy();
    expect(p.heatmap).not.toBeNull();
    expect(CreatorProfileSchema.safeParse(p).success).toBe(true);
  });

  it('反向破坏对照：无注入失败 → 六分区全成功、sectionErrors 空（证明上面失败断言非空跑）', async () => {
    const db = new ProfileFakeDb();
    const creatorId = seedFull(db);
    const res = await readCreatorProfile(db, creatorId, null, TODAY);
    const p = res!.profile;
    expect(p.heatmap).not.toBeNull();
    expect(p.network).not.toBeNull();
    expect(p.metrics).not.toBeNull();
    expect(p.works).not.toBeNull();
    expect(p.sectionErrors).toEqual([]);
  });
});

// ===========================================================================
// owner 隔离（P0，Codex r1#1）：同 slug 跨创作者，主页密度/网络只算本人，不串他人
// ===========================================================================
describe('owner 隔离：同 slug 跨创作者不串（密度段数 / 网络共现，主页-04/13/25/26）', () => {
  /** 播两位创作者 A/B，名下能力共用同一 slug；各自挂自有快照的支撑段。 */
  function seedTwoCreatorsSameSlug(db: ProfileFakeDb) {
    const sharedSlug = 'shared-slug';
    const aId = seedProfile(db, { user_id: 'creator-A' });
    const bId = seedProfile(db, { user_id: 'creator-B' });
    const a = seedPublishedCapability(db, aId, { name: 'A 的能力', slug: sharedSlug });
    const b = seedPublishedCapability(db, bId, { name: 'B 的能力', slug: sharedSlug });
    // A 自有快照挂 2 段；B 自有快照挂 5 段（同 slug，但属于 B）。
    seedSupport(db, aId, sharedSlug, [RECENT, RECENT]);
    seedSupport(db, bId, sharedSlug, [RECENT, RECENT, RECENT, RECENT, RECENT]);
    return { aId, bId, a, b, sharedSlug };
  }

  it('密度榜段数 owner-scoped：A 的主页只算 A 自己的 2 段，不含 B 的 5 段', async () => {
    const db = new ProfileFakeDb();
    const { aId } = seedTwoCreatorsSameSlug(db);
    const res = await readCreatorProfile(db, aId, null, TODAY);
    const row = res!.profile.density.rows[0]!;
    // 只算 A 自有快照的段（2），绝不把 B 的 5 段计入（数据越权泄露）。
    expect(row.supportingSegments).toBe(2);
  });

  it('密度榜段数 owner-scoped：B 的主页只算 B 自己的 5 段，不含 A 的 2 段', async () => {
    const db = new ProfileFakeDb();
    const { bId } = seedTwoCreatorsSameSlug(db);
    const res = await readCreatorProfile(db, bId, null, TODAY);
    expect(res!.profile.density.rows[0]!.supportingSegments).toBe(5);
  });

  it('网络共现 owner-scoped：A 的主页只含 A 自有 snapshot 的共现边，不含 B 的', async () => {
    const db = new ProfileFakeDb();
    const aId = seedProfile(db, { user_id: 'creator-A2' });
    const bId = seedProfile(db, { user_id: 'creator-B2' });
    // A 名下两能力（slug x/y），同 A 快照共现 → A 主页应有边。
    const ax = seedPublishedCapability(db, aId, { name: 'AX', slug: 'sx' });
    const ay = seedPublishedCapability(db, aId, { name: 'AY', slug: 'sy' });
    seedCooccurrence(db, aId, [ax.slug, ay.slug]);
    // B 名下两能力，复用同 slug x/y，在 B 自有快照共现（不应进 A 主页）。
    seedPublishedCapability(db, bId, { name: 'BX', slug: 'sx' });
    seedPublishedCapability(db, bId, { name: 'BY', slug: 'sy' });
    seedCooccurrence(db, bId, ['sx', 'sy']);

    const res = await readCreatorProfile(db, aId, null, TODAY);
    const net = res!.profile.network;
    // A 主页网络节点只含 A 自己的两能力。
    const nodeIds = net.nodes.map((n) => n.capabilityId).sort();
    expect(nodeIds).toEqual([ax.capabilityId, ay.capabilityId].sort());
    // 共现边端点都在 A 自己的能力内（不串 B 的 capabilityId）。
    for (const e of net.edges) {
      expect(nodeIds).toContain(e.source);
      expect(nodeIds).toContain(e.target);
    }
  });

  it('反向破坏：去掉 owner 限定（breakOwnerScope）→ A 主页密度段数串入 B 的（测红，证明守门非空跑）', async () => {
    const db = new ProfileFakeDb();
    db.breakOwnerScope = true; // 退回按 slug 全局归集（owner 隔离失守）
    const { aId } = seedTwoCreatorsSameSlug(db);
    const res = await readCreatorProfile(db, aId, null, TODAY);
    // 无 owner 限定 → A 的 2 段 + B 的 5 段 = 7（与隔离期望 2 相反 → 断言能抓到越权回归）。
    expect(res!.profile.density.rows[0]!.supportingSegments).toBe(7);
  });
});

describe('readViewerIsFollowing（§2.1）', () => {
  it('匿名 viewerId=null → null', async () => {
    const db = new ProfileFakeDb();
    expect(await readViewerIsFollowing(db, 'c1', null)).toBeNull();
  });
  it('自己看自己 → null（无关注语义）', async () => {
    const db = new ProfileFakeDb();
    expect(await readViewerIsFollowing(db, 'c1', 'c1')).toBeNull();
  });
  it('已关注 → true；未关注 → false', async () => {
    const db = new ProfileFakeDb();
    db.follows.push({ follower_id: 'v1', followee_id: 'c1' });
    expect(await readViewerIsFollowing(db, 'c1', 'v1')).toBe(true);
    expect(await readViewerIsFollowing(db, 'c1', 'v2')).toBe(false);
  });
});

describe('分区子端点（翻页/展开/重试，§2.3~§2.6）', () => {
  it('密度榜 cursor 翻页（展开更多，主页-06）', async () => {
    const db = new ProfileFakeDb();
    const creatorId = seedProfile(db);
    for (let i = 0; i < 5; i += 1) {
      const c = seedPublishedCapability(db, creatorId, { name: `能力${i}`, slug: `cs-${i}` });
      seedSupport(db, creatorId, c.slug, Array(5 - i).fill(RECENT));
    }
    const p1 = await readDensityPage(db, creatorId, { limit: 3 }, TODAY);
    expect(p1!.rows).toHaveLength(3);
    expect(p1!.hasMore).toBe(true);
    // nextCursor 不透明编码（脊柱 §2.3）；解码锚 = 上一页末位 capabilityId。
    expect(decodeIdCursor(p1!.nextCursor!)).toBe(p1!.rows[2]!.capabilityId);
    const p2 = await readDensityPage(db, creatorId, { cursor: p1!.nextCursor!, limit: 3 }, TODAY);
    expect(p2!.rows).toHaveLength(2);
    expect(p2!.hasMore).toBe(false);
    expect(p2!.nextCursor).toBeNull();
    // 两页无重叠。
    const ids1 = p1!.rows.map((r) => r.capabilityId);
    const ids2 = p2!.rows.map((r) => r.capabilityId);
    expect(ids1.some((id) => ids2.includes(id))).toBe(false);
  });

  it('作品墙 cursor 翻页（主页-11）', async () => {
    const db = new ProfileFakeDb();
    const creatorId = seedProfile(db);
    for (let i = 0; i < 4; i += 1) {
      seedPublishedCapability(db, creatorId, {
        name: `作品${i}`,
        slug: `ws-${i}`,
        createdAt: `2026-06-0${i + 1}T00:00:00.000Z`,
      });
    }
    const p1 = await readWorksPage(db, creatorId, { limit: 2 }, TODAY);
    expect(p1!.cards).toHaveLength(2);
    expect(p1!.hasMore).toBe(true);
    const p2 = await readWorksPage(db, creatorId, { cursor: p1!.nextCursor!, limit: 2 }, TODAY);
    expect(p2!.cards).toHaveLength(2);
    expect(p2!.hasMore).toBe(false);
  });

  it('热力图子端点 range=year 窗口扩大', async () => {
    const db = new ProfileFakeDb();
    const creatorId = seedProfile(db);
    const a = seedPublishedCapability(db, creatorId, { name: 'x' });
    seedSupport(db, creatorId, a.slug, ['2026-06-15T00:00:00.000Z']);
    const hm = await readHeatmap(db, creatorId, 'year', TODAY);
    expect(hm!.range).toBe('year');
    expect(hm!.enabled).toBe(true);
  });

  it('网络子端点单独可读', async () => {
    const db = new ProfileFakeDb();
    const creatorId = seedProfile(db);
    const a = seedPublishedCapability(db, creatorId, { name: 'A', slug: 'na' });
    const b = seedPublishedCapability(db, creatorId, { name: 'B', slug: 'nb' });
    seedCooccurrence(db, creatorId, [a.slug, b.slug]);
    const net = await readNetwork(db, creatorId, TODAY);
    expect(net!.thumbnailOnly).toBe(true);
    expect(net!.edges.some((e) => e.basis === 'session_cooccur')).toBe(true);
  });

  it('子端点 creatorId 不存在 → null（handler 404）', async () => {
    const db = new ProfileFakeDb();
    expect(await readDensityPage(db, 'nope', { limit: 3 }, TODAY)).toBeNull();
    expect(await readHeatmap(db, 'nope', 'half_year', TODAY)).toBeNull();
    expect(await readNetwork(db, 'nope', TODAY)).toBeNull();
    expect(await readWorksPage(db, 'nope', { limit: 24 }, TODAY)).toBeNull();
  });
});

// ===========================================================================
// cursor 失效/畸形 → InvalidCursorError（handler 回 400，非静默首页/非 500，P1 Codex r1#2）
// ===========================================================================
describe('cursor 失效/畸形 → InvalidCursorError（密度榜 / 作品墙，60 §2.7）', () => {
  function seedDensity(db: ProfileFakeDb): string {
    const creatorId = seedProfile(db);
    for (let i = 0; i < 5; i += 1) {
      const c = seedPublishedCapability(db, creatorId, { name: `能力${i}`, slug: `iv-${i}` });
      seedSupport(db, creatorId, c.slug, Array(5 - i).fill(RECENT));
    }
    return creatorId;
  }

  it('密度榜：畸形 cursor（非不透明编码）→ 抛 InvalidCursorError（非静默回首页）', async () => {
    const db = new ProfileFakeDb();
    const creatorId = seedDensity(db);
    await expect(
      readDensityPage(db, creatorId, { cursor: 'not-a-real-cursor', limit: 3 }, TODAY),
    ).rejects.toThrow(InvalidCursorError);
  });

  it('密度榜：合法编码但锚 id 不在当前榜单 → 抛 InvalidCursorError（失效，非静默回首页）', async () => {
    const db = new ProfileFakeDb();
    const creatorId = seedDensity(db);
    await expect(
      readDensityPage(
        db,
        creatorId,
        { cursor: encodeIdCursor('cap-does-not-exist'), limit: 3 },
        TODAY,
      ),
    ).rejects.toThrow(InvalidCursorError);
  });

  it('作品墙：畸形 cursor → 抛 InvalidCursorError', async () => {
    const db = new ProfileFakeDb();
    const creatorId = seedProfile(db);
    seedPublishedCapability(db, creatorId, { name: 'w' });
    await expect(
      readWorksPage(db, creatorId, { cursor: '%%bad%%', limit: 24 }, TODAY),
    ).rejects.toThrow(InvalidCursorError);
  });

  it('作品墙：合法编码但锚不在墙 → 抛 InvalidCursorError', async () => {
    const db = new ProfileFakeDb();
    const creatorId = seedProfile(db);
    seedPublishedCapability(db, creatorId, { name: 'w' });
    await expect(
      readWorksPage(db, creatorId, { cursor: encodeIdCursor('nope'), limit: 24 }, TODAY),
    ).rejects.toThrow(InvalidCursorError);
  });
});

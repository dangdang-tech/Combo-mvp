// 个人主页测试夹具（仅测试用）——构造契约形态的六分区数据，便于各分区/页面测试复用。
import type {
  CreatorProfile,
  ProfileHero,
  ProfileMetricsBand,
  ProfileDensitySlice,
  DensityRankRow,
  ProfileHeatmap,
  ProfileNetwork,
  ProfileWorksSlice,
  WorkCard,
  Meta,
} from '@cb/shared';

export function makeHero(over: Partial<ProfileHero> = {}): ProfileHero {
  return {
    avatarUrl: null,
    displayName: 'Wayne',
    identityTags: ['增长黑客', '保险经纪'],
    bio: '把会话沉淀成能力。',
    social: { following: 12, followers: 3400, likes: 128, viewerIsFollowing: null },
    ...over,
  };
}

export function makeMetrics(over: Partial<ProfileMetricsBand> = {}): ProfileMetricsBand {
  return {
    capabilityCount: 8,
    domainCount: 3,
    totalInvocations: null,
    hottestTopic: { name: '增长策略', heatValue: null },
    readonly: true,
    ...over,
  };
}

export function makeDensityRow(over: Partial<DensityRankRow> = {}): DensityRankRow {
  const rank = over.rank ?? 1;
  return {
    rank,
    capabilityId: over.capabilityId ?? `cap-${rank}`,
    slug: `s-${rank}`,
    name: `能力${rank}`,
    densityScore: 100 - rank * 10,
    supportingSegments: 30 - rank,
    trend: 'up',
    readonly: true,
    ...over,
  };
}

export function makeDensity(over: Partial<ProfileDensitySlice> = {}): ProfileDensitySlice {
  return {
    rows: [makeDensityRow({ rank: 1 }), makeDensityRow({ rank: 2 }), makeDensityRow({ rank: 3 })],
    hasMore: true,
    ...over,
  };
}

export function makeHeatmap(over: Partial<ProfileHeatmap> = {}): ProfileHeatmap {
  return {
    range: 'half_year',
    start: '2026-01-01',
    end: '2026-06-15',
    cells: [
      { date: '2026-06-10', count: 3, level: 2 },
      { date: '2026-06-11', count: 7, level: 4 },
    ],
    maxCount: 7,
    enabled: true,
    ...over,
  };
}

export function makeNetwork(over: Partial<ProfileNetwork> = {}): ProfileNetwork {
  return {
    nodes: [
      { capabilityId: 'cap-1', slug: 's-1', name: '能力1', size: 6, isCenter: true },
      { capabilityId: 'cap-2', slug: 's-2', name: '能力2', size: 3, isCenter: false },
      { capabilityId: 'cap-3', slug: 's-3', name: '能力3', size: 2, isCenter: false },
    ],
    edges: [
      { source: 'cap-1', target: 'cap-2', weight: 2, basis: 'session_cooccur' },
      { source: 'cap-1', target: 'cap-3', weight: 1, basis: 'tag_overlap' },
    ],
    thumbnailOnly: true,
    ...over,
  };
}

export function makeWorkCard(over: Partial<WorkCard> = {}): WorkCard {
  const n = over.capabilityId ?? 'cap-1';
  return {
    capabilityId: n,
    versionId: `ver-${n}`,
    slug: `s-${n}`,
    coverUrl: null,
    name: `作品 ${n}`,
    invocations: null,
    ...over,
  };
}

export function makeWorks(over: Partial<ProfileWorksSlice> = {}): ProfileWorksSlice {
  return {
    cards: [makeWorkCard({ capabilityId: 'cap-1' }), makeWorkCard({ capabilityId: 'cap-2' })],
    hasMore: true,
    // 首屏切片续翻游标由后端铸造（§2.6）：hasMore=true 默认带 cursor，前端「加载更多」据此真追加。
    nextCursor: 'cursor-works-page1',
    ...over,
  };
}

/**
 * usage 占位 meta（总调用量 / 热度 / 调用次数）。
 * 键对齐后端/契约真键（§2.2）：totalInvocations / hottestTopic.heatValue / works.invocations，
 *   不自造 hottestTopicHeat / 裸 invocations（Codex r1#3：前后端占位键统一）。
 */
export const PLACEHOLDER_META: Meta = {
  placeholders: {
    totalInvocations: '暂无数据 / 上线后填充',
    'hottestTopic.heatValue': '暂无数据 / 上线后填充',
    'works.invocations': '暂无数据 / 上线后填充',
  },
};

export function makeProfile(over: Partial<CreatorProfile> = {}): CreatorProfile {
  return {
    creatorId: 'creator-1',
    slug: 'wayne',
    sectionsOrder: ['hero', 'metrics', 'density', 'heatmap', 'network', 'works'],
    hero: makeHero(),
    metrics: makeMetrics(),
    density: makeDensity(),
    heatmap: makeHeatmap(),
    network: makeNetwork(),
    works: makeWorks(),
    heatmapEnabled: true,
    sectionErrors: [],
    ...over,
  };
}

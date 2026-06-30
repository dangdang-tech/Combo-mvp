// 60 · 个人主页聚合只读仓储（B-33，60-dashboard-profile §2）。全部注入 Queryable（pg 子集），便于 mock 单测、无真 PG。
//   对外信任口径：公开只读、访客同视图、钱/经营动作绝不外泄（主页-04/13/25/26）。
//   usage 类（总调用量/最热主题热度/作品墙调用次数）本期统一 null + meta.placeholders（决策②，脊柱 §2.2）。
//   非 usage（社交计数/能力点数/知识领域数/支撑段数/热力图格子/共现边/作品墙 name·cover）正常返回真实值。
//   读端点鉴权由路由 optionalAuth 守；creatorId 不存在/已注销 → repo 返 null → handler 404（不下钻、不暴露存在性）。
import type {
  CreatorProfile,
  ProfileHero,
  ProfileMetricsBand,
  ProfileDensitySlice,
  ProfileHeatmap,
  ProfileNetwork,
  ProfileWorksSlice,
  DensityRankRow,
  WorkCard,
  ProfileSectionKey,
  ProfileSectionError,
} from '@cb/shared';
import { decodeIdCursor, encodeIdCursor, InvalidCursorError } from '@cb/shared';
import type { Queryable } from '../../platform/jobs/types.js';
import { aggregateHeatmap } from './heatmap.js';
import { buildNetwork, type CooccurCapability, type SnapshotHit } from './cooccur.js';
import { rankDensity, type DensityInputRow } from './density.js';
import { filterWorkCards, isOnWall, type WorkRow } from './works.js';

/** usage 占位文案（响应 meta.placeholders，脊柱 §2.2；值恒 null，上线后由真实计量填充）。 */
export const PROFILE_USAGE_PLACEHOLDER = '暂无数据 / 上线后填充';

/** 主页六分区顺序固定（主页-01，§2.0）。 */
export const PROFILE_SECTIONS_ORDER: ProfileSectionKey[] = [
  'hero',
  'metrics',
  'density',
  'heatmap',
  'network',
  'works',
];

/** 主聚合内嵌密度榜首屏切片条数（前 3，主页-05）。 */
export const DENSITY_SLICE_LIMIT = 3;
/** 主聚合内嵌作品墙首屏切片条数（首页，§2.6 默认 24）。 */
export const WORKS_SLICE_LIMIT = 24;

/** creator_profiles 行（公开名片 + 社交冗余计数）。 */
interface ProfileRow {
  user_id: string;
  slug: string;
  display_name: string;
  avatar_url: string | null;
  identity_tags: string[];
  bio: string;
  heatmap_enabled: boolean;
  followers_count: number;
  following_count: number;
  likes_count: number;
}

/**
 * 读 creator_profiles（公开名片基行）。不存在 → null（handler 404，不下钻不暴露存在性，§2.7）。
 *   social 计数直读冗余列（非 usage，是真实计数，§2.1 / §3 写路径事务内维护）。
 */
export async function readProfileBase(
  db: Queryable,
  creatorId: string,
): Promise<ProfileRow | null> {
  const res = await db.query<ProfileRow>(
    `SELECT user_id, slug, display_name, avatar_url, identity_tags, bio,
            heatmap_enabled, followers_count, following_count, likes_count
       FROM creator_profiles
      WHERE user_id = $1`,
    [creatorId],
  );
  return res.rows[0] ?? null;
}

/**
 * 当前查看者是否已关注该创作者（§2.1 viewerIsFollowing）。
 *   viewerId 为空（匿名）→ null（不影响只读展示，§2.1）；登录态查 follows 去重键存在性。
 */
export async function readViewerIsFollowing(
  db: Queryable,
  creatorId: string,
  viewerId: string | null,
): Promise<boolean | null> {
  if (!viewerId) return null;
  if (viewerId === creatorId) return null; // 自己看自己无「关注」语义。
  const res = await db.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM follows WHERE follower_id = $1 AND followee_id = $2
     ) AS exists`,
    [viewerId, creatorId],
  );
  return res.rows[0]?.exists ?? false;
}

/** 组装 Hero 身份区（§2.1）。社交计数真实（冗余列）；viewerIsFollowing 登录态才有值。 */
export function buildHero(row: ProfileRow, viewerIsFollowing: boolean | null): ProfileHero {
  return {
    avatarUrl: row.avatar_url,
    displayName: row.display_name,
    identityTags: row.identity_tags,
    bio: row.bio,
    social: {
      following: row.following_count,
      followers: row.followers_count,
      likes: row.likes_count,
      viewerIsFollowing,
    },
  };
}

/** 上墙能力（review_status ∈ {alpha_pending,published}）的展示行 + tags + 支撑段数（密度/网络/指标带/作品墙共用）。 */
interface PublishedCapRow {
  capability_id: string;
  current_version_id: string;
  slug: string;
  name: string;
  review_status: string;
  cover_url: string | null;
  tags: string[];
  /** 真实支撑会话段数（段级血缘 distinct segment 计数，§2.3）。 */
  supporting_segments: number;
  /** 近半窗支撑段数（趋势用，§2.3）。 */
  recent_segments: number;
  /** 前半窗支撑段数（趋势用）。 */
  prior_segments: number;
  /** 创建时刻（作品墙倒序 / 稳定排序兜底）。 */
  created_at: string;
}

/**
 * 读本创作者名下【上墙】能力（公开口径，主页-11/19/23）。一次取齐密度榜/网络/指标带/作品墙所需的
 *   name/cover/tags/支撑段数/趋势分窗 —— 减少多次往返；被拒下架（review_rejected）不在结果内（主页-23）。
 *   回退版已在评审域落库（current_version_id 指回退版、review_status='published'），故读 current_version_id
 *   即天然展示回退版（主页-24，复用 3E 单源、本域不重做回退）。
 *   段级血缘对账（§4.4）：supporting_segments 经 candidate_evidence × session_segments 同 snapshot 血缘，
 *   只读已 fence 落库的证据（脊柱 §6.2），不读半成品。
 *   owner 隔离（Codex r1#1，P0）：LATERAL 必须把候选 cc 限定在
 *     ① 本能力体来源候选（cc.slug = c.slug，外层正确绑定，不再用全局 slug IN 子查询）；
 *     ② 本创作者自有快照（JOIN raw_snapshots rs ON rs.id = cc.snapshot_id AND rs.owner_user_id = $1）。
 *   否则同 slug 跨创作者会把别人的段数计入本公开主页（数据越权泄露）。
 */
export async function readPublishedCaps(
  db: Queryable,
  creatorId: string,
  halfWindowStart: string,
): Promise<PublishedCapRow[]> {
  const res = await db.query<PublishedCapRow>(
    `SELECT c.id AS capability_id,
            p.current_version_id,
            c.slug,
            (cv.manifest->>'name')        AS name,
            p.review_status,
            (cv.manifest->>'cover_url')   AS cover_url,
            c.tags                        AS tags,
            COALESCE(seg.supporting_segments, 0) AS supporting_segments,
            COALESCE(seg.recent_segments, 0)     AS recent_segments,
            COALESCE(seg.prior_segments, 0)      AS prior_segments,
            c.created_at
       FROM capabilities c
       JOIN publications p ON p.capability_id = c.id
       JOIN capability_versions cv
         ON cv.capability_id = c.id AND cv.id = p.current_version_id
       LEFT JOIN LATERAL (
         SELECT COUNT(DISTINCT ce.segment_id)                                   AS supporting_segments,
                COUNT(DISTINCT ce.segment_id) FILTER (WHERE ss.happened_at >= $2) AS recent_segments,
                COUNT(DISTINCT ce.segment_id) FILTER (WHERE ss.happened_at <  $2 OR ss.happened_at IS NULL) AS prior_segments
           FROM capability_candidates cc
           -- owner 隔离：候选所属快照必须是本创作者自有（rs.owner_user_id = $1），不串他人同 slug 段。
           JOIN raw_snapshots     rs ON rs.id = cc.snapshot_id AND rs.owner_user_id = $1
           JOIN candidate_evidence ce ON ce.candidate_id = cc.id
           JOIN session_segments  ss ON ss.id = ce.segment_id
          -- 本能力体来源候选（外层正确绑定 cc.slug = c.slug，不再用全局 slug IN 子查询归集）。
          WHERE cc.slug = c.slug
       ) seg ON true
      WHERE c.creator_user_id = $1
        AND p.review_status IN ('alpha_pending', 'published')
      ORDER BY c.created_at DESC, c.id DESC`,
    [creatorId, halfWindowStart],
  );
  // 防御：即便 SQL 漏过，应用层再过一道上墙过滤（被拒下架不上墙，主页-23）。
  return res.rows.filter((r) => isOnWall(r.review_status));
}

/** PublishedCapRow → 密度榜输入（真实段数 + 趋势分窗）。 */
function toDensityInput(rows: PublishedCapRow[]): DensityInputRow[] {
  return rows.map((r) => ({
    capabilityId: r.capability_id,
    slug: r.slug,
    name: r.name ?? '',
    supportingSegments: Number(r.supporting_segments) || 0,
    recentSegments: Number(r.recent_segments) || 0,
    priorSegments: Number(r.prior_segments) || 0,
  }));
}

/** PublishedCapRow → 共现能力（节点大小 = 支撑段数，真实）。 */
function toCooccurCaps(rows: PublishedCapRow[]): CooccurCapability[] {
  return rows.map((r) => ({
    capabilityId: r.capability_id,
    slug: r.slug,
    name: r.name ?? '',
    size: Number(r.supporting_segments) || 0,
    tags: r.tags ?? [],
  }));
}

/** PublishedCapRow → 作品墙行（current_version_id 即展示版，已含回退版口径，主页-24）。 */
function toWorkRows(rows: PublishedCapRow[]): WorkRow[] {
  return rows.map((r) => ({
    capabilityId: r.capability_id,
    versionId: r.current_version_id,
    slug: r.slug,
    reviewStatus: r.review_status,
    name: r.name ?? '',
    coverUrl: r.cover_url,
  }));
}

/** 排好的全量密度榜行（供主聚合切前 3 / 子端点翻页）。 */
export function buildDensityRows(caps: PublishedCapRow[]): DensityRankRow[] {
  return rankDensity(toDensityInput(caps));
}

/** 主聚合内嵌密度榜首屏切片（前 3 + hasMore，主页-05/06）。 */
export function densitySlice(
  rows: DensityRankRow[],
  limit = DENSITY_SLICE_LIMIT,
): ProfileDensitySlice {
  return { rows: rows.slice(0, limit), hasMore: rows.length > limit };
}

/** 全量作品墙卡（过滤被拒下架后的公开卡，主页-23/24）。 */
export function buildWorkCards(caps: PublishedCapRow[]): WorkCard[] {
  return filterWorkCards(toWorkRows(caps));
}

/**
 * 主聚合内嵌作品墙首屏切片（首页 + hasMore + nextCursor，§2.6，Codex r1#5）。
 *   nextCursor 由后端用末位卡 capabilityId 铸造（与 readWorksPage 同一不透明编码），
 *   前端「加载更多」据此真追加下一页（不重拉首页替换、不前端构造 cursor）。无更多 → null。
 */
export function worksSlice(cards: WorkCard[], limit = WORKS_SLICE_LIMIT): ProfileWorksSlice {
  const page = cards.slice(0, limit);
  const hasMore = cards.length > limit;
  const nextCursor =
    hasMore && page.length > 0 ? encodeIdCursor(page[page.length - 1]!.capabilityId) : null;
  return { cards: page, hasMore, nextCursor };
}

/**
 * 指标带（§2.2）。真实：能力点数（上墙能力数）、知识领域数（distinct domain tag）、最热主题名（密度榜首主题）。
 *   usage 占位：totalInvocations、hottestTopic.heatValue（恒 null + placeholders，决策②）。
 *   readonly:true 硬约束（主页-04，前端据此禁用任何下钻；本响应不含任何下钻 URL/明细引用、无收益/金额）。
 */
export function buildMetricsBand(input: {
  caps: PublishedCapRow[];
  densityRows: DensityRankRow[];
}): ProfileMetricsBand {
  const capabilityCount = input.caps.length;
  // 知识领域数 = distinct tags（公开口径按能力 tags 去重计数；技术方案以 tag 近似 domain，§2.2）。
  const domains = new Set<string>();
  for (const c of input.caps) {
    for (const t of c.tags ?? []) {
      const norm = t.trim().toLowerCase();
      if (norm.length > 0) domains.add(norm);
    }
  }
  // 最热主题名（真实）：密度榜首能力的名称作主题代表（不依赖 usage，§2.2）；无能力 → null（前端「暂无主题」）。
  const hottestName = input.densityRows[0]?.name ?? null;
  return {
    capabilityCount,
    domainCount: domains.size,
    totalInvocations: null, // usage 占位（placeholders["totalInvocations"]）。
    hottestTopic: {
      name: hottestName,
      heatValue: null, // usage 占位（placeholders["hottestTopic.heatValue"]）。
    },
    readonly: true,
  };
}

/**
 * 读会话足迹时刻（§2.4 热力图）。仅取 happened_at（绝不取正文/标题/片段，隐私硬约束主页-09）。
 *   按本创作者名下能力来源 snapshot 的段聚合时刻；窗口外过滤在 aggregateHeatmap 内做。
 */
export async function readHeatmapTimestamps(
  db: Queryable,
  creatorId: string,
  windowStart: string,
): Promise<(string | null)[]> {
  const res = await db.query<{ happened_at: string | null }>(
    `SELECT ss.happened_at
       FROM session_segments ss
       JOIN raw_snapshots rs ON rs.id = ss.snapshot_id
      WHERE rs.owner_user_id = $1
        AND (ss.happened_at IS NULL OR ss.happened_at >= $2)`,
    [creatorId, windowStart],
  );
  return res.rows.map((r) => r.happened_at);
}

/**
 * 读 session 共现命中（§2.5 网络）：同 snapshot 命中的能力集合（按 slug 归集到能力体）。
 *   owner 隔离（Codex r1#1，P0）：候选 cc 必须挂在本创作者自有快照
 *     （JOIN raw_snapshots rs ON rs.id = cc.snapshot_id AND rs.owner_user_id = $1），
 *   否则同 slug 跨创作者会把别人 snapshot 的共现命中计入本公开主页网络（数据越权泄露）。
 */
export async function readSnapshotHits(db: Queryable, creatorId: string): Promise<SnapshotHit[]> {
  const res = await db.query<{ snapshot_id: string; capability_id: string }>(
    `SELECT DISTINCT cc.snapshot_id AS snapshot_id, c.id AS capability_id
       FROM capabilities c
       JOIN publications p ON p.capability_id = c.id AND p.review_status IN ('alpha_pending','published')
       JOIN capability_candidates cc ON cc.slug = c.slug
       JOIN raw_snapshots rs ON rs.id = cc.snapshot_id AND rs.owner_user_id = $1
      WHERE c.creator_user_id = $1`,
    [creatorId],
  );
  const bySnapshot = new Map<string, Set<string>>();
  for (const r of res.rows) {
    let set = bySnapshot.get(r.snapshot_id);
    if (!set) {
      set = new Set();
      bySnapshot.set(r.snapshot_id, set);
    }
    set.add(r.capability_id);
  }
  return [...bySnapshot.entries()].map(([snapshotId, ids]) => ({
    snapshotId,
    capabilityIds: [...ids],
  }));
}

/** 组装能力网络缩略（§2.5，主页-10）。中心锚点 = 密度榜首能力。 */
export function buildProfileNetwork(input: {
  caps: PublishedCapRow[];
  hits: SnapshotHit[];
  densityRows: DensityRankRow[];
}): ProfileNetwork {
  const centerId = input.densityRows[0]?.capabilityId ?? null;
  return buildNetwork({ caps: toCooccurCaps(input.caps), hits: input.hits, centerId });
}

/** 主聚合返回（六分区首屏全量 + heatmapEnabled）+ usage 占位键集合（handler 放 meta.placeholders）。 */
export interface CreatorProfileResult {
  profile: CreatorProfile;
  /** usage 占位字段键（值恒 null，handler 据此填 meta.placeholders，脊柱 §2.2）。 */
  usagePlaceholderKeys: string[];
}

/** Promise.allSettled 结果取值（fulfilled 取 value，rejected 取 null）。 */
function settledValue<T>(r: PromiseSettledResult<T>): T | null {
  return r.status === 'fulfilled' ? r.value : null;
}

/**
 * 主聚合（§2.0，主页-01）。单次返回六分区全量首屏切片：hero/metrics/density(前3)/heatmap(半年)/network(全缩略)/works(首页)。
 *   - 公开只读、访客同视图、钱/经营动作绝不外泄（主页-04/13/25/26）。
 *   - heatmapEnabled=false（创作者关闭，主页-20）→ heatmap.enabled=false + 空 cells（前端不渲染分区，sectionsOrder 仍含 heatmap 占位键）。
 *   - 重导不丢（主页-18）：读当前生效能力/段（current_version_id、当前 snapshot 段），新快照聚合中不阻塞、不清空。
 *   creatorId 不存在 → null（handler 404）。
 *
 *   【分区局部失败不连坐】（60 §2.7，主页-17，Codex#r3 P1）：基行 readProfileBase 是 404/身份门，先单独读
 *     （失败由 handler 兜整页 500，不在此吞）。其余分区数据源用 Promise.allSettled 隔离——任一分区查询失败：
 *       · viewerFollowing 失败 → hero.viewerIsFollowing 退化为 null（hero 基行仍在，不连坐）。
 *       · caps 失败 → metrics/density/works/network 四个【依赖 caps 的分区】置 null + sectionErrors 标记。
 *       · heatmapTs 失败 → heatmap 置 null + sectionErrors（heatmap）。
 *       · hits 失败 → network 置 null + sectionErrors（network）（network 还需 caps，caps 失败优先）。
 *     已成功分区照常返回；失败分区走 sectionErrors（前端走对应子端点重试）。整页不崩成 500。
 */
export async function readCreatorProfile(
  db: Queryable,
  creatorId: string,
  viewerId: string | null,
  today = new Date(),
): Promise<CreatorProfileResult | null> {
  const base = await readProfileBase(db, creatorId);
  if (!base) return null;

  // 趋势分窗界（近半窗起点 = 半年窗口中点；用于密度趋势近/前半比较，§2.3）。
  const halfYearStart = new Date(today.getTime());
  halfYearStart.setUTCDate(halfYearStart.getUTCDate() - 182);
  const windowStart = halfYearStart.toISOString();
  const midpoint = new Date(today.getTime());
  midpoint.setUTCDate(midpoint.getUTCDate() - 91);
  const trendMid = midpoint.toISOString();

  // 分区隔离聚合（allSettled，§2.7）：任一分区源失败不拖垮其他分区。
  const [viewerFollowingR, capsR, heatmapTsR, hitsR] = await Promise.allSettled([
    readViewerIsFollowing(db, creatorId, viewerId),
    readPublishedCaps(db, creatorId, trendMid),
    base.heatmap_enabled
      ? readHeatmapTimestamps(db, creatorId, windowStart)
      : Promise.resolve<(string | null)[]>([]),
    readSnapshotHits(db, creatorId),
  ]);

  const sectionErrors: ProfileSectionError[] = [];

  // —— hero（恒在）：viewerFollowing 失败仅退化 viewerIsFollowing=null，不连坐 hero 本体（§2.1）。——
  const viewerFollowing = settledValue(viewerFollowingR); // 失败/匿名 → null（与匿名同语义，hero 仍渲染）
  const hero = buildHero(base, viewerFollowing);

  // —— caps 是 metrics/density/works/network 的脊柱数据源；失败 → 这四个分区 null + 标记。——
  const caps = settledValue(capsR);
  let metrics: ProfileMetricsBand | null = null;
  let density: ProfileDensitySlice | null = null;
  let works: ProfileWorksSlice | null = null;
  let densityRows: DensityRankRow[] = [];
  if (caps !== null) {
    densityRows = buildDensityRows(caps);
    metrics = buildMetricsBand({ caps, densityRows });
    density = densitySlice(densityRows);
    works = worksSlice(buildWorkCards(caps));
  } else {
    sectionErrors.push(
      { section: 'metrics', retriable: true },
      { section: 'density', retriable: true },
      { section: 'works', retriable: true },
    );
  }

  // —— heatmap（仅依赖 heatmapTs + 开关）：失败 → null + 标记（network/works 不受影响）。——
  let heatmap: ProfileHeatmap | null = null;
  const heatmapTs = settledValue(heatmapTsR);
  if (heatmapTs !== null) {
    heatmap = aggregateHeatmap({
      happenedAt: heatmapTs,
      today,
      range: 'half_year',
      enabled: base.heatmap_enabled,
    });
  } else {
    sectionErrors.push({ section: 'heatmap', retriable: true });
  }

  // —— network（依赖 caps + hits）：caps 失败已标记并使其 null；否则 hits 失败 → network null + 标记。——
  let network: ProfileNetwork | null = null;
  const hits = settledValue(hitsR);
  if (caps !== null && hits !== null) {
    network = buildProfileNetwork({ caps, hits, densityRows });
  } else if (caps !== null) {
    // caps 在但 hits 失败 → 仅 network 这一分区失败（不连坐 metrics/density/works）。
    sectionErrors.push({ section: 'network', retriable: true });
  }
  // caps 失败时 network 也无法构建：caps 分支已不含 network 标记，这里补一条（network 同样失败）。
  if (caps === null) sectionErrors.push({ section: 'network', retriable: true });

  const profile: CreatorProfile = {
    creatorId: base.user_id,
    slug: base.slug,
    sectionsOrder: PROFILE_SECTIONS_ORDER,
    hero,
    metrics,
    density,
    heatmap,
    network,
    works,
    heatmapEnabled: base.heatmap_enabled,
    sectionErrors,
  };

  return {
    profile,
    usagePlaceholderKeys: ['totalInvocations', 'hottestTopic.heatValue', 'works.invocations'],
  };
}

// ===========================================================================
// 分区子端点读（翻页/展开/重试，§2.3/§2.4/§2.5/§2.6）
// ===========================================================================

/**
 * 子端点：能力密度榜（cursor 分页，展开更多，§2.3）。creatorId 不存在 → null（handler 404）。
 *   cursor 失效/畸形（格式非法 / id 不在当前榜单）→ 抛 InvalidCursorError（handler 回 400，
 *   非静默回首页、非 500，契约 60 §2.7 / Codex r1#2）。
 */
export async function readDensityPage(
  db: Queryable,
  creatorId: string,
  opts: { cursor?: string; limit: number },
  today = new Date(),
): Promise<{ rows: DensityRankRow[]; nextCursor: string | null; hasMore: boolean } | null> {
  const base = await readProfileBase(db, creatorId);
  if (!base) return null;
  const midpoint = new Date(today.getTime());
  midpoint.setUTCDate(midpoint.getUTCDate() - 91);
  const caps = await readPublishedCaps(db, creatorId, midpoint.toISOString());
  const all = buildDensityRows(caps); // 已按密度降序、赋好 rank。
  // cursor = 上一页末位 capabilityId（不透明编码；密度榜整序已定，按位置切，脊柱 §2.3 cursor 唯一不返 total）。
  let startIdx = 0;
  if (opts.cursor !== undefined) {
    const anchor = decodeIdCursor(opts.cursor); // 格式非法 → InvalidCursorError
    const idx = all.findIndex((r) => r.capabilityId === anchor);
    if (idx < 0) throw new InvalidCursorError(); // 锚不在当前榜单 → 失效（不静默回首页）
    startIdx = idx + 1;
  }
  const page = all.slice(startIdx, startIdx + opts.limit);
  const hasMore = startIdx + opts.limit < all.length;
  const nextCursor = hasMore ? encodeIdCursor(page[page.length - 1]!.capabilityId) : null;
  return { rows: page, nextCursor, hasMore };
}

/** 子端点：热力图（半年/整年，§2.4）。creatorId 不存在 → null（handler 404）。 */
export async function readHeatmap(
  db: Queryable,
  creatorId: string,
  range: 'half_year' | 'year',
  today = new Date(),
): Promise<ProfileHeatmap | null> {
  const base = await readProfileBase(db, creatorId);
  if (!base) return null;
  const windowDays = range === 'year' ? 365 : 183;
  const start = new Date(today.getTime());
  start.setUTCDate(start.getUTCDate() - (windowDays - 1));
  const ts = base.heatmap_enabled
    ? await readHeatmapTimestamps(db, creatorId, start.toISOString())
    : [];
  return aggregateHeatmap({ happenedAt: ts, today, range, enabled: base.heatmap_enabled });
}

/** 子端点：能力网络缩略（一次全量缩略边，§2.5）。creatorId 不存在 → null（handler 404）。 */
export async function readNetwork(
  db: Queryable,
  creatorId: string,
  today = new Date(),
): Promise<ProfileNetwork | null> {
  const base = await readProfileBase(db, creatorId);
  if (!base) return null;
  const midpoint = new Date(today.getTime());
  midpoint.setUTCDate(midpoint.getUTCDate() - 91);
  const [caps, hits] = await Promise.all([
    readPublishedCaps(db, creatorId, midpoint.toISOString()),
    readSnapshotHits(db, creatorId),
  ]);
  const densityRows = buildDensityRows(caps);
  return buildProfileNetwork({ caps, hits, densityRows });
}

/**
 * 子端点：作品墙（cursor 分页，§2.6）。creatorId 不存在 → null（handler 404）。
 *   cursor 失效/畸形（格式非法 / id 不在当前墙）→ 抛 InvalidCursorError（handler 回 400，
 *   非静默回首页、非 500，契约 60 §2.7 / Codex r1#2）。
 */
export async function readWorksPage(
  db: Queryable,
  creatorId: string,
  opts: { cursor?: string; limit: number },
  today = new Date(),
): Promise<{ cards: WorkCard[]; nextCursor: string | null; hasMore: boolean } | null> {
  const base = await readProfileBase(db, creatorId);
  if (!base) return null;
  const midpoint = new Date(today.getTime());
  midpoint.setUTCDate(midpoint.getUTCDate() - 91);
  const caps = await readPublishedCaps(db, creatorId, midpoint.toISOString());
  const all = buildWorkCards(caps); // 已按 created_at 倒序（readPublishedCaps ORDER BY）+ 过滤被拒。
  let startIdx = 0;
  if (opts.cursor !== undefined) {
    const anchor = decodeIdCursor(opts.cursor); // 格式非法 → InvalidCursorError
    const idx = all.findIndex((c) => c.capabilityId === anchor);
    if (idx < 0) throw new InvalidCursorError(); // 锚不在当前墙 → 失效（不静默回首页）
    startIdx = idx + 1;
  }
  const page = all.slice(startIdx, startIdx + opts.limit);
  const hasMore = startIdx + opts.limit < all.length;
  const nextCursor = hasMore ? encodeIdCursor(page[page.length - 1]!.capabilityId) : null;
  return { cards: page, nextCursor, hasMore };
}

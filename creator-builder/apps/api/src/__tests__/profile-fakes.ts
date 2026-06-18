// 60 个人主页域单测夹具：内存假 PG，忠实模拟 profile-repo 的只读 SQL 形态（无真 PG / 无 Docker）。
//   忠实点（合规清单）：
//     - creator_profiles 读冗余社交计数（真实，非 usage）；不存在 → 0 行（handler 404）。
//     - readPublishedCaps：仅 review_status ∈ {alpha_pending,published} 上墙（被拒下架剔除），current_version_id
//       即展示版（回退版已落库），段级支撑数经 candidate_evidence × session_segments 同 snapshot 血缘聚合。
//     - readHeatmapTimestamps：仅取 happened_at（绝不取正文），按 owner snapshot 段过滤窗口。
//     - readSnapshotHits：同 snapshot 命中能力集合（按 slug 归集），供 session 共现。
//     - readViewerIsFollowing：follows 去重键存在性。
//   段级血缘按 slug 把候选↔能力体归集（与 readPublishedCaps / readSnapshotHits 一致）。
import type { Queryable, QueryResultLike } from '../jobs/types.js';

function ok<R>(rows: R[], rowCount = rows.length): QueryResultLike<R> {
  return { rows, rowCount };
}

let idSeq = 0;
export function genId(prefix: string): string {
  idSeq += 1;
  return `${prefix}-${String(idSeq).padStart(6, '0')}`;
}

export interface FakeProfile {
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
export interface FakeCapability {
  id: string;
  creator_user_id: string;
  slug: string;
  current_version_id: string | null;
  tags: string[];
  created_at: string;
}
export interface FakeVersion {
  id: string;
  capability_id: string;
  manifest: Record<string, unknown>;
}
export interface FakePublication {
  capability_id: string;
  current_version_id: string;
  review_status: string;
}
/** 候选（按 slug 归集到能力体的段级血缘载体）。 */
export interface FakeCandidate {
  id: string;
  slug: string;
  snapshot_id: string;
}
/** 证据：候选 ↔ 段。 */
export interface FakeEvidence {
  candidate_id: string;
  segment_id: string;
}
/** 段：归属某 snapshot（owner 经 snapshot 解析），含活跃时刻 happened_at。 */
export interface FakeSegment {
  id: string;
  snapshot_id: string;
  happened_at: string | null;
}
export interface FakeSnapshot {
  id: string;
  owner_user_id: string;
}
export interface FakeFollow {
  follower_id: string;
  followee_id: string;
}

export class ProfileFakeDb implements Queryable {
  readonly queries: Array<{ sql: string; params: unknown[] }> = [];
  profiles = new Map<string, FakeProfile>();
  capabilities = new Map<string, FakeCapability>();
  versions = new Map<string, FakeVersion>();
  publications = new Map<string, FakePublication>(); // key = capability_id
  candidates = new Map<string, FakeCandidate>();
  evidence: FakeEvidence[] = [];
  segments = new Map<string, FakeSegment>();
  snapshots = new Map<string, FakeSnapshot>();
  follows: FakeFollow[] = [];
  /** 注入：下一条 query 抛错（验聚合/分区失败 500）。 */
  throwNext = false;
  /** 注入：下一条 query 抛带 PG SQLSTATE 的错误（验 22P02 非法 UUID 文本 → 404 链接失效，BUG-011）。 */
  throwCodeNext: string | null = null;
  /**
   * 注入：按分区数据源【定向】抛错（验主聚合分区局部失败不连坐，Codex#r3 P1）。
   *   key 取分区源标识：'base' | 'viewerFollowing' | 'caps' | 'heatmap' | 'hits'。
   *   命中的源查询抛错 → repo 经 allSettled 捕成该分区 null + sectionErrors，其它分区照常 200。
   */
  throwOnSources = new Set<'base' | 'viewerFollowing' | 'caps' | 'heatmap' | 'hits'>();
  /**
   * 反向破坏开关（Codex r1#1 P0 owner 隔离）：true → 段级血缘/共现命中【不限定 owner】（退回按 slug 全局归集），
   *   用于证明 owner 隔离断言非空跑（跨创作者同 slug 会串入别人段数/共现边时断言能抓到回归）。
   */
  breakOwnerScope = false;

  async query<R = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<QueryResultLike<R>> {
    this.queries.push({ sql, params });
    if (this.throwNext) {
      this.throwNext = false;
      throw new Error('injected db failure');
    }
    if (this.throwCodeNext !== null) {
      const code = this.throwCodeNext;
      this.throwCodeNext = null;
      const e = new Error(`injected pg error ${code}`) as Error & { code: string };
      e.code = code;
      throw e;
    }
    // 定向分区失败注入（§2.7 分区不连坐）：命中的源查询抛错，由 repo 的 allSettled 隔离成该分区 null。
    const failIf = (src: 'base' | 'viewerFollowing' | 'caps' | 'heatmap' | 'hits'): void => {
      if (this.throwOnSources.has(src)) throw new Error(`injected ${src} failure`);
    };

    // —— readProfileBase ——
    if (sql.includes('FROM creator_profiles') && sql.includes('WHERE user_id = $1')) {
      failIf('base');
      const p = this.profiles.get(params[0] as string);
      return ok<R>(p ? ([p] as R[]) : []);
    }

    // —— readViewerIsFollowing（EXISTS follows）——
    if (sql.includes('FROM follows') && sql.includes('AS exists')) {
      failIf('viewerFollowing');
      const follower = params[0] as string;
      const followee = params[1] as string;
      const exists = this.follows.some(
        (f) => f.follower_id === follower && f.followee_id === followee,
      );
      return ok<R>([{ exists }] as R[]);
    }

    // —— readPublishedCaps（capabilities JOIN publications JOIN versions + LATERAL 段级支撑）——
    if (
      sql.includes('FROM capabilities c') &&
      sql.includes('JOIN publications p') &&
      sql.includes('supporting_segments')
    ) {
      failIf('caps');
      const creatorId = params[0] as string;
      const midpoint = params[1] as string; // 近/前半窗界
      const rows = [...this.capabilities.values()]
        .filter((c) => c.creator_user_id === creatorId)
        .map((c) => {
          const pub = this.publications.get(c.id);
          return { c, pub };
        })
        .filter(
          (x): x is { c: FakeCapability; pub: FakePublication } =>
            !!x.pub &&
            (x.pub.review_status === 'alpha_pending' || x.pub.review_status === 'published'),
        )
        .sort((a, b) => {
          if (a.c.created_at !== b.c.created_at) return a.c.created_at < b.c.created_at ? 1 : -1;
          return a.c.id < b.c.id ? 1 : -1;
        })
        .map(({ c, pub }) => {
          const cv = this.versions.get(pub.current_version_id);
          const manifest = cv?.manifest ?? {};
          // owner 隔离（与 SQL 一致）：段级血缘只算挂在本创作者自有快照上的候选段。
          const { supporting, recent, prior } = this.segLineageFor(c.slug, creatorId, midpoint);
          return {
            capability_id: c.id,
            current_version_id: pub.current_version_id,
            slug: c.slug,
            name: (manifest['name'] as string | undefined) ?? null,
            review_status: pub.review_status,
            cover_url: (manifest['cover_url'] as string | undefined) ?? null,
            tags: c.tags,
            supporting_segments: supporting,
            recent_segments: recent,
            prior_segments: prior,
            created_at: c.created_at,
          };
        });
      return ok<R>(rows as R[]);
    }

    // —— readHeatmapTimestamps（session_segments JOIN raw_snapshots，仅 happened_at）——
    if (
      sql.includes('FROM session_segments ss') &&
      sql.includes('JOIN raw_snapshots rs') &&
      sql.includes('ss.happened_at')
    ) {
      failIf('heatmap');
      const creatorId = params[0] as string;
      const windowStart = params[1] as string;
      const rows = [...this.segments.values()]
        .filter((s) => {
          const snap = this.snapshots.get(s.snapshot_id);
          if (!snap || snap.owner_user_id !== creatorId) return false;
          // SQL: happened_at IS NULL OR happened_at >= windowStart
          return s.happened_at === null || s.happened_at >= windowStart;
        })
        .map((s) => ({ happened_at: s.happened_at }));
      return ok<R>(rows as R[]);
    }

    // —— readSnapshotHits（DISTINCT snapshot × capability，按 slug 归集）——
    if (
      sql.includes('SELECT DISTINCT cc.snapshot_id') &&
      sql.includes('JOIN capability_candidates cc ON cc.slug = c.slug')
    ) {
      failIf('hits');
      const creatorId = params[0] as string;
      const out: { snapshot_id: string; capability_id: string }[] = [];
      const seen = new Set<string>();
      for (const c of this.capabilities.values()) {
        if (c.creator_user_id !== creatorId) continue;
        const pub = this.publications.get(c.id);
        if (!pub || (pub.review_status !== 'alpha_pending' && pub.review_status !== 'published')) {
          continue;
        }
        for (const cand of this.candidates.values()) {
          if (cand.slug !== c.slug) continue;
          // owner 隔离（与 SQL `JOIN raw_snapshots rs ... AND rs.owner_user_id = $1` 一致）：
          //   候选所属快照必须本创作者自有，否则同 slug 跨创作者会串入别人的共现命中（数据越权）。
          if (!this.breakOwnerScope) {
            const candSnap = this.snapshots.get(cand.snapshot_id);
            if (!candSnap || candSnap.owner_user_id !== creatorId) continue;
          }
          const key = `${cand.snapshot_id}|${c.id}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({ snapshot_id: cand.snapshot_id, capability_id: c.id });
        }
      }
      return ok<R>(out as R[]);
    }

    throw new Error(`ProfileFakeDb: unhandled SQL: ${sql.replace(/\s+/g, ' ').slice(0, 160)}`);
  }

  /**
   * 段级血缘：按 slug 取候选 → 证据 → distinct 段；近/前半窗按 happened_at vs midpoint（与 SQL FILTER 对齐）。
   *   owner 隔离（与 SQL `JOIN raw_snapshots rs ... AND rs.owner_user_id = $1` 一致）：候选所属快照必须本创作者自有，
   *   否则同 slug 跨创作者会把别人的段计入（数据越权）。
   */
  private segLineageFor(
    slug: string,
    ownerId: string,
    midpoint: string,
  ): { supporting: number; recent: number; prior: number } {
    const candIds = [...this.candidates.values()]
      .filter((c) => {
        if (c.slug !== slug) return false;
        if (this.breakOwnerScope) return true; // 反向破坏：退回全局 slug 归集（串入他人段）。
        const snap = this.snapshots.get(c.snapshot_id);
        return !!snap && snap.owner_user_id === ownerId;
      })
      .map((c) => c.id);
    const segIds = new Set<string>();
    for (const ev of this.evidence) {
      if (candIds.includes(ev.candidate_id)) segIds.add(ev.segment_id);
    }
    let recent = 0;
    let prior = 0;
    for (const sid of segIds) {
      const seg = this.segments.get(sid);
      if (!seg) continue;
      if (seg.happened_at !== null && seg.happened_at >= midpoint) recent += 1;
      else prior += 1;
    }
    return { supporting: segIds.size, recent, prior };
  }
}

// —— 播种 helpers ——

export function seedProfile(db: ProfileFakeDb, over?: Partial<FakeProfile>): string {
  const id = over?.user_id ?? genId('user');
  db.profiles.set(id, {
    user_id: id,
    slug: over?.slug ?? `c-${id}`,
    display_name: over?.display_name ?? '韦恩',
    avatar_url: over?.avatar_url ?? null,
    identity_tags: over?.identity_tags ?? ['保险经纪'],
    bio: over?.bio ?? '把对话炼成可复用的能力',
    heatmap_enabled: over?.heatmap_enabled ?? true,
    followers_count: over?.followers_count ?? 0,
    following_count: over?.following_count ?? 0,
    likes_count: over?.likes_count ?? 0,
  });
  return id;
}

/** 播种一个上墙能力（含 publication + current version manifest + tags）。返回 slug 供血缘归集。 */
export function seedPublishedCapability(
  db: ProfileFakeDb,
  creatorId: string,
  opts?: {
    reviewStatus?: string;
    name?: string;
    coverUrl?: string | null;
    tags?: string[];
    createdAt?: string;
    slug?: string;
  },
): { capabilityId: string; versionId: string; slug: string } {
  const capabilityId = genId('cap');
  const versionId = genId('ver');
  const slug = opts?.slug ?? `slug-${capabilityId}`;
  db.capabilities.set(capabilityId, {
    id: capabilityId,
    creator_user_id: creatorId,
    slug,
    current_version_id: versionId,
    tags: opts?.tags ?? [],
    created_at: opts?.createdAt ?? '2026-06-01T00:00:00.000Z',
  });
  const manifest: Record<string, unknown> = { name: opts?.name ?? '需求炼金师' };
  if (opts?.coverUrl !== undefined && opts.coverUrl !== null) manifest['cover_url'] = opts.coverUrl;
  db.versions.set(versionId, { id: versionId, capability_id: capabilityId, manifest });
  db.publications.set(capabilityId, {
    capability_id: capabilityId,
    current_version_id: versionId,
    review_status: opts?.reviewStatus ?? 'published',
  });
  return { capabilityId, versionId, slug };
}

/** 播种一个被拒下架能力（review_rejected，不上墙）。 */
export function seedRejectedCapability(
  db: ProfileFakeDb,
  creatorId: string,
  opts?: { name?: string },
): { capabilityId: string; slug: string } {
  const r = seedPublishedCapability(db, creatorId, {
    reviewStatus: 'review_rejected',
    name: opts?.name ?? '被拒能力',
  });
  return { capabilityId: r.capabilityId, slug: r.slug };
}

/** 播种段级支撑：把 N 个段（指定时刻）经候选挂到某 slug 的能力上。 */
export function seedSupport(
  db: ProfileFakeDb,
  creatorId: string,
  slug: string,
  happenedAts: (string | null)[],
): { snapshotId: string; segmentIds: string[] } {
  const snapshotId = genId('snap');
  db.snapshots.set(snapshotId, { id: snapshotId, owner_user_id: creatorId });
  const candId = genId('cand');
  db.candidates.set(candId, { id: candId, slug, snapshot_id: snapshotId });
  const segmentIds: string[] = [];
  for (const at of happenedAts) {
    const segId = genId('seg');
    db.segments.set(segId, { id: segId, snapshot_id: snapshotId, happened_at: at });
    db.evidence.push({ candidate_id: candId, segment_id: segId });
    segmentIds.push(segId);
  }
  return { snapshotId, segmentIds };
}

/**
 * 播种 session 共现：把多个能力（slug）的候选挂到【同一 snapshot】（→ session_cooccur 边）。
 *   每个 slug 在该 snapshot 下挂 1 个段（可省略时刻）。
 */
export function seedCooccurrence(db: ProfileFakeDb, creatorId: string, slugs: string[]): string {
  const snapshotId = genId('snap');
  db.snapshots.set(snapshotId, { id: snapshotId, owner_user_id: creatorId });
  for (const slug of slugs) {
    const candId = genId('cand');
    db.candidates.set(candId, { id: candId, slug, snapshot_id: snapshotId });
    const segId = genId('seg');
    db.segments.set(segId, {
      id: segId,
      snapshot_id: snapshotId,
      happened_at: '2026-06-10T00:00:00.000Z',
    });
    db.evidence.push({ candidate_id: candId, segment_id: segId });
  }
  return snapshotId;
}

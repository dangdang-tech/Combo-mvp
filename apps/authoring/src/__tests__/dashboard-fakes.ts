// 60 工作台域单测夹具（B-32）：内存假 PG，忠实模拟 dashboard-repo 的只读查询形态。无真 PG / 无 Docker。
//   忠实点（合规清单）：
//     - countPublished：本人 publications.review_status='published' 计数（owner 内联 JOIN capabilities）。
//     - countPublishedPrevWindow：上一区间 published_at 落窗的 published 计数（range 决定窗口；all → null 由 repo 短路）。
//     - listCapabilities：本人能力 LEFT JOIN publications（含未发布草稿）+ manifest 软字段 name/tagline +
//         最近 review_rejected 版定位 + has_published_version + Runtime 同口径 public_page_available；
//         cursor 用 capability id；status 过滤（draft=无 pub 行）。
//     - listDrafts：本人 status='active' 草稿，cursor 用 draft id，order desc/asc。
//   反向破坏：非本人 owner 取不到行（owner 守门）；status 过滤命中正确子集；usage 不查任何 daily_* 表（夹具无这些表）。
import type { Queryable, QueryResultLike } from '../platform/jobs/types.js';

function ok<R>(rows: R[], rowCount = rows.length): QueryResultLike<R> {
  return { rows, rowCount };
}

let seq = 0;
function nextId(prefix: string): string {
  seq += 1;
  // 后缀 6 位零填充，字典序 = 插入序（模拟 UUID v7 时间有序 cursor 比较）。
  return `${prefix}-${String(seq).padStart(6, '0')}`;
}

/** reject_reason 非空（与 SQL rejectedReasonNonEmptySql / derive 的 reason 非空判定一致）。 */
function rejectReasonNonEmpty(pub: PubRow): boolean {
  return pub.reject_reason !== null && pub.reject_reason !== '';
}

/**
 * 派生态匹配（Codex#r3 P1，忠实镜像 displayStatePredicateSql / derivePublicationDisplayState）：
 *   - alpha_pending：review_status='alpha_pending'。
 *   - review_rejected：review_status='review_rejected' OR (published AND reject_reason 非空)（回退拒绝态命中）。
 *   - published：published AND reject_reason 为空（排除回退拒绝态）。
 *   无 publication 行（pub=null）→ 任何派生态过滤都不命中（它属 draft 态）。
 */
/**
 * 从 displayStatePredicateSql 拼出的字面量 SQL 反解派生态（Codex#r3 P1，忠实模拟）。
 *   - review_rejected 谓词含 `review_status = 'review_rejected'`。
 *   - published 谓词含 `review_status = 'published' AND NOT (...)`（带 NOT，区别于 review_rejected 谓词里的 published 子句）。
 *   - alpha_pending 谓词为 `review_status = 'alpha_pending'`。
 *   filterDraftOnly（无 publication 行）由调用方单独判，这里只解非 draft 派生态。
 */
function parseDisplayStateFromSql(
  sql: string,
  filterDraftOnly: boolean,
): 'alpha_pending' | 'published' | 'review_rejected' | null {
  if (filterDraftOnly) return null;
  if (sql.includes("review_status = 'review_rejected'")) return 'review_rejected';
  if (sql.includes("review_status = 'published' AND NOT")) return 'published';
  if (sql.includes("review_status = 'alpha_pending'")) return 'alpha_pending';
  return null;
}

export function matchesDisplayState(
  pub: PubRow | undefined,
  status: 'alpha_pending' | 'published' | 'review_rejected',
): boolean {
  if (!pub) return false;
  switch (status) {
    case 'alpha_pending':
      return pub.review_status === 'alpha_pending';
    case 'review_rejected':
      return (
        pub.review_status === 'review_rejected' ||
        (pub.review_status === 'published' && rejectReasonNonEmpty(pub))
      );
    case 'published':
      return pub.review_status === 'published' && !rejectReasonNonEmpty(pub);
  }
}

export interface CapRow {
  id: string;
  creator_user_id: string;
  slug: string;
  status: string;
  current_version_id: string | null;
  updated_at: string;
  created_at: string;
}
export interface VerRow {
  id: string;
  capability_id: string;
  status: string; // draft|published|superseded|review_rejected
  visibility: string | null;
  source_candidate_id: string | null;
  manifest: { name?: string; tagline?: string };
  rejected_at: string | null;
  updated_at: string;
  created_at: string;
}
export interface CandidateRow {
  id: string;
  snapshot_id: string | null;
  slug: string | null;
}
export interface ListingRow {
  capability_id: string;
  version_id: string;
  updated_at: string;
}
export interface PubRow {
  capability_id: string;
  review_status: string; // alpha_pending|published|review_rejected
  reject_reason: string | null;
  published_at: string;
}
export interface DraftRow {
  id: string;
  owner_user_id: string;
  status: string;
  current_step: string;
  step_progress: { percent?: number; phrase?: string } | null;
  title: string | null;
  snapshot_id: string | null;
  extract_job_id: string | null;
  selection: unknown;
  version_id: string | null;
  batch_id: string | null;
  created_at: string;
  updated_at: string;
}

export class DashboardFakeDb implements Queryable {
  readonly queries: Array<{ sql: string; params: unknown[] }> = [];
  capabilities = new Map<string, CapRow>();
  versions = new Map<string, VerRow>();
  candidates = new Map<string, CandidateRow>();
  listings = new Map<string, ListingRow>();
  publications = new Map<string, PubRow>(); // key = capability_id
  drafts = new Map<string, DraftRow>();
  /** 注入：下一次 query 抛错（验聚合失败 → 500）。 */
  throwOnNext = false;

  async query<R = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<QueryResultLike<R>> {
    this.queries.push({ sql, params });
    if (this.throwOnNext) {
      this.throwOnNext = false;
      throw new Error('injected dashboard db failure');
    }

    // —— listCapabilities 锚点归属校验（SELECT EXISTS，Codex r2 P1）——
    //   忠实模拟：同一 owner + status 约束下，锚 capability id 是否仍在集合内。
    //   不存在 / 他人 owner / 被 status 筛掉 → exists:false（repo 抛 InvalidCursorError → 400）。
    if (
      sql.includes('SELECT EXISTS') &&
      sql.includes('FROM capabilities c') &&
      sql.includes('AND c.id = $')
    ) {
      const owner = params[0] as string;
      const anchor = params[params.length - 1] as string; // 末位 = 锚 id
      const filterDraftOnly = sql.includes('p.capability_id IS NULL');
      // status 过滤【镜像派生态】（Codex#r3 P1）：SQL 谓词为字面量（无参数占位），按谓词文本判派生态。
      const displayStatus = parseDisplayStateFromSql(sql, filterDraftOnly);
      const cap = this.capabilities.get(anchor);
      let exists = !!cap && cap.creator_user_id === owner;
      if (exists) {
        if (filterDraftOnly) {
          exists = !this.publications.has(anchor);
        } else if (displayStatus) {
          exists = matchesDisplayState(this.publications.get(anchor), displayStatus);
        }
      }
      return ok<R>([{ exists } as R]);
    }

    // —— listDrafts 锚点归属校验（SELECT EXISTS，Codex r2 P1）——
    //   忠实模拟：同一 owner + status='active' 约束下，锚 draft id 是否仍在集合内。
    if (
      sql.includes('SELECT EXISTS') &&
      sql.includes('FROM drafts') &&
      sql.includes('AND id = $')
    ) {
      const owner = params[0] as string;
      const anchor = params[params.length - 1] as string;
      const d = this.drafts.get(anchor);
      const exists = !!d && d.owner_user_id === owner && d.status === 'active';
      return ok<R>([{ exists } as R]);
    }

    // —— countPublished（本人 published 计数）——
    if (
      sql.includes('FROM publications p') &&
      sql.includes('count(*) AS n') &&
      sql.includes("p.review_status = 'published'") &&
      !sql.includes('p.published_at >=')
    ) {
      const owner = params[0] as string;
      const n = [...this.publications.values()].filter((p) => {
        const cap = this.capabilities.get(p.capability_id);
        return cap?.creator_user_id === owner && p.review_status === 'published';
      }).length;
      return ok<R>([{ n } as R]);
    }

    // —— countPublishedPrevWindow（上一区间 published_at 落窗）——
    if (
      sql.includes('FROM publications p') &&
      sql.includes('count(*) AS n') &&
      sql.includes('p.published_at >=') &&
      sql.includes('p.published_at <')
    ) {
      const owner = params[0] as string;
      const start = params[1] as string;
      const end = params[2] as string;
      const n = [...this.publications.values()].filter((p) => {
        const cap = this.capabilities.get(p.capability_id);
        return (
          cap?.creator_user_id === owner &&
          p.review_status === 'published' &&
          p.published_at >= start &&
          p.published_at < end
        );
      }).length;
      return ok<R>([{ n } as R]);
    }

    // —— listCapabilities（本人能力 LEFT JOIN publications + manifest + 定位）——
    if (sql.includes('FROM capabilities c') && sql.includes('AS capability_id')) {
      const owner = params[0] as string;
      // 末位是 limit+1；status/cursor 参数顺序与 repo 一致（owner=$1, [status], [cursor], limit）。
      // 翻页统一按 limitPlus 切片（多取一条判 hasMore），不需要单独的 limit 变量。
      const limitPlus = Number(params[params.length - 1]);
      const order = sql.includes('ORDER BY c.id DESC') ? 'desc' : 'asc';

      // 解析中间参数（cursor），按 repo 拼装顺序。status 过滤已是字面量谓词（无参数占位，Codex#r3 P1），
      //   故 owner 之后直接是 cursor（若有），不再为 status 占一个参数位。
      let cursorFilter: string | null = null;
      const filterDraftOnly = sql.includes('p.capability_id IS NULL');
      const displayStatus = parseDisplayStateFromSql(sql, filterDraftOnly);
      if (sql.includes('c.id < $') || sql.includes('c.id > $')) {
        cursorFilter = params[1] as string; // owner=$1 后即 cursor（status 无参数位）
      }

      let caps = [...this.capabilities.values()].filter((c) => c.creator_user_id === owner);
      // status 过滤【镜像派生态】（与 displayStatePredicateSql / derive 同口径）。
      if (filterDraftOnly) {
        caps = caps.filter((c) => !this.publications.has(c.id));
      } else if (displayStatus) {
        caps = caps.filter((c) => matchesDisplayState(this.publications.get(c.id), displayStatus));
      }
      // cursor
      if (cursorFilter) {
        caps = caps.filter((c) => (order === 'desc' ? c.id < cursorFilter! : c.id > cursorFilter!));
      }
      // order
      caps.sort((a, b) => (order === 'desc' ? (a.id < b.id ? 1 : -1) : a.id < b.id ? -1 : 1));
      const page = caps.slice(0, limitPlus);

      const rows = page.map((c) => {
        // current_version_id 或最近一条版本（按 created_at desc）
        let ver: VerRow | undefined = c.current_version_id
          ? this.versions.get(c.current_version_id)
          : undefined;
        if (!ver) {
          ver = [...this.versions.values()]
            .filter((v) => v.capability_id === c.id)
            .sort((a, b) => (b.created_at < a.created_at ? -1 : 1))[0];
        }
        const pub = this.publications.get(c.id) ?? null;
        const rej = [...this.versions.values()]
          .filter((v) => v.capability_id === c.id && v.status === 'review_rejected')
          .sort((a, b) => (b.rejected_at ?? '').localeCompare(a.rejected_at ?? ''))[0];
        const hasPublishedVersion = [...this.versions.values()].some(
          (v) => v.capability_id === c.id && v.status === 'published',
        );
        const currentVersion = c.current_version_id
          ? this.versions.get(c.current_version_id)
          : undefined;
        const currentCandidate = currentVersion?.source_candidate_id
          ? this.candidates.get(currentVersion.source_candidate_id)
          : undefined;
        const currentListing = currentVersion
          ? this.listings.get(`${c.id}:${currentVersion.id}`)
          : undefined;
        const currentFreshness = currentListing?.updated_at ?? currentVersion?.updated_at ?? '';
        const shadowedByNewerDuplicate =
          currentCandidate?.snapshot_id !== null &&
          currentCandidate?.snapshot_id !== undefined &&
          currentCandidate.slug !== null &&
          currentCandidate.slug !== undefined &&
          [...this.capabilities.values()].some((other) => {
            if (
              other.id === c.id ||
              other.creator_user_id !== c.creator_user_id ||
              other.status !== 'active' ||
              other.current_version_id === null
            ) {
              return false;
            }
            const otherVersion = this.versions.get(other.current_version_id);
            if (
              !otherVersion ||
              otherVersion.status !== 'published' ||
              (otherVersion.visibility ?? 'public') !== 'public' ||
              otherVersion.source_candidate_id === null
            ) {
              return false;
            }
            const otherCandidate = this.candidates.get(otherVersion.source_candidate_id);
            if (
              otherCandidate?.snapshot_id !== currentCandidate.snapshot_id ||
              otherCandidate?.slug !== currentCandidate.slug
            ) {
              return false;
            }
            const otherFreshness =
              this.listings.get(`${other.id}:${otherVersion.id}`)?.updated_at ??
              otherVersion.updated_at;
            return otherFreshness > currentFreshness;
          });
        const publicPageAvailable =
          c.status === 'active' &&
          currentVersion?.status === 'published' &&
          (currentVersion.visibility ?? 'public') === 'public' &&
          !shadowedByNewerDuplicate;
        return {
          capability_id: c.id,
          version_id: c.current_version_id ?? ver?.id ?? null,
          slug: c.slug,
          name: ver?.manifest.name ?? '',
          tagline: ver?.manifest.tagline ?? '',
          review_status: pub?.review_status ?? null,
          reject_reason: pub?.reject_reason ?? null,
          rejected_version_id: rej?.id ?? null,
          has_published_version: hasPublishedVersion,
          public_page_available: publicPageAvailable,
          published_at: pub?.published_at ?? null,
          updated_at: c.updated_at,
        };
      });
      return ok<R>(rows as R[]);
    }

    // —— listDrafts（本人 active 草稿）——
    if (sql.includes('FROM drafts') && sql.includes('current_step')) {
      const owner = params[0] as string;
      const limitPlus = Number(params[params.length - 1]);
      const order = sql.includes('ORDER BY id DESC') ? 'desc' : 'asc';
      let cursorFilter: string | null = null;
      if (sql.includes('id < $') || sql.includes('id > $')) {
        cursorFilter = params[1] as string;
      }
      let rows = [...this.drafts.values()].filter(
        (d) => d.owner_user_id === owner && d.status === 'active',
      );
      if (cursorFilter) {
        rows = rows.filter((d) => (order === 'desc' ? d.id < cursorFilter! : d.id > cursorFilter!));
      }
      rows.sort((a, b) => (order === 'desc' ? (a.id < b.id ? 1 : -1) : a.id < b.id ? -1 : 1));
      const page = rows.slice(0, limitPlus);
      return ok<R>(page as R[]);
    }

    throw new Error(`DashboardFakeDb: unhandled SQL: ${sql.replace(/\s+/g, ' ').slice(0, 160)}`);
  }
}

// —— 播种 helpers ——

export function seedCapability(
  db: DashboardFakeDb,
  ownerUserId: string,
  opts?: {
    slug?: string;
    name?: string;
    tagline?: string;
    /** 当前版本状态（默认 draft）。 */
    versionStatus?: string;
    /** 当前能力状态（默认 active）。 */
    capabilityStatus?: string;
    /** 当前版本可见性（默认 public）。 */
    visibility?: string | null;
    /** 当前版本候选血缘；两项同时提供时可测试公开页去重口径。 */
    candidateSnapshotId?: string;
    candidateSlug?: string;
    /** 当前版本/市集更新时间（用于公开页重复代表判定）。 */
    versionUpdatedAt?: string;
    listingUpdatedAt?: string;
    /** publications.review_status（不传 = 无 publication 行 = 草稿态）。 */
    reviewStatus?: 'alpha_pending' | 'published' | 'review_rejected' | null;
    rejectReason?: string | null;
    publishedAt?: string;
    /** 是否额外播一条 review_rejected 版（供 retryEditable / 被拒定位）。 */
    addRejectedVersion?: boolean;
    /** 是否额外播一条 published 版（供 has_published_version 派生回退 vs 下架）。 */
    addPublishedVersion?: boolean;
  },
): { capabilityId: string; versionId: string } {
  const capabilityId = nextId('cap');
  const versionId = nextId('ver');
  const now = '2026-06-16T00:00:00.000Z';
  db.capabilities.set(capabilityId, {
    id: capabilityId,
    creator_user_id: ownerUserId,
    slug: opts?.slug ?? `slug-${capabilityId}`,
    status: opts?.capabilityStatus ?? 'active',
    current_version_id: versionId,
    updated_at: now,
    created_at: now,
  });
  const candidateId =
    opts?.candidateSnapshotId !== undefined || opts?.candidateSlug !== undefined
      ? nextId('cand')
      : null;
  if (candidateId) {
    db.candidates.set(candidateId, {
      id: candidateId,
      snapshot_id: opts?.candidateSnapshotId ?? null,
      slug: opts?.candidateSlug ?? null,
    });
  }
  db.versions.set(versionId, {
    id: versionId,
    capability_id: capabilityId,
    status: opts?.versionStatus ?? 'draft',
    visibility: opts?.visibility ?? 'public',
    source_candidate_id: candidateId,
    manifest: { name: opts?.name ?? '需求炼金师', tagline: opts?.tagline ?? '把对话炼成能力' },
    rejected_at: null,
    updated_at: opts?.versionUpdatedAt ?? now,
    created_at: now,
  });
  if (opts?.listingUpdatedAt) {
    db.listings.set(`${capabilityId}:${versionId}`, {
      capability_id: capabilityId,
      version_id: versionId,
      updated_at: opts.listingUpdatedAt,
    });
  }
  if (opts?.addRejectedVersion) {
    const rejId = nextId('ver');
    db.versions.set(rejId, {
      id: rejId,
      capability_id: capabilityId,
      status: 'review_rejected',
      visibility: 'public',
      source_candidate_id: null,
      manifest: { name: opts?.name ?? '需求炼金师', tagline: '' },
      rejected_at: '2026-06-15T00:00:00.000Z',
      updated_at: '2026-06-15T00:00:00.000Z',
      created_at: '2026-06-15T00:00:00.000Z',
    });
  }
  if (opts?.addPublishedVersion) {
    const pubId = nextId('ver');
    db.versions.set(pubId, {
      id: pubId,
      capability_id: capabilityId,
      status: 'published',
      visibility: 'public',
      source_candidate_id: null,
      manifest: { name: opts?.name ?? '需求炼金师', tagline: '上一版' },
      rejected_at: null,
      updated_at: '2026-06-14T00:00:00.000Z',
      created_at: '2026-06-14T00:00:00.000Z',
    });
  }
  if (opts?.reviewStatus !== null && opts?.reviewStatus !== undefined) {
    db.publications.set(capabilityId, {
      capability_id: capabilityId,
      review_status: opts.reviewStatus,
      reject_reason: opts?.rejectReason ?? null,
      published_at: opts?.publishedAt ?? now,
    });
  }
  return { capabilityId, versionId };
}

export function seedDraft(
  db: DashboardFakeDb,
  ownerUserId: string,
  opts?: {
    status?: string;
    currentStep?: string;
    percent?: number;
    phrase?: string;
    title?: string;
    snapshotId?: string;
    extractJobId?: string;
  },
): string {
  const id = nextId('draft');
  const now = '2026-06-16T00:00:00.000Z';
  db.drafts.set(id, {
    id,
    owner_user_id: ownerUserId,
    status: opts?.status ?? 'active',
    current_step: opts?.currentStep ?? 'structure',
    step_progress: { percent: opts?.percent ?? 60, phrase: opts?.phrase ?? '结构化中 60%' },
    title: opts?.title ?? null,
    snapshot_id: opts?.snapshotId ?? null,
    extract_job_id: opts?.extractJobId ?? null,
    selection: null,
    version_id: null,
    batch_id: null,
    created_at: now,
    updated_at: now,
  });
  return id;
}

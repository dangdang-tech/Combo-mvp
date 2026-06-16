// 60 · 工作台只读仓储（B-32，60-dashboard-profile §1）。全部注入 Queryable（pg 子集），便于 mock 单测、无真 PG。
//   鉴权口径（外壳首页-20）：工作台是本人经营后台，全部读按 owner_user_id 内联进 WHERE
//     （非本人 → 0 行/空，handler 据「本人身份」直接返本人聚合；无跨用户下钻）。
//   单一真源（§1.4）：能力表状态列由 publications.review_status/reject_reason 经 derivePublicationDisplayState 派生
//     （在 dashboard-view，不在 SQL 里拼状态文案）；本仓储只取原始列。
//   usage（§决策②）：本仓储【不查】daily_capability_stats / daily_creator_llm_stats / daily_creator_consumers
//     （本月调用/累计调用/本月消耗/活跃消费者/收益/token 趋势全占位），只查真实维度（已发布数/能力名简介状态/草稿条）。
import type { DraftView, DraftStep, DraftStatus } from '@cb/shared';
import { decodeIdCursor, encodeIdCursor, InvalidCursorError } from '@cb/shared';
import type { Queryable } from '../jobs/types.js';
import type { DashboardCapabilityJoinRow } from './dashboard-view.js';
import { displayStatePredicateSql } from '../publish/publication-repo.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function clampLimit(limit?: number): number {
  return Math.min(Math.max(1, limit ?? DEFAULT_LIMIT), MAX_LIMIT);
}

/**
 * 已发布能力体数（真实，§1.1/§1.2）。口径：本人名下 publications.review_status='published' 计数
 *   （上墙/已上架口径；与摘要句、metrics published 卡同口径，外壳首页-08 摘要与卡一致）。
 *   JOIN capabilities 守 owner（creator_user_id = 本人）。usage 无关，纯 count。
 */
export async function countPublished(db: Queryable, ownerUserId: string): Promise<number> {
  const res = await db.query<{ n: number | string }>(
    `SELECT count(*) AS n
       FROM publications p
       JOIN capabilities c ON c.id = p.capability_id
      WHERE c.creator_user_id = $1
        AND p.review_status = 'published'`,
    [ownerUserId],
  );
  const n = res.rows[0]?.n;
  return typeof n === 'number' ? n : Number(n ?? 0);
}

/**
 * 某时间窗内【新增】已发布数（窗口内 published_at 落入的已发布计数，metrics published 卡环比口径，§1.2）。
 *   口径统一（Codex#r3 P1）：环比当前/上一窗口两侧都用「窗口内新增 published」同口径计数——
 *   不混「总数 vs 窗口新增」（混口径会导致：旧能力很多、当前窗口新增 0、上一窗口新增>0 时，
 *   用总数当 current 会误判为 up，方向错）。windowStart/windowEnd 为 ISO 闭开区间 [start, end)。
 */
async function countPublishedInWindow(
  db: Queryable,
  ownerUserId: string,
  windowStartIso: string,
  windowEndIso: string,
): Promise<number> {
  const res = await db.query<{ n: number | string }>(
    `SELECT count(*) AS n
       FROM publications p
       JOIN capabilities c ON c.id = p.capability_id
      WHERE c.creator_user_id = $1
        AND p.review_status = 'published'
        AND p.published_at >= $2
        AND p.published_at <  $3`,
    [ownerUserId, windowStartIso, windowEndIso],
  );
  const n = res.rows[0]?.n;
  return typeof n === 'number' ? n : Number(n ?? 0);
}

/** range → 窗口天数（all 无窗口 → null）。 */
function windowDaysOf(range: '7d' | '30d' | 'all'): number | null {
  if (range === 'all') return null;
  return range === '7d' ? 7 : 30;
}

/**
 * 当前时间区间内【新增】已发布数（环比 current 侧，§1.2，Codex#r3 P1）。
 *   range='all' 无区间 → null（环比方向/百分比一并置 null，不裸造）。
 *   口径：当前区间 [now-1w, now) 内 published_at 落入的已发布数（与上一区间同口径对比涨跌）。
 *   nowMs 注入便于单测（真集成由 handler 传 Date.now()）。
 */
export async function countPublishedCurrentWindow(
  db: Queryable,
  ownerUserId: string,
  range: '7d' | '30d' | 'all',
  nowMs: number,
): Promise<number | null> {
  const days = windowDaysOf(range);
  if (days === null) return null;
  const dayMs = 24 * 60 * 60 * 1000;
  const start = new Date(nowMs - days * dayMs).toISOString();
  const end = new Date(nowMs).toISOString();
  return countPublishedInWindow(db, ownerUserId, start, end);
}

/**
 * 上一时间区间内【新增】已发布数（真实环比基期，metrics published 卡 §1.2）。
 *   range 决定窗口：'7d' 上一个 7 天、'30d' 上一个 30 天；'all' 无上一区间 → 返回 null（环比置 null，不裸造）。
 *   口径：上一区间 [now-2w, now-1w) 内 published_at 落入的已发布数（与当前区间【新增】同口径对比涨跌，
 *   Codex#r3 P1：两侧都用窗口新增，不与总数混口径）。nowMs 注入便于单测。
 */
export async function countPublishedPrevWindow(
  db: Queryable,
  ownerUserId: string,
  range: '7d' | '30d' | 'all',
  nowMs: number,
): Promise<number | null> {
  const days = windowDaysOf(range);
  if (days === null) return null; // all 档无上一区间（环比 null）
  const dayMs = 24 * 60 * 60 * 1000;
  const prevStart = new Date(nowMs - 2 * days * dayMs).toISOString();
  const prevEnd = new Date(nowMs - days * dayMs).toISOString();
  return countPublishedInWindow(db, ownerUserId, prevStart, prevEnd);
}

export interface ListCapabilitiesParams {
  ownerUserId: string;
  cursor?: string;
  limit?: number;
  order?: 'asc' | 'desc';
  /** 状态过滤（all 缺省）。注意 draft/unpublished 是展示派生态，过滤映射在 SQL 注释处说明。 */
  status?: 'all' | 'alpha_pending' | 'published' | 'review_rejected' | 'draft';
}
export interface ListCapabilitiesResult {
  rows: DashboardCapabilityJoinRow[];
  nextCursor: string | null;
}

/**
 * 能力体列表（§1.4，cursor 分页，外壳首页-11）。本人名下能力 LEFT JOIN publications（含未发布草稿）。
 *   名称/简介取 capability_versions.manifest 软字段（真实）；状态原始列（review_status/reject_reason）交 view 派生。
 *   has_published_version：本能力是否有任意 published 版（派生 unpublished：被拒下架=无上一 published 版，§1.4）。
 *   rejected_version_id：最近一条 review_rejected 版（retryEditable 判定，与 3E 单源同口径）。
 *   cursor 用 capability id（UUID v7 时间有序）作不透明锚；多取一条判 hasMore（脊柱 §2.3，不返 total）。
 *   owner 内联 WHERE c.creator_user_id（外壳首页-20，本人经营口径）。
 */
export async function listCapabilities(
  db: Queryable,
  params: ListCapabilitiesParams,
): Promise<ListCapabilitiesResult> {
  const limit = clampLimit(params.limit);
  const order = params.order ?? 'desc'; // 默认最新在前（§1.4）
  const conds = ['c.creator_user_id = $1'];
  const args: unknown[] = [params.ownerUserId];

  // 状态过滤（status != all）。draft = 无 publication 行；其余【镜像单源派生态】（Codex#r3 P1）：
  //   不再按 publications.review_status 原始值过滤（会与展示层 derivePublicationDisplayState 漂移——
  //   published+reject_reason 的回退拒绝态展示为 review_rejected，但原始过滤 status='review_rejected' 查不到、
  //   status='published' 反查到它）。改用 displayStatePredicateSql（与 derive 同口径）：
  //     - review_rejected 含 review_status='review_rejected' OR (published AND reject_reason 非空)。
  //     - published 排除带 reject_reason 的回退拒绝态。
  //   谓词只引用列别名（p.*）、无参数占位，故对主查询与下方 cursor 锚点校验（共用 conds）同口径生效。
  const status = params.status ?? 'all';
  if (status === 'draft') {
    conds.push('p.capability_id IS NULL');
  } else if (status !== 'all') {
    conds.push(displayStatePredicateSql(status, 'p'));
  }

  if (params.cursor !== undefined) {
    // cursor 不透明编码（脊柱 §2.3）；格式非法 → InvalidCursorError（handler 回 400，
    //   不再把任意 string 直接进 id 比较 → 不静默错页、不让 PG 抛错变 500，Codex r1#2）。
    const anchor = decodeIdCursor(params.cursor);
    // 锚点归属校验（Codex r2 P1）：合法编码 ≠ 合法锚点。比较锚（c.id < / >）不会暴露「锚 id 不存在 /
    //   不属本 owner / 被 status 筛掉」——这类锚会静默错页/空页。先用【同一 owner+status 约束】SELECT
    //   该 id 是否仍在集合内（仅校验，不带 cursor 比较）；不在 → InvalidCursorError（handler 回 400
    //   VALIDATION_FAILED），与 profile 端 cursor 失效语义一致（§1.6 / §2.7）。
    //   注意区分：合法锚的正常空尾页（锚在集合内、比较后无更多行）→ 200 空页（此处放行）；
    //            无效锚（锚不在集合内）→ 400（此处抛错）。
    const anchorArgs = [...args, anchor];
    const anchorCheck = await db.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1
           FROM capabilities c
           LEFT JOIN publications p ON p.capability_id = c.id
          WHERE ${conds.join(' AND ')}
            AND c.id = $${anchorArgs.length}
       ) AS exists`,
      anchorArgs,
    );
    if (!anchorCheck.rows[0]?.exists) throw new InvalidCursorError();
    args.push(anchor);
    conds.push(order === 'desc' ? `c.id < $${args.length}` : `c.id > $${args.length}`);
  }
  args.push(limit + 1);

  const res = await db.query<DashboardCapabilityJoinRow>(
    `SELECT c.id                                       AS capability_id,
            COALESCE(c.current_version_id, v.id)       AS version_id,
            c.slug                                     AS slug,
            COALESCE(v.manifest->>'name', '')          AS name,
            COALESCE(v.manifest->>'tagline', '')       AS tagline,
            p.review_status                            AS review_status,
            p.reject_reason                            AS reject_reason,
            rej.id                                     AS rejected_version_id,
            (pubv.id IS NOT NULL)                      AS has_published_version,
            p.published_at::text                       AS published_at,
            c.updated_at::text                         AS updated_at
       FROM capabilities c
       LEFT JOIN capability_versions v
              ON v.id = COALESCE(c.current_version_id, (
                   SELECT v2.id FROM capability_versions v2
                    WHERE v2.capability_id = c.id
                    ORDER BY v2.created_at DESC LIMIT 1))
       LEFT JOIN publications p ON p.capability_id = c.id
       LEFT JOIN LATERAL (
         SELECT r.id FROM capability_versions r
          WHERE r.capability_id = c.id AND r.status = 'review_rejected'
          ORDER BY r.rejected_at DESC NULLS LAST LIMIT 1
       ) rej ON true
       LEFT JOIN LATERAL (
         SELECT pv.id FROM capability_versions pv
          WHERE pv.capability_id = c.id AND pv.status = 'published'
          LIMIT 1
       ) pubv ON true
      WHERE ${conds.join(' AND ')}
      ORDER BY c.id ${order === 'desc' ? 'DESC' : 'ASC'}
      LIMIT $${args.length}`,
    args,
  );

  const hasMore = res.rows.length > limit;
  const page = hasMore ? res.rows.slice(0, limit) : res.rows;
  const lastId = page[page.length - 1]?.capability_id;
  const nextCursor = hasMore && lastId ? encodeIdCursor(lastId) : null;
  return { rows: page, nextCursor };
}

/** drafts 行（草稿条所需列，脊柱 §8.4 DDL）。 */
interface DraftRow {
  id: string;
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

function rowToDraftView(r: DraftRow): DraftView {
  const sp = r.step_progress ?? {};
  const view: DraftView = {
    id: r.id,
    status: r.status as DraftStatus,
    currentStep: r.current_step as DraftStep,
    stepProgress: {
      percent: typeof sp.percent === 'number' ? sp.percent : 0,
      phrase: typeof sp.phrase === 'string' ? sp.phrase : '',
    },
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
  // 落点引用按存在性收敛（续传回精确断点，§1.5；不漏发 undefined 键）。
  if (r.title !== null) view.title = r.title;
  if (r.snapshot_id !== null) view.snapshotId = r.snapshot_id;
  if (r.extract_job_id !== null) view.extractJobId = r.extract_job_id;
  if (r.selection !== null && r.selection !== undefined) view.selection = r.selection;
  if (r.version_id !== null) view.versionId = r.version_id;
  if (r.batch_id !== null) view.batchId = r.batch_id;
  return view;
}

export interface ListDraftsParams {
  ownerUserId: string;
  cursor?: string;
  limit?: number;
  order?: 'asc' | 'desc';
}
export interface ListDraftsResult {
  items: DraftView[];
  nextCursor: string | null;
}

/**
 * 草稿与上传中条（§1.5，cursor 分页，外壳首页-16/17/33/34）。真实数据（非 usage）。
 *   仅返回 status='active' 草稿（completed/abandoned 不上条，§1.5）；多条逐条独立（id/title/落点各自）不串台。
 *   owner 内联 WHERE owner_user_id（本人，外壳首页-20）；空态 → items:[] + nextCursor:null（外壳首页-23）。
 *   cursor 用 draft id（UUID v7 时间有序，与 updated_at 同序近似）；order 默认 desc（最近更新在前，§1.5）。
 */
export async function listDrafts(
  db: Queryable,
  params: ListDraftsParams,
): Promise<ListDraftsResult> {
  const limit = clampLimit(params.limit);
  const order = params.order ?? 'desc';
  const conds = ['owner_user_id = $1', "status = 'active'"];
  const args: unknown[] = [params.ownerUserId];
  if (params.cursor !== undefined) {
    // cursor 不透明编码（脊柱 §2.3）；格式非法 → InvalidCursorError（handler 回 400，Codex r1#2）。
    const anchor = decodeIdCursor(params.cursor);
    // 锚点归属校验（Codex r2 P1）：合法编码 ≠ 合法锚点。先用【同一 owner + status='active' 约束】
    //   SELECT 该 draft id 是否仍在集合内（仅校验，不带 cursor 比较）；不存在 / 他人 owner /
    //   非 active（被 status 筛掉）→ InvalidCursorError（handler 回 400），与能力表/profile 端语义一致。
    //   区分：合法锚的正常空尾页 → 200 空页（放行）；无效锚 → 400（此处抛错）。
    const anchorArgs = [...args, anchor];
    const anchorCheck = await db.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM drafts
          WHERE ${conds.join(' AND ')}
            AND id = $${anchorArgs.length}
       ) AS exists`,
      anchorArgs,
    );
    if (!anchorCheck.rows[0]?.exists) throw new InvalidCursorError();
    args.push(anchor);
    conds.push(order === 'desc' ? `id < $${args.length}` : `id > $${args.length}`);
  }
  args.push(limit + 1);

  const res = await db.query<DraftRow>(
    `SELECT id, status, current_step, step_progress, title,
            snapshot_id, extract_job_id, selection, version_id, batch_id,
            created_at::text AS created_at, updated_at::text AS updated_at
       FROM drafts
      WHERE ${conds.join(' AND ')}
      ORDER BY id ${order === 'desc' ? 'DESC' : 'ASC'}
      LIMIT $${args.length}`,
    args,
  );
  const hasMore = res.rows.length > limit;
  const page = hasMore ? res.rows.slice(0, limit) : res.rows;
  const lastId = page[page.length - 1]?.id;
  const nextCursor = hasMore && lastId ? encodeIdCursor(lastId) : null;
  return { items: page.map(rowToDraftView), nextCursor };
}

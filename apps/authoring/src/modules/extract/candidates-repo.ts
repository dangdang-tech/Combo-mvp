// B-22/B-23 · 候选 / 证据只读仓储（30-step2-extract §2.2/§2.4）。
//   全部注入 Queryable（pg 子集），便于 mock 单测、无真 PG：
//     - 列候选（GET /extract-jobs/{jobId}/candidates）：cursor 分页（order 默认 asc，追加流顺序，提取-30）+
//       置信分布摘要 meta.confidenceSummary（仅 status=ready，提取-12）。
//     - 候选详情（GET /candidates/{id}）：CandidateView 全量。
//     - 段级证据下钻（GET /candidates/{id}/evidence）：cursor 分页（asc），条数 == segment_count（提取-34）。
//   鉴权：owner_user_id 内联进 WHERE（非属主/不存在 → 0 行 → 调用方 404，不暴露存在性，10-auth §6.3）。
//   候选行 error 是人话 ErrorBody（写库即去 code，UI 永不渲染 code；脊柱 §11.B / D1）。证据 quote 是去敏正文（提取-31）。
import type {
  CandidateView,
  CandidateEvidenceView,
  ConfidenceSummary,
  CandidateStatus,
  CapabilityType,
  Confidence,
  CandidateScope,
  ReusabilityBreakdown,
  ErrorBody,
} from '@cb/shared';
import type { Queryable } from '../../platform/jobs/types.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/** capability_candidates 行（只取展示所需列）。 */
interface CandidateRow {
  id: string;
  extract_job_id: string;
  snapshot_id: string;
  owner_user_id: string;
  status: string;
  name: string | null;
  intent: string | null;
  slug: string;
  type: string | null;
  confidence: string | null;
  segment_count: number | null;
  frequency_ratio: number | string | null;
  reusability: number | string | null;
  scope_coherence: number | string | null;
  split_suggested: boolean | null;
  scope: unknown;
  reusability_breakdown: unknown;
  error: unknown;
  retry_cnt: number;
  created_at: string;
}

/** numeric(4,3) 列 PG 驱动可能回字符串；统一成 number | null。 */
function toNum(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function rowToCandidateView(r: CandidateRow): CandidateView {
  return {
    id: r.id,
    extractJobId: r.extract_job_id,
    snapshotId: r.snapshot_id,
    status: r.status as CandidateStatus,
    name: r.name,
    intent: r.intent,
    slug: r.slug,
    type: (r.type as CapabilityType | null) ?? null,
    confidence: (r.confidence as Confidence | null) ?? null,
    segmentCount: r.segment_count,
    frequencyRatio: toNum(r.frequency_ratio),
    reusability: toNum(r.reusability),
    scopeCoherence: toNum(r.scope_coherence),
    splitSuggested: r.split_suggested,
    scope: (r.scope as CandidateScope | null) ?? null,
    reusabilityBreakdown: (r.reusability_breakdown as ReusabilityBreakdown | null) ?? null,
    error: (r.error as ErrorBody | null) ?? null,
    retryCount: r.retry_cnt,
    createdAt: r.created_at,
  };
}

/** 解析 ?status=ready,failed 多值过滤（缺省全部；非法值丢弃）。 */
function parseStatusFilter(raw: string | undefined): CandidateStatus[] | null {
  if (!raw) return null;
  const valid = new Set(['generating', 'ready', 'failed']);
  const vals = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => valid.has(s)) as CandidateStatus[];
  return vals.length > 0 ? vals : null;
}

export interface ListCandidatesParams {
  extractJobId: string;
  ownerUserId: string;
  cursor?: string;
  limit?: number;
  order?: 'asc' | 'desc';
  status?: string;
}
export interface ListCandidatesResult {
  items: CandidateView[];
  nextCursor: string | null;
  /** 置信分布摘要（仅 ready 候选，提取-12）；job 非本人/不存在 → null（调用方 404）。 */
  confidenceSummary: ConfidenceSummary | null;
  /** job 存在且属本人且 type=extract（区分「空候选」与「越权/不存在」→ 后者 404）。 */
  ownsJob: boolean;
}

/**
 * 列某次萃取的候选（§2.2）。先验 job 属主 + type=extract（不存在/非本人/非 extract → ownsJob=false → 404）。
 *   cursor 用候选 id（UUID v7 时间有序，与 created_at 同序）作不透明锚；多取一条判 hasMore（脊柱 §2.3，不返 total）。
 *   order 默认 asc（追加流：先识别在前，与逐个浮现一致，提取-30）。可选 status 多值过滤（缺省全部，含 failed 行，提取-17）。
 *   confidenceSummary 独立聚合（仅 ready，与分页无关、与 SSE done.total 同口径）。
 */
export async function listCandidates(
  db: Queryable,
  params: ListCandidatesParams,
): Promise<ListCandidatesResult> {
  // 属主 + type 校验（轻查；非 extract job / 非本人 / 不存在 → 拒，不暴露存在性）。
  const own = await db.query<{ ok: number }>(
    `SELECT 1 AS ok FROM jobs WHERE id = $1 AND owner_user_id = $2 AND type = 'extract'`,
    [params.extractJobId, params.ownerUserId],
  );
  if ((own.rowCount ?? 0) === 0) {
    return { items: [], nextCursor: null, confidenceSummary: null, ownsJob: false };
  }

  const limit = Math.min(Math.max(1, params.limit ?? DEFAULT_LIMIT), MAX_LIMIT);
  const order = params.order ?? 'asc';
  const statusFilter = parseStatusFilter(params.status);

  const conds = ['extract_job_id = $1'];
  const args: unknown[] = [params.extractJobId];
  if (statusFilter) {
    args.push(statusFilter);
    conds.push(`status = ANY($${args.length}::text[])`);
  }
  if (params.cursor) {
    args.push(params.cursor);
    conds.push(order === 'desc' ? `id < $${args.length}` : `id > $${args.length}`);
  }
  args.push(limit + 1);
  const res = await db.query<CandidateRow>(
    `SELECT id, extract_job_id, snapshot_id, owner_user_id, status, name, intent, slug,
            type, confidence, segment_count, frequency_ratio, reusability, scope_coherence,
            split_suggested, scope, reusability_breakdown, error, retry_cnt, created_at
       FROM capability_candidates
      WHERE ${conds.join(' AND ')}
      ORDER BY id ${order === 'desc' ? 'DESC' : 'ASC'}
      LIMIT $${args.length}`,
    args,
  );
  const hasMore = res.rows.length > limit;
  const page = hasMore ? res.rows.slice(0, limit) : res.rows;
  const nextCursor = hasMore ? (page[page.length - 1]?.id ?? null) : null;

  // 置信分布摘要（仅 ready，提取-12）：独立聚合（不靠分页 total，脊柱 §2.3；与 SSE done.total 同口径）。
  const sum = await db.query<{ confidence: string | null; n: number | string }>(
    `SELECT confidence, count(*) AS n
       FROM capability_candidates
      WHERE extract_job_id = $1 AND status = 'ready'
      GROUP BY confidence`,
    [params.extractJobId],
  );
  const confidenceSummary: ConfidenceSummary = { high: 0, med: 0, low: 0 };
  for (const r of sum.rows) {
    const n = typeof r.n === 'number' ? r.n : Number(r.n);
    if (r.confidence === 'high') confidenceSummary.high += n;
    else if (r.confidence === 'med') confidenceSummary.med += n;
    else if (r.confidence === 'low') confidenceSummary.low += n;
  }

  return {
    items: page.map(rowToCandidateView),
    nextCursor,
    confidenceSummary,
    ownsJob: true,
  };
}

/**
 * 候选详情（§2.4 GET /candidates/{id}）。owner 内联守门：不存在/非本人 → null（调用方 404）。
 */
export async function getCandidateForOwner(
  db: Queryable,
  candidateId: string,
  ownerUserId: string,
): Promise<CandidateView | null> {
  const res = await db.query<CandidateRow>(
    `SELECT id, extract_job_id, snapshot_id, owner_user_id, status, name, intent, slug,
            type, confidence, segment_count, frequency_ratio, reusability, scope_coherence,
            split_suggested, scope, reusability_breakdown, error, retry_cnt, created_at
       FROM capability_candidates
      WHERE id = $1 AND owner_user_id = $2`,
    [candidateId, ownerUserId],
  );
  const row = res.rows[0];
  return row ? rowToCandidateView(row) : null;
}

/** candidate_evidence + session_segments 联表行（去敏后段级摘要，提取-31）。 */
interface EvidenceRow {
  id: string;
  candidate_id: string;
  segment_id: string;
  snapshot_id: string;
  title: string | null;
  source: string | null;
  quote: string | null;
  happened_at: string | null;
  project: string | null;
}

function rowToEvidenceView(r: EvidenceRow): CandidateEvidenceView {
  return {
    id: r.id,
    candidateId: r.candidate_id,
    segmentId: r.segment_id,
    snapshotId: r.snapshot_id,
    title: r.title,
    source: r.source,
    quote: r.quote,
    happenedAt: r.happened_at,
    project: r.project,
  };
}

export interface ListEvidenceParams {
  candidateId: string;
  ownerUserId: string;
  cursor?: string;
  limit?: number;
  order?: 'asc' | 'desc';
}
export interface ListEvidenceResult {
  items: CandidateEvidenceView[];
  nextCursor: string | null;
  /** 候选存在且属本人（区分「无证据」与「越权/不存在」→ 后者 404）。 */
  ownsCandidate: boolean;
}

/**
 * 段级血缘证据下钻（§2.4 GET /candidates/{id}/evidence）。先验候选属主（owner 内联）。
 *   cursor 用 evidence id（UUID v7 时间有序）；order 默认 asc（与候选证据落库序一致）。
 *   quote/title 取自 candidate_evidence JOIN session_segments 的【去敏正文】（导入期已去敏，提取-31，不二次脱敏）。
 *   返回条数（跨页累加）= CandidateView.segmentCount = 频次条段数（提取-34，血缘一致）。
 */
export async function listCandidateEvidence(
  db: Queryable,
  params: ListEvidenceParams,
): Promise<ListEvidenceResult> {
  // 候选属主轻查（不存在/非本人 → 404，不暴露存在性）。
  const own = await db.query<{ ok: number }>(
    `SELECT 1 AS ok FROM capability_candidates WHERE id = $1 AND owner_user_id = $2`,
    [params.candidateId, params.ownerUserId],
  );
  if ((own.rowCount ?? 0) === 0) return { items: [], nextCursor: null, ownsCandidate: false };

  const limit = Math.min(Math.max(1, params.limit ?? DEFAULT_LIMIT), MAX_LIMIT);
  const order = params.order ?? 'asc';
  const conds = ['e.candidate_id = $1'];
  const args: unknown[] = [params.candidateId];
  if (params.cursor) {
    args.push(params.cursor);
    conds.push(order === 'desc' ? `e.id < $${args.length}` : `e.id > $${args.length}`);
  }
  args.push(limit + 1);
  const res = await db.query<EvidenceRow>(
    `SELECT e.id, e.candidate_id, e.segment_id, e.snapshot_id,
            seg.title, seg.source, seg.content AS quote,
            seg.happened_at::text AS happened_at, seg.project
       FROM candidate_evidence e
       JOIN session_segments seg ON seg.id = e.segment_id
      WHERE ${conds.join(' AND ')}
      ORDER BY e.id ${order === 'desc' ? 'DESC' : 'ASC'}
      LIMIT $${args.length}`,
    args,
  );
  const hasMore = res.rows.length > limit;
  const page = hasMore ? res.rows.slice(0, limit) : res.rows;
  const nextCursor = hasMore ? (page[page.length - 1]?.id ?? null) : null;
  return { items: page.map(rowToEvidenceView), nextCursor, ownsCandidate: true };
}

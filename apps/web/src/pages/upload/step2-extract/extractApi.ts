// STEP② 提取数据层（F-11）——触发萃取 + 列候选（含置信分布 meta）+ 单候选重试。
//
// 端点真源（30 §1 端点总览）；写命令走 4A typed client（自动注入 Idempotency-Key + scope）。
//   1. POST /snapshots/{id}/extract（scope=extract.create）：对去敏快照触发萃取 Job，秒回 jobId + eventsUrl。
//   2. GET  /extract-jobs/{jobId}/candidates：列候选（结果态拉全量 / 重连超窗对账；逐个浮现走 SSE，非轮询）。
//   3. POST /candidates/{id}/retry（scope=candidate.retry）：单候选重试，回新 retryJob eventsUrl（前端改连此流）。
import {
  IdempotencyScope,
  API_PREFIX,
  type ExtractJobAccepted,
  type CandidateView,
  type CandidateRetryAccepted,
  type ConfidenceSummary,
} from '@cb/shared';
import {
  apiPost,
  apiGetEnvelope,
  type RequestOptions,
  type WriteOptions,
} from '../../../api/index.js';

/** 触发萃取端点路径（30 §2.1，写命令 scope=extract.create）。 */
export function extractCreatePath(snapshotId: string): string {
  return `/snapshots/${encodeURIComponent(snapshotId)}/extract`;
}

/** 列候选端点路径（30 §2.2，读，天然幂等）。 */
export function candidatesPath(extractJobId: string): string {
  return `/extract-jobs/${encodeURIComponent(extractJobId)}/candidates`;
}

/** 单候选重试端点路径（30 §2.3，写命令 scope=candidate.retry）。 */
export function candidateRetryPath(candidateId: string): string {
  return `/candidates/${encodeURIComponent(candidateId)}/retry`;
}

/** job 流 SSE 端点（萃取 job 或重试 retryJob 复用；脊柱 §5 / 30 §3）。 */
export function jobEventsUrl(jobId: string): string {
  return `${API_PREFIX}/jobs/${encodeURIComponent(jobId)}/events`;
}

/**
 * 触发萃取（30 §2.1）。写命令必带 Idempotency-Key（client 自动）+ scope=extract.create。
 *   重复点 / 刷新复用 idempotencyKey → 回放首次（同 jobId，不重复跑，提取-25）。
 *   body：可选 `draftId`——本萃取由哪条草稿发起（续传指针）。后端同事务把 extract_job_id 焊到该草稿（owner 守卫），
 *     续传按 draftId 恢复 DraftView.extractJobId 即回精确断点（候选选择，P0：fresh flow 萃取指针落 draft）。
 *   options 本期 schema 冻结、传值忽略；无 draftId 即 body {}（30 §2.1）。
 */
export async function createExtractJob(
  snapshotId: string,
  idempotencyKey?: string,
  extra: { draftId?: string } = {},
  opts: RequestOptions = {},
): Promise<ExtractJobAccepted> {
  const write: WriteOptions = {
    ...opts,
    scope: IdempotencyScope.EXTRACT_CREATE,
    ...(idempotencyKey ? { idempotencyKey } : {}),
  };
  // draftId 入 body（后端据它同事务回填 drafts.extract_job_id）；无 draftId 仍发 {}（契约 §2.1 body 可空）。
  const body = extra.draftId ? { draftId: extra.draftId } : {};
  return apiPost<ExtractJobAccepted>(extractCreatePath(snapshotId), body, write);
}

export interface CandidatesResult {
  candidates: CandidateView[];
  /** 底部置信分布摘要（提取-12，仅本端点 meta 扩展；仅统计 ready）。 */
  confidenceSummary: ConfidenceSummary | undefined;
  nextCursor: string | undefined;
  hasMore: boolean;
}

/**
 * 列某次萃取的候选（结果态拉全量 / 重连超窗对账）。order=asc 与逐个浮现序一致（30 §2.2）。
 *   默认拉 ready + failed（结果态要展示失败行 + 行内重试，提取-17）；置信分布从 meta.confidenceSummary 取。
 */
export async function fetchCandidates(
  extractJobId: string,
  params: {
    cursor?: string | undefined;
    limit?: number | undefined;
    status?: string | undefined;
  } = {},
  opts: RequestOptions = {},
): Promise<CandidatesResult> {
  const res = await apiGetEnvelope<CandidateView[]>(candidatesPath(extractJobId), {
    ...opts,
    query: {
      cursor: params.cursor,
      limit: params.limit,
      order: 'asc',
      status: params.status ?? 'ready,failed',
    },
  });
  // confidenceSummary 是本端点对 Meta 的领域扩展（脊柱允许 meta 新增字段）；类型层 Meta 不含它，安全收窄。
  const meta = res.meta as { confidenceSummary?: ConfidenceSummary } | undefined;
  return {
    candidates: res.data,
    confidenceSummary: meta?.confidenceSummary,
    nextCursor: res.meta?.page?.nextCursor ?? undefined,
    hasMore: res.meta?.page?.hasMore ?? false,
  };
}

/**
 * 单候选重试（30 §2.3）。写命令必带 Idempotency-Key（client 自动）+ scope=candidate.retry。
 *   返回新 retryJob 的 eventsUrl——前端改连这条新流收回填（原萃取 job 已 terminal，不在其上追加，Codex#4）。
 *   单项失败不阻塞其余、无连坐（B-23）。
 */
export async function retryCandidate(
  candidateId: string,
  idempotencyKey?: string,
  opts: RequestOptions = {},
): Promise<CandidateRetryAccepted> {
  const write: WriteOptions = {
    ...opts,
    scope: IdempotencyScope.CANDIDATE_RETRY,
    ...(idempotencyKey ? { idempotencyKey } : {}),
  };
  return apiPost<CandidateRetryAccepted>(candidateRetryPath(candidateId), {}, write);
}

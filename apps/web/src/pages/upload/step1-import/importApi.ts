// STEP① 导入数据层（F-10）——浏览器直传主路径（B-20：presign → 分批 PUT 原文 → 建 Job）
//   + 本机助手路径（铸码 / 轮询，高级入口）+ 取消 + 快照统计/会话列表。
//
// 端点真源（20 §1 端点清单）；写命令走 4A typed client（自动注入 Idempotency-Key + scope）。
// 本期前端「主推」浏览器直传路径（用户在浏览器里选文件/目录/拖拽 → presign 拿预签名 URL →
//   分批 PUT 原文到对象存储 → POST /import/jobs 引用对象建 Job → 网页转 SSE）；本机助手 / CURL
//   降级为高级入口（铸码 → 终端跑命令 → 助手凭码全量直传 → 自动建 Job → 网页轮询拿 jobId → 转 SSE）。
import {
  IdempotencyScope,
  IdempotencyOptionalScope,
  API_PREFIX,
  type ImportSource,
  type PresignResult,
  type PairResult,
  type PairStatusView,
  type SnapshotView,
  type SnapshotSegmentView,
  type JobView,
} from '@cb/shared';
import {
  apiPost,
  apiPostReadonly,
  apiGet,
  apiGetEnvelope,
  ApiError,
  type RequestOptions,
  type WriteOptions,
} from '../../../api/index.js';

/** 申请分批直传预签名 URL 端点路径（20 §2.1，带请求体只读 POST，scope 可选 import.presign）。 */
export function presignPath(): string {
  return '/import/uploads/presign';
}

/** 引用已上传对象触发导入 Job 端点路径（20 §2.2，写命令 scope=import.create）。 */
export function createJobPath(): string {
  return '/import/jobs';
}

/** 铸配对码端点路径（20 §3.1，写命令 scope=import.connect.pair）。 */
export function pairPath(): string {
  return '/import/connect/pair';
}

/** 轮询配对/上传状态端点路径（20 §3.4）。 */
export function pairStatusPath(pairId: string): string {
  return `/import/connect/pair/${encodeURIComponent(pairId)}`;
}

/** 取消导入 Job 端点路径（脊柱 §6.1 / 20 §4.4，写命令 scope=job.cancel）。 */
export function cancelJobPath(jobId: string): string {
  return `/jobs/${encodeURIComponent(jobId)}/cancel`;
}

/** 快照统计 + 去敏报告端点路径（20 §5.1）。 */
export function snapshotPath(snapshotId: string): string {
  return `/snapshots/${encodeURIComponent(snapshotId)}`;
}

/** 快照会话节选列表端点路径（20 §5.2，只读 cursor 分页）。 */
export function snapshotSegmentsPath(snapshotId: string): string {
  return `/snapshots/${encodeURIComponent(snapshotId)}/segments`;
}

/**
 * 铸一次性配对码（20 §3.1）。写命令必带 Idempotency-Key（client 自动）+ scope=import.connect.pair。
 *   重复点「生成命令」/刷新复用同一 idempotencyKey → 回放首次结果（同 pairId+同码，不重复铸行，硬规则③）。
 *   续传草稿可挂接 draftId（20 §3.1 body）。
 */
export async function createPair(
  params: { draftId?: string | undefined; idempotencyKey?: string | undefined } = {},
  opts: RequestOptions = {},
): Promise<PairResult> {
  const body = params.draftId ? { draftId: params.draftId } : {};
  const write: WriteOptions = {
    ...opts,
    scope: IdempotencyScope.IMPORT_CONNECT_PAIR,
    ...(params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : {}),
  };
  return apiPost<PairResult>(pairPath(), body, write);
}

/**
 * 轮询配对/上传状态（20 §3.4，建议 2s 一次）。phase=job_created 时返 jobId + eventsUrl，前端停轮询转 SSE。
 *   读，天然幂等。expired 是态（非错误），上层给「配对码已过期，重新生成」引导。
 */
export async function fetchPairStatus(
  pairId: string,
  opts: RequestOptions = {},
): Promise<PairStatusView> {
  return apiGet<PairStatusView>(pairStatusPath(pairId), opts);
}

/**
 * 取消导入 Job（脊柱 §6.1 / 20 §4.4）。写命令必带 Idempotency-Key（client 自动）+ scope=job.cancel。
 *   取消后保留已完成段（硬规则③，导入-35）；重复取消同 key 回放首次结果。
 */
export async function cancelImportJob(
  jobId: string,
  idempotencyKey?: string,
  opts: RequestOptions = {},
): Promise<void> {
  await apiPost<unknown>(
    cancelJobPath(jobId),
    {},
    {
      ...opts,
      scope: IdempotencyScope.JOB_CANCEL,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    },
  );
}

// ---------------------------------------------------------------------------
// 浏览器直传主路径（B-20，20 §2）：presign → 分批 PUT 原文 → 建 Job
// ---------------------------------------------------------------------------

/** presign 请求里单个 part 的元信息（20 §2.1 PresignRequest.parts[]）。 */
export interface PresignPartInput {
  clientPartId: string;
  sizeBytes: number;
  contentSha256?: string | undefined;
}

/**
 * 申请分批直传预签名 URL（20 §2.1）。「带请求体只读」POST：不写库、只签 URL，
 *   按脊柱 §4.1 非写命令——带 scope=import.presign 则重放回放同一组 URL（断点续传重签同 uploadId）。
 *   严格按契约字段：{ parts, source, totalBytes } → { uploadId, bucket, parts:[{clientPartId,url,s3Key,expiresAt}] }。
 */
export async function presignUploads(
  params: { parts: PresignPartInput[]; source: ImportSource; totalBytes: number },
  opts: RequestOptions = {},
): Promise<PresignResult> {
  const body = {
    parts: params.parts.map((p) => ({
      clientPartId: p.clientPartId,
      sizeBytes: p.sizeBytes,
      ...(p.contentSha256 ? { contentSha256: p.contentSha256 } : {}),
    })),
    source: params.source,
    totalBytes: params.totalBytes,
  };
  return apiPostReadonly<PresignResult>(presignPath(), body, {
    ...opts,
    scope: IdempotencyOptionalScope.IMPORT_PRESIGN,
  });
}

/**
 * 把单个 part 的原文字节 PUT 到预签名 URL（直发对象存储，跨域、不带凭证、无 JSON 包络）。
 *   失败（网络断 / 非 2xx / URL 过期 403）抛人话 ApiError（UPLOAD_INTERRUPTED 语义：可续传/重签），
 *   绝不裸露 S3 状态码 / 堆栈（硬规则②）。abort 透传给上层（取消/卸载）。
 */
export async function putUploadPart(
  url: string,
  data: Blob | ArrayBuffer,
  opts: { signal?: AbortSignal | undefined } = {},
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'PUT',
      // 对象存储是跨域且 URL 自带签名，绝不携带站点 Cookie（避免签名失配 + 隐私）。
      credentials: 'omit',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: data,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    // 网络断 → 上传中断，可续传（导入-31 UPLOAD_INTERRUPTED）。
    throw uploadInterruptedError();
  }
  if (!res.ok) {
    // 非 2xx（含 URL 过期 403）→ 上传中断，续传时重签 + 重传未完成 part（导入-31）。
    throw uploadInterruptedError();
  }
}

/** 上传中断的人话信封（导入-31，UPLOAD_INTERRUPTED / action retry）。 */
function uploadInterruptedError(): ApiError {
  return new ApiError({
    error: {
      userMessage: '上传中断了，点重试可以续传剩下的内容。',
      retriable: true,
      action: 'retry',
      traceId: '',
    },
  });
}

/**
 * 引用已上传对象触发导入 Job（20 §2.2，阶段 A→B）。写命令必带 Idempotency-Key（client 自动）+ scope=import.create。
 *   同一 uploadId + 同 key 重放回放同一 jobId（导入-23）；秒回 JobView，前端拿 jobView.id 转订阅 SSE。
 *   续传草稿可挂接 draftId（20 §2.2 body）。
 */
export async function createImportJob(
  params: {
    uploadId: string;
    source: ImportSource;
    draftId?: string | undefined;
    idempotencyKey?: string | undefined;
  },
  opts: RequestOptions = {},
): Promise<JobView> {
  const body = {
    uploadId: params.uploadId,
    source: params.source,
    ...(params.draftId ? { draftId: params.draftId } : {}),
  };
  const write: WriteOptions = {
    ...opts,
    scope: IdempotencyScope.IMPORT_CREATE,
    ...(params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : {}),
  };
  return apiPost<JobView>(createJobPath(), body, write);
}

/** 取快照统计四格 + 去敏报告（完成态用；20 §5.1）。 */
export async function fetchSnapshot(
  snapshotId: string,
  opts: RequestOptions = {},
): Promise<SnapshotView> {
  return apiGet<SnapshotView>(snapshotPath(snapshotId), opts);
}

export interface SnapshotSegmentsResult {
  segments: SnapshotSegmentView[];
  nextCursor: string | undefined;
  hasMore: boolean;
}

/** 取快照会话节选列表（完成态只读列表；20 §5.2，desc 默认最新在前）。 */
export async function fetchSnapshotSegments(
  snapshotId: string,
  params: { cursor?: string | undefined; limit?: number | undefined } = {},
  opts: RequestOptions = {},
): Promise<SnapshotSegmentsResult> {
  const res = await apiGetEnvelope<SnapshotSegmentView[]>(snapshotSegmentsPath(snapshotId), {
    ...opts,
    query: { cursor: params.cursor, limit: params.limit },
  });
  return {
    segments: res.data,
    nextCursor: res.meta?.page?.nextCursor ?? undefined,
    hasMore: res.meta?.page?.hasMore ?? false,
  };
}

/** 导入 Job 的 SSE 端点（kind=job；脊柱 §5 / 20 §4.1）。 */
export function importJobEventsUrl(jobId: string): string {
  return `${API_PREFIX}/jobs/${encodeURIComponent(jobId)}/events`;
}

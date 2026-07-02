// Typed API client（F-01）——消费 @cb/shared 的契约真源。
//
// 三条硬规则在客户端层的落地：
//   1. 绝不裸露错误码：所有非 2xx → 解析为 ErrorEnvelope，UI 只读 userMessage + action（见 ApiError）。
//   2. 永不裸转圈：本层只负责取数与抛错；加载态/进度由组件层（components/）承担。
//   3. 已生成内容不丢：写命令统一注入 Idempotency-Key（幂等可安全重放），scope 取自 shared 常量表。
//
// 轻包络 { data, meta }（脊柱 §2）：成功解包 data，meta 经 requestEnvelope 暴露给需要分页/占位语义的调用方。
import {
  API_PREFIX,
  CLIENT_FALLBACK_TRACE_ID,
  TRACE_ID_HEADER,
  TRACEPARENT_HEADER,
  sanitizeErrorEnvelope,
  type Envelope,
  type Meta,
  type ErrorEnvelope,
  type ErrorBody,
  type IdempotencyScopeValue,
  type IdempotencyOptionalScopeValue,
} from '@cb/shared';
import { clientTraceHeaders, reportClientEvent } from './telemetry.js';

/** 写命令必带的 Idempotency scope（脊柱 §4 的 22 项之一；类型层强制不可省，编译期堵「写请求无幂等键」）。 */
export type IdempotencyScopeInput = IdempotencyScopeValue;
/** 带请求体「只读」POST 的可选 scope（presign/preview 等不写库豁免，脊柱 §4.1）。 */
export type IdempotencyOptionalScopeInput = IdempotencyOptionalScopeValue;

/**
 * 统一前端错误：内部承载完整对外 ErrorEnvelope（D1：不含 code），UI 只暴露人话 + action。
 * 渲染层应只读 `userMessage` / `action` / `retriable`；`traceId` 仅作「反馈代码」展示（非错误码）。
 */
export class ApiError extends Error {
  readonly envelope: ErrorEnvelope;

  constructor(envelope: ErrorEnvelope) {
    super(envelope.error.userMessage);
    this.name = 'ApiError';
    this.envelope = envelope;
  }

  /** 唯一可对 UI 渲染的人话。 */
  get userMessage(): string {
    return this.envelope.error.userMessage;
  }

  /** 退路动作：retry | change_input | escalate | wait | none。 */
  get action(): ErrorBody['action'] {
    return this.envelope.error.action;
  }

  get retriable(): boolean {
    return this.envelope.error.retriable;
  }

  /** 关联日志 / Sentry，可作「反馈代码」展示——但它不是错误码，永不当主文案。 */
  get traceId(): string {
    return this.envelope.error.traceId;
  }
}

/**
 * 兜底信封：当后端未按契约返回（网络断、HTML 错误页、JSON 解析失败）时仍给人话 + 退路。
 * 对外信封形态（D1）：不含 code —— 内部 code 仅日志侧存在，客户端兜底无 code 可言。
 */
function fallbackEnvelope(userMessage: string): ErrorEnvelope {
  return {
    error: {
      userMessage,
      retriable: true,
      action: 'retry',
      traceId: CLIENT_FALLBACK_TRACE_ID,
    },
  };
}

/** 读请求选项（GET / 只读 POST 共用基底；无幂等字段）。 */
export interface RequestOptions {
  /** 查询参数（自动 URL 编码，undefined 值跳过）。 */
  query?: Record<string, string | number | boolean | undefined>;
  /** AbortSignal（组件卸载/取消请求）。 */
  signal?: AbortSignal;
  /** 额外请求头。 */
  headers?: Record<string, string>;
}

/** 写命令选项：**强制**带 `scope`（编译期堵漏幂等），可选覆盖幂等键。 */
export interface WriteOptions extends RequestOptions {
  /** 写命令幂等 scope（脊柱 §4 必带 22 项之一）；注入 X-Idempotency-Scope + Idempotency-Key。 */
  scope: IdempotencyScopeInput;
  /** 覆盖自动生成的幂等键（断点续传/重放同一逻辑操作时复用同一 key，保证「已生成内容不丢」）。 */
  idempotencyKey?: string;
}

/** 带请求体「只读」POST 选项：可选 scope（不写库豁免，脊柱 §4.1）。 */
export interface ReadonlyPostOptions extends RequestOptions {
  /** 可选只读 scope（presign/preview）；给了才注入幂等头，不给则纯只读。 */
  scope?: IdempotencyOptionalScopeInput;
  /** 覆盖自动生成的幂等键（仅当带 scope 时有意义）。 */
  idempotencyKey?: string;
}

interface RawRequestOptions extends RequestOptions {
  method: string;
  body?: unknown;
  scope?: IdempotencyScopeInput | IdempotencyOptionalScopeInput;
  idempotencyKey?: string;
}

/** 生成幂等键：优先 crypto.randomUUID，降级时间戳+随机（仅本地兜底）。 */
function newIdempotencyKey(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `idem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  const base = path.startsWith('/api/') ? path : `${API_PREFIX}${path}`;
  if (!query) return base;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined) params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

/** 底层请求：解包 { data, meta }；非 2xx 统一抛 ApiError（永远带人话 + 退路）。 */
async function request<T>(path: string, opts: RawRequestOptions): Promise<Envelope<T>> {
  const headers: Record<string, string> = { ...opts.headers };
  const trace = clientTraceHeaders(headers[TRACE_ID_HEADER]);
  headers[TRACE_ID_HEADER] ??= trace.traceId;
  headers[TRACEPARENT_HEADER] ??= trace.headers[TRACEPARENT_HEADER]!;
  const hasBody = opts.body !== undefined;
  if (hasBody) headers['Content-Type'] = 'application/json';

  // 写命令注入幂等键（脊柱 §4）：scope 决定 (scope,key) 唯一性；DELETE 不豁免。
  if (opts.scope) {
    headers['Idempotency-Key'] = opts.idempotencyKey ?? newIdempotencyKey();
    headers['X-Idempotency-Scope'] = opts.scope;
  }

  let res: Response;
  const url = buildUrl(path, opts.query);
  try {
    res = await fetch(url, {
      method: opts.method,
      credentials: 'include',
      headers,
      ...(hasBody ? { body: JSON.stringify(opts.body) } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  } catch (cause) {
    // 网络层失败（断网/被 abort）：abort 透传，其余包成人话信封。
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    reportClientEvent('api_error', {
      traceId: trace.traceId,
      message: cause instanceof Error ? cause.message : 'network error',
      stack: cause instanceof Error ? cause.stack : undefined,
      url,
    });
    throw new ApiError(fallbackEnvelope('网络好像不太稳，检查连接后重试。'));
  }

  // 204 / 空体：直接返回空 data 包络。
  if (res.status === 204) return { data: undefined as T };

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    if (!res.ok) {
      reportClientEvent('api_error', {
        traceId: trace.traceId,
        message: 'non-json error response',
        url,
      });
      throw new ApiError(fallbackEnvelope('服务暂时没有正确响应，请稍后重试。'));
    }
    return { data: undefined as T };
  }

  if (!res.ok) {
    // 白名单重建（绝不强转原始 body）：只摘 userMessage/action/retriable/traceId/failureId?/details?，
    // code/status/stack/原始 message 一律不进 envelope（Codex r2 P1 / D1）。缺人话则回退兜底人话——
    // 后端没按契约出信封时也绝不裸露状态码。
    const inner = body as { error?: { userMessage?: unknown } } | null;
    const hasContractEnvelope =
      typeof inner === 'object' &&
      inner !== null &&
      typeof inner.error?.userMessage === 'string' &&
      (inner.error.userMessage as string).length > 0;
    if (hasContractEnvelope) {
      const envelope = sanitizeErrorEnvelope(body);
      reportClientEvent('api_error', {
        traceId: envelope.error.traceId,
        message: envelope.error.userMessage,
        url,
      });
      throw new ApiError(envelope);
    }
    reportClientEvent('api_error', {
      traceId: trace.traceId,
      message: 'non-contract error response',
      url,
    });
    throw new ApiError(fallbackEnvelope('服务开小差了，请稍后重试。'));
  }

  return body as Envelope<T>;
}

// ---------- 公共方法：默认解包 data；需要 meta（分页/占位）时用 *Envelope 版本 ----------

export async function apiGet<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  return (await request<T>(path, { ...opts, method: 'GET' })).data;
}

export async function apiGetEnvelope<T>(
  path: string,
  opts: RequestOptions = {},
): Promise<{ data: T; meta?: Meta }> {
  return request<T>(path, { ...opts, method: 'GET' });
}

/**
 * 写命令 POST：**强制** `opts.scope`（类型层堵漏，编译期保证带 Idempotency-Key）。
 * 只读 POST（market-card/preview、presign 等不写库）请用 {@link apiPostReadonly}，别在这里传可选 scope。
 */
export async function apiPost<T>(path: string, body: unknown, opts: WriteOptions): Promise<T> {
  return (await request<T>(path, { ...opts, method: 'POST', body })).data;
}

/**
 * 「带请求体只读」POST 显式 helper（脊柱 §4.1 豁免：不写库、只签 URL / 只算预览）。
 * scope 可选；不带 scope 即不注入任何幂等头（与写命令分流，杜绝「只读也被迫编一个写 scope」）。
 */
export async function apiPostReadonly<T>(
  path: string,
  body: unknown,
  opts: ReadonlyPostOptions = {},
): Promise<T> {
  return (await request<T>(path, { ...opts, method: 'POST', body })).data;
}

/** 写命令 PATCH：**强制** `opts.scope`。 */
export async function apiPatch<T>(path: string, body: unknown, opts: WriteOptions): Promise<T> {
  return (await request<T>(path, { ...opts, method: 'PATCH', body })).data;
}

/** 写命令 DELETE：**强制** `opts.scope`（DELETE 不因天然幂等豁免，脊柱 §4）。 */
export async function apiDelete<T>(path: string, opts: WriteOptions): Promise<T> {
  return (await request<T>(path, { ...opts, method: 'DELETE' })).data;
}

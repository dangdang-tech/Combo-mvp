// B-06 · OpenRouter(OpenAI 兼容)上游错误载体 + 归一(与 Anthropic 路径同分类口径)。
//   传输层(openrouter.ts)把 HTTP 非 2xx / 网络 / 坏响应都抛成 OpenRouterApiError(status?+headers?+片段);
//   errors.ts 的 normalizeLlmError 识别它并归一到既有内部分类(retriable/fatal + 既有 ErrorCode),
//   不新增对外形态、不引入 ErrorEnvelope code(对外仍只 userMessage+action)。
import { ErrorCode } from '@cb/shared';
import type { NormalizedLlmError } from './types.js';

/**
 * OpenRouter / OpenAI 兼容上游错误。
 *   - status:HTTP 状态码;网络/连接错误为 undefined。
 *   - headers:用于读 retry-after(429);网络错误可空。
 *   - internalMessage:上游报文片段(仅入日志,绝不进对外 payload)。
 */
export class OpenRouterApiError extends Error {
  constructor(
    public readonly status: number | undefined,
    public readonly headers: Headers | undefined,
    public readonly internalMessage: string,
  ) {
    super(internalMessage);
    this.name = 'OpenRouterApiError';
  }
}

/** 从 OpenRouterApiError 的 Headers 抠 retry-after(秒);抠不到返回 undefined。 */
function readRetryAfter(err: OpenRouterApiError): number | undefined {
  const raw = err.headers?.get('retry-after');
  if (raw != null && raw !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return undefined;
}

/**
 * 把 OpenRouterApiError 归一到与 Anthropic 路径一致的内部分类(脊柱 §3.3 / §10):
 *   - 401/403 鉴权 → fatal + INTERNAL(密钥/权限是系统配置错,重试无益;不暴露密钥语义)。
 *   - 429 限流 → retriable + RATE_LIMITED(+ retry-after)。
 *   - 400/404/422 输入类 → fatal + VALIDATION_FAILED(prompt/参数/模型名问题,重试无益)。
 *   - 其它 4xx → fatal + LLM_UPSTREAM_FAILED(罕见且通常重试无益)。
 *   - 5xx / status=undefined(网络/连接/坏响应)→ retriable + LLM_UPSTREAM_FAILED。
 * 返回 undefined 表示「这不是 OpenRouter 错误」,交回通用 Anthropic 归一链。
 */
export function normalizeOpenRouterError(err: unknown): NormalizedLlmError | undefined {
  if (!(err instanceof OpenRouterApiError)) return undefined;
  const internalMessage = err.internalMessage;
  const status = err.status;

  if (status === 401 || status === 403) {
    return { kind: 'fatal', code: ErrorCode.INTERNAL, internalMessage };
  }
  if (status === 429) {
    const retryAfterSec = readRetryAfter(err);
    return {
      kind: 'retriable',
      code: ErrorCode.RATE_LIMITED,
      internalMessage,
      ...(retryAfterSec !== undefined ? { retryAfterSec } : {}),
    };
  }
  if (status === 400 || status === 404 || status === 422) {
    return { kind: 'fatal', code: ErrorCode.VALIDATION_FAILED, internalMessage };
  }
  if (typeof status === 'number' && status >= 400 && status < 500) {
    return { kind: 'fatal', code: ErrorCode.LLM_UPSTREAM_FAILED, internalMessage };
  }
  // 5xx / 网络 / 连接 / 坏响应(status=undefined)→ 可重试上游失败。
  const retryAfterSec = readRetryAfter(err);
  return {
    kind: 'retriable',
    code: ErrorCode.LLM_UPSTREAM_FAILED,
    internalMessage,
    ...(retryAfterSec !== undefined ? { retryAfterSec } : {}),
  };
}

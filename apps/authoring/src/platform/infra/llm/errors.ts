// B-06 · 上游错误归一(SDK/网络 → 内部分类)。脊柱 §3 / §10 / 70 §8.3。
//   - 对外永不裸露 code/堆栈/英文原始报错(归一只产内部 code，仅入日志经 traceId 关联)。
//   - 区分 retriable(重试 ≤2)/degraded(上游不稳兜底，不裸 502)/fatal(不可重试，直接落终态)。
//   - 429 读 retry-after；5xx/连接错误可重试；4xx(非 429)多为 fatal(输入/鉴权问题)。
import Anthropic from '@anthropic-ai/sdk';
import { ErrorCode } from '@cb/shared';
import type { NormalizedLlmError } from './types.js';
import { normalizeOpenRouterError } from './openrouter-errors.js';

/**
 * 从 headers 抠 retry-after(秒)，抠不到返回 undefined。
 * 兼容两种 headers 形态:
 *   - SDK 0.33.x:APIError.headers 是普通对象 Record<string,string|null|undefined>(用方括号取)。
 *   - 新版 SDK / 全局 fetch:Headers 实例(用 .get())。
 */
function readRetryAfter(err: unknown): number | undefined {
  const headers = (err as { headers?: unknown }).headers;
  if (!headers || typeof headers !== 'object') return undefined;

  let raw: string | null | undefined;
  const getter = (headers as { get?: unknown }).get;
  if (typeof getter === 'function') {
    raw = (headers as { get(name: string): string | null }).get('retry-after');
  } else {
    raw = (headers as Record<string, string | null | undefined>)['retry-after'];
  }
  if (raw != null && raw !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return undefined;
}

/** 安全取内部消息(只入日志；绝不进 userMessage)。 */
function internalMessageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return 'unknown llm error';
  }
}

/**
 * 把任意 SDK/网络异常归一为内部分类(脊柱 §3.3 / §10)。
 *   - 429 RateLimitError → retriable + RATE_LIMITED(+ retryAfterSec)。
 *   - 5xx / overloaded(529) / 连接错误 / 超时 → retriable + LLM_UPSTREAM_FAILED。
 *   - 401/403 鉴权 → fatal + INTERNAL(密钥问题是系统配置错，不让用户改输入；对外仍走 retry 兜底由调用方决定)。
 *   - 400/404/422 输入类 → fatal + VALIDATION_FAILED(prompt/参数问题，重试无益)。
 *   - 其它未知 → retriable + LLM_UPSTREAM_FAILED(保守可重试一轮)。
 * 注：本函数只「归一」，不决定 degraded——degraded 由网关在「重试耗尽且仍是 retriable」时升级(脊柱 §10)。
 */
export function normalizeLlmError(err: unknown): NormalizedLlmError {
  const internalMessage = internalMessageOf(err);

  // OpenRouter(OpenAI 兼容)上游错误:先按其状态码归一(与 Anthropic 同分类口径)。
  //   非 OpenRouterApiError → 返回 undefined,继续走下面的 Anthropic 归一链。
  const orNorm = normalizeOpenRouterError(err);
  if (orNorm) return orNorm;

  // 用户主动取消(AbortError)：不计失败、不重试。
  //   Anthropic SDK 抛 APIUserAbortError;全局 fetch(OpenRouter 路径)抛 name='AbortError' 的 DOMException。
  if (
    err instanceof Anthropic.APIUserAbortError ||
    (err instanceof Error && err.name === 'AbortError')
  ) {
    return { kind: 'fatal', code: ErrorCode.CLIENT_CANCELLED, internalMessage };
  }

  // 429：限流，可重试，带 retry-after。
  if (err instanceof Anthropic.RateLimitError) {
    const retryAfterSec = readRetryAfter(err);
    return {
      kind: 'retriable',
      code: ErrorCode.RATE_LIMITED,
      internalMessage,
      ...(retryAfterSec !== undefined ? { retryAfterSec } : {}),
    };
  }

  // 鉴权类(401/403)：系统配置错(密钥/权限)，重试无益 → fatal。内部记 INTERNAL(不暴露密钥语义)。
  if (
    err instanceof Anthropic.AuthenticationError ||
    err instanceof Anthropic.PermissionDeniedError
  ) {
    return { kind: 'fatal', code: ErrorCode.INTERNAL, internalMessage };
  }

  // 输入类(400/404/422)：prompt/参数/模型名问题，重试无益 → fatal + VALIDATION_FAILED。
  if (
    err instanceof Anthropic.BadRequestError ||
    err instanceof Anthropic.NotFoundError ||
    err instanceof Anthropic.UnprocessableEntityError
  ) {
    return { kind: 'fatal', code: ErrorCode.VALIDATION_FAILED, internalMessage };
  }

  // 连接错误 / 超时：上游不稳，可重试。
  if (
    err instanceof Anthropic.APIConnectionTimeoutError ||
    err instanceof Anthropic.APIConnectionError
  ) {
    return { kind: 'retriable', code: ErrorCode.LLM_UPSTREAM_FAILED, internalMessage };
  }

  // 其它 APIError：5xx / 529 overloaded / 未细分状态 → 可重试上游失败。
  if (err instanceof Anthropic.APIError) {
    // instanceof 已收窄到 APIError 实例,直接取 status(可能 undefined,如连接错误)。
    const status = err.status;
    const retryAfterSec = readRetryAfter(err);
    // 4xx(非已处理)罕见且通常重试无益 → fatal；其余(含 undefined/5xx)可重试。
    if (typeof status === 'number' && status >= 400 && status < 500) {
      return { kind: 'fatal', code: ErrorCode.LLM_UPSTREAM_FAILED, internalMessage };
    }
    return {
      kind: 'retriable',
      code: ErrorCode.LLM_UPSTREAM_FAILED,
      internalMessage,
      ...(retryAfterSec !== undefined ? { retryAfterSec } : {}),
    };
  }

  // 非 SDK 异常(本地超时哨兵等)：保守可重试一轮。
  return { kind: 'retriable', code: ErrorCode.LLM_UPSTREAM_FAILED, internalMessage };
}

/** 退避计算：指数退避 + 满抖动(full jitter)。base * 2^attempt，封顶 capMs，叠加 [0, computed) 抖动。 */
export function backoffMs(
  attempt: number,
  opts: { baseMs?: number; capMs?: number; jitter01?: number } = {},
): number {
  const base = opts.baseMs ?? 500;
  const cap = opts.capMs ?? 8_000;
  const exp = Math.min(cap, base * 2 ** attempt);
  // jitter01 ∈ [0,1)：可由调用方注入(基于 clock.now())以可复现；缺省用 Math.random。
  const j = opts.jitter01 ?? Math.random();
  return Math.floor(exp * (0.5 + 0.5 * j)); // 半固定 + 半抖动，避免退避到 0。
}

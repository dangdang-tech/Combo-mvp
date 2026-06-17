// B-06 · LLM Gateway 模块装配(env → 真 SDK[Anthropic|OpenRouter] + 限流 + 审计 + 网关)。
// 对外保持 createLlmGateway(env, db?): LlmGatewayPort / probeLlm()，infra/index.ts 与脚手架不变。
//   - provider 选择(resolveLlmProvider):LLM_PROVIDER 显式优先;未设时按「哪个 key 在」自动判定。
//     · anthropic → new Anthropic({apiKey: ANTHROPIC_API_KEY})(原路径,模型默认 claude-opus-4-8)。
//     · openrouter → createOpenRouterClient({baseUrl,apiKey,model})(OpenAI 兼容 fetch /chat/completions)。
//   - 选定 provider 但其 key 缺失 → sdk=null:所有方法直接 degraded(不抛、不裸 502,脊柱 §10;
//     /ready 仍 ready=true,llm required:false)。
//   - 有 key → 真 SDK + 进程内令牌桶限流兜底(redis_hot 跨实例限流诚实推迟 Phase 5/6)。
//   - 传入 db → PG audit_llm_calls 仓储(createPgAuditSink):成功/降级都落审计,
//     写审计失败只日志不阻断主调用(70 §8.3:审计非计费真源);缺 db 才回落 no-op。
import Anthropic from '@anthropic-ai/sdk';
import type { LlmGatewayPort } from '@cb/shared';
import type { Env } from '../../config/env.js';
import { makeLlmGateway, type LlmSdkClient } from './gateway.js';
import { createTokenBucketLimiter, noopRateLimiter } from './limiter.js';
import { createPgAuditSink, noopAuditSink, type QueryableDb } from './audit.js';
import { DEFAULT_MODEL } from './types.js';
import {
  createOpenRouterClient,
  OPENROUTER_DEFAULT_BASE_URL,
  OPENROUTER_DEFAULT_MODEL,
} from './openrouter.js';

/** 解析出的 LLM provider 装配(sdk=null 表示选中 provider 但缺 key → 全降级)。 */
export interface ResolvedLlmProvider {
  provider: 'anthropic' | 'openrouter';
  sdk: LlmSdkClient | null;
  /** 实际使用的模型(用于网关默认 model + 审计记账)。 */
  model: string;
}

/**
 * 从 env 选 provider 并建 SDK。
 *   - LLM_PROVIDER 显式设置 → 用它;否则按 key 自动判定:
 *       有 OPENROUTER_API_KEY 而无 ANTHROPIC_API_KEY → openrouter;否则 anthropic(默认/原路径)。
 *   - 选中 provider 的 key 缺失 → sdk=null(degraded 兜底,不阻塞启动)。
 *   - 模型:LLM_MODEL 优先;否则按 provider 各自默认(anthropic→claude-opus-4-8,
 *     openrouter→anthropic/claude-sonnet-4.6)。
 */
export function resolveLlmProvider(env: Env): ResolvedLlmProvider {
  const anthropicKey = env.ANTHROPIC_API_KEY?.trim();
  const openrouterKey = env.OPENROUTER_API_KEY?.trim();
  const explicit = env.LLM_PROVIDER;
  const provider: 'anthropic' | 'openrouter' =
    explicit === 'openrouter' || explicit === 'anthropic'
      ? explicit
      : openrouterKey && !anthropicKey
        ? 'openrouter'
        : 'anthropic';

  const modelOverride = env.LLM_MODEL?.trim();

  if (provider === 'openrouter') {
    const model = modelOverride || OPENROUTER_DEFAULT_MODEL;
    const baseUrl = env.LLM_BASE_URL?.trim() || OPENROUTER_DEFAULT_BASE_URL;
    const sdk: LlmSdkClient | null = openrouterKey
      ? createOpenRouterClient({ apiKey: openrouterKey, baseUrl, model })
      : null;
    return { provider, sdk, model };
  }

  // anthropic(原路径)。
  const model = modelOverride || DEFAULT_MODEL;
  const sdk: LlmSdkClient | null = anthropicKey
    ? (new Anthropic({ apiKey: anthropicKey }) as unknown as LlmSdkClient)
    : null;
  return { provider, sdk, model };
}

/**
 * 组装生产网关:按 env 选 provider(anthropic|openrouter)建真 SDK;缺 key → null(降级,不阻塞启动)。
 * 限流默认进程内令牌桶(每分钟 60 次/key)。
 * 审计:传入 db → createPgAuditSink 落 audit_llm_calls(成功/降级都写;写失败只日志不阻断);
 *      缺 db → no-op(无 PG 直跑/冒烟用)。
 */
export function createLlmGateway(env: Env, db?: QueryableDb): LlmGatewayPort {
  const { sdk, model } = resolveLlmProvider(env);
  return makeLlmGateway({
    sdk,
    model,
    // 有 key 才开限流(无 key 直接 degraded,限流无意义)。
    rateLimiter: sdk
      ? createTokenBucketLimiter({ ratePerWindow: 60, windowMs: 60_000 })
      : noopRateLimiter,
    // 有 db → PG 审计(成功/降级都落库);写审计失败只 console.warn,不阻断主调用。
    audit: db
      ? createPgAuditSink(db, (err) =>
          console.warn(
            `[llm-audit] 落 audit_llm_calls 失败(已忽略,审计非计费真源): ${String(err)}`,
          ),
        )
      : noopAuditSink,
  });
}

/**
 * ready 探针(degraded 不算失败,脊柱 §10.2):LLM 永远 required:false。
 *   - 选中 provider 的 key 缺失/未实连 → 'degraded'(不停服,不计 /ready 失败)。
 *   - 有 key → 'ok'(真探活留 Phase;本期有 key 即视为可用,失败在调用时降级)。
 */
export function probeLlm(env?: Env): 'ok' | 'degraded' | 'down' {
  if (!env) return 'degraded';
  const { sdk } = resolveLlmProvider(env);
  return sdk ? 'ok' : 'degraded';
}

export { makeLlmGateway } from './gateway.js';
export type { LlmGatewayDeps, LlmSdkClient } from './gateway.js';
export { LlmTimeoutError } from './gateway.js';
export { createTokenBucketLimiter, noopRateLimiter, createRedisRateLimiter } from './limiter.js';
export {
  createOpenRouterClient,
  OPENROUTER_DEFAULT_BASE_URL,
  OPENROUTER_DEFAULT_MODEL,
} from './openrouter.js';
export { OpenRouterApiError, normalizeOpenRouterError } from './openrouter-errors.js';
export {
  noopAuditSink,
  createMemoryAuditSink,
  createPgAuditSink,
  type QueryableDb,
} from './audit.js';
export { normalizeLlmError, backoffMs } from './errors.js';
export {
  computeCostMicros,
  DEFAULT_MODEL,
  realClock,
  type LlmClock,
  type LlmRateLimiter,
  type LlmAuditSink,
  type LlmAuditRecord,
  type NormalizedLlmError,
} from './types.js';

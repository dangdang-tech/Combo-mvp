// B-06 · LLM Gateway 内部类型与依赖注入契约（仅本模块用，不外泄）。
// 端口形态来自 @cb/shared（LlmGatewayPort / LlmCallOptions / LlmResult），本文件只声明
// 「真实现需要的可注入依赖 + 内部分类」，便于单测 mock SDK/网络/时钟/限流/审计而不打真 API。
import type { ErrorCodeValue } from '@cb/shared';

/** 默认模型(最新 Claude)。3C/3D 可经 opts 不覆盖——网关统一兜底，prompt 由调用方给。 */
export const DEFAULT_MODEL = 'claude-opus-4-8';
/** embedding 路由模型(本期占位；真 embedding 端点 Phase 5/6 接，诚实推迟)。 */
export const DEFAULT_EMBEDDING_MODEL = 'claude-embedding-placeholder';

/**
 * 计费/计价(microUSD per 1e6 tokens)。仅供 audit_llm_calls 成本估算(非计费真源，70 §8.3)。
 * 真实费率随模型浮动；本表是「成本审计」用的近似，缺模型回落默认档。
 * 单位换算：$/MTok → microUSD/token = ($/MTok) 。每 token 成本(microUSD)=费率/1e6*1e6=费率。
 * 即 promptTokens * inputRate / 1e6 * 1e6... 简化为：costMicros = round(tokens * ratePerMTokMicros / 1e6)。
 */
export interface ModelPricing {
  /** 输入每 MTok 的 microUSD(= $/MTok * 1e6 的 micro 表达：$5/MTok → 5_000_000 microUSD/MTok)。 */
  inputMicrosPerMTok: number;
  outputMicrosPerMTok: number;
}

/** 模型计价表(成本审计近似，非计费真源)。 */
export const MODEL_PRICING: Record<string, ModelPricing> = {
  // Claude Opus 4.8: $5 / $25 per MTok。
  'claude-opus-4-8': { inputMicrosPerMTok: 5_000_000, outputMicrosPerMTok: 25_000_000 },
  // Claude Sonnet 4.6: $3 / $15 per MTok。
  'claude-sonnet-4-6': { inputMicrosPerMTok: 3_000_000, outputMicrosPerMTok: 15_000_000 },
  // Claude Haiku 4.5: $1 / $5 per MTok。
  'claude-haiku-4-5': { inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 5_000_000 },
  // —— OpenRouter 上的 Claude(模型名带 anthropic/ 前缀;费率与对应官方档一致)——
  // Claude Sonnet 4.6(OpenRouter 默认,实测 slug 有效):$3 / $15 per MTok。
  'anthropic/claude-sonnet-4.6': {
    inputMicrosPerMTok: 3_000_000,
    outputMicrosPerMTok: 15_000_000,
  },
  // Claude Sonnet 4.5(OpenRouter 备选):$3 / $15 per MTok。
  'anthropic/claude-sonnet-4.5': {
    inputMicrosPerMTok: 3_000_000,
    outputMicrosPerMTok: 15_000_000,
  },
  // Claude 3.5 Sonnet:$3 / $15 per MTok。
  'anthropic/claude-3.5-sonnet': {
    inputMicrosPerMTok: 3_000_000,
    outputMicrosPerMTok: 15_000_000,
  },
};

/** 缺模型时的回落费率(取 Opus 档，宁可高估成本不低估)。 */
export const FALLBACK_PRICING: ModelPricing = MODEL_PRICING['claude-opus-4-8']!;

/** 计 microUSD 成本(四舍五入)。 */
export function computeCostMicros(
  model: string,
  promptTokens: number,
  completionTokens: number,
): number {
  const p = MODEL_PRICING[model] ?? FALLBACK_PRICING;
  const inCost = (promptTokens * p.inputMicrosPerMTok) / 1_000_000;
  const outCost = (completionTokens * p.outputMicrosPerMTok) / 1_000_000;
  return Math.round(inCost + outCost);
}

/**
 * 上游调用归一后的「内部分类」(脊柱 §3 / 70 §8.3)。
 * 网关内部用 ErrorCodeValue 标内部 code(仅入日志/经 traceId 关联)，对外由调用方据此出 ErrorEnvelope。
 * degraded 不算依赖失败(脊柱 §10)：上游不稳 → LlmResult.degraded=true，不抛、不裸 502。
 */
export type LlmFailureKind = 'retriable' | 'degraded' | 'fatal';

/** SDK/网络错误归一结果。 */
export interface NormalizedLlmError {
  kind: LlmFailureKind;
  /** 内部 code(仅日志，绝不进对外 payload)。 */
  code: ErrorCodeValue;
  /** 原始内部消息(仅日志；绝不进 userMessage)。 */
  internalMessage: string;
  /** 上游建议的重试等待(秒)，来自 429 retry-after，可空。 */
  retryAfterSec?: number;
}

/** 一次审计记账(落 audit_llm_calls；非计费真源，70 §8.3)。 */
export interface LlmAuditRecord {
  ownerUserId?: string;
  anonKey?: string;
  taskClass: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  costMicros: number;
  degraded: boolean;
  /** 实际重试次数(≤ LLM_MAX_RETRIES)。 */
  retries: number;
  traceId: string;
}

/** 审计落库端口(注入)。骨架/无 PG 时用 no-op 或内存收集器；Phase 接 audit_llm_calls 仓储。 */
export interface LlmAuditSink {
  record(entry: LlmAuditRecord): Promise<void> | void;
}

/** 限流端口(注入)。返回是否放行 + 命中限流时建议等待秒数。 */
export interface LlmRateLimiter {
  /**
   * 尝试占用一个调用名额。key 维度：ownerUserId 或 anonKey(share_token 场景)。
   * 返回 { allowed:true } 放行；{ allowed:false, retryAfterSec } 命中限流(调用方据此 degraded/wait)。
   */
  acquire(key: string): Promise<{ allowed: boolean; retryAfterSec?: number }>;
}

/** 时钟/退避/超时注入(单测可注入快进，避免真 sleep/真超时拖慢测试)。 */
export interface LlmClock {
  /** 当前毫秒(用于退避 jitter 的可复现)。 */
  now(): number;
  /** 异步等待 ms(退避用;单测可 mock 成立即 resolve)。 */
  sleep(ms: number): Promise<void>;
  /**
   * 注册一个 ms 后触发的定时器(超时用,与 sleep 分离便于单测分别断言)。
   * 返回取消句柄(成功/正常收尾时清除,避免悬挂定时器)。
   */
  setTimer(cb: () => void, ms: number): () => void;
}

/** 真实时钟(生产用)。 */
export const realClock: LlmClock = {
  now: () => Date.now(),
  sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
  setTimer: (cb: () => void, ms: number) => {
    const t = setTimeout(cb, ms);
    return () => clearTimeout(t);
  },
};

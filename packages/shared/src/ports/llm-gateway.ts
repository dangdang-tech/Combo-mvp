// B-06 · LLM Gateway 端口（70 §8.3）。限流/重试/计费/流式。domain 声明，infra/llm 实现。
import type { TraceId, UserId } from '../core/ids.js';

/** 超时分级 40/45/60/180s 按 taskClass 选档（技术方案 1.4）。 */
export type LlmTaskClass = 'extract' | 'structure_field' | 'embedding' | 'misc';

export interface LlmCallOptions {
  taskClass: LlmTaskClass;
  traceId: TraceId;
  /** 预算闸/计费归属。 */
  ownerUserId?: UserId;
  /** 匿名按 token 限流（share_token 场景）。 */
  anonKey?: string;
  /** 流式（结构化字段流 field_delta 的上游）。 */
  stream?: boolean;
}

export interface LlmResult {
  text?: string;
  embedding?: number[];
  /** 上游不稳但有兜底 → 进度短语 + 退路（不裸转圈/不裸 502，脊柱 §10）。 */
  degraded: boolean;
  /** 审计落 audit_llm_calls（非计费真源）。 */
  usage: { promptTokens: number; completionTokens: number; costMicros: number };
}

export interface LlmGatewayPort {
  complete(prompt: string, opts: LlmCallOptions): Promise<LlmResult>;
  /** → field_delta。 */
  stream(prompt: string, opts: LlmCallOptions): AsyncIterable<{ deltaText: string }>;
  embed(input: string | string[], opts: LlmCallOptions): Promise<LlmResult>;
}

/** LLM 超时分级（毫秒，技术方案 1.4）。 */
export const LLM_TIMEOUTS_MS: Record<LlmTaskClass, number> = {
  extract: 60_000,
  structure_field: 45_000,
  embedding: 40_000,
  misc: 180_000,
};

/** LLM 调用重试上限（脊柱 §3.1：≤2 后才落终态错误）。 */
export const LLM_MAX_RETRIES = 2;

// B-06 · 统一 LLM 网关真实现(实现 shared LlmGatewayPort)。70 §8.3 / 脊柱 §3/§10。
// 调用链(complete/stream/embed 共用):
//   1) 限流(预算闸/匿名按 token)——命中 → degraded(不抛、不裸 502，脊柱 §10)。
//   2) 超时分级(LLM_TIMEOUTS_MS[taskClass])——本地 AbortController + 超时哨兵。
//   3) 退避重试(≤ LLM_MAX_RETRIES，指数退避 + 满抖动)——区分 retriable/fatal/degraded。
//   4) 重试耗尽且仍 retriable → 升级 degraded(进度短语 + 退路由调用方给，不裸 502)。
//   5) 用量记账落 audit(tokens/cost/retries/degraded；非计费真源)。
// 错误一律归一为内部分类(仅 internal code 入日志经 traceId 关联，绝不进对外 payload)。
// prompt 由 3C/3D 给;网关只提供 complete/stream/embed 高层方法骨架的「真传输/治理」层。
import Anthropic from '@anthropic-ai/sdk';
import type { LlmCallOptions, LlmGatewayPort, LlmResult } from '@cb/shared';
import { LLM_MAX_RETRIES, LLM_TIMEOUTS_MS } from '@cb/shared';
import {
  type LlmAuditSink,
  type LlmClock,
  type LlmRateLimiter,
  type NormalizedLlmError,
  DEFAULT_MODEL,
  computeCostMicros,
  realClock,
} from './types.js';
import { backoffMs, normalizeLlmError } from './errors.js';
import { noopRateLimiter } from './limiter.js';
import { noopAuditSink } from './audit.js';

/**
 * 网关只依赖 SDK 的最小子集(结构化接口)。真 Anthropic 客户端结构上满足它，
 * 单测可注入 fake 而不打真 API / 不需真 key。
 */
export interface LlmSdkClient {
  messages: {
    create(
      body: Anthropic.MessageCreateParamsNonStreaming,
      options?: { signal?: AbortSignal },
    ): Promise<Anthropic.Message>;
    create(
      body: Anthropic.MessageCreateParamsStreaming,
      options?: { signal?: AbortSignal },
    ): Promise<AsyncIterable<Anthropic.RawMessageStreamEvent>>;
  };
}

/** 网关依赖注入(全部可 mock；缺省走「无 PG/无 Redis 也能跑」的安全兜底)。 */
export interface LlmGatewayDeps {
  /** SDK 客户端(无 key 时可为 null → 直接 degraded，不抛、不裸 502)。 */
  sdk: LlmSdkClient | null;
  rateLimiter?: LlmRateLimiter;
  audit?: LlmAuditSink;
  clock?: LlmClock;
  /** 默认模型(缺省 claude-opus-4-8)。 */
  model?: string;
  /** 单次 completion 的 max_tokens(默认 4096；3C/3D 长输出可在 Phase 调)。 */
  maxTokens?: number;
  /** 退避 base/cap(ms)。 */
  backoffBaseMs?: number;
  backoffCapMs?: number;
}

const EMPTY_USAGE = { promptTokens: 0, completionTokens: 0, costMicros: 0 } as const;
const TIMEOUT_SENTINEL = Symbol('llm-timeout');

/**
 * 这次失败是不是一次「abort」(网关超时 timer 触发的 controller.abort，或真实用户取消)。
 * 导出供单测坐实 P1-3 归一口径(Anthropic.APIUserAbortError / 全局 fetch 的 AbortError 都算)。
 */
export function isAbortError(err: unknown): boolean {
  return (
    err instanceof Anthropic.APIUserAbortError ||
    (err instanceof Error && err.name === 'AbortError')
  );
}

/**
 * 给 Promise 套超时；超时 abort 上游并抛超时哨兵(归一为 retriable 上游失败)。
 *
 * 关键(P1-3)：超时由本函数自己的 timer 触发 controller.abort()，上游(OpenRouter fetch / Anthropic SDK)
 * 会随之抛 AbortError。该 abort reject 可能在 Promise.race 里【先于】超时哨兵胜出——若放它原样上抛，
 * normalizeLlmError 会把它当成「用户主动取消」→ fatal CLIENT_CANCELLED(不重试)，把一次【超时】误判成取消，语义错。
 * 因此用 timedOut 标志收口：只要超时 timer 已触发，任何随后的 abort 都统一改抛 LlmTimeoutError
 * (retriable LLM_UPSTREAM_FAILED → 重试到上限)。仅【非超时触发】的 abort(真实用户取消)才原样上抛 → CLIENT_CANCELLED。
 * anthropic 与 openrouter 两条路径同受益、不回归。
 *
 * 导出供单测：在测试 harness 里超时哨兵几乎总赢 race，难以稳定触发「abort 先于哨兵胜出」的分支；
 * 故直接对 withTimeout 单测该分支（factory 在 timer 触发后才以 AbortError reject）——确定性反向破坏可测。
 */
export async function withTimeout<T>(
  factory: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  clock: LlmClock,
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  let cancelTimer: (() => void) | undefined;
  const timeout = new Promise<typeof TIMEOUT_SENTINEL>((resolve) => {
    // 用 clock.setTimer(与退避 sleep 分离)注册超时；超时即 abort 上游(不裸挂)并记 timedOut。
    cancelTimer = clock.setTimer(() => {
      timedOut = true;
      controller.abort();
      resolve(TIMEOUT_SENTINEL);
    }, timeoutMs);
  });
  try {
    const result = await Promise.race([factory(controller.signal), timeout]);
    if (result === TIMEOUT_SENTINEL) {
      throw new LlmTimeoutError(timeoutMs);
    }
    return result as T;
  } catch (err) {
    // 超时 timer 已触发后的 abort = 网关自身超时(并非用户取消)→ 统一归一为可重试超时。
    if (timedOut && isAbortError(err)) {
      throw new LlmTimeoutError(timeoutMs);
    }
    throw err;
  } finally {
    // 工作已先完成时清掉悬挂的超时定时器。
    cancelTimer?.();
  }
}

/** 本地超时哨兵错误(归一为 retriable LLM_UPSTREAM_FAILED → 升级 JOB_TIMEOUT 由调用方据 taskClass)。 */
export class LlmTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`llm call timed out after ${timeoutMs}ms`);
    this.name = 'LlmTimeoutError';
  }
}

/** 限流 key：按 owner 计费归属优先，匿名按 anonKey(share_token)，都没有则全局桶。 */
function rateKeyOf(opts: LlmCallOptions): string {
  if (opts.ownerUserId) return `owner:${opts.ownerUserId}`;
  if (opts.anonKey) return `anon:${opts.anonKey}`;
  return 'global';
}

/** 降级结果工厂(不抛、不裸 502；usage 置空，degraded=true，调用方据此出进度短语 + 退路)。 */
function degradedResult(extra?: Partial<LlmResult>): LlmResult {
  return { degraded: true, usage: { ...EMPTY_USAGE }, ...extra };
}

/**
 * 降级审计（Codex r5 非阻塞②：「降级都审计」统一落地）。无 key / SDK 不可达 / embedding 端点未接等
 * 早退降级分支也写一条 audit（degraded=true、无计费 token/cost、retries=0），与限流/重试耗尽降级口径一致。
 *   写失败只被 safeAudit 吞掉(只日志不阻断，审计非计费真源，70 §8.3)。
 */
async function auditDegraded(
  audit: LlmAuditSink,
  opts: LlmCallOptions,
  model: string,
): Promise<void> {
  await safeAudit(audit, {
    ...(opts.ownerUserId ? { ownerUserId: opts.ownerUserId } : {}),
    ...(opts.anonKey ? { anonKey: opts.anonKey } : {}),
    taskClass: opts.taskClass,
    model,
    promptTokens: 0,
    completionTokens: 0,
    costMicros: 0,
    degraded: true,
    retries: 0,
    traceId: opts.traceId,
  });
}

/**
 * 治理执行器：对一次「产出 (text/embedding, usage) 的传输操作」套限流/超时/重试/降级/记账。
 * runOnce 必须在传入的 signal 上挂 abort(超时由本函数控制)；抛错由本函数归一+决定重试/降级。
 */
async function executeGoverned(
  opts: LlmCallOptions,
  deps: Required<Pick<LlmGatewayDeps, 'rateLimiter' | 'audit' | 'clock'>> & {
    model: string;
    backoffBaseMs: number;
    backoffCapMs: number;
  },
  runOnce: (signal: AbortSignal) => Promise<{
    text?: string;
    embedding?: number[];
    promptTokens: number;
    completionTokens: number;
  }>,
): Promise<LlmResult> {
  const { rateLimiter, audit, clock, model } = deps;
  const timeoutMs = LLM_TIMEOUTS_MS[opts.taskClass];
  if (typeof timeoutMs !== 'number') {
    // 守门:新增 taskClass 必须配超时(不静默放行)。
    throw new Error(`no timeout configured for LLM taskClass: ${opts.taskClass}`);
  }

  // ① 限流(预算闸)。命中 → degraded(不抛、不裸 502，脊柱 §10)；记一条 degraded 审计。
  const gate = await rateLimiter.acquire(rateKeyOf(opts));
  if (!gate.allowed) {
    await safeAudit(audit, {
      ...(opts.ownerUserId ? { ownerUserId: opts.ownerUserId } : {}),
      ...(opts.anonKey ? { anonKey: opts.anonKey } : {}),
      taskClass: opts.taskClass,
      model,
      promptTokens: 0,
      completionTokens: 0,
      costMicros: 0,
      degraded: true,
      retries: 0,
      traceId: opts.traceId,
    });
    return degradedResult();
  }

  let retries = 0;
  let lastError: NormalizedLlmError | undefined;

  // ②③ 超时 + 退避重试(≤ LLM_MAX_RETRIES：首次 + 最多 LLM_MAX_RETRIES 次重试)。
  for (let attempt = 0; attempt <= LLM_MAX_RETRIES; attempt++) {
    try {
      const out = await withTimeout((signal) => runOnce(signal), timeoutMs, clock);
      const costMicros = computeCostMicros(model, out.promptTokens, out.completionTokens);
      // ⑤ 成功记账(非计费真源)。
      await safeAudit(audit, {
        ...(opts.ownerUserId ? { ownerUserId: opts.ownerUserId } : {}),
        ...(opts.anonKey ? { anonKey: opts.anonKey } : {}),
        taskClass: opts.taskClass,
        model,
        promptTokens: out.promptTokens,
        completionTokens: out.completionTokens,
        costMicros,
        degraded: false,
        retries,
        traceId: opts.traceId,
      });
      const result: LlmResult = {
        degraded: false,
        usage: {
          promptTokens: out.promptTokens,
          completionTokens: out.completionTokens,
          costMicros,
        },
      };
      if (out.text !== undefined) result.text = out.text;
      if (out.embedding !== undefined) result.embedding = out.embedding;
      return result;
    } catch (err) {
      const norm = normalizeLlmError(err);
      lastError = norm;

      // fatal:不可重试(输入/取消/鉴权)。直接落 degraded 兜底(不抛、不裸 502)+ 记账。
      // 注:对外仍由调用方据内部 code 出 ErrorEnvelope;网关层不抛原始错误(脊柱 §3)。
      if (norm.kind === 'fatal') {
        break;
      }
      // retriable:还有重试额度 → 退避后再试;否则升级 degraded。
      if (attempt < LLM_MAX_RETRIES) {
        retries++;
        const waitMs =
          norm.retryAfterSec !== undefined
            ? norm.retryAfterSec * 1000
            : backoffMs(attempt, {
                baseMs: deps.backoffBaseMs,
                capMs: deps.backoffCapMs,
                jitter01: (clock.now() % 1000) / 1000,
              });
        await clock.sleep(waitMs);
        continue;
      }
      // 重试耗尽且仍 retriable → 升级 degraded(脊柱 §10:上游不稳兜底)。
      break;
    }
  }

  // 走到这:fatal 或重试耗尽。统一降级(不裸 502)+ 记 degraded 审计。
  await safeAudit(audit, {
    ...(opts.ownerUserId ? { ownerUserId: opts.ownerUserId } : {}),
    ...(opts.anonKey ? { anonKey: opts.anonKey } : {}),
    taskClass: opts.taskClass,
    model,
    promptTokens: 0,
    completionTokens: 0,
    costMicros: 0,
    degraded: true,
    retries,
    traceId: opts.traceId,
  });
  // lastError 仅供潜在日志关联(此处不抛、不暴露 code)。
  void lastError;
  return degradedResult();
}

/** 审计落库不抛(非计费真源、漏记不致命)。 */
async function safeAudit(audit: LlmAuditSink, entry: Parameters<LlmAuditSink['record']>[0]) {
  try {
    await audit.record(entry);
  } catch {
    /* 审计失败不阻塞主流程(70 §8.3:非计费真源) */
  }
}

/**
 * 构造统一 LLM 网关(注入 deps)。sdk=null 时全部方法直接 degraded(无 key/上游不可达兜底)。
 * 高层方法骨架:complete/stream/embed —— 真传输/治理在此;具体 prompt 由 3C/3D 实现。
 */
export function makeLlmGateway(deps: LlmGatewayDeps): LlmGatewayPort {
  const resolved = {
    rateLimiter: deps.rateLimiter ?? noopRateLimiter,
    audit: deps.audit ?? noopAuditSink,
    clock: deps.clock ?? realClock,
    model: deps.model ?? DEFAULT_MODEL,
    maxTokens: deps.maxTokens ?? 4096,
    backoffBaseMs: deps.backoffBaseMs ?? 500,
    backoffCapMs: deps.backoffCapMs ?? 8_000,
  };
  const sdk = deps.sdk;

  return {
    async complete(prompt: string, opts: LlmCallOptions): Promise<LlmResult> {
      if (!sdk) {
        // 无 key/SDK 不可达 → degraded 兜底，并落一条 degraded 审计（降级都审计，Codex r5）。
        await auditDegraded(resolved.audit, opts, resolved.model);
        return degradedResult();
      }
      return executeGoverned(opts, resolved, async (signal) => {
        const msg = await sdk.messages.create(
          {
            model: resolved.model,
            max_tokens: resolved.maxTokens,
            messages: [{ role: 'user', content: prompt }],
          },
          { signal },
        );
        return {
          text: extractText(msg),
          promptTokens: msg.usage.input_tokens,
          completionTokens: msg.usage.output_tokens,
        };
      });
    },

    async *stream(prompt: string, opts: LlmCallOptions): AsyncIterable<{ deltaText: string }> {
      // 流式不走 executeGoverned 的「整体重试」(流已开始无法干净重放);
      // 但仍套限流 + 超时建流 + 失败降级:建流失败/超时 → 静默收尾(不裸抛、不裸 502),
      // 由调用方据无产出 + degraded 语义给进度短语 + 退路(结构化字段流 field_delta 上游)。
      if (!sdk) {
        // 无 key/SDK 不可达 → 空流兜底，并落一条 degraded 审计（降级都审计，Codex r5）。
        await auditDegraded(resolved.audit, opts, resolved.model);
        return;
      }
      const timeoutMs = LLM_TIMEOUTS_MS[opts.taskClass];
      if (typeof timeoutMs !== 'number') {
        throw new Error(`no timeout configured for LLM taskClass: ${opts.taskClass}`);
      }
      const gate = await resolved.rateLimiter.acquire(rateKeyOf(opts));
      if (!gate.allowed) {
        await safeAudit(resolved.audit, {
          ...(opts.ownerUserId ? { ownerUserId: opts.ownerUserId } : {}),
          ...(opts.anonKey ? { anonKey: opts.anonKey } : {}),
          taskClass: opts.taskClass,
          model: resolved.model,
          promptTokens: 0,
          completionTokens: 0,
          costMicros: 0,
          degraded: true,
          retries: 0,
          traceId: opts.traceId,
        });
        return;
      }

      let promptTokens = 0;
      let completionTokens = 0;
      let degraded = false;
      const controller = new AbortController();
      // 整流超时:超过分级时长 abort(避免流挂死)。setTimer 与退避 sleep 分离。
      let timedOut = false;
      const cancelTimer = resolved.clock.setTimer(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);

      try {
        const events = await sdk.messages.create(
          {
            model: resolved.model,
            max_tokens: resolved.maxTokens,
            stream: true,
            messages: [{ role: 'user', content: prompt }],
          },
          { signal: controller.signal },
        );
        for await (const ev of events) {
          if (timedOut) {
            degraded = true;
            break;
          }
          if (ev.type === 'message_start') {
            promptTokens = ev.message.usage.input_tokens ?? promptTokens;
          } else if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
            yield { deltaText: ev.delta.text };
          } else if (ev.type === 'message_delta') {
            completionTokens = ev.usage.output_tokens ?? completionTokens;
            // OpenAI 兼容(OpenRouter)流的 prompt usage 落在末帧(非 message_start);
            // 这里兜底从 message_delta.usage 读 input_tokens(Anthropic 该帧无此字段 → undefined,不影响原路径)。
            const deltaInput = (ev.usage as { input_tokens?: number | null }).input_tokens;
            if (typeof deltaInput === 'number') promptTokens = deltaInput;
          }
        }
      } catch {
        // 建流/读流失败 → 降级收尾(不裸抛、不裸 502)。已 yield 的增量不回滚(边生成边显示已落)。
        degraded = true;
      } finally {
        cancelTimer(); // 流正常/失败收尾后清掉超时定时器。
        const costMicros = computeCostMicros(resolved.model, promptTokens, completionTokens);
        await safeAudit(resolved.audit, {
          ...(opts.ownerUserId ? { ownerUserId: opts.ownerUserId } : {}),
          ...(opts.anonKey ? { anonKey: opts.anonKey } : {}),
          taskClass: opts.taskClass,
          model: resolved.model,
          promptTokens,
          completionTokens,
          costMicros,
          degraded,
          retries: 0,
          traceId: opts.traceId,
        });
      }
    },

    async embed(input: string | string[], opts: LlmCallOptions): Promise<LlmResult> {
      // embedding 路由(70 §8.3 行为契约⑥)。真 embedding 端点本期不接(无 key/SDK 0.33 无该端点),
      // 诚实推迟:返回 degraded + 空 embedding,Phase 5/6 接真 embedding 模型路由。
      void input;
      // 降级路径也落审计（降级都审计，Codex r5）：端点未接 = degraded，记一条无计费 token 的 degraded 审计。
      await auditDegraded(resolved.audit, opts, resolved.model);
      return degradedResult({ embedding: [] });
    },
  };
}

/** 从 Message 抽纯文本(忽略非 text block)。 */
function extractText(msg: Anthropic.Message): string {
  return msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

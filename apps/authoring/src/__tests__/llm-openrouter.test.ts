// B-06 · OpenRouter(OpenAI 兼容)provider 单测(mock fetch;无真 key、不打真 OpenRouter)。
// 覆盖:complete 成功+计量(OpenRouter usage→cost)、SSE 流式分块+末帧 usage、重试退避(5xx)、
//   降级(重试耗尽/400 fatal/401 鉴权)、429 retry-after、无 key degraded、provider 选择、
//   错误归一(OpenRouterApiError)、anthropic 路径不回归。
// 真集成(真 sk-or-... key / 真 OpenRouter)诚实推迟 Phase。
import { describe, it, expect, vi } from 'vitest';
import type { LlmCallOptions } from '@cb/shared';
import { LLM_MAX_RETRIES } from '@cb/shared';
import { makeLlmGateway } from '../platform/infra/llm/gateway.js';
import { createMemoryAuditSink } from '../platform/infra/llm/audit.js';
import { createOpenRouterClient, OPENROUTER_DEFAULT_MODEL } from '../platform/infra/llm/openrouter.js';
import { OpenRouterApiError, normalizeOpenRouterError } from '../platform/infra/llm/openrouter-errors.js';
import { resolveLlmProvider } from '../platform/infra/llm/index.js';
import {
  computeCostMicros,
  MODEL_PRICING,
  FALLBACK_PRICING,
  type LlmClock,
  type LlmRateLimiter,
} from '../platform/infra/llm/types.js';
import type { Env } from '../platform/config/env.js';

/** 快进时钟:退避立即 resolve(slept 记 ms);超时用 setTimeout(0)(已 settle 的 fetch 先胜出)。 */
function fakeClock(): LlmClock & { slept: number[] } {
  let t = 0;
  const slept: number[] = [];
  return {
    slept,
    now: () => (t += 1),
    sleep: (ms: number) =>
      new Promise<void>((resolve) => {
        slept.push(ms);
        setTimeout(resolve, 0);
      }),
    setTimer: (cb: () => void) => {
      const handle = setTimeout(cb, 0);
      return () => clearTimeout(handle);
    },
  };
}

/**
 * 流式测试用时钟:sleep 即时(退避不拖慢),但 setTimer 用一个长真延时——
 * 真 ReadableStream 的 reader.read() 排宏任务,与 setTimeout(0) 超时竞争会误触发超时;
 * 这里把超时定时器拉远(测试收尾时被 cancel 清掉),只测「正常流」而非超时路径。
 */
function noTimeoutClock(): LlmClock {
  let t = 0;
  return {
    now: () => (t += 1),
    sleep: () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
    setTimer: (cb: () => void) => {
      const handle = setTimeout(cb, 60_000);
      return () => clearTimeout(handle);
    },
  };
}

const OPTS: LlmCallOptions = {
  taskClass: 'extract',
  traceId: 'trace-or-1',
  ownerUserId: 'user-1',
};

const MODEL = OPENROUTER_DEFAULT_MODEL; // anthropic/claude-sonnet-4.6（OpenRouter 上真实存在的 slug）

/** 造一个 OpenAI 兼容非流式响应(Response 形态,res.ok=true)。 */
function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** 造一个错误响应(非 2xx;text body)。 */
function errorResponse(
  status: number,
  message = 'boom',
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** 造一个 SSE 流式响应:把若干 data: 行拼成 text/event-stream body。 */
function sseResponse(lines: string[]): Response {
  const text = lines.map((l) => `data: ${l}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(text, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

/** 用注入 fetch 建一个 OpenRouter SDK 适配器,接进网关。 */
function gatewayWithFetch(
  fetchImpl: typeof fetch,
  extra?: {
    audit?: ReturnType<typeof createMemoryAuditSink>;
    rateLimiter?: LlmRateLimiter;
    clock?: LlmClock;
  },
) {
  const sdk = createOpenRouterClient({ apiKey: 'sk-or-test', model: MODEL, fetchImpl });
  return makeLlmGateway({
    sdk,
    model: MODEL,
    clock: extra?.clock ?? fakeClock(),
    ...(extra?.audit ? { audit: extra.audit } : {}),
    ...(extra?.rateLimiter ? { rateLimiter: extra.rateLimiter } : {}),
  });
}

describe('OPENROUTER_DEFAULT_MODEL — 必须是 OpenRouter 上真实存在的 slug（非 3.7 死值）', () => {
  // 根因锚：旧默认 'anthropic/claude-3.7-sonnet' 在 OpenRouter /api/v1/models 不存在 →
  //   不设 LLM_MODEL 跑 OpenRouter 会拿不到模型 → 全程 degraded。
  // 反向破坏：把 OPENROUTER_DEFAULT_MODEL 改回 'anthropic/claude-3.7-sonnet'（或任何已知无效值）→
  //   下面三条断言转红。
  const KNOWN_INVALID = 'anthropic/claude-3.7-sonnet';

  it('默认 slug 不是已知无效的 anthropic/claude-3.7-sonnet', () => {
    expect(OPENROUTER_DEFAULT_MODEL).not.toBe(KNOWN_INVALID);
    expect(OPENROUTER_DEFAULT_MODEL).not.toContain('3.7');
  });

  it('默认 slug 与 .env(LLM_MODEL)一致，是 OpenRouter 上实测有效的 Claude Sonnet', () => {
    // 实测 https://openrouter.ai/api/v1/models 存在该 slug；与 .env 的 LLM_MODEL 对齐。
    expect(OPENROUTER_DEFAULT_MODEL).toBe('anthropic/claude-sonnet-4.6');
    // OpenRouter 上的 Claude 模型 slug 形如 anthropic/claude-...（前缀必带 provider）。
    expect(OPENROUTER_DEFAULT_MODEL.startsWith('anthropic/claude-')).toBe(true);
  });

  it('默认模型在计价表里有显式条目（不静默回落 Opus 费率高估成本）', () => {
    const pricing = MODEL_PRICING[OPENROUTER_DEFAULT_MODEL];
    expect(pricing).toBeDefined();
    expect(pricing).not.toBe(FALLBACK_PRICING);
  });
});

describe('OpenRouter.complete — 成功 + 计量记账(OpenRouter usage→cost)', () => {
  it('200 返回 choices[0].message.content + usage → text/usage/cost,落 degraded=false 审计', async () => {
    const audit = createMemoryAuditSink();
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        choices: [{ message: { content: 'hello from openrouter' } }],
        usage: { prompt_tokens: 11, completion_tokens: 22 },
      }),
    ) as unknown as typeof fetch;
    const gw = gatewayWithFetch(fetchImpl, { audit });

    const res = await gw.complete('hi', OPTS);

    expect(res.degraded).toBe(false);
    expect(res.text).toBe('hello from openrouter');
    expect(res.usage.promptTokens).toBe(11);
    expect(res.usage.completionTokens).toBe(22);
    // Sonnet 档 $3/$15 → 11*3 + 22*15 = 363。
    expect(res.usage.costMicros).toBe(computeCostMicros(MODEL, 11, 22));
    expect(res.usage.costMicros).toBe(363);
    expect(audit.records).toHaveLength(1);
    expect(audit.records[0]).toMatchObject({
      degraded: false,
      retries: 0,
      promptTokens: 11,
      completionTokens: 22,
      model: MODEL,
      taskClass: 'extract',
      traceId: 'trace-or-1',
      ownerUserId: 'user-1',
    });
  });

  it('请求打到 {baseUrl}/chat/completions,带 Bearer key + OpenAI 兼容 body', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ choices: [{ message: { content: 'ok' } }], usage: {} }),
      ) as unknown as typeof fetch;
    const gw = gatewayWithFetch(fetchImpl);
    await gw.complete('prompt-text', OPTS);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(init.method).toBe('POST');
    expect(init.headers.authorization).toBe('Bearer sk-or-test');
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe(MODEL);
    expect(body.messages).toEqual([{ role: 'user', content: 'prompt-text' }]);
  });

  it('缺 usage 字段 → token 记 0(不崩),cost=0', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ choices: [{ message: { content: 'x' } }] }),
      ) as unknown as typeof fetch;
    const gw = gatewayWithFetch(fetchImpl);
    const res = await gw.complete('hi', OPTS);
    expect(res.usage.promptTokens).toBe(0);
    expect(res.usage.completionTokens).toBe(0);
    expect(res.usage.costMicros).toBe(0);
  });
});

describe('OpenRouter.complete — 重试 + 退避', () => {
  it('前两次 5xx,第三次成功 → 成功 + retries=2 + sleep 2 次', async () => {
    const clock = fakeClock();
    const audit = createMemoryAuditSink();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(errorResponse(500))
      .mockResolvedValueOnce(errorResponse(503))
      .mockResolvedValueOnce(
        jsonResponse({
          choices: [{ message: { content: 'recovered' } }],
          usage: { prompt_tokens: 1, completion_tokens: 2 },
        }),
      ) as unknown as typeof fetch;
    const sdk = createOpenRouterClient({ apiKey: 'sk-or-test', model: MODEL, fetchImpl });
    const gw = makeLlmGateway({ sdk, model: MODEL, audit, clock });

    const res = await gw.complete('hi', OPTS);

    expect(res.degraded).toBe(false);
    expect(res.text).toBe('recovered');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(clock.slept).toHaveLength(2);
    expect(clock.slept.every((ms) => ms > 0)).toBe(true);
    expect(audit.records.at(-1)).toMatchObject({ degraded: false, retries: 2 });
  });

  it('重试耗尽(全 5xx)→ 升级 degraded(不抛、不裸 502)+ degraded 审计', async () => {
    const clock = fakeClock();
    const audit = createMemoryAuditSink();
    const fetchImpl = vi.fn().mockResolvedValue(errorResponse(500)) as unknown as typeof fetch;
    const sdk = createOpenRouterClient({ apiKey: 'sk-or-test', model: MODEL, fetchImpl });
    const gw = makeLlmGateway({ sdk, model: MODEL, audit, clock });

    const res = await gw.complete('hi', OPTS);

    expect(res.degraded).toBe(true);
    expect(res.text).toBeUndefined();
    expect(res.usage.costMicros).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(LLM_MAX_RETRIES + 1);
    expect(audit.records.at(-1)).toMatchObject({ degraded: true, retries: LLM_MAX_RETRIES });
  });

  it('429 带 retry-after → 用 header 秒数作等待(不走指数退避)', async () => {
    const clock = fakeClock();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(errorResponse(429, 'rate', { 'retry-after': '9' }))
      .mockResolvedValueOnce(
        jsonResponse({ choices: [{ message: { content: 'ok' } }], usage: {} }),
      ) as unknown as typeof fetch;
    const sdk = createOpenRouterClient({ apiKey: 'sk-or-test', model: MODEL, fetchImpl });
    const gw = makeLlmGateway({ sdk, model: MODEL, clock });

    const res = await gw.complete('hi', OPTS);

    expect(res.degraded).toBe(false);
    expect(clock.slept).toEqual([9000]);
  });

  it('网络错误(fetch reject 非 AbortError)→ 归一可重试,耗尽后 degraded', async () => {
    const clock = fakeClock();
    const fetchImpl = vi
      .fn()
      .mockRejectedValue(new TypeError('fetch failed')) as unknown as typeof fetch;
    const sdk = createOpenRouterClient({ apiKey: 'sk-or-test', model: MODEL, fetchImpl });
    const gw = makeLlmGateway({ sdk, model: MODEL, clock });

    const res = await gw.complete('hi', OPTS);
    expect(res.degraded).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(LLM_MAX_RETRIES + 1);
  });
});

describe('OpenRouter.complete — fatal 不重试,直接降级', () => {
  it('400 输入类 → 不重试、degraded、fetch 仅一次', async () => {
    const clock = fakeClock();
    const audit = createMemoryAuditSink();
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(errorResponse(400, 'bad input')) as unknown as typeof fetch;
    const sdk = createOpenRouterClient({ apiKey: 'sk-or-test', model: MODEL, fetchImpl });
    const gw = makeLlmGateway({ sdk, model: MODEL, audit, clock });

    const res = await gw.complete('hi', OPTS);

    expect(res.degraded).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(clock.slept).toHaveLength(0);
    expect(audit.records.at(-1)).toMatchObject({ degraded: true, retries: 0 });
  });

  it('401 鉴权(密钥错)→ fatal 不重试、degraded、fetch 仅一次', async () => {
    const clock = fakeClock();
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(errorResponse(401, 'no auth')) as unknown as typeof fetch;
    const sdk = createOpenRouterClient({ apiKey: 'sk-or-bad', model: MODEL, fetchImpl });
    const gw = makeLlmGateway({ sdk, model: MODEL, clock });

    const res = await gw.complete('hi', OPTS);
    expect(res.degraded).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('OpenRouter.complete — 超时触发的 abort 归一为可重试超时（P1-3，不误判 CLIENT_CANCELLED）', () => {
  // P1-3 根因：OpenRouter fetch 在网关超时 timer 触发 controller.abort() 后抛 AbortError。
  //   该 abort reject 可能在 Promise.race 里先于超时哨兵胜出 → 若原样上抛，normalizeLlmError 会把它
  //   当成「用户主动取消」→ fatal CLIENT_CANCELLED（单次失败、不重试），把一次【超时】误判成取消。
  //   修法（withTimeout 的 timedOut 标志）：超时触发的 abort 统一改抛 LlmTimeoutError → retriable
  //   LLM_UPSTREAM_FAILED → 重试到上限、最终 degraded（而非单次 fatal）。
  // 说明：这两条是【端到端 OpenRouter 路径】的行为锚（超时 → 可重试；真实取消 → 不重试）。
  //   在测试 harness 里超时哨兵几乎总赢 race（abort reject 因 executeGoverned 的 async 包一层而落后），
  //   故 catch 分支的【确定性反向破坏可测】放在 llm-gateway.test.ts 的 `withTimeout` 单测（abort 先于哨兵胜出）。
  //   下方第二条「真实用户取消 → CLIENT_CANCELLED 仅一次」是端到端层真正的反向破坏锚（去掉收口会把它误当超时重试）。

  /** fetch 监听传入 signal：一旦 abort 就 reject AbortError（模拟超时 abort 导致的上游中断）。 */
  function abortOnSignalFetch(): typeof fetch {
    return vi.fn().mockImplementation(
      (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) return; // 无 signal：永挂（不应发生）
          const onAbort = () => {
            const e = new Error('The operation was aborted');
            e.name = 'AbortError';
            reject(e);
          };
          if (signal.aborted) onAbort();
          else signal.addEventListener('abort', onAbort, { once: true });
        }),
    ) as unknown as typeof fetch;
  }

  it('超时 abort → 按 retriable 重试到上限，最终 degraded（非 fatal 单次 CLIENT_CANCELLED）', async () => {
    const clock = fakeClock(); // setTimer 用 setTimeout(0) → 超时立刻触发 abort
    const audit = createMemoryAuditSink();
    const fetchImpl = abortOnSignalFetch();
    const sdk = createOpenRouterClient({ apiKey: 'sk-or-test', model: MODEL, fetchImpl });
    const gw = makeLlmGateway({ sdk, model: MODEL, audit, clock });

    const res = await gw.complete('hi', OPTS);

    expect(res.degraded).toBe(true);
    // 超时（哨兵路径）当作可重试 → 首次 + LLM_MAX_RETRIES 次重试（端到端行为锚，不依赖 catch 分支）。
    expect(fetchImpl).toHaveBeenCalledTimes(LLM_MAX_RETRIES + 1);
    expect(audit.records.at(-1)).toMatchObject({ degraded: true, retries: LLM_MAX_RETRIES });
  });

  it('保留：真实用户取消（非超时触发的 abort）→ fatal CLIENT_CANCELLED（单次、不重试）', async () => {
    // 用一个永不触发的超时 timer（拉远到 60s，测试不会等到），但调用方传入「已 abort 的外部 signal」
    //   不可行（网关不接外部 signal），故直接验「未超时时 AbortError 仍归一为 CLIENT_CANCELLED」：
    //   fetch 立即抛 AbortError，但超时 timer 未触发（timedOut=false）→ normalizeLlmError → CLIENT_CANCELLED fatal。
    const clock = noTimeoutClock(); // setTimer 拉远 60s（本测内不触发）
    const fetchImpl = vi.fn().mockImplementation(() => {
      const e = new Error('user canceled');
      e.name = 'AbortError';
      return Promise.reject(e);
    }) as unknown as typeof fetch;
    const sdk = createOpenRouterClient({ apiKey: 'sk-or-test', model: MODEL, fetchImpl });
    const gw = makeLlmGateway({ sdk, model: MODEL, clock });

    const res = await gw.complete('hi', OPTS);

    expect(res.degraded).toBe(true); // 网关 fatal 也落 degraded 兜底（不裸抛）
    // 真实取消 = fatal CLIENT_CANCELLED → 不重试，fetch 仅 1 次（反向破坏若把所有 abort 都当超时，此处会变 >1）。
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('归一坐实：超时哨兵（LlmTimeoutError）→ retriable，而非 CLIENT_CANCELLED', async () => {
    // 直接验 normalizeLlmError：LlmTimeoutError（name=LlmTimeoutError）不是 AbortError → 不归 CLIENT_CANCELLED，
    //   落到末尾「保守可重试」分支 → retriable LLM_UPSTREAM_FAILED。
    const { normalizeLlmError } = await import('../platform/infra/llm/errors.js');
    const { LlmTimeoutError } = await import('../platform/infra/llm/gateway.js');
    const n = normalizeLlmError(new LlmTimeoutError(1000));
    expect(n.kind).toBe('retriable');
    expect(n.code).toBe('LLM_UPSTREAM_FAILED');
  });
});

describe('OpenRouter.complete — 限流降级', () => {
  it('限流不放行 → 直接 degraded(不调 fetch)+ degraded 审计', async () => {
    const audit = createMemoryAuditSink();
    const limiter: LlmRateLimiter = {
      acquire: async () => ({ allowed: false, retryAfterSec: 30 }),
    };
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const gw = gatewayWithFetch(fetchImpl, { audit, rateLimiter: limiter });

    const res = await gw.complete('hi', OPTS);

    expect(res.degraded).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(audit.records).toHaveLength(1);
    expect(audit.records[0]).toMatchObject({ degraded: true, retries: 0 });
  });
});

describe('OpenRouter.stream — SSE 流式分块 + 末帧 usage 记账', () => {
  it('逐 delta.content 浮现 deltaText,并落计量(末帧 usage)', async () => {
    const audit = createMemoryAuditSink();
    const fetchImpl = vi.fn().mockResolvedValue(
      sseResponse([
        JSON.stringify({ choices: [{ delta: { content: 'Hel' } }] }),
        JSON.stringify({ choices: [{ delta: { content: 'lo' } }] }),
        JSON.stringify({
          choices: [{ delta: {} }],
          usage: { prompt_tokens: 7, completion_tokens: 3 },
        }),
      ]),
    ) as unknown as typeof fetch;
    const gw = gatewayWithFetch(fetchImpl, { audit, clock: noTimeoutClock() });

    const chunks: string[] = [];
    for await (const c of gw.stream('hi', OPTS)) chunks.push(c.deltaText);

    expect(chunks).toEqual(['Hel', 'lo']);
    expect(audit.records).toHaveLength(1);
    expect(audit.records[0]).toMatchObject({
      degraded: false,
      promptTokens: 7,
      completionTokens: 3,
    });
  });

  it('请求体带 stream:true + include_usage', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      sseResponse([
        JSON.stringify({
          choices: [{ delta: { content: 'x' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
      ]),
    ) as unknown as typeof fetch;
    const gw = gatewayWithFetch(fetchImpl, { clock: noTimeoutClock() });
    const chunks: string[] = [];
    for await (const c of gw.stream('hi', OPTS)) chunks.push(c.deltaText);

    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const body = JSON.parse(init.body as string);
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  it('建流抛错(5xx)→ 静默收尾(无产出)+ degraded 审计(不裸抛)', async () => {
    const audit = createMemoryAuditSink();
    const fetchImpl = vi.fn().mockResolvedValue(errorResponse(500)) as unknown as typeof fetch;
    const gw = gatewayWithFetch(fetchImpl, { audit });

    const chunks: string[] = [];
    for await (const c of gw.stream('hi', OPTS)) chunks.push(c.deltaText);

    expect(chunks).toEqual([]);
    expect(audit.records.at(-1)).toMatchObject({ degraded: true });
  });
});

describe('OpenRouter — sdk=null(无 key)兜底', () => {
  it('无 OPENROUTER_API_KEY → resolveLlmProvider 给 sdk=null → complete degraded(不抛)', async () => {
    const env = {
      LLM_PROVIDER: 'openrouter',
      OPENROUTER_API_KEY: '',
      ANTHROPIC_API_KEY: '',
      LLM_BASE_URL: 'https://openrouter.ai/api/v1',
      LLM_MODEL: '',
    } as unknown as Env;
    const { sdk, provider, model } = resolveLlmProvider(env);
    expect(provider).toBe('openrouter');
    expect(sdk).toBeNull();
    expect(model).toBe(OPENROUTER_DEFAULT_MODEL);
    const gw = makeLlmGateway({ sdk, model });
    const res = await gw.complete('hi', OPTS);
    expect(res.degraded).toBe(true);
    expect(res.usage).toEqual({ promptTokens: 0, completionTokens: 0, costMicros: 0 });
  });
});

describe('resolveLlmProvider — provider 选择', () => {
  function env(over: Partial<Record<string, string>>): Env {
    return {
      ANTHROPIC_API_KEY: '',
      OPENROUTER_API_KEY: '',
      LLM_BASE_URL: 'https://openrouter.ai/api/v1',
      LLM_MODEL: '',
      ...over,
    } as unknown as Env;
  }

  it('显式 LLM_PROVIDER=openrouter + key → openrouter sdk 非空', () => {
    const r = resolveLlmProvider(
      env({ LLM_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'sk-or-x' }),
    );
    expect(r.provider).toBe('openrouter');
    expect(r.sdk).not.toBeNull();
    expect(r.model).toBe(OPENROUTER_DEFAULT_MODEL);
  });

  it('显式 LLM_PROVIDER=anthropic + key → anthropic sdk 非空(默认 Opus 模型)', () => {
    const r = resolveLlmProvider(env({ LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-ant-x' }));
    expect(r.provider).toBe('anthropic');
    expect(r.sdk).not.toBeNull();
    expect(r.model).toBe('claude-opus-4-8');
  });

  it('未设 provider:有 OPENROUTER key 而无 ANTHROPIC key → 自动 openrouter', () => {
    const r = resolveLlmProvider(env({ OPENROUTER_API_KEY: 'sk-or-x' }));
    expect(r.provider).toBe('openrouter');
    expect(r.sdk).not.toBeNull();
  });

  it('未设 provider:有 ANTHROPIC key → 自动 anthropic(原默认路径)', () => {
    const r = resolveLlmProvider(env({ ANTHROPIC_API_KEY: 'sk-ant-x' }));
    expect(r.provider).toBe('anthropic');
    expect(r.sdk).not.toBeNull();
  });

  it('未设 provider:两 key 都在 → 偏向 anthropic(原路径默认)', () => {
    const r = resolveLlmProvider(
      env({ ANTHROPIC_API_KEY: 'sk-ant-x', OPENROUTER_API_KEY: 'sk-or-x' }),
    );
    expect(r.provider).toBe('anthropic');
  });

  it('LLM_MODEL 覆盖 provider 默认模型', () => {
    const r = resolveLlmProvider(
      env({
        LLM_PROVIDER: 'openrouter',
        OPENROUTER_API_KEY: 'sk-or-x',
        LLM_MODEL: 'anthropic/claude-3.5-sonnet',
      }),
    );
    expect(r.model).toBe('anthropic/claude-3.5-sonnet');
  });
});

describe('normalizeOpenRouterError — 错误归一(与 Anthropic 同口径)', () => {
  function err(status: number | undefined, headers?: Record<string, string>) {
    return new OpenRouterApiError(status, headers ? new Headers(headers) : undefined, 'boom');
  }
  it('429 → retriable + retryAfterSec(读 header)', () => {
    const n = normalizeOpenRouterError(err(429, { 'retry-after': '5' }))!;
    expect(n.kind).toBe('retriable');
    expect(n.code).toBe('RATE_LIMITED');
    expect(n.retryAfterSec).toBe(5);
  });
  it('500 → retriable + LLM_UPSTREAM_FAILED', () => {
    const n = normalizeOpenRouterError(err(500))!;
    expect(n.kind).toBe('retriable');
    expect(n.code).toBe('LLM_UPSTREAM_FAILED');
  });
  it('400 → fatal + VALIDATION_FAILED', () => {
    const n = normalizeOpenRouterError(err(400))!;
    expect(n.kind).toBe('fatal');
    expect(n.code).toBe('VALIDATION_FAILED');
  });
  it('401 鉴权 → fatal + INTERNAL(不暴露密钥语义)', () => {
    const n = normalizeOpenRouterError(err(401))!;
    expect(n.kind).toBe('fatal');
    expect(n.code).toBe('INTERNAL');
  });
  it('status=undefined(网络/连接)→ retriable + LLM_UPSTREAM_FAILED', () => {
    const n = normalizeOpenRouterError(err(undefined))!;
    expect(n.kind).toBe('retriable');
    expect(n.code).toBe('LLM_UPSTREAM_FAILED');
  });
  it('非 OpenRouterApiError → undefined(交回 Anthropic 归一链)', () => {
    expect(normalizeOpenRouterError(new Error('plain'))).toBeUndefined();
  });
});

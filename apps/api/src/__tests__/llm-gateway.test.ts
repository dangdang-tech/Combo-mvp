// B-06 · 统一 LLM 网关单测(mock SDK/网络/时钟/限流/审计;无真 key、不打真 API)。
// 覆盖:限流降级、重试+退避、降级路径(fatal/重试耗尽)、流式分块、计量记账、超时、错误归一。
// 真集成(真 Anthropic key/真上游)诚实推迟 Phase 5/6。
import { describe, it, expect, vi } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import type { LlmCallOptions } from '@cb/shared';
import { LLM_MAX_RETRIES } from '@cb/shared';
import {
  makeLlmGateway,
  withTimeout,
  isAbortError,
  LlmTimeoutError,
  type LlmSdkClient,
} from '../infra/llm/gateway.js';
import { createMemoryAuditSink, noopAuditSink } from '../infra/llm/audit.js';
import { createTokenBucketLimiter, noopRateLimiter } from '../infra/llm/limiter.js';
import { normalizeLlmError, backoffMs } from '../infra/llm/errors.js';
import { computeCostMicros, type LlmClock, type LlmRateLimiter } from '../infra/llm/types.js';

/**
 * 快进时钟:
 *   - sleep(退避)记 ms 并只让出一个宏任务(测试不被退避拖慢);slept 只反映退避。
 *   - setTimer(超时)用真 setTimeout(0):只在微任务队列排空后才触发。
 *     这样已 settle 的 create(微任务)会先于超时(宏任务)在 race 里胜出;
 *     而真正永挂的 create 仍会被超时触发 abort —— 可同时测「成功不超时」与「永挂超时」。
 */
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
    setTimer: (cb: () => void, _ms: number) => {
      const handle = setTimeout(cb, 0);
      return () => clearTimeout(handle);
    },
  };
}

const OPTS: LlmCallOptions = {
  taskClass: 'extract',
  traceId: 'trace-llm-1',
  ownerUserId: 'user-1',
};

/** 构造一个最小 Message(满足 SDK 形态:content + usage)。 */
function fakeMessage(text: string, inTok: number, outTok: number): Anthropic.Message {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-4-8',
    stop_reason: 'end_turn',
    stop_sequence: null,
    content: [{ type: 'text', text } as Anthropic.TextBlock],
    usage: {
      input_tokens: inTok,
      output_tokens: outTok,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
    },
  } as Anthropic.Message;
}

// Anthropic 风格错误工厂(供归一/重试测试)。用 APIError.generate(SDK 内部工厂)按 status
// 产出正确子类实例(429→RateLimitError, 400→BadRequestError, 500→InternalServerError),
// headers 为普通对象(与 SDK 0.33.x 一致:APIError.headers 是 Record,非 Headers 实例)。
function apiError(status: number, message: string, headers: Record<string, string> = {}) {
  // 注:generate 要求 headers 真值,否则回落 APIConnectionError(故传空对象而非 undefined)。
  // 返回类型由推断给出(APIError 子类实例),不显式标注(Anthropic.APIError 是值非类型)。
  return Anthropic.APIError.generate(status, { error: { message } }, message, headers);
}
function rateLimitError(retryAfter?: string) {
  return apiError(429, 'rate', retryAfter ? { 'retry-after': retryAfter } : {});
}
function serverError() {
  return apiError(500, 'boom');
}
function badRequest() {
  return apiError(400, 'bad');
}

describe('makeLlmGateway.complete — 成功 + 计量记账', () => {
  it('成功返回 text + usage,并落一条 degraded=false 审计', async () => {
    const audit = createMemoryAuditSink();
    const create = vi.fn().mockResolvedValue(fakeMessage('hello world', 10, 20));
    const sdk = { messages: { create } } as unknown as LlmSdkClient;
    const gw = makeLlmGateway({ sdk, audit, clock: fakeClock() });

    const res = await gw.complete('hi', OPTS);

    expect(res.degraded).toBe(false);
    expect(res.text).toBe('hello world');
    expect(res.usage.promptTokens).toBe(10);
    expect(res.usage.completionTokens).toBe(20);
    // 成本审计(非计费真源):Opus 4.8 $5/$25 → 10*5 + 20*25 = 550 microUSD。
    expect(res.usage.costMicros).toBe(computeCostMicros('claude-opus-4-8', 10, 20));
    expect(res.usage.costMicros).toBe(550);
    expect(audit.records).toHaveLength(1);
    expect(audit.records[0]).toMatchObject({
      degraded: false,
      retries: 0,
      promptTokens: 10,
      completionTokens: 20,
      taskClass: 'extract',
      traceId: 'trace-llm-1',
      ownerUserId: 'user-1',
    });
  });

  it('多 text block 拼接,非 text block 忽略', async () => {
    const msg = fakeMessage('', 1, 1);
    msg.content = [
      { type: 'text', text: 'foo ' } as Anthropic.TextBlock,
      { type: 'tool_use', id: 't', name: 'x', input: {} } as unknown as Anthropic.TextBlock,
      { type: 'text', text: 'bar' } as Anthropic.TextBlock,
    ];
    const create = vi.fn().mockResolvedValue(msg);
    const sdk = { messages: { create } } as unknown as LlmSdkClient;
    const gw = makeLlmGateway({ sdk, clock: fakeClock() });
    const res = await gw.complete('hi', OPTS);
    expect(res.text).toBe('foo bar');
  });
});

describe('makeLlmGateway.complete — 重试 + 退避(≤ LLM_MAX_RETRIES)', () => {
  it('前两次 5xx,第三次成功 → 成功 + retries=2 + sleep 调用 2 次', async () => {
    const clock = fakeClock();
    const audit = createMemoryAuditSink();
    const create = vi
      .fn()
      .mockRejectedValueOnce(serverError())
      .mockRejectedValueOnce(serverError())
      .mockResolvedValueOnce(fakeMessage('ok', 3, 4));
    const sdk = { messages: { create } } as unknown as LlmSdkClient;
    const gw = makeLlmGateway({ sdk, audit, clock });

    const res = await gw.complete('hi', OPTS);

    expect(res.degraded).toBe(false);
    expect(res.text).toBe('ok');
    expect(create).toHaveBeenCalledTimes(3); // 首次 + 2 重试
    expect(clock.slept).toHaveLength(2); // 退避 2 次
    expect(clock.slept.every((ms) => ms > 0)).toBe(true);
    expect(audit.records.at(-1)).toMatchObject({ degraded: false, retries: 2 });
  });

  it('重试耗尽(全 5xx)→ 升级 degraded(不抛、不裸 502)+ 记 degraded 审计', async () => {
    const clock = fakeClock();
    const audit = createMemoryAuditSink();
    const create = vi.fn().mockRejectedValue(serverError());
    const sdk = { messages: { create } } as unknown as LlmSdkClient;
    const gw = makeLlmGateway({ sdk, audit, clock });

    const res = await gw.complete('hi', OPTS);

    expect(res.degraded).toBe(true);
    expect(res.text).toBeUndefined();
    expect(res.usage.costMicros).toBe(0);
    // 首次 + LLM_MAX_RETRIES 次重试 = LLM_MAX_RETRIES+1 次调用。
    expect(create).toHaveBeenCalledTimes(LLM_MAX_RETRIES + 1);
    expect(clock.slept).toHaveLength(LLM_MAX_RETRIES);
    expect(audit.records.at(-1)).toMatchObject({ degraded: true, retries: LLM_MAX_RETRIES });
  });

  it('429 带 retry-after → 用 header 秒数作等待(不走指数退避)', async () => {
    const clock = fakeClock();
    const create = vi
      .fn()
      .mockRejectedValueOnce(rateLimitError('7'))
      .mockResolvedValueOnce(fakeMessage('ok', 1, 1));
    const sdk = { messages: { create } } as unknown as LlmSdkClient;
    const gw = makeLlmGateway({ sdk, clock });

    const res = await gw.complete('hi', OPTS);

    expect(res.degraded).toBe(false);
    expect(clock.slept).toEqual([7000]); // retry-after=7s → 7000ms
  });
});

describe('makeLlmGateway.complete — fatal 不重试,直接降级', () => {
  it('400 BadRequest(输入类)→ 不重试、degraded、create 仅调一次', async () => {
    const clock = fakeClock();
    const audit = createMemoryAuditSink();
    const create = vi.fn().mockRejectedValue(badRequest());
    const sdk = { messages: { create } } as unknown as LlmSdkClient;
    const gw = makeLlmGateway({ sdk, audit, clock });

    const res = await gw.complete('hi', OPTS);

    expect(res.degraded).toBe(true);
    expect(create).toHaveBeenCalledTimes(1); // fatal 不重试
    expect(clock.slept).toHaveLength(0);
    expect(audit.records.at(-1)).toMatchObject({ degraded: true, retries: 0 });
  });
});

describe('makeLlmGateway.complete — 限流降级', () => {
  it('限流不放行 → 直接 degraded(不调 SDK)+ 记 degraded 审计', async () => {
    const audit = createMemoryAuditSink();
    const limiter: LlmRateLimiter = {
      acquire: async () => ({ allowed: false, retryAfterSec: 30 }),
    };
    const create = vi.fn();
    const sdk = { messages: { create } } as unknown as LlmSdkClient;
    const gw = makeLlmGateway({ sdk, audit, rateLimiter: limiter, clock: fakeClock() });

    const res = await gw.complete('hi', OPTS);

    expect(res.degraded).toBe(true);
    expect(create).not.toHaveBeenCalled();
    expect(audit.records).toHaveLength(1);
    expect(audit.records[0]).toMatchObject({ degraded: true, retries: 0 });
  });

  it('令牌桶:容量耗尽后命中限流(同一 key 连续取)', async () => {
    const clock = fakeClock();
    const limiter = createTokenBucketLimiter({ ratePerWindow: 2, windowMs: 60_000, clock });
    const a = await limiter.acquire('k');
    const b = await limiter.acquire('k');
    const c = await limiter.acquire('k');
    expect(a.allowed).toBe(true);
    expect(b.allowed).toBe(true);
    expect(c.allowed).toBe(false);
    expect(c.retryAfterSec).toBeGreaterThanOrEqual(1);
  });
});

describe('makeLlmGateway.complete — 超时', () => {
  it('上游永不 resolve → 超时哨兵被归一为可重试,耗尽后 degraded', async () => {
    // create 返回永挂 Promise;fakeClock.sleep 立即 resolve → 超时哨兵立刻触发。
    const clock = fakeClock();
    const create = vi
      .fn()
      .mockImplementation(
        (_body: unknown, _opts: { signal?: AbortSignal }) => new Promise(() => {}),
      );
    const sdk = { messages: { create } } as unknown as LlmSdkClient;
    const gw = makeLlmGateway({ sdk, clock });

    const res = await gw.complete('hi', OPTS);

    expect(res.degraded).toBe(true);
    // 超时按可重试处理:首次 + LLM_MAX_RETRIES 次重试。
    expect(create).toHaveBeenCalledTimes(LLM_MAX_RETRIES + 1);
  });

  it('超时会 abort 传给 SDK 的 signal', async () => {
    const clock = fakeClock();
    let captured: AbortSignal | undefined;
    const create = vi.fn().mockImplementation(
      (_body: unknown, o: { signal?: AbortSignal }) =>
        new Promise(() => {
          captured = o.signal;
        }),
    );
    const sdk = { messages: { create } } as unknown as LlmSdkClient;
    const gw = makeLlmGateway({ sdk, clock });

    await gw.complete('hi', OPTS);
    expect(captured).toBeDefined();
    expect(captured!.aborted).toBe(true);
  });
});

describe('makeLlmGateway.stream — 流式分块 + 记账', () => {
  /** 造一个发 message_start / 两个 text_delta / message_delta 的异步流。 */
  async function* fakeStream(): AsyncIterable<Anthropic.RawMessageStreamEvent> {
    yield {
      type: 'message_start',
      message: { usage: { input_tokens: 12 } },
    } as unknown as Anthropic.RawMessageStreamEvent;
    yield {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'Hel' },
    } as Anthropic.RawMessageStreamEvent;
    yield {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'lo' },
    } as Anthropic.RawMessageStreamEvent;
    yield {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: 5 },
    } as unknown as Anthropic.RawMessageStreamEvent;
  }

  it('逐 text_delta 浮现 deltaText,并落计量(degraded=false)', async () => {
    const audit = createMemoryAuditSink();
    const create = vi.fn().mockResolvedValue(fakeStream());
    const sdk = { messages: { create } } as unknown as LlmSdkClient;
    const gw = makeLlmGateway({ sdk, audit, clock: fakeClock() });

    const chunks: string[] = [];
    for await (const c of gw.stream('hi', OPTS)) chunks.push(c.deltaText);

    expect(chunks).toEqual(['Hel', 'lo']);
    expect(audit.records).toHaveLength(1);
    expect(audit.records[0]).toMatchObject({
      degraded: false,
      promptTokens: 12,
      completionTokens: 5,
    });
  });

  it('建流抛错 → 静默收尾(无产出)+ 记 degraded 审计(不裸抛)', async () => {
    const audit = createMemoryAuditSink();
    const create = vi.fn().mockRejectedValue(serverError());
    const sdk = { messages: { create } } as unknown as LlmSdkClient;
    const gw = makeLlmGateway({ sdk, audit, clock: fakeClock() });

    const chunks: string[] = [];
    for await (const c of gw.stream('hi', OPTS)) chunks.push(c.deltaText);

    expect(chunks).toEqual([]);
    expect(audit.records.at(-1)).toMatchObject({ degraded: true });
  });

  it('限流不放行 → 流无产出 + degraded 审计,不调 SDK', async () => {
    const audit = createMemoryAuditSink();
    const limiter: LlmRateLimiter = { acquire: async () => ({ allowed: false }) };
    const create = vi.fn();
    const sdk = { messages: { create } } as unknown as LlmSdkClient;
    const gw = makeLlmGateway({ sdk, audit, rateLimiter: limiter, clock: fakeClock() });

    const chunks: string[] = [];
    for await (const c of gw.stream('hi', OPTS)) chunks.push(c.deltaText);

    expect(chunks).toEqual([]);
    expect(create).not.toHaveBeenCalled();
    expect(audit.records[0]).toMatchObject({ degraded: true });
  });
});

describe('makeLlmGateway — sdk=null(无 key)兜底', () => {
  it('complete → degraded、空 usage,不抛', async () => {
    const gw = makeLlmGateway({ sdk: null });
    const res = await gw.complete('hi', OPTS);
    expect(res.degraded).toBe(true);
    expect(res.usage).toEqual({ promptTokens: 0, completionTokens: 0, costMicros: 0 });
  });

  it('stream → 空流(无产出),不抛', async () => {
    const gw = makeLlmGateway({ sdk: null });
    const chunks: string[] = [];
    for await (const c of gw.stream('hi', OPTS)) chunks.push(c.deltaText);
    expect(chunks).toEqual([]);
  });

  it('embed → degraded + 空 embedding(诚实推迟真 embedding 端点)', async () => {
    const gw = makeLlmGateway({ sdk: null });
    const res = await gw.embed('hi', OPTS);
    expect(res.degraded).toBe(true);
    expect(res.embedding).toEqual([]);
  });
});

describe('makeLlmGateway — 降级都审计(Codex r5 非阻塞②)：无 key/端点未接 也落 degraded 审计', () => {
  it('sdk=null complete → 落一条 degraded 审计(无计费 token、retries=0)', async () => {
    const audit = createMemoryAuditSink();
    const gw = makeLlmGateway({ sdk: null, audit });
    const res = await gw.complete('hi', OPTS);
    expect(res.degraded).toBe(true);
    expect(audit.records).toHaveLength(1);
    expect(audit.records[0]).toMatchObject({
      degraded: true,
      retries: 0,
      promptTokens: 0,
      completionTokens: 0,
      costMicros: 0,
      taskClass: 'extract',
      traceId: 'trace-llm-1',
      ownerUserId: 'user-1',
    });
  });

  it('sdk=null stream → 空流但落 degraded 审计', async () => {
    const audit = createMemoryAuditSink();
    const gw = makeLlmGateway({ sdk: null, audit });
    const chunks: string[] = [];
    for await (const c of gw.stream('hi', OPTS)) chunks.push(c.deltaText);
    expect(chunks).toEqual([]);
    expect(audit.records).toHaveLength(1);
    expect(audit.records[0]).toMatchObject({ degraded: true, retries: 0, costMicros: 0 });
  });

  it('embed(端点未接)→ degraded 审计(诚实推迟也审计)', async () => {
    const audit = createMemoryAuditSink();
    const gw = makeLlmGateway({ sdk: null, audit });
    const res = await gw.embed('hi', OPTS);
    expect(res.degraded).toBe(true);
    expect(audit.records).toHaveLength(1);
    expect(audit.records[0]).toMatchObject({ degraded: true, costMicros: 0 });
  });

  it('降级审计写失败只吞掉、不阻断主流程(返回 degraded 结果)', async () => {
    const throwingSink = {
      record: () => {
        throw new Error('audit db down');
      },
    };
    const gw = makeLlmGateway({ sdk: null, audit: throwingSink });
    const res = await gw.complete('hi', OPTS); // 审计抛错不应冒泡
    expect(res.degraded).toBe(true);
  });
});

describe('makeLlmGateway — taskClass 守门', () => {
  it('未配超时档的 taskClass → complete 抛(守门:新增 taskClass 必须配超时)', async () => {
    const sdk = { messages: { create: vi.fn() } } as unknown as LlmSdkClient;
    const gw = makeLlmGateway({ sdk, clock: fakeClock() });
    await expect(
      gw.complete('hi', { taskClass: 'bogus' as LlmCallOptions['taskClass'], traceId: 't' }),
    ).rejects.toThrow(/no timeout configured/);
  });
});

describe('makeLlmGateway — embed(诚实推迟)', () => {
  it('有 sdk 时 embed 仍返 degraded + 空 embedding(端点未接)', async () => {
    const create = vi.fn();
    const sdk = { messages: { create } } as unknown as LlmSdkClient;
    const gw = makeLlmGateway({ sdk, clock: fakeClock() });
    const res = await gw.embed(['a', 'b'], OPTS);
    expect(res.degraded).toBe(true);
    expect(res.embedding).toEqual([]);
    expect(create).not.toHaveBeenCalled(); // 未路由到 messages 端点
  });
});

describe('normalizeLlmError — 错误归一', () => {
  it('429 → retriable + retryAfterSec', () => {
    const n = normalizeLlmError(rateLimitError('5'));
    expect(n.kind).toBe('retriable');
    expect(n.retryAfterSec).toBe(5);
  });
  it('500 → retriable', () => {
    expect(normalizeLlmError(serverError()).kind).toBe('retriable');
  });
  it('400 → fatal', () => {
    expect(normalizeLlmError(badRequest()).kind).toBe('fatal');
  });
  it('401 鉴权 → fatal(内部 INTERNAL)', () => {
    // generate(401) 产 AuthenticationError 实例。
    const n = normalizeLlmError(apiError(401, 'noauth'));
    expect(n.kind).toBe('fatal');
    expect(n.code).toBe('INTERNAL');
  });
  it('用户取消(abort)→ fatal + CLIENT_CANCELLED', () => {
    const e = new Anthropic.APIUserAbortError();
    const n = normalizeLlmError(e);
    expect(n.kind).toBe('fatal');
    expect(n.code).toBe('CLIENT_CANCELLED');
  });
  it('连接超时 → retriable', () => {
    const e = new Anthropic.APIConnectionTimeoutError({ message: 'timeout' });
    expect(normalizeLlmError(e).kind).toBe('retriable');
  });
  it('非 SDK 异常(普通 Error)→ 保守可重试', () => {
    expect(normalizeLlmError(new Error('weird')).kind).toBe('retriable');
  });
  it('归一只产内部 code + internalMessage,不暴露对外文案', () => {
    const n = normalizeLlmError(serverError());
    expect(n.internalMessage).toContain('boom');
    expect(n.code).toBe('LLM_UPSTREAM_FAILED');
  });
});

describe('backoffMs — 指数退避 + 满抖动', () => {
  it('随 attempt 递增(同 jitter 下)且不超过 cap', () => {
    const a0 = backoffMs(0, { baseMs: 100, capMs: 10_000, jitter01: 1 });
    const a1 = backoffMs(1, { baseMs: 100, capMs: 10_000, jitter01: 1 });
    const a2 = backoffMs(2, { baseMs: 100, capMs: 10_000, jitter01: 1 });
    expect(a1).toBeGreaterThan(a0);
    expect(a2).toBeGreaterThan(a1);
  });
  it('封顶 cap(高 attempt 不无限增长)', () => {
    const big = backoffMs(20, { baseMs: 100, capMs: 1_000, jitter01: 1 });
    expect(big).toBeLessThanOrEqual(1_000);
  });
  it('满抖动:始终 > 0(半固定底)', () => {
    const v = backoffMs(0, { baseMs: 100, capMs: 1_000, jitter01: 0 });
    expect(v).toBeGreaterThan(0);
  });
});

describe('computeCostMicros — 成本估算', () => {
  it('已知模型按费率算', () => {
    // Sonnet 4.6 $3/$15:100*3 + 50*15 = 1050。
    expect(computeCostMicros('claude-sonnet-4-6', 100, 50)).toBe(1050);
  });
  it('未知模型回落 Opus 档(宁高勿低)', () => {
    expect(computeCostMicros('unknown-model', 10, 0)).toBe(
      computeCostMicros('claude-opus-4-8', 10, 0),
    );
  });
  it('零 token → 0', () => {
    expect(computeCostMicros('claude-opus-4-8', 0, 0)).toBe(0);
  });
});

describe('audit/limiter 默认兜底', () => {
  it('noopAuditSink.record 不抛', () => {
    expect(() => noopAuditSink.record({} as never)).not.toThrow();
  });
  it('noopRateLimiter 永远放行', async () => {
    expect(await noopRateLimiter.acquire('k')).toEqual({ allowed: true });
  });
});

// P1-3：超时触发的 abort 不可误判为 CLIENT_CANCELLED。直接对 withTimeout 单测「abort 先于哨兵胜出」
//   的分支（测试 harness 里端到端几乎总是哨兵赢 race，难稳定触发该分支，故在 withTimeout 层确定性反向破坏可测）。
describe('withTimeout — 超时触发的 abort 归一为超时(P1-3，不误判 CLIENT_CANCELLED)', () => {
  /** setTimer 同步触发(立即 abort + resolve sentinel);sleep/now 不参与本测。 */
  function immediateTimerClock(): LlmClock {
    return {
      now: () => 0,
      sleep: () => Promise.resolve(),
      setTimer: (cb: () => void) => {
        cb(); // 立即触发超时：同步 abort 上游 + 置 timedOut + resolve sentinel。
        return () => undefined;
      },
    };
  }

  it('timer 触发后 factory 才以 AbortError reject → 抛 LlmTimeoutError(非 AbortError)', async () => {
    // factory 监听 signal：超时 timer 同步 abort 后,它【同步】reject AbortError。
    //   该 abort reject(注册在 race 第一个 promise 上)先于 sentinel reaction 胜出 → 命中 catch 分支。
    //   反向破坏：去掉 gateway.ts catch 里 `if (timedOut && isAbortError(err)) throw LlmTimeoutError`
    //     → 抛出的会是 AbortError(name='AbortError')而非 LlmTimeoutError → 下面两条断言转红。
    const clock = immediateTimerClock();
    const factory = (signal: AbortSignal) =>
      new Promise<string>((_resolve, reject) => {
        const onAbort = () => {
          const e = new Error('aborted by gateway timeout');
          e.name = 'AbortError';
          reject(e);
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      });

    const err = await withTimeout(factory, 1000, clock).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(LlmTimeoutError); // ← 反向破坏此处转红(会是 AbortError)
    expect((err as Error).name).toBe('LlmTimeoutError');
    // 归一坐实：LlmTimeoutError → retriable(会重试),AbortError → fatal CLIENT_CANCELLED(不重试)。
    const norm = normalizeLlmError(err);
    expect(norm.kind).toBe('retriable');
    expect(norm.code).toBe('LLM_UPSTREAM_FAILED');
  });

  it('保留：未超时(timedOut=false)时 factory 主动以 AbortError reject → 原样上抛 → CLIENT_CANCELLED', async () => {
    // 真实用户取消(非网关超时触发)：timer 从不触发(setTimer 不调 cb)→ timedOut 恒 false。
    //   factory 立即以 AbortError reject → withTimeout 原样上抛 → normalizeLlmError 归 CLIENT_CANCELLED(fatal)。
    //   反向破坏若把「所有 abort 都当超时」,本条会从 CLIENT_CANCELLED 变 LLM_UPSTREAM_FAILED → 转红。
    const neverTimerClock: LlmClock = {
      now: () => 0,
      sleep: () => Promise.resolve(),
      setTimer: () => () => undefined, // 不触发超时
    };
    const factory = () =>
      Promise.reject(Object.assign(new Error('user canceled'), { name: 'AbortError' }) as Error);

    const err = await withTimeout(factory, 1000, neverTimerClock).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect((err as Error).name).toBe('AbortError'); // 非超时触发 → 原样上抛
    const norm = normalizeLlmError(err);
    expect(norm.kind).toBe('fatal');
    expect(norm.code).toBe('CLIENT_CANCELLED');
  });

  it('isAbortError 识别 Anthropic.APIUserAbortError 与全局 fetch AbortError', () => {
    expect(isAbortError(new Anthropic.APIUserAbortError())).toBe(true);
    expect(isAbortError(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe(true);
    expect(isAbortError(new Error('plain'))).toBe(false);
    expect(isAbortError(new LlmTimeoutError(1))).toBe(false); // 超时哨兵不是 abort
  });
});

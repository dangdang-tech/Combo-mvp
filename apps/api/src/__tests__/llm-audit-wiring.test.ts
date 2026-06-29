// B-06 · P1-6 修复单测:LLM 生产装配把 PG audit_llm_calls sink 接进网关。
// 验证「成功与降级都落审计、写审计失败只日志不阻断主调用」(70 §8.3:审计非计费真源)。
// 用 mock db(QueryableDb)+ mock SDK,无真 PG/无真 key/不打真 API。
// 真集成(真 PG/真上游)诚实推迟 Phase 5/6。
import { describe, it, expect, vi } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import type { LlmCallOptions } from '@cb/shared';
import { LLM_MAX_RETRIES } from '@cb/shared';
import { makeLlmGateway, type LlmSdkClient } from '../infra/llm/gateway.js';
import { createPgAuditSink, type QueryableDb } from '../infra/llm/audit.js';
import { createLlmGateway } from '../infra/llm/index.js';
import type { Env } from '../config/env.js';
import type { LlmClock } from '../infra/llm/types.js';

/** 快进时钟:退避立即 resolve,超时用 setTimeout(0)(已 settle 的 create 先胜出)。 */
function fakeClock(): LlmClock {
  let t = 0;
  return {
    now: () => (t += 1),
    sleep: () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
    setTimer: (cb: () => void) => {
      const handle = setTimeout(cb, 0);
      return () => clearTimeout(handle);
    },
  };
}

const OPTS: LlmCallOptions = {
  taskClass: 'extract',
  traceId: 'trace-audit-1',
  ownerUserId: 'user-1',
};

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

function serverError() {
  return Anthropic.APIError.generate(500, { error: { message: 'boom' } }, 'boom', {});
}

/** 一个总是成功记录 INSERT 的 mock db(QueryableDb 结构形态)。 */
function okDb(): QueryableDb & { calls: Array<{ sql: string; params?: unknown[] }> } {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  return {
    calls,
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params });
      return { rows: [] };
    },
  };
}

describe('P1-6 · PG 审计 sink 接进网关(makeLlmGateway + createPgAuditSink)', () => {
  it('成功调用 → 经 PG sink 写一条 degraded=false 审计到 db.query', async () => {
    const db = okDb();
    const audit = createPgAuditSink(db);
    const create = vi.fn().mockResolvedValue(fakeMessage('hi', 10, 20));
    const sdk = { messages: { create } } as unknown as LlmSdkClient;
    const gw = makeLlmGateway({ sdk, audit, clock: fakeClock() });

    const res = await gw.complete('hi', OPTS);

    expect(res.degraded).toBe(false);
    expect(db.calls).toHaveLength(1);
    expect(db.calls[0]!.sql).toContain('INSERT INTO audit_llm_calls');
    // 参数顺序:owner, anon, taskClass, model, promptTok, completionTok, cost, degraded, retries, traceId。
    const p = db.calls[0]!.params!;
    expect(p[0]).toBe('user-1'); // owner_user_id
    expect(p[2]).toBe('extract'); // task_class
    expect(p[4]).toBe(10); // prompt_tokens
    expect(p[5]).toBe(20); // completion_tokens
    expect(p[7]).toBe(false); // degraded
  });

  it('降级调用(重试耗尽 5xx)→ 经 PG sink 写 degraded=true 审计到 db.query', async () => {
    const db = okDb();
    const audit = createPgAuditSink(db);
    const create = vi.fn().mockRejectedValue(serverError());
    const sdk = { messages: { create } } as unknown as LlmSdkClient;
    const gw = makeLlmGateway({ sdk, audit, clock: fakeClock() });

    const res = await gw.complete('hi', OPTS);

    expect(res.degraded).toBe(true);
    // 末条审计应为 degraded=true、retries=LLM_MAX_RETRIES。
    const last = db.calls.at(-1)!;
    expect(last.sql).toContain('INSERT INTO audit_llm_calls');
    expect(last.params![7]).toBe(true); // degraded
    expect(last.params![8]).toBe(LLM_MAX_RETRIES); // retries
  });

  it('写审计失败(db.query 抛)→ 只触发 onError 日志,不抛、不阻断主调用', async () => {
    const onError = vi.fn();
    const failingDb: QueryableDb = {
      async query() {
        throw new Error('pg down');
      },
    };
    const audit = createPgAuditSink(failingDb, onError);
    const create = vi.fn().mockResolvedValue(fakeMessage('ok', 5, 6));
    const sdk = { messages: { create } } as unknown as LlmSdkClient;
    const gw = makeLlmGateway({ sdk, audit, clock: fakeClock() });

    // 审计写失败不应让主调用抛——complete 正常返回成功结果。
    const res = await gw.complete('hi', OPTS);

    expect(res.degraded).toBe(false);
    expect(res.text).toBe('ok');
    expect(res.usage.promptTokens).toBe(5);
    expect(res.usage.completionTokens).toBe(6);
    // onError 收到落库失败(只日志,不阻断)。
    expect(onError).toHaveBeenCalledTimes(1);
    expect(String(onError.mock.calls[0]![0])).toContain('pg down');
  });

  it('降级路径写审计失败 → 仍只日志不阻断,主调用返回 degraded', async () => {
    const onError = vi.fn();
    const failingDb: QueryableDb = {
      async query() {
        throw new Error('pg down on degraded');
      },
    };
    const audit = createPgAuditSink(failingDb, onError);
    const create = vi.fn().mockRejectedValue(serverError());
    const sdk = { messages: { create } } as unknown as LlmSdkClient;
    const gw = makeLlmGateway({ sdk, audit, clock: fakeClock() });

    const res = await gw.complete('hi', OPTS);

    expect(res.degraded).toBe(true);
    expect(onError).toHaveBeenCalled(); // 降级审计写失败也只回调日志
  });
});

describe('P1-6 · createLlmGateway(env, db) 生产装配接 PG 审计', () => {
  // 无 key → sdk=null,所有方法直接 degraded(不构造真 Anthropic 客户端、不打真 API)。
  // 「降级都审计」(Codex r5 非阻塞②):无 key 的 degraded 早退分支也经 PG sink 落一条 degraded 审计——
  // 验证装配点本身:有 db 时审计走 PG sink(降级也写)、缺 db 时回落 no-op(均不抛、不阻塞)。
  const env = { ANTHROPIC_API_KEY: '' } as unknown as Env;

  it('传入 db → 无 key 下安全 degraded(不抛)且降级也落一条 degraded 审计(Codex r5)', async () => {
    const db = okDb();
    const gw = createLlmGateway(env, db);
    const res = await gw.complete('hi', OPTS);
    expect(res.degraded).toBe(true);
    // 无 key(sdk=null)直接 degraded → 降级都审计：经 PG sink 写一条 degraded=true 审计。
    expect(db.calls).toHaveLength(1);
    expect(db.calls[0]!.sql).toContain('INSERT INTO audit_llm_calls');
    expect(db.calls[0]!.params![7]).toBe(true); // degraded=true
    expect(db.calls[0]!.params![6]).toBe(0); // cost_micros=0(无计费 token)
  });

  it('不传 db → 回落 no-op 审计,complete 仍安全 degraded(不抛)', async () => {
    const gw = createLlmGateway(env);
    const res = await gw.complete('hi', OPTS);
    expect(res.degraded).toBe(true);
  });
});

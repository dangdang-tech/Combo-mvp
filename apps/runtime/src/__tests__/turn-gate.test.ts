import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventType } from '@ag-ui/core';
import type { CapabilityDefinition } from '@cb/shared';
import { createTurnRunner } from '../modules/agent/run-turn.js';
import { GATE_RENEW_MS, GATE_TTL_MS } from '../modules/agent/turn-gate.js';
import { createSession } from '../modules/session/repo.js';
import { createSessionEventBus } from '../platform/infra/event-bus.js';
import { FakeTurnGateStore } from './fake-turn-gate.js';
import { FakeDb, FakeObjectStore, makeFakeAgentFactory, silentLog, waitFor } from './fakes.js';

const definition: CapabilityDefinition = {
  version: 1,
  name: '测试能力',
  summary: '测试',
  kind: 'writing',
  instructions: '测试',
  inputs: [],
  starterPrompts: [],
  meta: {},
};

async function makeRunner(gate: FakeTurnGateStore, instanceId: string, idleTimeoutMs = 60_000) {
  const db = new FakeDb();
  const cap = db.seedCapability({ owner_user_id: 'me' });
  const session = await createSession(db, { capabilityId: cap.id, ownerUserId: 'me' });
  const handle = makeFakeAgentFactory({ deltas: ['部分'], hangUntilAbort: true });
  const runner = createTurnRunner({
    db,
    objectStore: new FakeObjectStore(),
    bus: createSessionEventBus(),
    agentFactory: handle.factory,
    idleTimeoutMs,
    gate,
    instanceId,
  });
  return { db, session, runner };
}

afterEach(() => vi.useRealTimers());

describe('Redis 会话闸语义', () => {
  it('共享闸跨实例互斥，不同会话互不影响', async () => {
    const gate = new FakeTurnGateStore();
    const a = await makeRunner(gate, 'a');
    const b = await makeRunner(gate, 'b');
    expect(
      (await a.runner.startTurn({ session: a.session, definition, text: 'a', log: silentLog }))
        .status,
    ).toBe('started');
    expect(
      (await b.runner.startTurn({ session: a.session, definition, text: 'b', log: silentLog }))
        .status,
    ).toBe('busy');
    expect(
      (await b.runner.startTurn({ session: b.session, definition, text: 'b', log: silentLog }))
        .status,
    ).toBe('started');
    await a.runner.interrupt(a.session.id);
    await b.runner.interrupt(b.session.id);
  });

  it('任意实例发出的打断会终止真正执行轮次', async () => {
    const gate = new FakeTurnGateStore();
    const a = await makeRunner(gate, 'a');
    const b = await makeRunner(gate, 'b');
    await a.runner.startTurn({ session: a.session, definition, text: 'a', log: silentLog });
    expect(await b.runner.interrupt(a.session.id)).toBe(true);
    await waitFor(async () => !(await a.runner.isBusy(a.session.id)));
    expect(a.db.messages.find((row) => row.role === 'assistant')?.status).toBe('failed');
    expect(a.db.streamEvents.at(-1)?.event.type).toBe(EventType.RUN_ERROR);
  });

  it('本地打断走快路径，不写 Redis 打断标记', async () => {
    const gate = new FakeTurnGateStore();
    const a = await makeRunner(gate, 'a');
    await a.runner.startTurn({ session: a.session, definition, text: 'a', log: silentLog });
    expect(await a.runner.interrupt(a.session.id)).toBe(true);
    expect(gate.requestInterruptCalls).toBe(0);
  });

  it('续租单次报错不杀轮，连续失败耗尽窗口才 fence', async () => {
    vi.useFakeTimers();
    const gate = new FakeTurnGateStore();
    const renewFailLimit = Math.max(1, Math.floor(GATE_TTL_MS / GATE_RENEW_MS) - 1);
    const spy = vi
      .spyOn(gate, 'renewAndReadInterrupt')
      .mockRejectedValueOnce(new Error('redis 瞬断'))
      .mockResolvedValueOnce({ owned: true, interrupted: false });
    // 看门狗阈值放大到 10 分钟：本测试专测续租失败路径，别让空闲看门狗抢先杀轮。
    const a = await makeRunner(gate, 'a', 600_000);
    await a.runner.startTurn({ session: a.session, definition, text: 'a', log: silentLog });

    // 第一次续租报错 + 第二次成功：轮子不该被杀，失败计数被清零。
    await vi.advanceTimersByTimeAsync(GATE_RENEW_MS * 2);
    await Promise.resolve();
    expect(a.db.messages.find((row) => row.role === 'assistant')).toBeUndefined();

    // 此后连续报错达到阈值：按丢租约自停，写调度异常终态。
    spy.mockRejectedValue(new Error('redis 持续不可达'));
    await vi.advanceTimersByTimeAsync(GATE_RENEW_MS * renewFailLimit);
    await Promise.resolve();
    await Promise.resolve();
    expect(a.db.streamEvents.at(-1)?.event.message).toBe('服务调度异常，本轮已终止，请重试。');
  });

  it('租约丢失会 fence 并写入调度异常终态', async () => {
    vi.useFakeTimers();
    const gate = new FakeTurnGateStore();
    vi.spyOn(gate, 'renewAndReadInterrupt').mockResolvedValue({
      owned: false,
      interrupted: false,
    });
    const a = await makeRunner(gate, 'a');
    await a.runner.startTurn({ session: a.session, definition, text: 'a', log: silentLog });
    await vi.advanceTimersByTimeAsync(GATE_RENEW_MS);
    await Promise.resolve();
    await Promise.resolve();
    const failed = a.db.messages.find((row) => row.role === 'assistant');
    expect(failed?.content).toEqual([{ type: 'text', text: '部分' }]);
    expect(a.db.streamEvents.at(-1)?.event.message).toBe('服务调度异常，本轮已终止，请重试。');
  });
});

describe('闸存储的租约与标记', () => {
  it('过期租约允许新实例自愈占闸', async () => {
    let now = 0;
    const gate = new FakeTurnGateStore(() => now);
    expect(await gate.acquire('s', 'a', GATE_TTL_MS)).toBe(true);
    now = GATE_TTL_MS + 1;
    expect(await gate.acquire('s', 'b', GATE_TTL_MS)).toBe(true);
  });

  it('新一轮清残留标记，轮内续租消费标记一次', async () => {
    const gate = new FakeTurnGateStore();
    await gate.requestInterrupt('s', 10_000);
    await gate.acquire('s', 'a', GATE_TTL_MS);
    expect((await gate.renewAndReadInterrupt('s', 'a', GATE_TTL_MS)).interrupted).toBe(false);
    await gate.requestInterrupt('s', 10_000);
    expect((await gate.renewAndReadInterrupt('s', 'a', GATE_TTL_MS)).interrupted).toBe(true);
    expect((await gate.renewAndReadInterrupt('s', 'a', GATE_TTL_MS)).interrupted).toBe(false);
  });

  it('release 只允许 owner 删除租约', async () => {
    const gate = new FakeTurnGateStore();
    await gate.acquire('s', 'b', GATE_TTL_MS);
    await gate.release('s', 'a');
    expect(await gate.isHeld('s')).toBe(true);
  });
});

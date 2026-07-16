import { EventType } from '@ag-ui/core';
import type { CapabilityDefinition } from '@cb/shared';
import { describe, expect, it, vi } from 'vitest';
import { createTurnRunner, type TurnAgentFactory } from '../modules/agent/run-turn.js';
import { createTurn, finishTurnCas, TURN_ABANDON_AFTER_MS } from '../modules/agent/turn-repo.js';
import { appendTurnMessage, createSession } from '../modules/session/repo.js';
import { createSessionEventBus } from '../platform/infra/event-bus.js';
import { createInterruptBus, type InterruptBus } from '../platform/infra/redis-interrupt-bus.js';
import {
  FakeDb,
  FakeObjectStore,
  FakeSessionEventLog,
  makeFakeAgentFactory,
  silentLog,
  waitFor,
} from './fakes.js';

const definition: CapabilityDefinition = {
  version: 1,
  name: '测试',
  summary: '测试',
  kind: 'writing',
  instructions: '测试',
  inputs: [],
  starterPrompts: [],
  meta: {},
};

async function setup(
  factory: TurnAgentFactory,
  interrupts: InterruptBus = createInterruptBus(),
  sweepIntervalMs?: number,
) {
  const db = new FakeDb();
  const cap = db.seedCapability({ owner_user_id: 'me' });
  const session = await createSession(db, { capabilityId: cap.id, ownerUserId: 'me' });
  const eventLog = new FakeSessionEventLog();
  const runner = createTurnRunner({
    db,
    objectStore: new FakeObjectStore(),
    bus: createSessionEventBus(),
    eventLog,
    agentFactory: factory,
    idleTimeoutMs: 60_000,
    interrupts,
    sweepIntervalMs,
    log: silentLog,
  });
  return { db, session, eventLog, runner };
}

const waitDone = (db: FakeDb) =>
  waitFor(() => [...db.turns.values()].every((turn) => turn.status !== 'running'));

describe('lock-free 轮次控制', () => {
  it('同会话并发提交两轮都 started，消息按 turnId 归组', async () => {
    const handle = makeFakeAgentFactory({
      finalMessages: [{ role: 'assistant', content: [{ type: 'text', text: 'ok' }] }],
    });
    const { db, session, runner } = await setup(handle.factory);
    const [a, b] = await Promise.all([
      runner.startTurn({ session, definition, text: 'a', log: silentLog }),
      runner.startTurn({ session, definition, text: 'b', log: silentLog }),
    ]);
    expect([a.status, b.status]).toEqual(['started', 'started']);
    await waitDone(db);
    expect(db.turns.size).toBe(2);
    for (const turn of db.turns.values())
      expect(
        db.messages.filter((message) => message.turn_id === turn.id).map((message) => message.idx),
      ).toEqual([0, 1]);
    runner.dispose();
  });

  it('成功收尾写 completed、连续 idx 与 RUN_FINISHED', async () => {
    const handle = makeFakeAgentFactory({
      finalMessages: [{ role: 'assistant', content: [{ type: 'text', text: 'ok' }] }],
    });
    const { db, session, eventLog, runner } = await setup(handle.factory);
    await runner.startTurn({ session, definition, text: 'go', log: silentLog });
    await waitDone(db);
    expect([...db.turns.values()][0]?.status).toBe('completed');
    expect(db.messages.map((message) => message.idx)).toEqual([0, 1]);
    expect(eventLog.entries(session.id).at(-1)?.event.type).toBe(EventType.RUN_FINISHED);
    runner.dispose();
  });

  it('本地打断走执行句柄快路径，不发布广播', async () => {
    const inner = createInterruptBus();
    const publish = vi.fn((sessionId: string) => inner.publish(sessionId));
    const interrupts: InterruptBus = { publish, subscribe: (cb) => inner.subscribe(cb) };
    const handle = makeFakeAgentFactory({ hangUntilAbort: true });
    const { db, session, runner } = await setup(handle.factory, interrupts);
    await runner.startTurn({ session, definition, text: 'go', log: silentLog });
    expect(await runner.interrupt(session.id)).toBe(true);
    await waitDone(db);
    expect(publish).not.toHaveBeenCalled();
    runner.dispose();
  });

  it('跨实例广播打断真正执行轮次', async () => {
    const interrupts = createInterruptBus();
    const handle = makeFakeAgentFactory({ deltas: ['部分'], hangUntilAbort: true });
    const a = await setup(handle.factory, interrupts);
    const b = createTurnRunner({
      db: a.db,
      objectStore: new FakeObjectStore(),
      bus: createSessionEventBus(),
      eventLog: a.eventLog,
      agentFactory: makeFakeAgentFactory().factory,
      idleTimeoutMs: 60_000,
      interrupts,
      log: silentLog,
    });
    await a.runner.startTurn({ session: a.session, definition, text: 'go', log: silentLog });
    await waitFor(() => handle.calls.length === 1);
    expect(await b.interrupt(a.session.id)).toBe(true);
    await waitDone(a.db);
    expect([...a.db.turns.values()][0]?.status).toBe('interrupted');
    expect(a.db.messages.find((message) => message.role === 'assistant')?.status).toBe('failed');
    a.runner.dispose();
    b.dispose();
  });

  it('清扫抢先后正常收尾静默，不重复终态帧', async () => {
    let release!: () => void;
    const prompt = new Promise<void>((resolve) => {
      release = resolve;
    });
    const factory: TurnAgentFactory = () => ({
      subscribeTextDelta: () => () => undefined,
      prompt: () => prompt,
      abort: () => undefined,
      transcript: () => [
        { role: 'user', content: [{ type: 'text', text: 'go' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      ],
      runtimeError: () => undefined,
    });
    const { db, session, eventLog, runner } = await setup(factory);
    await runner.startTurn({ session, definition, text: 'go', log: silentLog });
    const turn = [...db.turns.values()][0];
    expect(turn).toBeTruthy();
    await finishTurnCas(db, { id: turn!.id, status: 'failed' });
    release();
    await waitFor(() => db.messages.some((message) => message.role === 'assistant'));
    const terminal = eventLog
      .entries(session.id)
      .filter(
        (entry) =>
          entry.event.type === EventType.RUN_FINISHED || entry.event.type === EventType.RUN_ERROR,
      );
    expect(terminal).toHaveLength(0);
    runner.dispose();
  });

  it('清扫循环写失败消息与 RUN_ERROR，dispose 后停止', async () => {
    const handle = makeFakeAgentFactory({ hangUntilAbort: true });
    const { db, session, eventLog, runner } = await setup(handle.factory, createInterruptBus(), 5);
    await runner.startTurn({ session, definition, text: 'go', log: silentLog });
    const turn = [...db.turns.values()][0]!;
    turn.created_at = new Date(Date.now() - TURN_ABANDON_AFTER_MS - 1).toISOString();
    await waitFor(() => turn.status === 'failed');
    expect(
      db.messages.some((message) => message.turn_id === turn.id && message.status === 'failed'),
    ).toBe(true);
    expect(
      eventLog.entries(session.id).some((entry) => entry.event.type === EventType.RUN_ERROR),
    ).toBe(true);
    runner.dispose();
    const count = eventLog.entries(session.id).length;
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(eventLog.entries(session.id)).toHaveLength(count);
  });

  it('历史只包含 legacy completed 与 completed 轮消息', async () => {
    const handle = makeFakeAgentFactory();
    const { db, session, runner } = await setup(handle.factory);
    db.messages.push({
      id: 'legacy',
      session_id: session.id,
      turn_id: null,
      idx: null,
      seq: 1,
      role: 'user',
      content: [{ type: 'text', text: 'legacy' }],
      status: 'completed',
      created_at: new Date(0).toISOString(),
    });
    for (const [id, status] of [
      ['done', 'completed'],
      ['failed', 'failed'],
      ['running', 'running'],
    ] as const) {
      await createTurn(db, { id, sessionId: session.id });
      await appendTurnMessage(db, {
        sessionId: session.id,
        turnId: id,
        idx: 0,
        role: 'user',
        content: [{ type: 'text', text: id }],
      });
      if (status !== 'running') await finishTurnCas(db, { id, status });
    }
    await runner.startTurn({ session, definition, text: 'new', log: silentLog });
    await waitFor(() => handle.calls.length === 1);
    expect(
      handle.calls[0]?.history.map((message) => (message.content[0] as { text: string }).text),
    ).toEqual(['legacy', 'done']);
    runner.dispose();
  });
});

// run-turn 编排（注入假 agent 工厂）：事件双写、终态消息落库、busy 闸、失败落 failed 消息、打断。
import { describe, expect, it } from 'vitest';
import { EventType } from '@ag-ui/core';
import type { CapabilityDefinition } from '@cb/shared';
import { createTurnRunner, TurnAgentUnavailableError } from '../modules/agent/run-turn.js';
import { createSession, type SessionRow } from '../modules/session/repo.js';
import { createSessionEventBus, type PublishedStreamEvent } from '../platform/infra/event-bus.js';
import {
  FakeDb,
  FakeObjectStore,
  makeFakeAgentFactory,
  silentLog,
  waitFor,
  type FakeAgentScript,
} from './fakes.js';
import { FakeTurnGateStore } from './fake-turn-gate.js';

const ME = 'user-me';

const DEFINITION: CapabilityDefinition = {
  version: 1,
  name: '会议纪要生成',
  summary: '把速记变成结构化纪要',
  kind: 'writing',
  instructions: '你是一名会议纪要专家。',
  inputs: [],
  starterPrompts: [],
  meta: {},
};

async function setup(script: FakeAgentScript = {}, idleTimeoutMs = 60_000) {
  const db = new FakeDb();
  const store = new FakeObjectStore();
  const bus = createSessionEventBus();
  const handle = makeFakeAgentFactory(script);
  const gate = new FakeTurnGateStore();
  const runner = createTurnRunner({
    db,
    objectStore: store,
    bus,
    agentFactory: handle.factory,
    idleTimeoutMs,
    gate,
    instanceId: 'test-instance',
  });
  const cap = db.seedCapability({ owner_user_id: ME });
  const session: SessionRow = await createSession(db, { capabilityId: cap.id, ownerUserId: ME });
  const published: PublishedStreamEvent[] = [];
  bus.subscribe(session.id, (e) => published.push(e));
  return { db, store, bus, handle, gate, runner, session, published };
}

function eventTypes(db: FakeDb): unknown[] {
  return db.streamEvents.map((e) => e.event.type);
}

async function runToIdle(
  runner: ReturnType<typeof createTurnRunner>,
  session: SessionRow,
  text = '帮我整理这份速记',
) {
  const result = await runner.startTurn({ session, definition: DEFINITION, text, log: silentLog });
  if (result.status === 'started') await waitFor(async () => !(await runner.isBusy(session.id)));
  return result;
}

describe('run-turn 成功路径', () => {
  it('事件双写（表+总线同 id 同序）、整轮消息落 completed', async () => {
    const { db, runner, session, published, handle } = await setup({
      deltas: ['我来', '整理'],
      invokeTool: { title: '纪要', content: '<!doctype html><html>纪要</html>' },
      finalMessages: [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: '我来整理' },
            { type: 'toolCall', id: 'tc-1', name: 'upsert_artifact', arguments: {} },
          ],
        },
        {
          role: 'toolResult',
          toolCallId: 'tc-1',
          toolName: 'upsert_artifact',
          content: [{ type: 'text', text: 'ok' }],
          isError: false,
        },
        { role: 'assistant', content: [{ type: 'text', text: '整理好了' }] },
      ],
    });

    const result = await runToIdle(runner, session);
    expect(result.status).toBe('started');
    if (result.status === 'started') {
      expect(result.userMessage.seq).toBe(1);
      expect(result.userMessage.role).toBe('user');
    }

    // 事件顺序：RUN_STARTED → 文本开闭之间夹产物 STATE_DELTA → RUN_FINISHED。
    expect(eventTypes(db)).toEqual([
      EventType.RUN_STARTED,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.STATE_DELTA,
      EventType.TEXT_MESSAGE_END,
      EventType.RUN_FINISHED,
    ]);
    // 双写：总线收到同一批（id = 表自增 id，同序）。
    expect(published.map((e) => e.id)).toEqual(db.streamEvents.map((e) => e.id));
    expect(published.map((e) => e.event.type)).toEqual(eventTypes(db));

    // 整轮定稿：user + assistant + tool + assistant，全 completed。
    const rows = db.messages.filter((m) => m.session_id === session.id);
    expect(rows.map((m) => [m.seq, m.role, m.status])).toEqual([
      [1, 'user', 'completed'],
      [2, 'assistant', 'completed'],
      [3, 'tool', 'completed'],
      [4, 'assistant', 'completed'],
    ]);
    // 产物工具真实走通（表 + MinIO 在 artifact.test 覆盖，这里验接线）。
    expect(db.artifacts.size).toBe(1);

    // agent 工厂拿到 definition 与空历史（首轮）。
    expect(handle.calls[0]?.definition).toEqual(DEFINITION);
    expect(handle.calls[0]?.history).toHaveLength(0);
  });

  it('第二轮把上一轮定稿作为历史喂给 agent（failed 消息除外）', async () => {
    const { runner, session, handle } = await setup({
      finalMessages: [{ role: 'assistant', content: [{ type: 'text', text: '好的' }] }],
    });
    await runToIdle(runner, session, '第一轮');
    await runToIdle(runner, session, '第二轮');

    const secondHistory = handle.calls[1]?.history ?? [];
    // 历史 = 第一轮的 user + assistant（不含第二轮自己的 user 消息）。
    expect(secondHistory.map((m) => m.role)).toEqual(['user', 'assistant']);
  });
});

describe('run-turn busy 闸与打断', () => {
  it('同会话生成中再发 → busy 且不落第二条 user 消息；打断后闸释放', async () => {
    const { db, runner, session } = await setup({ deltas: ['部分'], hangUntilAbort: true });

    const first = await runner.startTurn({
      session,
      definition: DEFINITION,
      text: '第一条',
      log: silentLog,
    });
    expect(first.status).toBe('started');
    expect(await runner.isBusy(session.id)).toBe(true);

    const second = await runner.startTurn({
      session,
      definition: DEFINITION,
      text: '第二条',
      log: silentLog,
    });
    expect(second.status).toBe('busy');
    expect(db.messages.filter((m) => m.role === 'user')).toHaveLength(1); // 第二条没落库

    expect(await runner.interrupt(session.id)).toBe(true);
    await waitFor(async () => !(await runner.isBusy(session.id)));

    // 打断落 failed 消息（已生成的部分文本保留），事件以 RUN_ERROR 收尾、无 RUN_FINISHED。
    const failed = db.messages.find((m) => m.role === 'assistant');
    expect(failed?.status).toBe('failed');
    expect(failed?.content).toEqual([{ type: 'text', text: '部分' }]);
    const types = eventTypes(db);
    expect(types).toContain(EventType.RUN_ERROR);
    expect(types).not.toContain(EventType.RUN_FINISHED);

    // 闸已释放：可开下一轮；无进行中的轮时 interrupt → false。
    expect(await runner.interrupt(session.id)).toBe(false);
  });
});

describe('run-turn 空闲看门狗（issue #51：流中途停滞永无终态）', () => {
  it('LLM 流停滞超过阈值 → abort + RUN_ERROR，已生成的部分文本保进 failed 消息', async () => {
    const { db, runner, session } = await setup({ deltas: ['部分'], hangUntilAbort: true }, 30);

    const result = await runner.startTurn({
      session,
      definition: DEFINITION,
      text: '会停滞的一轮',
      log: silentLog,
    });
    expect(result.status).toBe('started');
    // 不做人工 interrupt：看门狗自己判死并收尾。
    await waitFor(async () => !(await runner.isBusy(session.id)));

    const failed = db.messages.find((m) => m.role === 'assistant');
    expect(failed?.status).toBe('failed');
    expect(failed?.content).toEqual([{ type: 'text', text: '部分' }]);

    const last = db.streamEvents.at(-1)?.event as { type: unknown; message?: string };
    expect(last.type).toBe(EventType.RUN_ERROR);
    expect(last.message).toContain('停滞');
    expect(eventTypes(db)).not.toContain(EventType.RUN_FINISHED);
  });
});

describe('run-turn 失败路径（失败落 failed 消息 + RUN_ERROR）', () => {
  it('agent.prompt 抛错', async () => {
    const { db, runner, session } = await setup({ promptError: new Error('llm down') });
    await runToIdle(runner, session);

    const failed = db.messages.find((m) => m.role === 'assistant');
    expect(failed?.status).toBe('failed');
    expect(failed?.content).toEqual([{ type: 'text', text: '对话生成失败，请重试。' }]);
    expect(eventTypes(db).at(-1)).toBe(EventType.RUN_ERROR);
  });

  it('pi 把失败编码进消息（runtimeError）', async () => {
    const { db, runner, session } = await setup({ runtimeError: 'credit exhausted' });
    await runToIdle(runner, session);

    const failed = db.messages.find((m) => m.role === 'assistant');
    expect(failed?.status).toBe('failed');
    expect(failed?.content).toEqual([
      { type: 'text', text: '模型调用失败（额度/网络/服务波动），请重试。' },
    ]);
  });

  it('agent 工厂不可用（未配置模型密钥）→ 人话进 failed 消息', async () => {
    const db = new FakeDb();
    const cap = db.seedCapability({ owner_user_id: ME });
    const session = await createSession(db, { capabilityId: cap.id, ownerUserId: ME });
    const runner = createTurnRunner({
      db,
      objectStore: new FakeObjectStore(),
      bus: createSessionEventBus(),
      agentFactory: () => {
        throw new TurnAgentUnavailableError('试用服务未配置模型密钥，暂时无法对话。');
      },
      idleTimeoutMs: 60_000,
      gate: new FakeTurnGateStore(),
      instanceId: 'test-instance',
    });
    const result = await runner.startTurn({
      session,
      definition: DEFINITION,
      text: 'hi',
      log: silentLog,
    });
    expect(result.status).toBe('started');
    await waitFor(async () => !(await runner.isBusy(session.id)));

    const failed = db.messages.find((m) => m.role === 'assistant');
    expect(failed?.status).toBe('failed');
    expect(failed?.content).toEqual([
      { type: 'text', text: '试用服务未配置模型密钥，暂时无法对话。' },
    ]);
  });
});

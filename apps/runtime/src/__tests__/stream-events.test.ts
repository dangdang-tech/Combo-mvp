// stream_events：表补发逻辑（按 afterId 过滤）+ 轮次 emitter 双写（表 + 进程内总线）。
import { describe, expect, it } from 'vitest';
import { insertStreamEvent, listStreamEventsAfter } from '../modules/agent/event-log.js';
import { createTurnEmitter } from '../modules/agent/turn-emitter.js';
import { createSessionEventBus, type PublishedStreamEvent } from '../platform/infra/event-bus.js';
import { FakeDb, silentLog } from './fakes.js';

describe('stream 事件表补发（按 afterId 过滤）', () => {
  it('afterId=0 取全量；afterId=n 只取 id>n 的增量，升序', async () => {
    const db = new FakeDb();
    for (let i = 1; i <= 5; i += 1) {
      await insertStreamEvent(db, { sessionId: 'sess-a', event: { type: 'E', n: i } });
    }
    await insertStreamEvent(db, { sessionId: 'sess-b', event: { type: 'E', n: 99 } }); // 别的会话

    const all = await listStreamEventsAfter(db, 'sess-a', 0);
    expect(all.map((e) => e.id)).toEqual([1, 2, 3, 4, 5]);

    const tail = await listStreamEventsAfter(db, 'sess-a', 3);
    expect(tail.map((e) => e.id)).toEqual([4, 5]);
    expect(tail.map((e) => (e.event as { n: number }).n)).toEqual([4, 5]);

    const none = await listStreamEventsAfter(db, 'sess-a', 5);
    expect(none).toHaveLength(0);
  });

  it('limit 生效（分批补发的单批上限）', async () => {
    const db = new FakeDb();
    for (let i = 1; i <= 4; i += 1) {
      await insertStreamEvent(db, { sessionId: 'sess-a', event: { n: i } });
    }
    const batch = await listStreamEventsAfter(db, 'sess-a', 0, 2);
    expect(batch.map((e) => e.id)).toEqual([1, 2]);
  });
});

describe('turn emitter 双写', () => {
  it('每个事件先落表（拿自增 id）再发总线，顺序与 id 一致', async () => {
    const db = new FakeDb();
    const bus = createSessionEventBus();
    const received: PublishedStreamEvent[] = [];
    bus.subscribe('sess-a', (e) => received.push(e));

    const emitter = createTurnEmitter({ db, bus, sessionId: 'sess-a', log: silentLog });
    emitter.emit({ type: 'RUN_STARTED' });
    emitter.emit({ type: 'TEXT_MESSAGE_CONTENT', delta: 'x' });
    emitter.emit({ type: 'RUN_FINISHED' });
    await emitter.flush();

    // 表是真源：三行、id 连续。
    expect(db.streamEvents.map((e) => e.id)).toEqual([1, 2, 3]);
    expect(db.streamEvents.map((e) => e.event.type)).toEqual([
      'RUN_STARTED',
      'TEXT_MESSAGE_CONTENT',
      'RUN_FINISHED',
    ]);
    // 总线拿到同一份（id 与表一致，SSE 直接当帧 id 用）。
    expect(received.map((e) => e.id)).toEqual([1, 2, 3]);
    expect(received[2]?.event.type).toBe('RUN_FINISHED');
  });

  it('无订阅者时事件仍落表（离线也不丢真源）', async () => {
    const db = new FakeDb();
    const emitter = createTurnEmitter({
      db,
      bus: createSessionEventBus(),
      sessionId: 'sess-a',
      log: silentLog,
    });
    emitter.emit({ type: 'RUN_STARTED' });
    await emitter.flush();
    expect(db.streamEvents).toHaveLength(1);
  });
});

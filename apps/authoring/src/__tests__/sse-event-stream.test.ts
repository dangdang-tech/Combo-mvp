// B-12 worker→api 进度桥自检（redis_hot Streams）：XADD 推帧、Last-Event-ID 窗口补发 / 超窗重置、id 比较。
import { describe, it, expect } from 'vitest';
import { RedisEventStream, compareStreamId, jobStreamKey } from '../platform/sse/event-stream.js';
import type { Redis } from 'ioredis';

/** 极简内存假 Stream：支持 xadd / xrange / xinfo / expire（仅本测用到的形态）。 */
class FakeStreamRedis {
  private streams = new Map<string, Array<[string, string[]]>>();
  private seq = 0;

  async xadd(key: string, ...args: unknown[]): Promise<string> {
    // args: 'MAXLEN','~',N,'*','event',ev,'data',data
    const idx = args.indexOf('*');
    const fields = args.slice(idx + 1).map(String);
    const id = `${1000 + this.seq}-0`;
    this.seq += 1;
    const arr = this.streams.get(key) ?? [];
    arr.push([id, fields]);
    this.streams.set(key, arr);
    return id;
  }
  async expire(): Promise<number> {
    return 1;
  }
  async xinfo(_sub: string, key: string): Promise<unknown[]> {
    const arr = this.streams.get(key);
    if (!arr || arr.length === 0) throw new Error('no such key');
    return ['length', arr.length, 'first-entry', arr[0]];
  }
  async xrange(key: string, start: string, _end: string): Promise<Array<[string, string[]]>> {
    const arr = this.streams.get(key) ?? [];
    const exclusive = start.startsWith('(');
    const startId = exclusive ? start.slice(1) : start;
    return arr.filter(([id]) =>
      exclusive ? compareStreamId(id, startId) > 0 : compareStreamId(id, startId) >= 0,
    );
  }
  // latestId 用：流最后一条（XREVRANGE + - COUNT 1）。
  async xrevrange(key: string, _plus: string, _minus: string): Promise<Array<[string, string[]]>> {
    const arr = this.streams.get(key) ?? [];
    return arr.length ? [arr[arr.length - 1]] : [];
  }
  // subscribe 用独立连接：duplicate 返回自身（同一内存流即可，本测不区分连接）。
  duplicate(): this {
    return this;
  }
  disconnect(): void {
    /* no-op（测试无真连接） */
  }
  // subscribe 用：XREAD BLOCK ms STREAMS key lastId → 返回 lastId 之后的新帧；无则在 blockMs 后返回 null。
  async xread(...args: unknown[]): Promise<Array<[string, Array<[string, string[]]>]>> | null {
    const key = args[3] as string;
    const lastId = args[4] as string;
    const arr = this.streams.get(key) ?? [];
    const fresh = arr.filter(([id]) => compareStreamId(id, lastId) > 0);
    if (fresh.length === 0) {
      // 模拟 BLOCK 超时（短暂让出，避免忙等）。
      await new Promise((r) => setTimeout(r, 5));
      return null;
    }
    return [[key, fresh]];
  }
  // 测试辅助：手动塞条目（模拟已被 MAXLEN 裁剪后的窗口）。
  _setEntries(key: string, entries: Array<[string, string[]]>): void {
    this.streams.set(key, entries);
  }
}

function frameData(event: string, payload: unknown): string[] {
  return ['event', event, 'data', JSON.stringify(payload)];
}

describe('compareStreamId（Redis Stream id 比较）', () => {
  it('ms 不同按 ms 比；ms 同按 seq 比；缺 seq 视为 0', () => {
    expect(compareStreamId('100-0', '200-0')).toBeLessThan(0);
    expect(compareStreamId('200-5', '200-3')).toBeGreaterThan(0);
    expect(compareStreamId('200', '200-0')).toBe(0);
    expect(compareStreamId('200-0', '200-0')).toBe(0);
  });
});

describe('RedisEventStream.publish（XADD 推帧）', () => {
  it('推帧返回 entry id（= SSE id）', async () => {
    const fake = new FakeStreamRedis();
    const stream = new RedisEventStream(fake as unknown as Redis);
    const id = await stream.publish('j1', { event: 'progress', payload: { percent: 10 } });
    expect(id).toMatch(/^\d+-\d+$/);
  });

  it('publish 在 redis 抛错时吞掉返回 null（尽力而为，jobs.progress 才是真源）', async () => {
    const throwing = {
      xadd: async () => {
        throw new Error('redis down');
      },
    };
    const stream = new RedisEventStream(throwing as unknown as Redis);
    expect(await stream.publish('j1', { event: 'progress', payload: {} })).toBeNull();
  });
});

describe('replaySince（Last-Event-ID 窗口补发，脊柱 §5.4）', () => {
  it('窗口内：返回 (lastEventId, +] 增量帧、inWindow=true、不含 lastEventId 自身', async () => {
    const fake = new FakeStreamRedis();
    const stream = new RedisEventStream(fake as unknown as Redis);
    await stream.publish('j1', { event: 'progress', payload: { percent: 10 } }); // 1000-0
    await stream.publish('j1', { event: 'progress', payload: { percent: 20 } }); // 1001-0
    await stream.publish('j1', { event: 'progress', payload: { percent: 30 } }); // 1002-0

    const res = await stream.replaySince('j1', '1000-0');
    expect(res.inWindow).toBe(true);
    // 只返回 1000-0 之后的两条（exclusive），不重推 snapshot。
    expect(res.frames.map((f) => f.id)).toEqual(['1001-0', '1002-0']);
    expect((res.frames[0].payload as { percent: number }).percent).toBe(20);
  });

  it('超窗（lastEventId 早于流最早条目，已被裁）→ inWindow=false（走 snapshot 重置）', async () => {
    const fake = new FakeStreamRedis();
    // 流最早条目是 5000-0（更早的已被 MAXLEN 裁掉）。
    fake._setEntries(jobStreamKey('j1'), [
      ['5000-0', frameData('progress', { percent: 90 })],
      ['5001-0', frameData('progress', { percent: 95 })],
    ]);
    const stream = new RedisEventStream(fake as unknown as Redis);
    const res = await stream.replaySince('j1', '100-0'); // 100-0 早于 5000-0 → 超窗
    expect(res.inWindow).toBe(false);
    expect(res.frames).toEqual([]);
  });

  it('流为空 / 不存在 → inWindow=false（保守走 snapshot，永不漏）', async () => {
    const fake = new FakeStreamRedis();
    const stream = new RedisEventStream(fake as unknown as Redis);
    const res = await stream.replaySince('j-none', '100-0');
    expect(res.inWindow).toBe(false);
  });

  it('lastEventId 恰为流最早条目 → 仍在窗口（返回其后增量）', async () => {
    const fake = new FakeStreamRedis();
    fake._setEntries(jobStreamKey('j1'), [
      ['5000-0', frameData('progress', { percent: 90 })],
      ['5001-0', frameData('done', { status: 'completed' })],
    ]);
    const stream = new RedisEventStream(fake as unknown as Redis);
    const res = await stream.replaySince('j1', '5000-0');
    expect(res.inWindow).toBe(true);
    expect(res.frames.map((f) => f.id)).toEqual(['5001-0']);
    expect(res.frames[0].event).toBe('done');
  });
});

describe('latestId（订阅起点，Codex P0-1）', () => {
  it('返回流最新 entry id；空流 → 0-0', async () => {
    const fake = new FakeStreamRedis();
    const stream = new RedisEventStream(fake as unknown as Redis);
    expect(await stream.latestId('empty')).toBe('0-0');
    await stream.publish('j1', { event: 'progress', payload: { percent: 10 } }); // 1000-0
    await stream.publish('j1', { event: 'progress', payload: { percent: 20 } }); // 1001-0
    expect(await stream.latestId('j1')).toBe('1001-0');
  });
});

describe('subscribe（持续订阅 XREAD BLOCK，Codex P0-1）', () => {
  it('从 fromId 起把后续新帧实时回调 onFrame；abort → 循环退出（清理 reader）', async () => {
    const fake = new FakeStreamRedis();
    const stream = new RedisEventStream(fake as unknown as Redis);
    // 建流时刻流里已有一帧（1000-0）；订阅从它之后开始（fromId=1000-0）。
    await stream.publish('j1', { event: 'progress', payload: { percent: 10 } }); // 1000-0
    const got: Array<{ id: string; event: string }> = [];
    const ac = new AbortController();
    const sub = stream.subscribe(
      'j1',
      '1000-0',
      (f) => {
        got.push({ id: f.id, event: f.event });
        if (f.event === 'done') ac.abort(); // 收到终态自行停（模拟 SSE 插件 done 关流）。
      },
      ac.signal,
      20, // 短 BLOCK 便于测试
    );
    // 订阅启动后 worker 继续推帧。
    await new Promise((r) => setTimeout(r, 5));
    await stream.publish('j1', { event: 'progress', payload: { percent: 60 } }); // 1001-0
    await stream.publish('j1', { event: 'done', payload: { status: 'completed' } }); // 1002-0
    await sub; // abort 后 resolve
    // 只收到 fromId 之后的帧（不含 1000-0），含 done。
    expect(got.map((g) => g.id)).toEqual(['1001-0', '1002-0']);
    expect(got.at(-1)?.event).toBe('done');
  });

  it('signal 已 abort → 直接返回，不订阅', async () => {
    const fake = new FakeStreamRedis();
    const stream = new RedisEventStream(fake as unknown as Redis);
    const ac = new AbortController();
    ac.abort();
    const got: unknown[] = [];
    await stream.subscribe('j1', '0-0', (f) => got.push(f), ac.signal, 20);
    expect(got).toEqual([]);
  });
});

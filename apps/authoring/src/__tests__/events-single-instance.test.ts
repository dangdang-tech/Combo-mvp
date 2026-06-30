// B-14 §3.1 · 启动级单实例防重（PG advisory lock）单测。
//   - 拿到锁：acquired=true，连接被持有（不归还）；release 时解锁 + 归还。
//   - 拿不到锁：acquired=false，连接立即归还（调用方据此退出/标 degraded、绝不消费）。
import { describe, it, expect, vi } from 'vitest';
import {
  tryAcquireAdvisoryLock,
  type LockablePool,
  type LockableConn,
} from '../platform/events/single-instance.js';

function mockPool(locked: boolean): {
  pool: LockablePool;
  released: { count: number };
  queries: string[];
} {
  const released = { count: 0 };
  const queries: string[] = [];
  const conn: LockableConn = {
    query: vi.fn(async (sql: string) => {
      queries.push(sql);
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked }] } as never;
      if (sql.includes('pg_advisory_unlock')) return { rows: [{ unlocked: true }] } as never;
      return { rows: [] } as never;
    }),
    release: () => {
      released.count += 1;
    },
  };
  return { pool: { connect: async () => conn }, released, queries };
}

describe('tryAcquireAdvisoryLock (B-14 §3.1 单实例防重)', () => {
  it('拿到锁 → acquired=true，连接被持有（未归还）；release 解锁后归还', async () => {
    const { pool, released, queries } = mockPool(true);
    const lock = await tryAcquireAdvisoryLock(pool, 'consumer:NotifyConsumer');
    expect(lock.acquired).toBe(true);
    expect(released.count).toBe(0); // 持锁不归还连接（归还=释放锁）
    expect(queries[0]).toContain('pg_try_advisory_lock');
    await lock.release();
    expect(queries.some((q) => q.includes('pg_advisory_unlock'))).toBe(true);
    expect(released.count).toBe(1); // release 后归还
  });

  it('拿不到锁 → acquired=false，连接立即归还（不消费）', async () => {
    const { pool, released } = mockPool(false);
    const lock = await tryAcquireAdvisoryLock(pool, 'consumer:NotifyConsumer');
    expect(lock.acquired).toBe(false);
    expect(released.count).toBe(1); // 立即归还
    // 拿不到锁时 release 无副作用（不二次归还/解锁）。
    await lock.release();
    expect(released.count).toBe(1);
  });
});

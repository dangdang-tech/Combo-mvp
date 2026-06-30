// B-14 §3.1 · 启动级单实例防重（防误 scale 破坏保序）。首选 PG advisory lock。
//   pg_try_advisory_lock(hashtext('consumer:'||name))：拿到才进消费循环；拿不到 → 不消费（degraded）。
//   会话级 advisory lock 在持锁连接断开时自动释放（实例挂了锁自动放、另一实例接管）。
// 关键：持锁必须用【独占的长连接】（不能从池借后归还——归还即释放锁）。本模块持有该连接直到 release。
import type { Pool, PoolClient } from 'pg';

/** advisory lock 句柄：持有期间锁有效；release() 解锁并归还连接。 */
export interface AdvisoryLock {
  /** 是否成功取到锁。 */
  acquired: boolean;
  /** 解锁并归还持锁连接（acquired=false 时无副作用）。 */
  release(): Promise<void>;
}

/** 仅依赖 connect 的池子集（便于 mock 单测）。 */
export interface LockablePool {
  connect(): Promise<LockableConn>;
}
export interface LockableConn {
  query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: R[] }>;
  release(): void;
}

/**
 * 尝试取 consumer/sweeper 的会话级 advisory lock（B-14 §3.1 / 类比 sweeper §6.1 单活）。
 *   - 拿到：返回 acquired=true，并【持有】该连接（不归还）→ 锁在进程存活期间有效。
 *   - 拿不到：立即归还连接，返回 acquired=false（调用方据此退出 / 标 degraded、绝不消费）。
 * lockName 形如 'consumer:NotifyConsumer'；用 hashtext 落到 advisory lock 的 bigint 键空间。
 */
export async function tryAcquireAdvisoryLock(
  pool: LockablePool,
  lockName: string,
): Promise<AdvisoryLock> {
  const conn = await pool.connect();
  try {
    const res = await conn.query<{ locked: boolean }>(
      `SELECT pg_try_advisory_lock(hashtext($1)) AS locked`,
      [lockName],
    );
    const locked = res.rows[0]?.locked === true;
    if (!locked) {
      conn.release();
      return { acquired: false, release: async () => undefined };
    }
    // 持锁：不归还连接（归还=释放锁）。release 时显式解锁 + 归还。
    return {
      acquired: true,
      release: async () => {
        try {
          await conn.query(`SELECT pg_advisory_unlock(hashtext($1))`, [lockName]);
        } finally {
          conn.release();
        }
      },
    };
  } catch (err) {
    conn.release();
    throw err;
  }
}

/** 把 pg.Pool 适配成 LockablePool（生产用）。 */
export function asLockablePool(pool: Pool): LockablePool {
  return {
    async connect(): Promise<LockableConn> {
      const client: PoolClient = await pool.connect();
      return {
        query: (sql: string, params?: unknown[]) => client.query(sql, params) as never,
        release: () => client.release(),
      };
    },
  };
}

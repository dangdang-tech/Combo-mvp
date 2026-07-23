// 最小事务抽象。
//   - Tx：单连接事务句柄（BEGIN/COMMIT/ROLLBACK 由 withTransaction 收口）。
//   - withTransaction：从池领连接、开事务、回调内复用同一连接（建任务的 tasks+uploads
//     两表插入必须同一事务原子提交，靠它保证）。
// 无 PG 也能跑：单测注入 mock TxPool。
import type { Pool, PoolClient } from 'pg';

/** 仅依赖 query 的最小 DB 句柄（pg 子集），事务内/池层通用，便于 mock。 */
export interface QueryableDb {
  query<R = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }>;
}

/** 事务句柄（单连接，回调内所有写入复用它 → 同一事务原子提交/回滚）。 */
export type Tx = QueryableDb;

/** 能领出单连接做事务的池（pg.Pool 子集）。 */
export interface TxPool {
  connect(): Promise<TxConn>;
}

/** 单连接（pg.PoolClient 子集）：可 query + release。 */
export interface TxConn extends QueryableDb {
  release(): void;
}

/**
 * 在单连接事务内执行 fn（70 §2.1/§3.3 的同事务硬约束收口）。
 *   BEGIN → fn(tx) → COMMIT；fn 抛错 → ROLLBACK 后上抛；最终 release 连接。
 * 调用方在 fn 内的所有 query 必须用传入的 tx（同一连接 = 同一事务），不可另取连接。
 */
export async function withTransaction<T>(pool: TxPool, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const conn = await pool.connect();
  try {
    await conn.query('BEGIN');
    try {
      const result = await fn(conn);
      await conn.query('COMMIT');
      return result;
    } catch (err) {
      // ROLLBACK 自身失败不掩盖原始错误（连接可能已坏）；吞 rollback 错、上抛原错。
      await conn.query('ROLLBACK').catch(() => undefined);
      throw err;
    }
  } finally {
    conn.release();
  }
}

/** 把 pg.Pool 适配成 TxPool（生产用）；测试可直接传 mock TxPool。 */
export function asTxPool(pool: Pool): TxPool {
  return {
    async connect(): Promise<TxConn> {
      const client: PoolClient = await pool.connect();
      return {
        query: (sql: string, params?: unknown[]) => client.query(sql, params) as never,
        release: () => client.release(),
      };
    },
  };
}

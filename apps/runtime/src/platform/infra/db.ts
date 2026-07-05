// PostgreSQL 连接池（pg）+ 最小事务抽象。
//   惰性建池（无 Docker 也能跑 tsc/单测）；池层错误吞掉，错误在调用点处理。
//   Queryable/TxPool 是 pg 的最小子集：单测注入忠实假 PG，不依赖真库。
import { Pool, type PoolClient } from 'pg';
import type { Env } from '../config/env.js';

/** 仅依赖 query 的最小 DB 句柄（pg 子集），事务内/池层通用。 */
export interface QueryResultLike<R = Record<string, unknown>> {
  rows: R[];
  rowCount: number | null;
}
export interface Queryable {
  query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResultLike<R>>;
}

/** 单连接（pg.PoolClient 子集）：可 query + release。 */
export interface TxConn extends Queryable {
  release(): void;
}

/** 能领出单连接做事务的池。 */
export interface TxPool {
  connect(): Promise<TxConn>;
}

/** runtime 各 repo 统一依赖的 DB 句柄：可直查 + 可开事务。 */
export type RuntimeDb = Queryable & TxPool;

let pool: Pool | undefined;

/** PG 连接池单例。 */
export function getPool(env: Env): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: env.DATABASE_URL,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 2_000,
    });
    pool.on('error', () => {
      /* swallow idle-client errors; handled at query call sites */
    });
  }
  return pool;
}

/** 把 pg.Pool 适配成 RuntimeDb（生产用）；测试直接注入 FakeDb。 */
export function toRuntimeDb(p: Pool): RuntimeDb {
  return {
    query: (sql: string, params?: unknown[]) => p.query(sql, params) as never,
    async connect(): Promise<TxConn> {
      const client: PoolClient = await p.connect();
      return {
        query: (sql: string, params?: unknown[]) => client.query(sql, params) as never,
        release: () => client.release(),
      };
    },
  };
}

/**
 * 在单连接事务内执行 fn：BEGIN → fn(tx) → COMMIT；fn 抛错 → ROLLBACK 后上抛。
 * fn 内所有 query 必须用传入的 tx（同一连接 = 同一事务），不可另取连接。
 */
export async function withTransaction<T>(
  db: TxPool,
  fn: (tx: Queryable) => Promise<T>,
): Promise<T> {
  const conn = await db.connect();
  try {
    await conn.query('BEGIN');
    try {
      const result = await fn(conn);
      await conn.query('COMMIT');
      return result;
    } catch (err) {
      // ROLLBACK 自身失败不掩盖原始错误（连接可能已坏）。
      await conn.query('ROLLBACK').catch(() => undefined);
      throw err;
    }
  } finally {
    conn.release();
  }
}

/** ready 探针：SELECT 1（连不上/超时 → down）。 */
export async function pingDb(env: Env): Promise<boolean> {
  try {
    const client = await getPool(env).connect();
    try {
      await client.query('SELECT 1');
      return true;
    } finally {
      client.release();
    }
  } catch {
    return false;
  }
}

/** 优雅关闭连接池。 */
export async function closeDb(): Promise<void> {
  await pool?.end().catch(() => undefined);
  pool = undefined;
}

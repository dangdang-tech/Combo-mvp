// PostgreSQL 连接池（pg）。试用端只读已发布投影 + 读写自有 runtime_* 表。
//   惰性建池（无 Docker 也能跑 tsc/单测）；池层错误吞掉，错误在调用点处理。
import { Pool, type PoolClient } from 'pg';
import type { Env } from '../config/env.js';

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

/** 单事务：BEGIN→fn→COMMIT；fn 抛错则 ROLLBACK 并上抛。 */
export async function withTx<T>(env: Env, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool(env).connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** 优雅关闭连接池。 */
export async function closeDb(): Promise<void> {
  await pool?.end().catch(() => undefined);
  pool = undefined;
}

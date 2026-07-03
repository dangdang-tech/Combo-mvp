// PostgreSQL 连接池（pg）。jobs/idempotency/users 等真源（脊柱 §6 / §4 / 10 §7）。
// 骨架阶段：惰性建池，不在启动期强连（无 Docker 也能跑 tsc/单测/冒烟）。
import { Pool } from 'pg';
import type { Env } from '../config/env.js';

let pool: Pool | undefined;

/** PG 连接池单例。 */
export function getPool(env: Env): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: env.DATABASE_URL,
      // 骨架阶段保守池参，Phase 3 按负载调。connectionTimeoutMillis 短，依赖宕机时探针快速判 down。
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 2_000,
    });
    // 池层错误不能裸抛崩进程（脊柱：绝不裸露错误码）；记日志由调用方 logger 兜。
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

/** 优雅关闭连接池。 */
export async function closeDb(): Promise<void> {
  await pool?.end().catch(() => undefined);
  pool = undefined;
}

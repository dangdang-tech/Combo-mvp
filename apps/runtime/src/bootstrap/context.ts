// 运行期上下文容器：env + pg 连接池。各路由注册器经它取依赖（避免全局单例散落）。
import type { Pool } from 'pg';
import type { Env } from '../platform/config/env.js';

export interface RuntimeContext {
  env: Env;
  pool: Pool;
}

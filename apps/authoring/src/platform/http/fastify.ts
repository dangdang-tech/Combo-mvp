// Fastify 类型增强：声明中间件注入的请求装饰 + app.infra 基础设施容器。
// 中间件（auth/pairAuth/idempotency）解出的上下文挂到 req；handler 取用类型安全。
import type { AuthContext } from '@cb/shared';
import type { InfraContext } from '../infra/index.js';
import type { PairAuthContext } from '../middleware/pair-auth.js';
import type { IdempotencyContext } from '../middleware/idempotency.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** 基础设施容器（db/redis/queue/objectStore/llm），app.decorate('infra') 注入。 */
    infra: InfraContext;
  }
  interface FastifyRequest {
    /** requireAuth/requireRole/optionalAuth 解出的鉴权上下文（10-auth §4.2）。 */
    auth?: AuthContext;
    /** PairAuth 解出的配对上下文（B-21 本机助手直传）。 */
    pairAuth?: PairAuthContext;
    /** Idempotency-Key 中间件注入的幂等上下文（脊柱 §4）。 */
    idempotency?: IdempotencyContext;
  }
}

export {};

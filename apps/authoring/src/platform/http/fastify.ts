// Fastify 类型增强：声明中间件注入的请求装饰 + app.infra 基础设施容器。
import type { AuthContext } from '@cb/shared';
import type { InfraContext } from '../infra/index.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** 基础设施容器（db/redis/queue/objectStore/llm），app.decorate('infra') 注入。 */
    infra: InfraContext;
  }
  interface FastifyRequest {
    /** requireAuth / requireSseAuth 解出的鉴权上下文。 */
    auth?: AuthContext;
  }
}

export {};

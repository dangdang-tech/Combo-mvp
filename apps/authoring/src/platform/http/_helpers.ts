// 路由公共工具：501 占位 handler（Phase 3 替换为真实业务）+ 端点声明类型。
// 501 统一出 ErrorEnvelope（绝不裸露错误码，脊柱 §11.B）；action:'wait'（功能搭建中、后台态）。
// SSE 端点（jobs/structure）已用真实 handler（握手 + state_snapshot + 心跳 + Last-Event-ID），
//   非 SSE 业务端点继续 501 占位（用同一信封）。
import type {
  FastifyReply,
  FastifyRequest,
  RouteHandlerMethod,
  preHandlerHookHandler,
  RouteOptions,
} from 'fastify';
import { buildError, ErrorCode } from '@cb/shared';

/** 501 占位 handler（本期非 SSE 业务端点共用，Phase 3 逐个替换）。 */
export function notImplemented(req: FastifyRequest, reply: FastifyReply): void {
  reply.code(501).send(
    buildError(ErrorCode.INTERNAL, req.id, {
      userMessage: '这个功能还在搭建中，很快就好。',
      action: 'wait',
      retriable: true,
    }),
  );
}

/**
 * 端点声明：方法 + 路径（不含 API_PREFIX）+ 守卫链（鉴权/幂等 preHandler）+ 可选 handler。
 * 路由路径/方法/鉴权/幂等标注与契约一致（10~70 各域）；
 * 给了 handler（SSE 真实流）则用之，否则 501 占位（非 SSE 业务端点）。
 */
export interface EndpointDecl {
  method: RouteOptions['method'];
  url: string;
  preHandlers?: preHandlerHookHandler[];
  /** 真实 handler（SSE 流用真实实现；缺省 = 501 占位）。 */
  handler?: RouteHandlerMethod;
}

/** 把一组端点声明注册到 scoped 实例（有 handler 用之，否则 501 占位）。 */
export function registerEndpoints(
  scoped: { route: (opts: RouteOptions) => void },
  endpoints: EndpointDecl[],
): void {
  for (const ep of endpoints) {
    scoped.route({
      method: ep.method,
      url: ep.url,
      ...(ep.preHandlers && ep.preHandlers.length > 0 ? { preHandler: ep.preHandlers } : {}),
      handler: ep.handler ?? notImplemented,
    });
  }
}

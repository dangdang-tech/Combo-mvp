// 脊柱通用 · jobs SSE 流 + 取消（脊柱 §5/§6）。
//   - GET /jobs/:jobId/events SSE：requireSseAuth（同源 Cookie，禁 Authorization/query token，脊柱 §11.C）
//     + 建流前 owner 校验（jobSseHandler 内查库，缺 404/非 owner 403）。真实 text/event-stream：
//     首帧 state_snapshot + 15s 心跳 + Last-Event-ID 恢复协议；业务事件源经 redis_hot Streams 桥接（B-12）。
//   - POST /jobs/:jobId/cancel：requireAuth + requireIdempotency（标 cancelled + 换 fence，脊柱 §6.1）。
import type { FastifyInstance } from 'fastify';
import { IdempotencyScope } from '@cb/shared';
import { requireAuth, requireSseAuth } from '../platform/middleware/auth.js';
import { requireIdempotency } from '../platform/middleware/idempotency.js';
import { registerEndpoints, type EndpointDecl } from '../platform/http/_helpers.js';
import { jobSseHandler } from '../platform/http/_sse.js';
import { jobCancelHandler } from './jobs-cancel.js';

export const JOB_ENDPOINTS: EndpointDecl[] = [
  // SSE job 流：建流前 HTTP 鉴权（脊柱 §11.C，同源 Cookie、禁 query/Authorization token）+ owner 校验。
  {
    method: 'GET',
    url: '/jobs/:jobId/events',
    preHandlers: [requireSseAuth()],
    handler: jobSseHandler(),
  },
  {
    method: 'POST',
    url: '/jobs/:jobId/cancel',
    preHandlers: [requireAuth(), requireIdempotency(IdempotencyScope.JOB_CANCEL)],
    handler: jobCancelHandler(),
  },
];

export async function registerJobRoutes(scoped: FastifyInstance): Promise<void> {
  registerEndpoints(scoped, JOB_ENDPOINTS);
}

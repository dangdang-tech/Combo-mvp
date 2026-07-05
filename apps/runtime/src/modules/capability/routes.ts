// 能力域路由（全部 requireAuth）。
//   GET /runtime/capabilities  试用入口列表（我的全部 + 已发布的）
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../../platform/middleware/auth.js';
import { registerEndpoints, type EndpointDecl } from '../../platform/http/_helpers.js';
import { listCapabilitiesHandler } from './handlers.js';

export const CAPABILITY_ENDPOINTS: EndpointDecl[] = [
  {
    method: 'GET',
    url: '/runtime/capabilities',
    preHandlers: [requireAuth()],
    handler: listCapabilitiesHandler(),
  },
];

export async function registerCapabilityRoutes(scoped: FastifyInstance): Promise<void> {
  registerEndpoints(scoped, CAPABILITY_ENDPOINTS);
}

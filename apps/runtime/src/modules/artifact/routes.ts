// 产物域路由（requireAuth）。
//   GET /runtime/artifacts/:id/content  产物内容回读（画布 iframe/渲染源）
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../../platform/middleware/auth.js';
import { registerEndpoints, type EndpointDecl } from '../../platform/http/_helpers.js';
import { artifactContentHandler } from './handlers.js';

export const ARTIFACT_ENDPOINTS: EndpointDecl[] = [
  {
    method: 'GET',
    url: '/runtime/artifacts/:id/content',
    preHandlers: [requireAuth()],
    handler: artifactContentHandler(),
  },
];

export async function registerArtifactRoutes(scoped: FastifyInstance): Promise<void> {
  registerEndpoints(scoped, ARTIFACT_ENDPOINTS);
}

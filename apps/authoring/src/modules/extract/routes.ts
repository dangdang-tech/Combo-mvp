// 30 · 提取域路由（B-22/B-23，30-step2-extract §2）。Phase 3 真实 handler 落位。
//   - extract / candidate.retry：requireRole('creator') + requireIdempotency（幂等行为矩阵在中间件层）。
//   - candidate 读：requireAuth + handler owner 校验。
import type { FastifyInstance } from 'fastify';
import { IdempotencyScope } from '@cb/shared';
import { requireAuth, requireRole } from '../../platform/middleware/auth.js';
import { requireIdempotency } from '../../platform/middleware/idempotency.js';
import { registerEndpoints, type EndpointDecl } from '../../platform/http/_helpers.js';
import {
  triggerExtractHandler,
  listCandidatesHandler,
  getCandidateHandler,
  listEvidenceHandler,
  retryCandidateHandler,
} from './handlers.js';

export const EXTRACT_ENDPOINTS: EndpointDecl[] = [
  {
    method: 'POST',
    url: '/snapshots/:snapshotId/extract',
    preHandlers: [requireRole('creator'), requireIdempotency(IdempotencyScope.EXTRACT_CREATE)],
    handler: triggerExtractHandler(),
  },
  {
    method: 'GET',
    url: '/extract-jobs/:jobId/candidates',
    preHandlers: [requireAuth()],
    handler: listCandidatesHandler(),
  },
  {
    method: 'GET',
    url: '/candidates/:candidateId',
    preHandlers: [requireAuth()],
    handler: getCandidateHandler(),
  },
  {
    method: 'GET',
    url: '/candidates/:candidateId/evidence',
    preHandlers: [requireAuth()],
    handler: listEvidenceHandler(),
  },
  {
    method: 'POST',
    url: '/candidates/:candidateId/retry',
    preHandlers: [requireRole('creator'), requireIdempotency(IdempotencyScope.CANDIDATE_RETRY)],
    handler: retryCandidateHandler(),
  },
];

export async function registerExtractRoutes(scoped: FastifyInstance): Promise<void> {
  registerEndpoints(scoped, EXTRACT_ENDPOINTS);
}

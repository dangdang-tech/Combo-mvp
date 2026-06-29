// 00 · 草稿生命周期路由（脊柱 §8，开工总纲 §5.0；Codex phase4c P0-2）。
//   - POST /drafts（草稿 bootstrap）：requireRole('creator')（创作者向导基线）+ requireIdempotency(draft.create)。
//   - GET  /drafts/:draftId（读完整 DraftView，续传 hydrate）：requireAuth（handler 内 owner 守门）。
//   逐步推进（snapshot/extract/version/capability/batch 回填同一 draft）由各域写路径同事务/同 worker 内回填——
//     不另开「逐步推进」HTTP 端点（落点跟随各步既有写动作，§8.4 续传回精确断点）。
import type { FastifyInstance } from 'fastify';
import { IdempotencyScope } from '@cb/shared';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { requireIdempotency } from '../middleware/idempotency.js';
import { registerEndpoints, type EndpointDecl } from './_helpers.js';
import { createDraftHandler, getDraftHandler } from './drafts-handlers.js';

export const DRAFT_ENDPOINTS: EndpointDecl[] = [
  // 草稿 bootstrap（fresh flow 续传基线）：creator 角色 + 幂等（重复点新建回放同一 draftId）。
  {
    method: 'POST',
    url: '/drafts',
    preHandlers: [requireRole('creator'), requireIdempotency(IdempotencyScope.DRAFT_CREATE)],
    handler: createDraftHandler(),
  },
  // 读完整 DraftView（续传 hydrate）：requireAuth + handler owner 守门。
  {
    method: 'GET',
    url: '/drafts/:draftId',
    preHandlers: [requireAuth()],
    handler: getDraftHandler(),
  },
];

export async function registerDraftRoutes(scoped: FastifyInstance): Promise<void> {
  registerEndpoints(scoped, DRAFT_ENDPOINTS);
}

// 50 · 发布域路由（B-26~B-28 + B-30，50-step5-publish §3）。
//   - publish.version：requireRole('creator') + requireIdempotency（脊柱 §4.1）。
//   - publish.review（评审裁决，B-30 / §2.6）：requireReviewer（reviewer 角色 + 禁创作者自审，Codex#7）
//     + requireIdempotency。评审是运营/审核侧动作，不在创作者向导内。
//   - market-card/preview：「带请求体只读」POST，Idempotency 豁免（脊柱 §4.1）。
//   - publications 读：requireAuth + handler owner 校验。
//   批量发布（B-29）已整体移除（2026-07-04），发布入口占位待 Task 重构。
import type { FastifyInstance } from 'fastify';
import { IdempotencyScope, IdempotencyOptionalScope } from '@cb/shared';
import { requireAuth, requireRole, requireReviewer } from '../../platform/middleware/auth.js';
import { optionalIdempotency, requireIdempotency } from '../../platform/middleware/idempotency.js';
import { registerEndpoints, type EndpointDecl } from '../../platform/http/_helpers.js';
import { publishVersionHandler, marketCardPreviewHandler } from './handlers.js';
import { reviewDecisionHandler, getPublicationHandler } from './review-handlers.js';

export const PUBLISH_ENDPOINTS: EndpointDecl[] = [
  // §2.1 · 发布单个能力（B-27/B-28，同步事务）。
  {
    method: 'POST',
    url: '/versions/:versionId/publish',
    preHandlers: [requireRole('creator'), requireIdempotency(IdempotencyScope.PUBLISH_VERSION)],
    handler: publishVersionHandler(),
  },
  // §2.2 · 市集卡预览（B-28）：只算预览、不写库 → Idempotency 豁免（脊柱 §4.1）。
  {
    method: 'POST',
    url: '/versions/:versionId/market-card/preview',
    preHandlers: [
      requireRole('creator'),
      optionalIdempotency(IdempotencyOptionalScope.MARKET_CARD_PREVIEW),
    ],
    handler: marketCardPreviewHandler(),
  },
  {
    method: 'POST',
    url: '/publications/:capabilityId/review',
    // 评审角色 + 禁创作者自审（50 §2.6 / Codex#7），非创作者角色。
    preHandlers: [requireReviewer(), requireIdempotency(IdempotencyScope.PUBLISH_REVIEW)],
    handler: reviewDecisionHandler(),
  },
  {
    method: 'GET',
    url: '/publications/:capabilityId',
    preHandlers: [requireAuth()],
    handler: getPublicationHandler(),
  },
];

export async function registerPublishRoutes(scoped: FastifyInstance): Promise<void> {
  registerEndpoints(scoped, PUBLISH_ENDPOINTS);
}

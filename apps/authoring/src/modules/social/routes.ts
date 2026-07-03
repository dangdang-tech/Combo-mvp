// 60 · 社交（关注/点赞）域路由（B-34，60-dashboard-profile §3）。
//   社交写（follow/like 及 DELETE 取消）：requireAuth（任意已登录用户，脊柱 §11.F）+ requireIdempotency——【已实现】真实写路径。
//   原与 dashboard/profile 同声明于 routes/dashboard.ts，按域拆出本文件，由 routes/index.ts 单独注册。
import type { FastifyInstance } from 'fastify';
import { IdempotencyScope } from '@cb/shared';
import { requireAuth } from '../../platform/middleware/auth.js';
import { requireIdempotency } from '../../platform/middleware/idempotency.js';
import { registerEndpoints, type EndpointDecl } from '../../platform/http/_helpers.js';
import { followHandler, unfollowHandler, likeHandler, unlikeHandler } from './handlers.js';

export const SOCIAL_ENDPOINTS: EndpointDecl[] = [
  // 社交写（B-34）：requireAuth（任意登录用户，脊柱 §11.F）+ Idempotency（POST/DELETE 都带 key）——已实现真实写路径。
  {
    method: 'POST',
    url: '/creators/:creatorId/follows',
    preHandlers: [requireAuth(), requireIdempotency(IdempotencyScope.SOCIAL_FOLLOW)],
    handler: followHandler(),
  },
  {
    method: 'DELETE',
    url: '/creators/:creatorId/follows',
    preHandlers: [requireAuth(), requireIdempotency(IdempotencyScope.SOCIAL_UNFOLLOW)],
    handler: unfollowHandler(),
  },
  {
    method: 'POST',
    url: '/capabilities/:capabilityId/likes',
    preHandlers: [requireAuth(), requireIdempotency(IdempotencyScope.SOCIAL_LIKE)],
    handler: likeHandler(),
  },
  {
    method: 'DELETE',
    url: '/capabilities/:capabilityId/likes',
    preHandlers: [requireAuth(), requireIdempotency(IdempotencyScope.SOCIAL_UNLIKE)],
    handler: unlikeHandler(),
  },
];

export async function registerSocialRoutes(scoped: FastifyInstance): Promise<void> {
  registerEndpoints(scoped, SOCIAL_ENDPOINTS);
}

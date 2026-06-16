// 60 · 工作台 + 个人主页 + 社交域路由（B-30~B-35，60-dashboard-profile §3）。
//   - dashboard/*（B-32 工作台聚合）：requireAuth + handler owner 校验（私有经营数据，只对本人可见，外壳首页-20）——【已实现】真实读路径。
//   - creators/:id/profile + 公开读（B-33 全六分区 P0）：optionalAuth（公开只读、访客同视图，主页-13）——【已实现】真实读路径。
//   - 社交写（follow/like 及 DELETE 取消，B-34）：requireAuth（任意已登录用户，脊柱 §11.F）+ requireIdempotency——【已实现】真实写路径。
import type { FastifyInstance } from 'fastify';
import { IdempotencyScope } from '@cb/shared';
import { optionalAuth, requireAuth } from '../middleware/auth.js';
import { requireIdempotency } from '../middleware/idempotency.js';
import { registerEndpoints, type EndpointDecl } from './_helpers.js';
import {
  dashboardSummaryHandler,
  dashboardMetricsHandler,
  dashboardTokenTrendHandler,
  dashboardCapabilitiesHandler,
  dashboardDraftsHandler,
} from './dashboard-handlers.js';
import {
  getCreatorProfileHandler,
  getDensityHandler,
  getHeatmapHandler,
  getNetworkHandler,
  getWorksHandler,
} from './profile-handlers.js';
import { followHandler, unfollowHandler, likeHandler, unlikeHandler } from './social-handlers.js';

export const DASHBOARD_ENDPOINTS: EndpointDecl[] = [
  // 工作台（私有，requireAuth + handler owner=本人；B-32 已实现真实读路径）。
  {
    method: 'GET',
    url: '/dashboard/summary',
    preHandlers: [requireAuth()],
    handler: dashboardSummaryHandler(),
  },
  {
    method: 'GET',
    url: '/dashboard/metrics',
    preHandlers: [requireAuth()],
    handler: dashboardMetricsHandler(),
  },
  {
    method: 'GET',
    url: '/dashboard/token-trend',
    preHandlers: [requireAuth()],
    handler: dashboardTokenTrendHandler(),
  },
  {
    method: 'GET',
    url: '/dashboard/capabilities',
    preHandlers: [requireAuth()],
    handler: dashboardCapabilitiesHandler(),
  },
  {
    method: 'GET',
    url: '/dashboard/drafts',
    preHandlers: [requireAuth()],
    handler: dashboardDraftsHandler(),
  },
  // 公开主页（B-33 全六分区 P0，optionalAuth：公开只读、访客同视图，主页-13）。viewerId 仅切 Hero.viewerIsFollowing。
  {
    method: 'GET',
    url: '/creators/:creatorId/profile',
    preHandlers: [optionalAuth()],
    handler: getCreatorProfileHandler(),
  },
  {
    method: 'GET',
    url: '/creators/:creatorId/capabilities',
    preHandlers: [optionalAuth()],
    handler: getDensityHandler(),
  },
  {
    method: 'GET',
    url: '/creators/:creatorId/heatmap',
    preHandlers: [optionalAuth()],
    handler: getHeatmapHandler(),
  },
  {
    method: 'GET',
    url: '/creators/:creatorId/network',
    preHandlers: [optionalAuth()],
    handler: getNetworkHandler(),
  },
  {
    method: 'GET',
    url: '/creators/:creatorId/works',
    preHandlers: [optionalAuth()],
    handler: getWorksHandler(),
  },
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

export async function registerDashboardRoutes(scoped: FastifyInstance): Promise<void> {
  registerEndpoints(scoped, DASHBOARD_ENDPOINTS);
}

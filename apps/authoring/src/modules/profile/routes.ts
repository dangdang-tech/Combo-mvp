// 60 · 个人主页（公开只读）域路由（B-33 全六分区 P0，60-dashboard-profile §3）。
//   creators/:id/profile + 各分区（capabilities/heatmap/network/works）：optionalAuth（公开只读、访客同视图，主页-13）——【已实现】真实读路径。
//     viewerId 仅切 Hero.viewerIsFollowing。
//   原与 dashboard/social 同声明于 routes/dashboard.ts，按域拆出本文件，由 routes/index.ts 单独注册。
import type { FastifyInstance } from 'fastify';
import { optionalAuth } from '../../platform/middleware/auth.js';
import { registerEndpoints, type EndpointDecl } from '../../platform/http/_helpers.js';
import {
  getCreatorProfileHandler,
  getDensityHandler,
  getHeatmapHandler,
  getNetworkHandler,
  getWorksHandler,
} from './handlers.js';

export const PROFILE_ENDPOINTS: EndpointDecl[] = [
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
];

export async function registerProfileRoutes(scoped: FastifyInstance): Promise<void> {
  registerEndpoints(scoped, PROFILE_ENDPOINTS);
}

// 60 · 工作台域路由（B-30~B-32，60-dashboard-profile §3）。
//   - dashboard/*（B-32 工作台聚合）：requireAuth + handler owner 校验（私有经营数据，只对本人可见，外壳首页-20）——【已实现】真实读路径。
//   profile（公开主页）与 social（关注/点赞）端点已拆出各自模块（modules/profile/routes.ts、modules/social/routes.ts），
//     由 routes/index.ts 分别注册——本文件只声明工作台端点，关注点单一。
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../../platform/middleware/auth.js';
import { registerEndpoints, type EndpointDecl } from '../../platform/http/_helpers.js';
import {
  dashboardSummaryHandler,
  dashboardMetricsHandler,
  dashboardTokenTrendHandler,
  dashboardCapabilitiesHandler,
  dashboardDraftsHandler,
} from './handlers.js';

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
];

export async function registerDashboardRoutes(scoped: FastifyInstance): Promise<void> {
  registerEndpoints(scoped, DASHBOARD_ENDPOINTS);
}

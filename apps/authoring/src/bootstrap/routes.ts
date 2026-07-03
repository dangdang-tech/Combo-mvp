// 业务路由聚合（10~70 各域）。全部挂在 API_PREFIX 下（脊柱 §1.1）。
// 各域端点路径/方法/鉴权/幂等标注与契约一致；handler 本期 501 占位（Phase 3 逐功能点填充）。
import type { FastifyInstance } from 'fastify';
import { API_PREFIX } from '@cb/shared';
import { registerAuthRoutes, AUTH_ENDPOINTS } from '../modules/account/index.js';
import { registerDraftRoutes, DRAFT_ENDPOINTS } from '../modules/drafts/index.js';
import { registerImportRoutes, IMPORT_ENDPOINTS } from '../modules/import/index.js';
import { registerExtractRoutes, EXTRACT_ENDPOINTS } from '../modules/extract/index.js';
import { registerStructureRoutes, STRUCTURE_ENDPOINTS } from '../modules/structure/index.js';
import { registerPublishRoutes, PUBLISH_ENDPOINTS } from '../modules/publish/index.js';
import { registerDashboardRoutes, DASHBOARD_ENDPOINTS } from '../modules/dashboard/index.js';
import { registerProfileRoutes, PROFILE_ENDPOINTS } from '../modules/profile/index.js';
import { registerSocialRoutes, SOCIAL_ENDPOINTS } from '../modules/social/index.js';
import {
  registerNotificationRoutes,
  NOTIFICATION_ENDPOINTS,
} from '../modules/notifications/index.js';
import { registerJobRoutes, JOB_ENDPOINTS } from './jobs-routes.js';
import { registerClientEventRoutes } from '../platform/http/client-events.js';
import type { EndpointDecl } from '../platform/http/_helpers.js';

/** 全部业务端点声明汇总（供守门/测试核对端点数、方法、鉴权链）。 */
export const ALL_ENDPOINTS: EndpointDecl[] = [
  ...AUTH_ENDPOINTS,
  ...DRAFT_ENDPOINTS,
  ...IMPORT_ENDPOINTS,
  ...EXTRACT_ENDPOINTS,
  ...STRUCTURE_ENDPOINTS,
  ...PUBLISH_ENDPOINTS,
  ...DASHBOARD_ENDPOINTS,
  ...PROFILE_ENDPOINTS,
  ...SOCIAL_ENDPOINTS,
  ...NOTIFICATION_ENDPOINTS,
  ...JOB_ENDPOINTS,
];

/** 注册全部业务路由（API_PREFIX 子作用域）。 */
export async function registerBusinessRoutes(app: FastifyInstance): Promise<void> {
  await app.register(
    async (scoped) => {
      await registerAuthRoutes(scoped); // 10
      await registerDraftRoutes(scoped); // 00 草稿生命周期（bootstrap + 续传 hydrate）
      await registerImportRoutes(scoped); // 20
      await registerExtractRoutes(scoped); // 30
      await registerStructureRoutes(scoped); // 40
      await registerPublishRoutes(scoped); // 50
      await registerDashboardRoutes(scoped); // 60 工作台（私有）
      await registerProfileRoutes(scoped); // 60 个人主页（公开只读）
      await registerSocialRoutes(scoped); // 60 社交写（关注/点赞）
      await registerNotificationRoutes(scoped); // 70 通知
      await registerJobRoutes(scoped); // 脊柱通用（jobs SSE + cancel）
      await registerClientEventRoutes(scoped); // 浏览器侧错误/调试事件（只落结构化日志）
    },
    { prefix: API_PREFIX },
  );
}

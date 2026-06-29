// 业务路由聚合（10~70 各域）。全部挂在 API_PREFIX 下（脊柱 §1.1）。
// 各域端点路径/方法/鉴权/幂等标注与契约一致；handler 本期 501 占位（Phase 3 逐功能点填充）。
import type { FastifyInstance } from 'fastify';
import { API_PREFIX } from '@cb/shared';
import { registerAuthRoutes, AUTH_ENDPOINTS } from './auth.js';
import { registerDraftRoutes, DRAFT_ENDPOINTS } from './drafts.js';
import { registerImportRoutes, IMPORT_ENDPOINTS } from './import.js';
import { registerExtractRoutes, EXTRACT_ENDPOINTS } from './extract.js';
import { registerStructureRoutes, STRUCTURE_ENDPOINTS } from './structure.js';
import { registerPublishRoutes, PUBLISH_ENDPOINTS } from './publish.js';
import { registerDashboardRoutes, DASHBOARD_ENDPOINTS } from './dashboard.js';
import { registerNotificationRoutes, NOTIFICATION_ENDPOINTS } from './notifications.js';
import { registerJobRoutes, JOB_ENDPOINTS } from './jobs.js';
import type { EndpointDecl } from './_helpers.js';

/** 全部业务端点声明汇总（供守门/测试核对端点数、方法、鉴权链）。 */
export const ALL_ENDPOINTS: EndpointDecl[] = [
  ...AUTH_ENDPOINTS,
  ...DRAFT_ENDPOINTS,
  ...IMPORT_ENDPOINTS,
  ...EXTRACT_ENDPOINTS,
  ...STRUCTURE_ENDPOINTS,
  ...PUBLISH_ENDPOINTS,
  ...DASHBOARD_ENDPOINTS,
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
      await registerDashboardRoutes(scoped); // 60
      await registerNotificationRoutes(scoped); // 70 通知
      await registerJobRoutes(scoped); // 脊柱通用（jobs SSE + cancel）
    },
    { prefix: API_PREFIX },
  );
}

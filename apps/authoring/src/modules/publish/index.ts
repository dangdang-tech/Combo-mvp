// publish（发布）域唯一对外出口（跨域只 import 本文件，不深入模块内部文件）。
//   被依赖方：routes/index.ts 注册路由、jobs/handlers/index.ts 注册 worker handler、
//             dashboard 域 repo/view 复用发布展示态推导（合法下游→上游，单向）。
export { PUBLISH_ENDPOINTS, registerPublishRoutes } from './routes.js';
export { createPublishBatchHandler } from './job.js';

// 市集读模型投影（消费 capability.* lifecycle 事件写 marketplace_listings）。
//   由 processes/event-routes.ts 组装进 consumer 路由表（机制 import 业务 processor，单向）。
export { marketplaceProjection } from './projection.js';

// dashboard 域复用的发布展示态推导/谓词（下游 → 上游，单向）。
export { derivePublicationDisplayState, displayStatePredicateSql } from './publication-repo.js';

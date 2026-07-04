// drafts 域唯一对外出口（仓库规范：跨域只 import 本文件，不深入模块内部文件）。
//   被依赖方：import 域 job 回填快照、bootstrap 注册路由。
export { createDraft, readDraftView, backfillDraftSnapshot, backfillDraftExtract } from './repo.js';
export { DRAFT_ENDPOINTS, registerDraftRoutes } from './routes.js';

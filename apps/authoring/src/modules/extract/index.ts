// extract 域唯一对外出口（跨域只 import 本文件，不深入模块内部文件）。
//   被依赖方：routes/index.ts 注册路由、jobs/handlers/index.ts 注册 worker handler。
export { EXTRACT_ENDPOINTS, registerExtractRoutes } from './routes.js';
export { createExtractHandler } from './job.js';

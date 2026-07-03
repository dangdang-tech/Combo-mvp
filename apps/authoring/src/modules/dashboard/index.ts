// dashboard（工作台）域唯一对外出口（跨域只 import 本文件，不深入模块内部文件）。
//   被依赖方：routes/index.ts 注册工作台路由。
export { DASHBOARD_ENDPOINTS, registerDashboardRoutes } from './routes.js';

// profile（个人主页，公开只读）域唯一对外出口（跨域只 import 本文件，不深入模块内部文件）。
//   被依赖方：routes/index.ts 注册公开主页路由。
export { PROFILE_ENDPOINTS, registerProfileRoutes } from './routes.js';

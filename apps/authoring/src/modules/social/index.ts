// social（关注/点赞）域唯一对外出口（跨域只 import 本文件，不深入模块内部文件）。
//   被依赖方：routes/index.ts 注册社交写路由。
export { SOCIAL_ENDPOINTS, registerSocialRoutes } from './routes.js';

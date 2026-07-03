// account（账号 / 登录）域唯一对外出口（10 · Auth/Logto，B-08）。
//   登录流编排（OIDC 回调/PKCE/首登 provision/cb_session/me/角色）的业务面；底层 verifyJwt/中间件在
//   platform/middleware、Logto 客户端/users provision/dev-session 在 platform/infra——account 只做业务编排。
//   被依赖方：bootstrap/routes.ts 注册 /auth·/me 路由；bootstrap/app.ts 条件注册 dev-login（仅 dev/test 守卫）。
export {
  AUTH_ENDPOINTS,
  registerAuthRoutes,
  DEV_AUTH_ENDPOINTS,
  registerDevAuthRoutes,
} from './routes.js';

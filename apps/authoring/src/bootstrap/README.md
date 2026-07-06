# bootstrap — api 进程组装层

这个目录负责把 Fastify 应用组装起来：注入基础设施容器、挂全局插件与统一错误处理、注册健康检查和全部业务路由。api 进程入口只需要调 buildApp 再 listen。

## 文件

- `app.ts` 是 Fastify 应用工厂：加载环境配置，创建带结构化日志和 traceId 的 Fastify 实例，把 buildInfra 组装的基础设施容器挂到 app.infra，把 account 域的 provisionUser 以 app.decorate 注入给 platform 鉴权中间件（依赖反转：platform 不 import 业务域，接线在组合根做），注册 helmet、cors、cookie、限流四个全局插件，设置统一错误信封（对外只出人话错误体，内部错误码和堆栈只进日志）和 404 处理，注册健康检查与业务路由，并在 dev/test 且开关打开时条件注册种子登录端点，最后挂进程退出时关闭数据库、Redis、队列、对象存储连接的钩子。
- `routes.ts` 是业务路由聚合器：把 account、task、capability 三个模块的路由外加浏览器侧错误上报端点统一挂到 `/api/v1` 前缀下，并导出 ALL_ENDPOINTS 全量端点声明清单供测试核对端点数、方法和鉴权链。

## 上下游

被谁使用：`processes/api.ts` 在启动时动态加载 `app.ts` 的 buildApp；集成测试也用 buildApp 起内存应用。

依赖什么：`app.ts` 引用 `platform/config/env.ts`（配置）、`platform/infra/index.ts`（基础设施容器与关闭函数）、`platform/http/health.ts`（健康检查路由）、`platform/http/fastify.ts`（类型增强）、`platform/infra/dev-session.ts`（种子登录开关判定）、`platform/observability/node.ts`（traceId 工具）、`platform/middleware/auth.ts`（ProvisionUserFn 类型）、`modules/account/routes.ts`（种子登录路由）、`modules/account/repo.ts`（provisionUser 实现，注入用）；`routes.ts` 引用三个模块的 routes 文件、`platform/http/client-events.ts` 和 `platform/http/_helpers.ts`。错误码、traceId 工具、API 前缀等常量来自共享包 `@cb/shared`。本层自己不直接访问数据库或 Redis，只负责把客户端实例注入给下游。

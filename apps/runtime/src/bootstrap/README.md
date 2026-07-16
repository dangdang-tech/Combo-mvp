# bootstrap —— 应用组装

这个目录负责把散落在 platform 层和 modules 层的零件组装成一个可监听端口的 Fastify 应用：建基础设施容器、装全局插件、定统一错误信封、挂健康检查和全部业务路由。

## 文件

- `app.ts` 提供 buildApp 工厂函数：加载环境变量，建 Fastify 实例，把基础设施容器挂成 app.infra、把带 Redis 打断广播和周期孤儿清扫的轮次编排器挂成 app.turns，注册跨域和 Cookie 插件，给每个请求分配并回写 traceId，设置统一错误处理器，最后注册健康检查路由和业务路由。应用关闭时先停止轮次清扫并退订广播，再关闭基础设施连接。
- `routes.ts` 汇总三个业务模块的端点声明为 ALL_ENDPOINTS（供测试核对端点数与鉴权链），并把 capability、session、artifact 三组路由和浏览器事件上报路由统一注册在 API 前缀之下。

## 上下游

被谁使用：`processes/api.ts` 在启动时调用 buildApp；集成测试也直接用 buildApp 建应用。

依赖什么：`app.ts` 引用 `platform/config/env.ts`（环境变量）、`platform/infra/index.ts`（数据库、对象存储、事件总线容器）、`platform/http/health.ts`（健康检查）、`platform/observability/node.ts`（trace 字段）、`modules/agent/run-turn.ts` 与 `modules/agent/build-agent.ts`（轮次编排器及其模型代理工厂），并以副作用方式引入 `platform/http/fastify.ts` 注册类型增强。`routes.ts` 引用三个模块各自的 routes 文件和 `platform/http/client-events.ts`。

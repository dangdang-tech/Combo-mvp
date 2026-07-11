# platform/http — HTTP 公共工具

这个目录放路由层的公共工具：端点声明与注册、统一错误信封回复、健康检查路由、浏览器侧错误上报端点，以及 Fastify 的类型增强。

## 文件

- `_helpers.ts` 提供 sendError（按内部错误码组装对外错误信封并回复，绝不裸露内部码和堆栈）、EndpointDecl 端点声明类型和 registerEndpoints 批量注册函数，是各模块 routes.ts 的统一注册方式。
- `browser-origin.ts` 从 `LOGTO_REDIRECT_URI` 推导生产 canonical origin，为 CORS 做精确白名单；dev/test 仅额外放行 5173/5174 的 localhost/127.0.0.1。它还为 refresh/logout/dev-login 提供 Cookie 变更来源守卫，通过 Origin + `Sec-Fetch-Site` 在执行 handler 前拒绝未获准的同站跨源与跨站请求；无 Origin 的服务端/CLI 仍兼容。
- `health.ts` 注册两个不带 /api/v1 前缀的探针路由：GET /health 只报进程活着；GET /ready 并发探测数据库、两个 Redis、MinIO、Logto 五个必需依赖，任一挂了返回 503；大模型只标降级不影响就绪判定。
- `client-events.ts` 注册 POST /client-events：接收浏览器上报的接口报错、SSE 断流、window 错误等事件，截断后只写结构化日志（按 traceId 关联），一律返回 204。
- `fastify.ts` 是纯类型文件：给 Fastify 声明 app.infra（基础设施容器）和 req.auth（鉴权上下文）两个装饰字段，由 `bootstrap/app.ts` 以副作用 import 引入。

## 上下游

被谁使用：`bootstrap/app.ts` 注册 health.ts 的探针路由并 import fastify.ts 的类型增强；`bootstrap/routes.ts` 挂载 client-events.ts 的上报端点；三个业务模块的 routes.ts 和 handlers.ts 以及 `platform/middleware/auth.ts` 都用 \_helpers.ts 的 sendError 和 registerEndpoints。

依赖什么：health.ts 调 `platform/infra/` 各文件的探针函数（pingDb、pingRedis、pingObjectStore、probeLogto、probeLlm），间接触达 PostgreSQL、Redis、MinIO、Logto；client-events.ts 用 `platform/observability/node.ts` 的日志字段工具；错误码与信封组装来自共享包 `@cb/shared`。

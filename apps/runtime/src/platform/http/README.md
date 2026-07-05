# platform/http —— HTTP 公共设施

这个目录放与路由相关但不属于任何业务模块的公共代码：端点声明与注册工具、统一错误回复、Fastify 类型增强、健康检查路由和浏览器事件上报路由。

## 文件

- `_helpers.ts` 定义端点声明的统一形态 EndpointDecl（方法、路径、鉴权守卫链、处理器）和批量注册函数 registerEndpoints，并提供 sendError：按内部错误码生成对外错误信封，绝不裸露内部错误码或堆栈。
- `fastify.ts` 是纯类型声明文件：给 Fastify 补上 app.infra（基础设施容器）、app.turns（轮次编排器）和 req.auth（鉴权上下文）三个装饰的类型，由 `bootstrap/app.ts` 以副作用方式引入。
- `health.ts` 注册两个不带 API 前缀的探针路由：GET /health 只报进程活着；GET /ready 并发探测数据库、对象存储、登录服务三个必需依赖和模型密钥这一个可降级依赖，任一必需依赖不可用就返回 503。
- `client-events.ts` 注册 POST /client-events：接收浏览器侧上报的接口报错、流式连接报错、页面异常等事件，只写结构化日志（经 traceId 关联排障），无论内容合法与否一律返回 204。

## 上下游

被谁使用：三个业务模块的 routes 文件和 `modules/agent/stream.ts`、`platform/middleware/auth.ts` 都用 `_helpers.ts`；`bootstrap/app.ts` 引入 `fastify.ts` 与 `health.ts`；`bootstrap/routes.ts` 把 `client-events.ts` 挂进 API 前缀。

依赖什么：`health.ts` 引用 `platform/infra/` 里四个探针函数；`client-events.ts` 引用 `platform/observability/node.ts` 的 trace 日志字段；`fastify.ts` 引用 `platform/infra/index.ts` 与 `modules/agent/run-turn.ts` 的类型。错误码与信封的定义都来自共享包 @cb/shared。

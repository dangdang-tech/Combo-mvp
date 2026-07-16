# runtime 服务源码总览

runtime 是能力试用端的后端服务：用户挑一个创作端做好的能力，在这里开会话、发消息、看模型流式生成回复和产物。整个服务只有一个 HTTP 进程，对话生成在进程内异步执行。

## 文件

- `index.ts` 是包的默认入口，它只做一件事：加载 `processes/api.js`，把服务当 api 进程启动。

## 四层布局

- `bootstrap/` 负责组装：把基础设施容器、轮次编排器、全局插件、错误信封、健康检查和业务路由拼成一个完整的 Fastify 应用。
- `processes/` 是进程入口层：目前只有一个 api 进程，负责起观测、建应用、监听端口、处理退出信号。
- `modules/` 是业务模块层：按领域分成 capability（能力）、session（会话）、artifact（产物）、agent（对话轮次）四个模块，路由、处理器、数据访问都收在各自模块内。
- `platform/` 是平台层：环境变量、数据库连接池、对象存储、登录态验签、鉴权中间件、路由工具、观测接线，供上面三层公用。

## 一条最典型请求的完整路径

以「用户在会话里发一条消息」（POST /api/v1/runtime/sessions/:id/messages）为例：

1. 请求进入 `bootstrap/app.ts` 建好的 Fastify 应用，先被分配 traceId 并写进响应头。
2. 路由在 `modules/session/routes.ts` 里声明，前置守卫是 `platform/middleware/auth.ts` 的 requireAuth，它验登录 Cookie 并查 users 表，把用户身份挂到请求上。
3. `modules/session/handlers.ts` 的 sendMessageHandler 校验请求体，用 `modules/session/repo.ts` 按 owner 查会话行。
4. handler 调 `modules/capability/loader.ts` 重新加载该会话对应的能力定义（查 capabilities 表、从对象存储读定义 JSON、过 schema 校验）。
5. handler 调 `modules/agent/run-turn.ts` 的 startTurn：创建独立轮次并写入轮内用户消息，然后立即回 202，生成在本进程内异步继续；同一会话的多个轮次可以并发自治运行。
6. 异步轮次里，`modules/agent/build-agent.ts` 用能力定义和历史消息构造模型代理，模型输出的每个事件由 `modules/agent/turn-emitter.ts` 先追加到 Redis Stream，再发布跨实例直播通知。
7. 前端另开着 GET /runtime/sessions/:id/stream 长连接（`modules/agent/stream.ts`），实时收到这些事件并从 Redis Stream 补发漏帧；轮次结束时整轮回复落 messages 表。

# authoring 服务源码总览

这是 Combo 创作侧后端服务：创作者登录后建任务，可以让云端 Worker 读取上传的 Claude / Codex 对话历史，也可以让本地 Worker 在用户机器上完成提取；两种模式最终都写入同一套能力定义、能力索引和发布状态。创作者随后可以审阅并发布能力项。对外提供 HTTP 接口和进度推送（SSE，服务器单向事件流），路由前缀是 `/api/v1`。

## 四层布局

- `processes/`：进程入口。同一份代码按环境变量分成 api 进程（对外 HTTP 服务）和 worker 进程（后台消费队列跑提取流水线）两个进程运行。
- `bootstrap/`：api 进程的组装层。构建 Fastify 应用，挂全局插件、统一错误信封、健康检查和全部业务路由。
- `modules/`：业务模块层，按领域分三个模块：account（登录与用户）、task（任务、云端上传和本地执行）、capability（能力项与共享持久化）。
- `platform/`：平台层，与具体业务无关的公共设施：配置加载、HTTP 工具、基础设施客户端（数据库、Redis、队列、对象存储、大模型网关、登录服务）、鉴权中间件、链路追踪、SSE 推流、文本工具。

依赖方向是单向的：processes 用 bootstrap 和 modules，bootstrap 用 modules 和 platform，modules 用 platform，platform 不反向依赖任何业务代码。类型契约、错误码、Zod 校验等公共定义来自仓库内共享包 `@cb/shared`。

## 文件

- `index.ts` 是默认入口，只做一件事：加载 `processes/api.ts`，即本地直跑时默认起 api 进程。

## 一条最典型请求的完整路径（助手上传一片对话历史）

1. 本机助手脚本向 `POST /api/v1/connect/upload` 发一片文本，带配对码。
2. `bootstrap/app.ts` 建好的 Fastify 应用接到请求，生成或继承 traceId，路由匹配到 `modules/task/routes.ts` 里注册的端点。
3. `modules/task/handlers.ts` 的上传 handler 校验请求体，然后调 `modules/task/pairing.ts` 的 landPart。
4. landPart 先按配对码哈希查 uploads 表验码，再把分片内容写进 MinIO 的原始件桶，并在 uploads.parts 里登记这一片。
5. 如果这一片让分片收齐了，landPart 把所有分片按序拼成完整原始件写回 MinIO，把 uploads 置为 raw，经 `modules/task/service.ts` 的 transition（乐观锁）把任务从 upload 步流转到 extract 步，并向 BullMQ 队列投递该任务。
6. worker 进程（`processes/worker.ts`）消费到这个任务，执行 `modules/task/pipeline.ts` 的提取流水线：拉原文、解析切段、脱敏、喂大模型归纳、逐项写能力项到 capabilities 表和 MinIO，进度帧同步推到 Redis 流。
7. 浏览器通过 `GET /api/v1/tasks/:taskId/events`（`modules/task/sse.ts`）订阅进度，实时看到子任务点亮直到 done。

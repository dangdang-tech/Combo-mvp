# platform — 平台层

这个目录放与具体业务无关的公共设施，按职责分成八个子目录：`config/` 加载并校验环境变量；`http/` 放路由注册工具、健康检查、浏览器错误上报和 Fastify 类型增强；`infra/` 放各外部依赖的客户端与端口实现（PostgreSQL、Redis、BullMQ 队列、MinIO 对象存储、Logto 登录服务、分布式锁、dev 种子会话），其中 `infra/llm/` 是带限流、超时、重试、降级和审计的大模型网关；`middleware/` 放鉴权中间件；`observability/` 放链路追踪（OpenTelemetry）与 traceId 工具；`sse/` 放 SSE 建流协议和基于 Redis 流的进度桥；`text/` 放会话噪声识别的纯函数。

平台层只被上层使用：bootstrap 用它组装应用，modules 用它访问数据库、队列、对象存储和大模型，processes 用它起进程级设施。它自己不 import 任何 modules 或 bootstrap 代码，公共类型与端口契约来自共享包 `@cb/shared`。

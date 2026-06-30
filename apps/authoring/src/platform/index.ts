// platform 唯一对外出口（领域无关机制层）。业务侧（modules/、processes/、bootstrap/）按机制从此处或
//   对应子路径 import；platform 内不得 import 任何 modules/<域>（分层单向：业务 → 机制，机制不依赖业务）。
//   收口：基础设施容器(infra/buildInfra)、事件引擎(events)、任务执行框架(jobs)、鉴权/幂等中间件(middleware)、
//         SSE 流(sse)、HTTP 工具(http)、配置(config)。
//   事件管道的 topic→processor 业务路由表不在此（它 import 业务 processor，属组合根，放 processes/event-routes）。

// —— 配置 ——（env schema + loadEnv）
export { loadEnv, type Env } from './config/env.js';

// —— 基础设施 ——（PG/Redis/Queue/ObjectStore/LLM 网关/Logto 客户端容器 + 各端口）
export { buildInfra, type InfraContext } from './infra/index.js';
export * from './infra/db.js';
export * from './infra/redis.js';
export * from './infra/queue.js';
export * from './infra/object-store.js';
export * from './infra/llm-gateway.js';
export * from './infra/logto.js';
export * from './infra/logto-oidc.js';
// users-repo 自带一份最小 QueryableDb（与 events/db-tx 同名）；从 events 引擎统一导出该类型，
//   此处仅再导出 provision/me 业务面，避免 barrel 重复导出 QueryableDb 冲突。
export {
  provisionUser,
  readMeRow,
  type ProvisionInput,
  type ProvisionedUser,
  type MeRow,
} from './infra/users-repo.js';
export * from './infra/dev-session.js';
export * from './infra/lock.js';

// —— 事件管道引擎 ——（outbox / consumer 框架 / sweeper 框架 / 单实例锁 / 事务）
export * from './events/index.js';

// —— 任务执行框架 ——（types/repo/runner/registry/sweeper-reconcile）
export * from './jobs/index.js';

// —— 中间件 ——（鉴权 / 幂等 / 配对鉴权）
export * from './middleware/auth.js';
export * from './middleware/idempotency.js';
export * from './middleware/pair-auth.js';

// —— SSE 流 ——（worker→api 进度桥 + SSE 帧/握手工具）
export * from './sse/sse.js';
export { RedisEventStream } from './sse/event-stream.js';

// —— HTTP 工具 ——（端点声明/注册 + SSE handler 工厂 + 健康检查 + Fastify 类型增强副作用）
export { notImplemented, registerEndpoints, type EndpointDecl } from './http/_helpers.js';
export { jobSseHandler, structureSseHandler } from './http/_sse.js';
export { registerHealthRoutes } from './http/health.js';
import './http/fastify.js';

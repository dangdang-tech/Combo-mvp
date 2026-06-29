// @cb/shared — 创作者中心主链路共享真源（Phase 3/4 直接 import）。
//
// 导出分组：
//   core/      契约脊柱（00-约定与状态机 §9）：ids/包络/分页/错误信封/jobs/progress/sse/drafts/health
//   constants/ Idempotency scope 表（§2.10）、路由前缀、SSE 路径
//   ports/     B-04/B-05/B-06 端口接口（QueuePort/EventStreamPort/LockPort/ObjectStorePort/LlmGatewayPort）
//   domains/   各域 DTO + zod schema（10 auth / 20 import / 30 extract / 40 structure / 50 publish / 60 dashboard / 70 events）
//   openapi/   zod-to-openapi 注册表 + 3.1 document 生成（B-07）—— 经 "@cb/shared/openapi" 子路径导出
//
// 命名约定：每个 DTO 同时导出 `XxxSchema`（zod 真源）与 `Xxx`（z.infer 类型）。

export * from './core/index.js';
export * from './constants/index.js';
export * from './ports/index.js';
export * from './domains/index.js';

// OpenAPI 也从根可达（亦有独立子路径导出 "@cb/shared/openapi"）。
export {
  registry,
  registerSchemas,
  REGISTERED_SCHEMA_NAMES,
  buildOpenApiDocument,
  type BuildOpenApiOptions,
} from './openapi/index.js';

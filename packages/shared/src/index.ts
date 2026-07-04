// @cb/shared — 前后端共享真源。
//
// 导出分组：
//   core/      地基：ids / 响应包络 / 分页 / 错误信封 / 进度模型 / SSE 帧协议 / health / trace
//   constants/ 路由前缀与 SSE 路径
//   ports/     基础设施端口接口（队列 / 事件流 / 锁 / 对象存储 / LLM 网关）
//   domains/   业务域 DTO + zod schema（auth / task / capability / trial / redaction）
//
// 命名约定：每个 DTO 同时导出 `XxxSchema`（zod 真源）与 `Xxx`（z.infer 类型）。

export * from './core/index.js';
export * from './constants/index.js';
export * from './ports/index.js';
export * from './domains/index.js';

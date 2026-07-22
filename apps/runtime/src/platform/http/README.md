# platform/http HTTP 公共设施

这个目录保存端点声明、统一错误回复、Fastify 类型增强、健康检查和浏览器事件上报。

- `_helpers.ts` 定义端点声明、批量注册和统一 ErrorEnvelope 输出。
- `fastify.ts` 为 Fastify 增加 `app.infra`、`app.turns` 和 `req.auth` 类型。`app.infra` 包含默认禁用或显式启用的 SandboxBackend。
- `health.ts` 注册 `GET /health` 和 `GET /ready`。沙箱 Pod 只在首次工具调用时创建，不参与 Runtime readiness，也不会预创建。
- `client-events.ts` 接收浏览器错误事件并只写结构化日志。

Runtime 没有增加浏览器可调用的沙箱管理端点。sandboxd 的认证协议只在 Pod 网络中由 SandboxClient 调用，不通过 Fastify 暴露。

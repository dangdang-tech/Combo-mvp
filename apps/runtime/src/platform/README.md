# platform 平台层

这个目录保存与具体业务无关的 Runtime 机制。

- `config/` 负责环境变量定义、默认值、生产必填和沙箱启用条件校验。
- `infra/` 负责数据库、Redis、对象存储、登录验签、模型选择，以及可选的 Kubernetes SandboxBackend 和能力令牌客户端。
- `middleware/` 负责普通请求和 SSE 的登录鉴权。
- `http/` 负责端点注册工具、统一错误信封、Fastify 类型增强、健康检查和浏览器事件上报。
- `observability/` 负责 OpenTelemetry 启动和 trace 字段。

模型工具代码只能调用平台层的 SandboxBackend。ESLint 会拒绝 agent 目录和沙箱基础设施代码导入 `node:fs`、`node:fs/promises` 或 `node:child_process`，因此功能关闭或远程调用失败时都不存在宿主回退。

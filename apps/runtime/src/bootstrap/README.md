# bootstrap 应用组装

这个目录负责把平台层和业务模块组装成可监听端口的 Fastify 应用。

## 文件

- `app.ts` 加载环境变量并创建 Fastify。它组装数据库、对象存储、Redis 事件设施和可选 SandboxBackend，把基础设施挂到 `app.infra`，再把带跨实例打断、孤儿清扫和沙箱取消接线的 TurnRunner 挂到 `app.turns`。关闭应用时，它创建一个总截止信号，并依次传给轮次中止、远程清理、沙箱后端、数据库和 Redis 关闭。截止时间耗尽后不再等待未决依赖，未能安全收尾的 Turn 保持 `running`。
- `routes.ts` 汇总 capability、session、artifact 和浏览器事件端点，并统一注册到 API 前缀。

`SANDBOX_TOOLS_ENABLED=false` 时，组装过程只创建禁用后端，连 Kubernetes 客户端模块也不加载。显式开启时，组装过程动态加载 KubernetesSandboxBackend；镜像或签名私钥缺失会在环境变量校验阶段拒绝启动。

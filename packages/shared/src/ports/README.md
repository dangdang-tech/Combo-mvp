# ports — 基础设施接口

这个目录只声明基础设施的 TypeScript 接口（端口，即业务层依赖的抽象），不含任何实现；实现在各服务的 `platform/infra` 目录里，业务模块只依赖这里的类型。

## 文件

- `redis.ts` 声明 Redis 双实例的三个接口：`QueuePort` 负责任务入队与移除，`EventStreamPort` 负责往事件流追加 SSE（服务端事件推送）帧并返回可续传的条目号，`LockPort` 负责带租约的分布式锁；另导出两个实例连接串的环境变量名。
- `object-store.ts` 声明对象存储接口 `ObjectStorePort`：预签名上传下载、按键直写直读（字节与 utf-8 文本两种读法分开）、列举、删除和探测；另定义四个桶名清单和连接配置的环境变量名。
- `llm-gateway.ts` 声明大模型网关接口 `LlmGatewayPort`：一次性补全、流式输出和向量化三个方法；另定义按任务类别分级的超时表 `LLM_TIMEOUTS_MS` 和重试上限 `LLM_MAX_RETRIES`。
- `index.ts` 汇总转出以上全部文件。

## 上下游

runtime 侧只用到对象存储：`platform/infra/object-store.ts` 实现 `ObjectStorePort`，`modules/capability/loader.ts` 经它读能力定义。

authoring 侧五个接口全部有实现：`platform/infra/queue.ts` 实现 `QueuePort`，`platform/sse/event-stream.ts` 实现 `EventStreamPort`，`platform/infra/lock.ts` 实现 `LockPort`，`platform/infra/object-store.ts` 实现 `ObjectStorePort`，`platform/infra/llm/gateway.ts` 实现 `LlmGatewayPort` 并引用超时表与重试上限；`modules/task` 的 `pipeline.ts`、`pairing.ts`、`service.ts`、`extract.ts` 以这些端口类型作为参数接收依赖。

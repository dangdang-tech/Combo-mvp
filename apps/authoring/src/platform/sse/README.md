# platform/sse — 进度推流

这个目录实现任务进度的实时推送：worker 进程把进度帧写进 Redis 流，api 进程按 SSE（服务器单向事件流）协议下发给浏览器，断线重连按 Last-Event-ID 补发增量，超出窗口就用数据库快照重置，保证前端永不停在空转圈。

## 文件

- `sse.ts` 是与 Redis 无关的建流协议实现：startSseStream 写流式响应头并接管连接，先按 Last-Event-ID 判断是否在补发窗口内（在窗口内补增量、否则发全量快照帧），再过统一终态闸（数据库已终态就恰好补发一次终态帧并关流，绝不重复 done），只有仍在运行的任务才启动持续订阅；心跳用具名 heartbeat 帧按固定间隔发。另导出取 Last-Event-ID 和写单帧的工具。
- `event-stream.ts` 是 Redis 流桥 RedisEventStream：publish 供 worker 把帧 XADD 进 events:task:{taskId} 流（条目 id 就是 SSE 帧 id，带长度上限裁剪和 TTL，失败吞掉不阻断 worker）；latestId 取流最新条目 id 作订阅锚点；subscribe 用独立复制连接做 XREAD BLOCK 长循环，把新帧实时回调给在线连接，收到 abort 就断开清理；replaySince 做重连窗口补发，判断 Last-Event-ID 是否早于流里最早的条目（早于就算超窗）。

## 上下游

被谁使用：`modules/task/sse.ts` 的任务进度端点组合两个文件建流；`modules/task/pipeline.ts` 以 TaskEventBridge 接口经 publish 推进度帧；`processes/worker.ts` 启动时用 redis_hot 实例构造 RedisEventStream 注入流水线。

依赖什么：`platform/observability/node.ts`（响应头里的 traceparent），帧类型与心跳间隔常量来自共享包 `@cb/shared`，Redis 客户端类型来自 ioredis。外部资源只有 redis_hot 实例的 Streams；进度的持久化真源是 tasks.meta.progress，由 task 模块负责，本目录只做传输。

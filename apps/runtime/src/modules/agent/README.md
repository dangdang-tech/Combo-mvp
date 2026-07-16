# modules/agent —— 对话轮次编排与流式推送

这个目录负责「一轮对话生成」的全部生命周期：创建自治轮次、构造模型代理、把生成过程翻译成标准事件写表并推给在线连接、轮次结束把整轮消息落库。它没有自己的路由文件，流式端点由 session 模块的路由表挂载。

## 文件

- `turn-repo.ts` 收口 turns 表的开轮、运行态查询、CAS 收尾与超时清扫。清扫器逐轮在事务里抢占运行态，只有抢占成功者会补一条失败消息，迟到的正常收尾会静默跳过。
- `run-turn.ts` 定义轮次编排器 TurnRunner。每次提交创建独立的 running 轮并写入 idx 为零的用户消息，随后异步执行生成。正常结束先写助手和工具消息，再用条件更新认领 completed 终态；失败或打断同样先写 failed 消息再认领终态。若清扫器已抢先收尾，执行方静默退出。本地 Map 保存当前实例可直接打断的执行句柄，跨实例打断通过广播总线尽力而为送达。轮次内的空闲看门狗只检测无输出的停滞，不限制轮次总时长。
- `build-agent.ts` 提供生产用的模型代理工厂：把能力定义的 instructions 与平台注入的运行约定（服务端当前日期与证据纪律、产物协议）拼成系统提示词，把 messages 表历史重建成 pi（内部模型代理框架）的消息格式喂回，按环境变量选模型和密钥。日期与证据纪律是为了防止产物写错生成日期、把片段材料外推成确定性结论。
- `turn-emitter.ts` 是事件双写器：每个 AG-UI 事件先追加到 Redis Stream 取得条目 id，再经 Redis 发布订阅发送直播通知；用 promise 链串行化保证顺序，单条写失败只记日志不翻掉主流程。
- `event-log.ts` 定义会话事件日志端口、保留上限与过期时间，并提供 Redis Stream id 的校验和数值比较。
- `stream.ts` 实现 GET /runtime/sessions/:id/stream 的流式推送处理器：先挂上事件总线的实时订阅并缓冲，再从事件日志补发断线期间漏掉的事件，最后排空缓冲切到实时；重叠帧按 id 单调去重，每 15 秒发送心跳并兜底补读。

## 上下游

被谁使用：`bootstrap/app.ts` 用 createTurnRunner 和 createPiTurnAgentFactory 组装 app.turns；session 模块的 `handlers.ts` 经 req.server.turns 调 startTurn 和 interrupt；session 模块的 `routes.ts` 把 `stream.ts` 的处理器挂到流式端点上。

依赖什么：引用 `modules/session/repo.ts` 读写 messages 表和查会话，引用 `modules/artifact/tool.ts` 给模型挂产物工具，引用 `platform/infra/` 的数据库句柄、对象存储、Redis 事件日志和事件总线类型，引用 `platform/infra/llm.ts` 解析模型与密钥，引用 `platform/http/_helpers.ts` 和 `platform/observability/node.ts` 处理错误信封与 trace 头。直接访问的外部资源是数据库的 messages 表、Redis 和经 pi 框架发起的模型服务调用。

## 典型流程

以「一轮生成从启动到结束」为例：

1. session 模块的 sendMessageHandler 调用 `run-turn.ts` 的 startTurn。每次提交都创建新轮次并返回接受结果，不检查同会话是否正在生成。
2. startTurn 用 `session/repo.ts` 的 appendTurnMessage 把用户消息写入轮内位置零，然后异步启动 executeTurn 并立即把用户消息返回给 handler。
3. executeTurn 用 `turn-emitter.ts` 建双写器，先发 RUN_STARTED 事件（追加 Redis Stream 并发布直播通知）。
4. 它从 messages 表读出本轮之前的已定稿历史，用 `artifact/tool.ts` 建产物工具，再经 `build-agent.ts` 的工厂构造模型代理。
5. 代理开始生成，每段文本增量都经双写器变成 TEXT_MESSAGE_CONTENT 事件；模型若调用产物工具，工具回调会追加发产物更新的状态事件。
6. 在线的前端通过 `stream.ts` 的流式端点实时收到上述事件；掉线重连时带上最后收到的事件 id，事件日志补发保留窗口内的后续事件。事件日志只保证覆盖进行中的一轮，历史轮次以 messages 表为真源。
7. 生成正常结束后，executeTurn 把代理转录里本轮新增的助手和工具消息逐条写进 messages 表，最后发 RUN_FINISHED 并等双写链全部完成。
8. 本地打断直接中止执行句柄。跨实例请求先确认数据库仍有 running 轮，再发布一次打断广播；广播丢失时用户可以再次请求。
9. 周期清扫把超过三十分钟的 running 轮收为 failed，补失败消息并发送 RUN_ERROR。编排器关闭时停止清扫并退订广播。

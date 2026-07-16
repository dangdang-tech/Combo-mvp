# modules/agent —— 对话轮次编排与流式推送

这个目录负责「一轮对话生成」的全部生命周期：占会话并发闸、构造模型代理、把生成过程翻译成标准事件写表并推给在线连接、轮次结束把整轮消息落库。它没有自己的路由文件，流式端点由 session 模块的路由表挂载。

## 文件

- `turn-repo.ts` 收口 turns 表的开轮、运行态查询、CAS 收尾与超时清扫。清扫器逐轮在事务里抢占运行态，只有抢占成功者会补一条失败消息，迟到的正常收尾会静默跳过。
- `run-turn.ts` 定义轮次编排器 TurnRunner：先取得 Redis 会话租约再落用户消息并立即返回，随后异步执行整轮生成。运行期间定时续租，丢失租约时主动中止本轮；本地 Map 只保存本实例的执行句柄。正常结束把助手和工具消息写进 messages 表，失败或被打断则落一条 failed 消息并发 RUN_ERROR 事件。轮次内还有一个空闲看门狗：模型流两次活动之间超过 RUNTIME_TURN_IDLE_TIMEOUT_MS（默认三分钟）没有任何事件，就判定连接夯死，中止本轮并按失败收尾；它只检测无输出的停滞，不限制轮次总时长。
- `turn-gate.ts` 定义会话租约、续租周期、打断标记有效期和 TurnGateStore 端口。打断使用 Redis 发布订阅广播，并由续租读取并消费打断标记作为兜底。
- `build-agent.ts` 提供生产用的模型代理工厂：把能力定义的 instructions 与平台注入的运行约定（服务端当前日期与证据纪律、产物协议）拼成系统提示词，把 messages 表历史重建成 pi（内部模型代理框架）的消息格式喂回，按环境变量选模型和密钥。日期与证据纪律是为了防止产物写错生成日期、把片段材料外推成确定性结论。
- `turn-emitter.ts` 是事件双写器：每个 AG-UI 事件先追加到 Redis Stream 取得条目 id，再经 Redis 发布订阅发送直播通知；用 promise 链串行化保证顺序，单条写失败只记日志不翻掉主流程。
- `event-log.ts` 定义会话事件日志端口、保留上限与过期时间，并提供 Redis Stream id 的校验和数值比较。
- `stream.ts` 实现 GET /runtime/sessions/:id/stream 的流式推送处理器：先挂上事件总线的实时订阅并缓冲，再从事件日志补发断线期间漏掉的事件，最后排空缓冲切到实时；重叠帧按 id 单调去重，每 15 秒发送心跳并兜底补读。

## 上下游

被谁使用：`bootstrap/app.ts` 用 createTurnRunner 和 createPiTurnAgentFactory 组装 app.turns；session 模块的 `handlers.ts` 经 req.server.turns 调 startTurn 和 interrupt；session 模块的 `routes.ts` 把 `stream.ts` 的处理器挂到流式端点上。

依赖什么：引用 `modules/session/repo.ts` 读写 messages 表和查会话，引用 `modules/artifact/tool.ts` 给模型挂产物工具，引用 `platform/infra/` 的数据库句柄、对象存储、Redis 事件日志和事件总线类型，引用 `platform/infra/llm.ts` 解析模型与密钥，引用 `platform/http/_helpers.ts` 和 `platform/observability/node.ts` 处理错误信封与 trace 头。直接访问的外部资源是数据库的 messages 表、Redis 和经 pi 框架发起的模型服务调用。

## 典型流程

以「一轮生成从启动到结束」为例：

1. session 模块的 sendMessageHandler 调用 `run-turn.ts` 的 startTurn，先取得该会话的 Redis 租约，占不到就返回 busy。
2. startTurn 用 `session/repo.ts` 的 appendMessage 把用户消息写进 messages 表，然后异步启动 executeTurn 并立即把用户消息返回给 handler。
3. executeTurn 用 `turn-emitter.ts` 建双写器，先发 RUN_STARTED 事件（追加 Redis Stream 并发布直播通知）。
4. 它从 messages 表读出本轮之前的已定稿历史，用 `artifact/tool.ts` 建产物工具，再经 `build-agent.ts` 的工厂构造模型代理。
5. 代理开始生成，每段文本增量都经双写器变成 TEXT_MESSAGE_CONTENT 事件；模型若调用产物工具，工具回调会追加发产物更新的状态事件。
6. 在线的前端通过 `stream.ts` 的流式端点实时收到上述事件；掉线重连时带上最后收到的事件 id，事件日志补发保留窗口内的后续事件。事件日志只保证覆盖进行中的一轮，历史轮次以 messages 表为真源。
7. 生成正常结束后，executeTurn 把代理转录里本轮新增的助手和工具消息逐条写进 messages 表，最后发 RUN_FINISHED 并等双写链全部完成。
8. 运行期间每十五秒续租一次。打断广播命中本实例时立即中止，广播未送达时由下一次续租消费打断标记；轮次结束时只释放 owner 匹配的租约。

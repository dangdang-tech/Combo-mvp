# modules/session —— 会话与消息

这个目录负责试用会话的完整生命周期：开会话、列会话、看详情、发消息触发一轮生成、打断当前轮。会话与消息数据落 sessions 和 messages 表，所有归属查询都在 SQL 里带 owner 条件，非本人与不存在同样返回空。

## 文件

- `routes.ts` 声明会话域全部六个端点：开会话、会话列表、会话详情、发消息、打断，这五个挂 requireAuth；流式事件端点挂 requireSseAuth（只认同源 Cookie），其处理器来自 agent 模块的 `stream.ts`。
- `handlers.ts` 实现前五个端点的处理器：校验入参、做会话归属校验、调 loader 和编排器、包响应信封；开会话与发消息前都完整加载一次能力定义，发消息成功返回 202 表示用户消息已落库而生成在异步进行。
- `repo.ts` 封装 sessions 和 messages 两表的 SQL。旧的 appendMessage 保留原有事务与会话序号分配，供尚未改造的轮次编排器使用。新的 appendTurnMessage 按调用方给定的轮内位置直接写入，不加锁也不分配跨轮序号。读取会合并存量消息与已完成轮次，按轮次创建时间和轮内位置排序，再派生连续的对外序号。
- `message-content.ts` 定义消息正文的严格校验 schema：按 user、assistant、tool 三种角色各自允许的内容块结构校验，写入前必过，坏块直接拒写，保证历史能无损喂回模型代理。

## 上下游

被谁使用：`bootstrap/routes.ts` 注册本模块路由；`modules/agent/run-turn.ts` 和 `modules/agent/build-agent.ts` 用 `repo.ts` 读写消息并消费其行类型，`modules/agent/stream.ts` 用 getSession 做归属校验；`modules/artifact/repo.ts` 和 `modules/capability/loader.ts` 引用 `repo.ts` 的时间格式化函数。

依赖什么：引用 `modules/capability/loader.ts` 与 `modules/capability/handlers.ts` 做能力加载和失败信封，引用 `modules/artifact/repo.ts` 的产物列表查询，引用 `modules/agent/stream.ts` 的流式处理器，经 req.server.turns 调用 bootstrap 组装的轮次编排器；向下引用 `platform/infra/db.ts` 的事务工具、`platform/middleware/auth.ts` 的两个鉴权守卫和 `platform/http/_helpers.ts` 的信封工具。直接访问的外部资源是数据库的 sessions 与 messages 两张表。

## 典型流程

以「开一个新会话」（POST /runtime/sessions）为例：

1. 请求经 `routes.ts` 的端点进来，requireAuth 守卫验登录态并把用户 id 挂到请求上。
2. `handlers.ts` 的 createSessionHandler 用共享 schema 校验请求体，拿到要试用的能力 id。
3. 处理器调 `capability/loader.ts` 的 loadCapability 做全链校验：查 capabilities 表过权限闸、从对象存储读定义、过版本与 schema 校验；任何一步不通过就经 sendLoadFailure 返回对应错误信封，不留下空会话。
4. 校验通过后调 `repo.ts` 的 createSession 往 sessions 表插一行，owner 记为当前用户。
5. 新会话行被转成对外形态，包进带 traceId 的响应信封以 201 返回；前端随后跳进会话页发第一条消息。

# modules/task — 任务、上传与提取流水线

这个模块是业务主链路：创作者建任务拿到配对码，本机助手凭配对码分片上传对话历史，收齐后 worker 跑提取流水线归纳能力项，浏览器经 SSE（服务器单向事件流）看实时进度。tasks 表是任务状态的唯一真源。

## 文件

- `routes.ts` 声明七个端点：建任务、任务列表、任务详情、任务进度 SSE、重试失败任务（以上要求登录，SSE 用仅认同源 Cookie 的专用守卫），以及无登录态、凭配对码鉴权的助手脚本下发和分片上传两个端点。
- `handlers.ts` 是 HTTP 薄壳：校验入参、调 service/repo/pairing、包响应信封；脚本下发端点在配对码失效时也返回可执行脚本（打印人话后退出），不向管道输出裸 JSON 错误。
- `service.ts` 是任务状态机服务：transition 是状态轴变更的唯一入口（UPDATE 带期望现态做乐观锁，0 行即放弃）；createTask 在一个事务里插 tasks 和 uploads 两行，幂等键冲突时回读已有任务并轮换新配对码；retryTask 只允许 failed 态重试并重新入队。
- `repo.ts` 收拢 tasks 和 uploads 两表的全部 SQL：建行、按幂等键回读、任务视图组装（联 uploads 并统计能力项数）、分片登记、租约认领与续租、进度快照持久化、找出租约过期的悬空任务等。
- `pairing-code.ts` 是配对码纯函数：生成 XXXX-XXXX 格式的随机码、sha256 哈希（库里只存哈希）、算 48 小时过期时刻。
- `pairing.ts` 实现配对上传：verifyPairingCode 验码验期验状态；landPart 把分片写进 MinIO、登记进 uploads.parts，收齐时拼接完整原始件、流转任务到 extract 步并入队，并发收齐由乐观锁收敛为恰好入队一次。
- `connect-script.ts` 渲染助手脚本：外层 shell 守门，内嵌 python3 上传器扫描本机 ~/.claude/projects 和 ~/.codex/sessions 的会话文件，打包切片后逐片上传，终端画进度条。
- `session-parse.ts` 是纯函数解析器：把 Claude / Codex 两种对话历史格式（JSONL，一行一个 JSON 对象）解析成标准「段」，含来源嗅探、坏行容错、按内容哈希去重、打包文本按分隔行拆回各文件。
- `extract.ts` 做大模型归纳：把去敏段落分批喂给 LLM 网关，用括号配平扫描容错解析模型输出的 JSON 数组（每个能力项除名字、摘要、系统提示词外还让模型建议试用开场表单字段和开场提示语，坏条目单独丢弃），跨批按名去重；上游降级或全空时落确定性兜底能力，并逐次调用记审计。
- `pipeline.ts` 是 worker 执行体：领租约防双跑，依次执行拉原文、解析切段、脱敏、大模型归纳、逐项落库、清理原始件，进度同时写 tasks.meta.progress 和推 Redis 流，成败终态都经 transition 写回。
- `sse.ts` 是任务进度 SSE handler：建流前做 owner 校验，先取流锚点再读库里的进度快照发首帧，断线重连在窗口内补增量，建流瞬间已终态则补终态帧后立即关流。

## 上下游

被谁使用：路由由 `bootstrap/routes.ts` 挂载；`processes/worker.ts` 消费队列时调 pipeline.ts 的 runPipeline、对账时调 repo.ts 的 findStalledExtractTasks。

依赖什么：`platform/middleware/auth.ts`（登录与 SSE 守卫）、`platform/http/_helpers.ts`（错误信封）、`platform/infra/db.ts` 与 `db-tx.ts`（连接池与事务）、`platform/infra/queue.ts`（BullMQ 队列名与入队）、`platform/sse/`（建流与 Redis 流桥）、`platform/infra/llm/`（LLM 网关端口与审计类型）、`platform/text/session-noise.ts`（平台噪声识别）、`modules/capability/repo.ts`（落能力项行）、`modules/account/repo.ts`（toIso）。外部资源：PostgreSQL 的 tasks、uploads、capabilities 表，MinIO 的 agora-raw（原始件，处理完清除）与 agora-artifacts（能力项定义，长期保留）两个桶，Redis 队列（BullMQ）与 Redis 热流（进度帧），以及经网关调用的大模型上游。

## 典型流程：POST /connect/upload（助手上传一片，恰好收齐）

1. 助手脚本发 JSON 体（配对码、分片序号、总片数、文本内容）到本端点，无登录态。
2. `handlers.ts` 的 connectUploadHandler 用共享包的 Zod schema 校验请求体，然后调 `pairing.ts` 的 landPart。
3. landPart 先调 verifyPairingCode：把码做 sha256 后查 uploads 表，确认码存在、未过期、上传仍是 pending 且任务停在 upload 步，否则按无效或过期返回对应错误。
4. 把分片文本写进 MinIO 的 agora-raw 桶（先写桶再登记，保证登记过的分片一定可读）。
5. 调 `repo.ts` 的 registerPart 把「序号到对象键」登记进 uploads.parts；这条 UPDATE 只对 pending 且未过期的行生效，重复分片幂等覆盖同一序号。
6. 用 partsState 判断 0 到 total-1 是否连续到齐；没齐就直接返回已落地片数，助手继续传下一片。
7. 收齐了：按序号把各分片读出来拼接成完整原始件写回 MinIO，调 markUploadRaw 把 uploads 置为 raw。
8. 调 `service.ts` 的 transition 把任务从「upload 步、running」流转到「extract 步」；乐观锁命中才向 BullMQ 的 task-pipeline 队列入队，并发收齐时输掉竞争的一方跳过入队。
9. handler 把落地片数和 complete 标记包进响应信封返回 200；后续提取由 worker 进程接手。

# modules/task — 任务、上传与提取流水线

这个模块是业务主链路：云端模式由本机助手凭配对码分片上传对话历史，收齐后 Cloud Worker 跑提取流水线；本地模式直接创建 extract 阶段任务，由 Local Worker 在用户机器上提取并上报进度与最终能力定义。两种模式共用 tasks、进度快照、能力持久化和发布链路，浏览器经 SSE（服务器单向事件流）看实时进度。tasks 表是任务状态的唯一真源。

## 文件

- `routes.ts` 声明十二个端点：原有云端任务、SSE、重试和配对上传端点之外，还提供 local Task 创建、一次性绑定、进度上报和最终定义提交。进度与结果接口使用短期 Task Token 和设备签名守卫。
- `handlers.ts` 是 HTTP 薄壳：校验入参、调 service/repo/pairing、包响应信封；脚本下发端点在配对码失效时也返回可执行脚本（打印人话后退出），不向管道输出裸 JSON 错误。
- `service.ts` 是任务状态机服务：transition 是常规状态轴变更入口（UPDATE 带期望现态做乐观锁，0 行即放弃）；createTask 在一个事务里插 tasks 和 uploads 两行，幂等键冲突时回读已有任务并轮换新配对码；createLocalTask 插 tasks 与 local_task_executions；retryTask 只允许 Cloud extract/failed 重试；周期对账用 repo 的加锁 CTE 原子收口过期上传和过期本地执行权，并在 worker 中可重试清理上传原始对象。
- `repo.ts` 收拢 tasks、uploads 和 local_task_executions 三表的 SQL：建行、按幂等键回读、任务视图组装（可选联 uploads 并统计能力项数）、分片登记、Cloud Worker 租约、本地执行权、进度快照、最终结果游标、过期上传收口及待清理队列等。
- `pairing-code.ts` 是配对码纯函数：生成 XXXX-XXXX 格式的随机码、sha256 哈希（库里只存哈希）、算 48 小时过期时刻。
- `pairing.ts` 实现配对上传：prepareUpload 建立或确认带 bundleId 的不可变快照清单；landPart 在写桶前后校验快照与总片数，收齐时把上传置为 raw、流转任务到 extract 步并入队。收齐时不拼接完整原始件，分片留在桶里由 worker 逐片消费。
- `raw-purge.ts` 是原始上传对象统一删除策略：成功流水线和 expired 对账都逐键幂等删除；只有全部删除成功，调用方才允许写 raw_purged_at，失败保留追踪状态下一轮重试。
- `connect-script.ts` 渲染助手脚本：内嵌 python3 上传器把扫描结果流式写成权限收紧的本地快照，校验每片哈希，通过 prepare 查询缺片后续传；网络异常先确认服务端是否已落地，再做有限重试，成功后删除缓存。
- `session-parse.ts` 是纯函数解析器：把 Claude / Codex 两种对话历史格式（JSONL，一行一个 JSON 对象）解析成标准「段」，含来源嗅探、坏行容错、按内容哈希去重、打包文本按分隔行拆回各文件。
- `extract.ts` 做大模型归纳：把去敏段落分批喂给 LLM 网关，用括号配平扫描容错解析模型输出的 JSON 数组，候选串不是严格合法 JSON 时用 jsonrepair 库修复重试（覆盖字符串内裸控制字符、尾逗号、截断等模型常见毛病），并且只认「至少一个条目带名字」的能力形数组，避免外层数组坏掉时错拿条目里的嵌套空数组当结果（每个能力项除名字、摘要、系统提示词外还让模型建议试用开场表单字段和开场提示语，坏条目单独丢弃），跨批按名去重；上游降级或全空时落确定性兜底能力，并逐次调用记审计。
- `local-execution.ts` 实现本地执行旁路：创建不带 uploads 的 local Task，用短期绑定码绑定设备公钥；同一设备可在绑定窗口内幂等换新 Task Token，换 token 后旧 token 立即失效。进度和结果请求同时校验短期 Task Token 与 Ed25519 签名，按序号幂等写入现有任务进度，并把最终 `CapabilityDefinition v1` 交给 capability 域的共享持久化服务。
- `pipeline.ts` 是 Cloud Worker 执行体：领租约防双跑，按 uploads.parts 登记表逐片读取分片，每片解析切段、脱敏、截断到提取会消费的长度后释放原文，跨片按内容哈希去重（长循环里每二十片续一次租约），随后大模型归纳（每完成一批归纳也续一次租约，防止真实大模型延迟下租约过期被对账循环重派造成双跑）、经共享持久化服务逐项落库、清理分片；分步耗时用单调时钟计量，墙钟被校正时不会出现负值或虚高；进度同时写 tasks.meta.progress 和推 Redis 流，成败终态都经 transition 写回。逐片处理让内存峰值只随单片大小走，不随上传总量增长。
- `sse.ts` 是任务进度 SSE handler：建流前做 owner 校验，先取流锚点再读库里的进度快照发首帧，断线重连在窗口内补增量，建流瞬间已终态则补终态帧后立即关流。

## 上下游

被谁使用：路由由 `bootstrap/routes.ts` 挂载；`processes/worker.ts` 消费队列时调 pipeline.ts 的 runPipeline、对账时调 repo.ts 的 findStalledExtractTasks。

依赖什么：`platform/middleware/auth.ts`（登录与 SSE 守卫）、`platform/infra/index.ts` 注入的任务事件桥、`platform/http/_helpers.ts`（错误信封）、`platform/infra/db.ts` 与 `db-tx.ts`（连接池与事务）、`platform/infra/queue.ts`（BullMQ 队列名与入队）、`platform/sse/`（建流与 Redis 流桥）、`platform/infra/llm/`（LLM 网关端口与审计类型）、`platform/text/session-noise.ts`（平台噪声识别）、`modules/capability/index.ts`（域出口，统一持久化能力定义与索引）。toIso 时间格式化来自 `platform/infra/db.ts`。外部资源包括 PostgreSQL 的 tasks、uploads、local_task_executions 和 capabilities 表，MinIO 的 combo-raw（原始件，处理完清除）与 combo-artifacts（能力项定义，长期保留）两个桶，Redis 队列（BullMQ）与 Redis 热流（进度帧），以及经网关调用的大模型上游。

## 典型流程：prepare 后逐片上传

1. 助手把本次扫描固化为本地快照，计算 bundleId，再调用 `/connect/prepare` 建立或确认服务端清单。
2. prepare 返回已经落地的序号；同一快照直接续传缺片，新快照仅能替换仍未完成的上传。
3. 助手发 JSON 体（配对码、bundleId、分片序号、总片数、文本内容）到 `/connect/upload`。
4. landPart 先验码、验期、验状态，并在写对象前严格核对 bundleId 与总片数。
5. 把分片写进带 bundleId 的 MinIO 对象键，再用同一清单条件登记；并发替换造成的未登记对象进入带版本号的清理队列。
6. partsState 判断序号是否连续到齐；没齐就返回进度，收齐则置 raw、流转到 extract 并恰好入队一次。
7. 若客户端没收到响应，它先重新调用 prepare；服务端已登记当前片或已经收齐时不重复上传。

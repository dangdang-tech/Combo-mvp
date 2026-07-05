# db — PostgreSQL 迁移

这个目录是数据库结构的唯一真源。迁移基线是 `migrations/0000_baseline_schema.sql`，单个文件建齐全部九张表；此后的结构变更以新编号的迁移文件追加，已执行过的文件不可再改。基线里还定义了 `gen_uuid_v7()` 函数，所有表主键默认用它生成时间有序的 UUID。大内容（上传原始件、能力定义、会话产物正文）一律不进库，库里只存 MinIO 对象键和状态。

## 表

- `users` 是身份与权限的唯一真源，存外部认证服务的用户对应关系、账号、邮箱和角色，全库所有归属字段都指向它。
- `tasks` 是一次上传任务的聚合根，用步骤和状态两个正交字段表达进展，并带幂等键、重试计数、最后错误和 worker 租约字段。
- `uploads` 与任务一对一，记录配对码哈希、分片对账表、收齐后的原始件对象键和原始件清除时间。
- `capabilities` 是提取产出的能力项轻量索引，发布标记与分享令牌记在它身上，完整可运行定义按 `storage_key` 存 MinIO。
- `sessions` 是一次试用对话会话，引用被试用的能力项和会话归属人。
- `messages` 是会话内的定稿消息，按会话内序号唯一排序，内容是 agent 原生分块格式的 JSON。
- `stream_events` 是流式生成的过程记录，自增主键让断线的客户端能报出最后收到的事件号从中断处续传。
- `artifacts` 是会话交互产物的索引，正文存 MinIO，行内只留类型、标题和对象键。
- `audit_llm_calls` 给每次大模型调用记一行 token 用量与费用，只做审计不是计费真源，任务字段是不设外键的松引用。
- `schema_migrations` 是 migrate 脚本自建的记账表，记录哪些迁移文件已执行，不在基线文件里。

## migrate 脚本

脚本在 `scripts/migrate.ts`。在本目录执行 `npm run migrate` 会按文件名字典序执行 `migrations/` 下尚未记账的 SQL 文件，每个文件在一个事务里执行并写入 `schema_migrations`；`npm run migrate:status` 只列出各文件是否已执行。连接串取环境变量 `DATABASE_URL`，缺省连本机的 agora 库；没设 `DATABASE_URL` 时 status 模式不连库、仅列文件清单。

## 测试

`__tests__` 下两个测试都不需要真实数据库。`migrations.test.ts` 守护基线完整性：九张表一张不少也一张不多、旧结构的表名不许回潮、tasks 的双轴状态与租约和幂等字段都在、消息的会话内序号唯一约束在、`stream_events` 主键是自增。`gen_uuid_v7.test.ts` 静态核对函数里每个 `set_byte` 的字节值都显式转成 int，并用 TypeScript 复刻同一套字节打包逻辑，验证产出是合法且时间有序的 UUID v7。

## 读写关系

- `users` 由 authoring 的 `modules/account/repo.ts` 在登录时写入和更新，runtime 的 `platform/middleware/auth.ts` 只读它做鉴权。
- `tasks` 和 `uploads` 只有 authoring 读写，代码在 `modules/task/repo.ts` 和 `modules/task/service.ts`。
- `capabilities` 由 authoring 写入（`modules/task/repo.ts` 在提取完成时落库，`modules/capability/repo.ts` 负责列表与发布），runtime 的 `modules/capability/loader.ts` 只读它拿对象键去加载定义。
- `sessions`、`messages`、`artifacts` 只有 runtime 读写，代码在 `modules/session/repo.ts` 和 `modules/artifact/repo.ts`。
- `stream_events` 只有 runtime 读写，代码在 `modules/agent/event-log.ts`。
- `audit_llm_calls` 只有 authoring 写入，代码在 `platform/infra/llm/audit.ts`。

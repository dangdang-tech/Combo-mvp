# db — PostgreSQL 迁移

这个目录是数据库结构的唯一真源。迁移基线是 `migrations/0000_baseline_schema.sql`；此后的结构变更以新编号的迁移文件追加，已执行过的文件不可再改。`0002_drop_stream_events.sql` 删除已经迁移到 Redis Stream 的事件日志表。`0003_turns.sql` 新增自治轮次表，并让新消息按轮次和轮内位置归组。`0004_local_task_execution.sql` 给任务增加云端或本地执行模式，并新增本地任务的一对一执行权附表。基线里还定义了 `gen_uuid_v7()` 函数，所有表主键默认用它生成时间有序的 UUID。大内容（上传原始件、能力定义、会话产物正文）一律不进库，库里只存 MinIO 对象键和状态。

## 表

- `users` 是身份与权限的唯一真源，存外部认证服务的用户对应关系、账号、邮箱和角色，全库所有归属字段都指向它。
- `tasks` 是一次生产任务的聚合根，用步骤和状态两个正交字段表达进展，并带执行模式、幂等键、重试计数、最后错误和 worker 租约字段。云端和本地提取共用这张表；运行中的本地任务用无限远租约作为滚动发布栅栏，旧版 Cloud Worker 也不会误领。
- `local_task_executions` 与本地任务一对一，保存短期绑定码哈希、设备公钥、可轮换的短期任务令牌哈希与版本、进度序号和最终能力定义提交摘要。它只记录本地执行权，不复制任务或能力项。
- `uploads` 与任务一对一，记录配对码哈希、分片对账表和原始件清除时间。分片对账表（parts 列）是 worker 逐片读取分片的键清单真源；`storage_key` 列已不再写入（收齐后不再拼接完整原始件），保留只为兼容历史行的清理。
- `capabilities` 是提取产出的能力项轻量索引，发布标记与分享令牌记在它身上，完整可运行定义按 `storage_key` 存 MinIO。
- `sessions` 是一次试用对话会话，引用被试用的能力项和会话归属人。
- `turns` 是会话下的自治任务，以服务端生成的运行编号为主键，只用运行态 CAS 协调收尾。历史只读取已完成轮次，因此运行中、失败或中断轮次的半截消息不可见。
- `messages` 是会话内的定稿消息，内容是 agent 原生分块格式的 JSON。存量消息永久保留会话序号且不归属轮次；新消息的会话序号为空，改用轮次编号和轮内位置排序，对外序号由合并读路径连续派生。
- `artifacts` 是会话交互产物的索引，正文存 MinIO，行内只留类型、标题和对象键。
- `audit_llm_calls` 给每次大模型调用记一行 token 用量与费用，只做审计不是计费真源，任务字段是不设外键的松引用。
- `schema_migrations` 是 migrate 脚本自建的记账表，记录哪些迁移文件已执行，不在基线文件里。

## migrate 脚本

脚本在 `scripts/migrate.ts`。在本目录执行 `npm run migrate` 会按文件名字典序执行 `migrations/` 下尚未记账的 SQL 文件，每个文件在一个事务里执行并写入 `schema_migrations`；`npm run migrate:status` 只列出各文件是否已执行。连接串取环境变量 `DATABASE_URL`，缺省连本机的 combo 库；没设 `DATABASE_URL` 时 status 模式不连库、仅列文件清单。

## 测试

`__tests__` 下两个测试都不需要真实数据库。`migrations.test.ts` 守护历史基线完整性以及后续迁移文件，核对 tasks 的双轴状态、执行模式、租约和幂等字段，核对本地执行附表没有复制任务、产物或发布模型，并核对轮次状态、部分索引与消息归属列。`gen_uuid_v7.test.ts` 静态核对函数里每个 `set_byte` 的字节值都显式转成 int，并用 TypeScript 复刻同一套字节打包逻辑，验证产出是合法且时间有序的 UUID v7。

## 读写关系

- `users` 由 authoring 的 `modules/account/repo.ts` 在登录时写入和更新，runtime 的 `platform/middleware/auth.ts` 只读它做鉴权。
- `tasks`、`uploads` 和 `local_task_executions` 只有 authoring 读写，代码在 `modules/task/repo.ts`、`modules/task/service.ts` 和 `modules/task/local-execution.ts`。
- `capabilities` 由 authoring 的 `modules/capability/persist.ts` 与 `repo.ts` 写入，前者统一承接云端和本地提取结果，后者负责索引、列表与发布；runtime 的 `modules/capability/loader.ts` 只读它拿对象键去加载定义。
- `sessions`、`turns`、`messages`、`artifacts` 只有 runtime 读写，代码在 `modules/session/repo.ts`、`modules/agent/turn-repo.ts` 和 `modules/artifact/repo.ts`。
- `audit_llm_calls` 只有 authoring 写入，代码在 `platform/infra/llm/audit.ts`。

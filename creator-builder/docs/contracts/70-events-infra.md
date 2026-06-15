# 70 · 事件 / 基础设施域契约（outbox · consumer · sweeper · 通知 · 端口）

> **本域定位**：创作者中心主链路的「事件总线 + 后台对账 + 端口抽象」地基。它不直接面向创作者出大量在线端点，而是为发布/导入/提取/结构化四条链路提供**可靠事件投递（outbox 同事务，绝不丢不重）**、**保序消费（xid 提交序水位 + 启动级防重）**、**毒丸隔离（按 topic + dead_events，不悄悄漏）**、**后台对账(sweeper：job 续期/orphan/outbox 滞留补投)**、**通知链路(站内 + 飞书/邮件，关页也收得到)**，以及三个 domain 端口（ObjectStore / LLMGateway / Redis 双实例分工）的契约形态。
>
> **必须先读并严格遵循**：`/Users/danielxing/repos/agora-mvp-creator-builder/creator-builder/docs/contracts/00-约定与状态机.md`（契约脊柱）。本文 **import 脊柱定义、不重定义**：路由前缀 `/api/v1`、响应包络 `Envelope<T>`/`Paginated<T>`、错误信封 `ErrorEnvelope` + action 五枚举 + 错误分类表缺省、`Idempotency-Key` + §4 行为矩阵、SSE 帧协议（首帧 `state_snapshot` 三型、12 event、Last-Event-ID、心跳/done）、jobs 状态机 + fencing 字段、`ProgressView`、drafts、§9 全部共享 TS 类型、健康检查口径。
>
> **覆盖功能点**：B-13（outbox 同事务 + xid 水位）、B-14（consumer 顺序拉取 + 提交序 + 启动级防重 advisory lock/lease + cursor 与处理同事务）、B-15（毒丸按 topic + dead_events）、B-16（sweeper：job 对账 / orphan 清理 / outbox 滞留告警补投）、B-35（通知链路 NotifyConsumer + `/notifications`）；端口 B-04（redis_queue/redis_hot 分工）、B-05（S3 ObjectStore 端口）、B-06（LLM Gateway：限流/重试/计费/流式）。
>
> **本期仅冻结 schema、不实现**：B-36（metering `usage_events` / `daily_*`）、B-38（`experience_packs`）、B-40（trial/runtime 表 + 事件）。这三块在本文给 DDL + 事件 payload schema，但**不注册任何 consumer / processor、不产生数据、不挂可调用端点**。
>
> **三条硬规则在本域的落地点**：
> 1. **永不裸转圈** —— 通知与对账让「关页/断线/超时」的耗时步骤始终有进度去向（导入完成通知把人带回完成态；sweeper 续期/重入队让卡死任务自愈而非永久转圈）。落地于 §5 NotifyConsumer、§6 sweeper。
> 2. **绝不裸露错误码** —— `/notifications` 与所有本域对外失败只出 `ErrorEnvelope`；毒丸/未入账对用户呈现为人话「未入账事件 N 条」而非死信堆栈。落地于 §4.4 毒丸用户呈现、§5.3 通知文案。
> 3. **已生成内容不丢** —— outbox 与业务**同一 PG 事务**（发布成功必发事件、事件存在必发布成功，不丢不重）；consumer **at-least-once + event_id 幂等 + cursor 与处理同事务**；毒丸进 `dead_events` 而非丢弃。落地于 §2 outbox、§3 consumer、§4 dead_events。
>
> 本文只写契约（markdown + TS 类型片段 + SQL DDL），不写业务实现代码。TS 片段最终归集到 `src/shared/`（zod schema 即 OpenAPI 3.1 真源），DDL 归 `src/infra/pg/migrations/`，outbox 写入封装归 `src/infra/outbox/`，consumer 进程归 `src/consumers/`，sweeper 归 `src/sweeper/`。

---

## 0. 本域端点与表速览

| 类型 | 清单 |
|---|---|
| **对外端点** | `GET /api/v1/notifications`（列表，cursor 分页）· `POST /api/v1/notifications/{notificationId}/read`（标已读，幂等）· `POST /api/v1/notifications/read-all`（全部已读，幂等）· `GET /api/v1/notifications/unread-count`（未读数）。健康检查 `GET /health` `GET /ready`（脊柱 §10，本文补五依赖的探针实现口径）。 |
| **内部协议（无在线端点）** | outbox 写入封装（与业务同事务）、consumer 顺序拉取框架、sweeper 三件事循环、三个 domain 端口（ObjectStore / LLMGateway / Redis 双实例）。 |
| **新增表** | `outbox_events`、`consumer_cursors`、`dead_events`、`notifications`、`notification_channels`（投递通道明细）、`audit_llm_calls`（LLM 成本审计）。 |
| **冻结表（schema-only）** | `usage_events`、`daily_capability_stats`、`daily_creator_consumers`、`daily_creator_llm_stats`（B-36）；`experience_packs` + `experience_pack_items` + `experience_pack_item_sources`（B-38）；`runtime_sessions` + `artifacts`（B-40，`usage_events` 同时服务 B-36/B-40）。 |
| **SSE** | 本域不新增 SSE event 类型。通知**不走 SSE**（异步、可关页），走「站内表 + 外部通道（飞书/邮件）+ 前端轮询/拉取 `unread-count`」。本域产出的 `done`/`error` 帧由 B-12 SSE Hub 统一发（outbox 完成 → notify 与 SSE done 是两条独立投递路径，互不替代）。 |

---

## 1. outbox 主题（topic）目录

> **设计原则**：topic 是「域事件类别」，决定毒丸/重试策略（见 §4）与消费者归属（见 §3）。命名 `{aggregate}.{event}`，全小写点分。`aggregate_id` 指向聚合根（capabilityId / jobId / versionId / batchId）。**本期实际被消费的只有 `capability.*` 与 `notify.*` 两类**；`usage.metering` 与 `runtime.*` 仅在 topic 目录登记、本期不产生事件。

| topic | aggregate_id 指向 | 生产者（同事务写 outbox） | 消费者（本期） | 毒丸策略（§4） | 用途 |
|---|---|---|---|---|---|
| `capability.published` | capabilityId | 发布门事务（B-27/B-28）、评审通过/回退（B-30） | `MarketplaceProjection`（→ marketplace_listings） | **lifecycle：卡住等人工 + 告警，不进 dead_events、不跳过**（贯穿-26：宁可延迟不放错状态） | 能力发布/回退上架；市集投影 |
| `capability.unpublished` | capabilityId | 评审拒绝且无上一版（B-30） | `MarketplaceProjection` | lifecycle：同上 | 能力下架；市集投影 |
| `notify.import_completed` | jobId | 导入 Job 完成（B-19） | `NotifyConsumer` | **notify：重试 N 次进 dead_events + cursor 跳过 + 告警**（不阻塞后续通知） | 导入完成通知（关页也收得到，导入-32/贯穿-03） |
| `notify.extract_completed` | jobId | 萃取 Job 完成（B-22） | `NotifyConsumer` | notify：同上 | 萃取完成通知 |
| `notify.publish_completed` | versionId | 发布成功（B-28）/批量完成（B-29） | `NotifyConsumer` | notify：同上 | 发布完成通知 |
| `notify.review_decided` | capabilityId | Alpha 评审通过/拒绝（B-30） | `NotifyConsumer` | notify：同上 | 评审结果通知（通过/简单拒绝原因） |
| `usage.metering` | sessionId | （Runtime 计量，**本期不产生**） | `MeteringConsumer`（**本期不启动**） | metering：重试 N 次进 dead_events + cursor 跳过 + **收益页/成本日报显式「未入账事件 N 条」**（贯穿-25） | 计量回流（B-36，冻结） |
| `runtime.session_event` | sessionId | （Runtime 会话，**本期不产生**） | （**本期无消费者**） | — | Trial 预留（B-40，冻结） |

> **topic 三类毒丸语义一句话**：`lifecycle`（capability.*）= 卡住等人工、宁延迟不放错；`notify`（notify.*）= 重试进死信 + 跳过不阻塞；`metering`（usage.metering）= 重试进死信 + 用户侧显式「未入账 N 条」。三类策略在 `outbox_topics` 元数据 / consumer 配置里声明，不硬编码在处理逻辑。

---

## 2. B-13 · outbox 写入（与业务同事务）+ xid 提交序水位

### 2.1 核心契约（不丢不重的事务边界）

- **写 outbox 必须与产生它的业务变更在同一 PG 事务内**。发布门 / 导入完成 / 评审回写都是「业务行变更 + `INSERT outbox_events` 一把事务提交」。事务成功 ⇒ 业务态与待发事件同时落；事务回滚 ⇒ 两者同时不落。**杜绝「发布了却没发事件」或「发了事件却没发布」**（硬规则③）。
- **`xid` 提交序水位**：每条 outbox 行带 `xid xid8 NOT NULL DEFAULT pg_current_xact_id()`，记录写入它的事务 id。这是 consumer 保序的关键——因为 `id`（BIGSERIAL/UUID v7）的分配序 ≠ 提交序：事务 A 先拿到小 id 但后提交，事务 B 后拿大 id 却先提交，naive「按 id 升序读」会在 A 还在 in-flight 时跳过它、漏读。consumer 用 `pg_snapshot_xmin(pg_current_snapshot())` 作为「已提交水位」判定哪些行可安全消费（见 §3.2）。
- **outbox 行不可变**：写入后只读，不 UPDATE。投递状态记在 `consumer_cursors`（每消费者各自游标）与 `dead_events`（毒丸），不回写 outbox 本身——这样多个消费者（MarketplaceProjection / NotifyConsumer）可各自独立消费同一 topic 流，互不干扰。

### 2.2 `outbox_events` DDL

```sql
-- B-13 · 事务型 outbox。与业务同事务写入；行不可变；xid 记提交序水位。
CREATE TABLE outbox_events (
  id            uuid        PRIMARY KEY DEFAULT gen_uuid_v7(),  -- 流内排序键（UUID v7 时间有序）
  seq           bigint      GENERATED ALWAYS AS IDENTITY,        -- 单调自增序号，cursor 推进/水位比较用
  event_id      text        NOT NULL,                           -- 业务幂等键，consumer 去重锚点（见 2.3）
  topic         text        NOT NULL,                           -- §1 topic 目录
  aggregate_id  uuid        NOT NULL,                           -- 聚合根 id（capabilityId/jobId/versionId...）
  payload       jsonb       NOT NULL,                           -- 事件 payload（§7 各 topic schema）
  trace_id      text,                                           -- 贯穿日志/SSE/通知的 traceId
  xid           xid8        NOT NULL DEFAULT pg_current_xact_id(), -- 写入事务 id（提交序水位真源）
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_outbox_event_id UNIQUE (event_id)               -- 生产侧防重复 INSERT（同一业务事件只一行）
);
-- consumer 按 (seq) 顺序拉取；按 topic 过滤；xid 水位裁剪在【应用层】连续安全前缀做、SQL 不过滤 xid（见 §3.2 / §11.D）
CREATE INDEX idx_outbox_seq           ON outbox_events (seq);
CREATE INDEX idx_outbox_topic_seq     ON outbox_events (topic, seq);
CREATE INDEX idx_outbox_xid           ON outbox_events (xid);
CREATE INDEX idx_outbox_created       ON outbox_events (created_at);  -- sweeper 滞留巡查（§6.3）
```

> **为何同时有 `id`(uuid v7) 与 `seq`(bigint identity)**：`seq` 是稠密单调整数，cursor 与水位比较（`seq > cursorSeq`）高效且无歧义；`id`(uuid v7) 对外暴露、做 event 引用。两者都时间有序但 `seq` 更适合「严格 > 游标」的保序拉取。`event_id` 是业务语义幂等键（如 `publish:{versionId}:{manifestHash}`、`import_done:{jobId}`），保证同一业务事件即便重试也只 INSERT 一行（UNIQUE 兜底），consumer 侧再以 `event_id` 二次幂等（§3.3）。

### 2.3 event_id 生成规约（生产侧幂等）

| topic | event_id 模板 | 幂等含义 |
|---|---|---|
| `capability.published` | `published:{versionId}:{manifestHash}` | 同版本同 manifest 只发一次（重发布走新版本 = 新 manifestHash） |
| `capability.unpublished` | `unpublished:{capabilityId}:{at_epoch_bucket}` | 同一下架动作不重复（评审拒绝下架） |
| `notify.import_completed` | `import_done:{jobId}:{attemptNo}` | 同 attempt 只通知一次；重入队新 attempt 视作新事件（避免漏通知） |
| `notify.extract_completed` | `extract_done:{jobId}:{attemptNo}` | 同上 |
| `notify.publish_completed` | `publish_done:{versionId}` | 单条发布完成一次；批量见 batchItem 维度 |
| `notify.review_decided` | `review:{capabilityId}:{reviewRound}` | 每轮评审决定通知一次 |

---

## 3. B-14 · consumer 顺序拉取框架 + 启动级防重 + 提交序安全 + 幂等

### 3.1 进程模型与启动级防重（advisory lock / lease）

- **每个 topic consumer 单实例、单线程、按 `seq` 顺序拉取**（保序，不可多实例并发——并发会破坏顺序与 cursor）。本期两类：`MarketplaceProjection`（消费 `capability.*`）、`NotifyConsumer`（消费 `notify.*`）。`MeteringConsumer` 注册但**本期不启动**。
- **启动级防重（防误 scale 破坏保序）**：每个 consumer 启动时先拿**互斥锁**，拿不到的实例**直接退出或只报 degraded、绝不消费**：
  - 首选 **PG advisory lock**：`pg_try_advisory_lock(hashtext('consumer:' || $consumerName))`。拿到才进入消费循环；拿不到 → 该实例不消费（记日志 + `/ready` 该消费者标 degraded，但不拖垮整进程）。会话级 advisory lock 在持锁连接断开时自动释放，天然适配「实例挂了锁自动放、另一实例接管」。
  - 备选 **Redis lease**（redis_hot）：`SET consumer:lock:{name} {instanceId} NX PX {ttl}` + 周期续期；崩溃后 TTL 到期自动释放。
  - 二者择一即可，advisory lock 与 PG 同生命周期更省一个依赖；选 Redis lease 时须与 sweeper 单活锁（§6.1）用同一 lease 约定。
- **consumer 不属于 sweeper**（脊柱与 B-16 已明确）：sweeper 只做 job 对账/orphan/outbox 滞留补投，**不承担 consumer 保序**。

### 3.2 提交序安全（xid 水位 · 连续安全前缀，不跳 unsafe 行）

> **唯一权威算法 = 脊柱 §11.D（Codex#1）**。本节是其在 70 域的落地复述，**不得偏移**。关键：**SQL 不过滤 `xid`，水位裁剪在应用层做**；若把 `xid < xmin` 写进 SQL `WHERE`，会永远遇不到「首条 unsafe 行」（被 SQL 直接滤掉），cursor 会越过被滤掉的低 seq 未提交行、等它提交后已无人回头取它 → **事件永久漏消费**。

consumer 拉取一批的安全边界算法（契约，非实现，遵 §11.D 连续安全前缀）：

1. 取「已提交水位」`xmin = pg_snapshot_xmin(pg_current_snapshot())`：所有 `xid < xmin` 的事务都已确定提交/回滚，可安全读。
2. 按 `WHERE topic = $topic AND seq > $cursorSeq ORDER BY seq ASC LIMIT $batch` 取**连续批**——**SQL 里不带任何 `xid` 过滤**，把可能 unsafe 的行也读进来（见下「权威取批 SQL」）。
3. 应用层**顺序扫描**该批，逐条比对 `xid` 与 `xmin`：
   - `xid < $xmin` → 安全，处理它、记入「可提交的连续安全前缀」。
   - **遇到第一条 `xid >= $xmin`（其事务可能仍 in-flight）→ 立即停止本轮**，不处理它、也不处理其后任何行（即使后面有 `xid < $xmin` 的也不抢跑）。等下一轮 `xmin` 推进后再处理。
4. **只把已处理的连续安全前缀的末尾 seq 提交为新 cursor**（cursor 与处理副作用同事务，见 §3.3）。这样 cursor 永远 `< 任何 in-flight 事务最早写入行的 seq`，**永不跨 in-flight 事务、永不漏读低 seq 晚提交的事件**。

```sql
-- §11.D 唯一权威取批：不在 SQL 过滤 xid，水位判定交应用层连续前缀扫描
SELECT seq, event_id, topic, payload, xid
FROM outbox_events
WHERE topic = :topic
  AND seq > :cursorSeq
ORDER BY seq ASC
LIMIT :batch;
-- 应用层：xmin = pg_snapshot_xmin(pg_current_snapshot())；顺序扫描，
--   命中首条 xid >= xmin 立即 break；只提交 break 之前连续处理过的最大 seq 为新 cursor。
```

> 没有 xid 水位的 naive「按 id/seq 升序消费」会在「大 id 事务先提交、小 id 事务后提交」时把后者漏掉（cursor 已越过它）。**但水位过滤绝不能下推进 SQL**——必须在应用层做连续前缀停判，否则等价于「把 unsafe 行删掉再升序消费」，同样漏读。这是飞书差异第 3 条 + Codex#1 的核心修正。

### 3.3 cursor 与事件处理同一事务（at-least-once + 幂等 = effectively-once）

- **每条事件的「处理副作用 + cursor 推进」必须在同一 PG 事务内提交**：consumer 在一个事务里 ① 执行处理（写 marketplace_listings / 写 notifications / 触发外部投递的入队） ② `UPDATE consumer_cursors SET last_seq = $thisSeq` ③ 提交。崩溃在提交前 ⇒ 副作用与 cursor 同时回滚，重启从原 cursor 重放（at-least-once）。
- **event_id 幂等**：处理副作用对 `event_id` 幂等（投影 `ON CONFLICT DO UPDATE`；通知按 `(notification dedupe_key)` `ON CONFLICT DO NOTHING`；计量 `ON CONFLICT DO NOTHING` 且 affected=1 才累加）。at-least-once 重放 + event_id 幂等 = **effectively-once**。
- **外部副作用（飞书/邮件发送）不进同一事务**：外部 I/O 不可回滚，故先在事务内把「站内通知 + 待外发记录」落库（同事务、可靠），外发由后续步骤读 `notification_channels` 投递（见 §5.2），失败重试不影响 cursor 推进。

### 3.4 `consumer_cursors` DDL

```sql
-- B-14 · 每个 consumer 一行游标。cursor 推进与事件处理同事务；永不跨 in-flight。
CREATE TABLE consumer_cursors (
  consumer_name text        PRIMARY KEY,                  -- 'MarketplaceProjection' | 'NotifyConsumer' | 'MeteringConsumer'
  topic         text        NOT NULL,                     -- 该 consumer 订阅的 topic（或 topic 前缀，多 topic 时拆多行）
  last_seq      bigint      NOT NULL DEFAULT 0,           -- 已处理到的 outbox_events.seq（严格 > 拉取）
  last_event_id text,                                     -- 已处理的最后一条 event_id（排障/审计）
  updated_at    timestamptz NOT NULL DEFAULT now()
);
```

> 一个 consumer 订阅多个 topic 时（如 NotifyConsumer 订阅四个 `notify.*`），可用 `(consumer_name, topic)` 复合主键拆多行各自推进；或单行单调消费「该 consumer 关心的所有 topic 的合并 seq 流」。本期 NotifyConsumer 按 `(consumer_name, topic)` 拆多行（各 notify 子 topic 独立游标，互不阻塞——某子 topic 毒丸不卡其它）。MarketplaceProjection 对 `capability.*` 用单行合并流（保上架/下架严格顺序）。DDL 改主键为 `PRIMARY KEY (consumer_name, topic)` 以支持多行。

```sql
-- 多 topic 版本（本期采用）
ALTER TABLE consumer_cursors DROP CONSTRAINT consumer_cursors_pkey;
ALTER TABLE consumer_cursors ADD PRIMARY KEY (consumer_name, topic);
```

---

## 4. B-15 · 毒丸/失败按 topic 策略 + dead_events

### 4.1 三类 topic 策略矩阵

| topic 类 | 失败处理 | cursor 行为 | 用户/运维呈现 | 验收 |
|---|---|---|---|---|
| `lifecycle`（capability.published/unpublished） | **重试 + 卡住等人工 + 告警**，**不进 dead_events、不跳过**（保上架顺序） | cursor **停在卡住条**，宁延迟不前进 | 不放错状态（市集不出现错误上架/下架态）；告警兜底；恢复后状态补齐 | 贯穿-26 |
| `notify`（notify.*） | 重试 N 次（默认 3，指数退避）→ 仍败进 `dead_events` + **cursor 跳过该条** + 告警 | cursor **跳过**死信条，继续处理后续通知（一条通知失败不阻塞其它） | 通知漏发不致命；dead_events 可人工/补投重放 | 导入-32/贯穿-03 |
| `metering`（usage.metering，本期不产生） | 重试 N 次 → 进 `dead_events` + cursor 跳过 + 告警 | cursor 跳过 | **收益页 / 成本日报显式「未入账事件 N 条」**（N=该 topic 未补记 dead_events 数），不悄悄少算；补记后归零 | 贯穿-25、外壳首页-31 |

> **lifecycle 不进 dead_events** 是有意为之：上架/下架的顺序正确性高于「不阻塞」，卡住宁可停（等人工修）也不能跳过造成市集状态错乱。notify/metering 反之——单条失败不该卡住整个通知/计量流，进死信 + 跳过 + 显式暴露。

### 4.2 重试与退避

- notify/metering 在 consumer 内对单条事件重试，退避 `next_retry_at = now() + base * 2^attempts`（base 默认 30s，封顶如 30min）；`attempts >= maxAttempts`（默认 3）落 `dead_events`。
- LLM/外部投递（飞书/邮件）的失败重试 ≤ 2/N 后才落终态（与 LLM Gateway §6.3 重试策略、脊柱 §3 「重试 ≤2 才落错误信封」一致）。

### 4.3 `dead_events` DDL

```sql
-- B-15 · 毒丸死信。notify/metering 重试耗尽落此；lifecycle 不进此表（卡住等人工）。
-- schema 层焊死（Codex#12）：event_id FK → outbox_events、status/attempts CHECK、唯一键按 (consumer, event) 语义。
CREATE TABLE dead_events (
  id            uuid        PRIMARY KEY DEFAULT gen_uuid_v7(),
  consumer_name text        NOT NULL,                     -- 哪个 consumer 投递失败
  topic         text        NOT NULL,
  event_id      text        NOT NULL,                     -- 源 outbox_events.event_id（重放幂等锚点）
  outbox_seq    bigint      NOT NULL,                     -- 源 seq（重放定位）
  payload       jsonb       NOT NULL,                     -- 冗余事件 payload（重放不必回查 outbox）
  last_error    jsonb,                                    -- 人话错误（ErrorEnvelope.error 形态，禁堆栈）
  attempts      int         NOT NULL DEFAULT 0,
  next_retry_at timestamptz,                              -- 补投计划时刻（NULL = 不自动补投，待人工）
  status        text        NOT NULL DEFAULT 'dead',      -- dead | retrying | resolved
  created_at    timestamptz NOT NULL DEFAULT now(),
  resolved_at   timestamptz,
  -- 死信源必须是真实存在的 outbox 事件（event_id 是 outbox_events 的 UNIQUE 列 uq_outbox_event_id，可作 FK 目标）。
  CONSTRAINT fk_dead_events_event
    FOREIGN KEY (event_id) REFERENCES outbox_events (event_id),
  -- 同 consumer 对同一事件只一条死信（at-least-once 重放/重入死信幂等；不含 topic：event_id 已全局唯一定 topic）。
  CONSTRAINT uq_dead_event UNIQUE (consumer_name, event_id),
  CONSTRAINT ck_dead_status   CHECK (status IN ('dead', 'retrying', 'resolved')),
  CONSTRAINT ck_dead_attempts CHECK (attempts >= 0)
);
CREATE INDEX idx_dead_unresolved ON dead_events (status, next_retry_at) WHERE status <> 'resolved';
CREATE INDEX idx_dead_topic      ON dead_events (topic, status);  -- 「未入账 N 条」按 topic 计数
```

> **唯一键语义（Codex#12 收紧）**：死信唯一性锚点 = `(consumer_name, event_id)`。`event_id` 已由 `uq_outbox_event_id` 全局唯一、且单条 outbox 行只属一个 topic，故 `topic` 不入唯一键（同 event 必同 topic，加 topic 是冗余且会破坏「同 consumer 同事件只一条」语义）。一个 event 可被多个 consumer 各自打入死信（如同一 outbox 行被两个 consumer 订阅），故 `consumer_name` 必须在唯一键里。`event_id` FK 到 `outbox_events(event_id)`，杜绝「死信指向不存在的事件」；重放/补投按 `event_id` 回查或直接用冗余 `payload`。

### 4.4 毒丸的用户侧呈现（绝不裸露错误码 + 不悄悄漏）

- **「未入账事件 N 条」（贯穿-25 / 外壳首页-31）**：收益页 / 成本日报读 `SELECT count(*) FROM dead_events WHERE topic='usage.metering' AND status='dead'` 得 N，显式展示人话「未入账事件 N 条（系统正在补记）」。**本期 metering 不产生事件，N 恒为 0 / 占位**；机制就绪，随计量上线生效。补记（重放成功 → `status='resolved'`）后 N 归零。
- dead_events 的 `last_error` 只存人话（ErrorEnvelope.error 形态），**禁堆栈/原始报错**（脊柱 §3 硬约束）。运维补投经内部脚本/sweeper（§6.3），不暴露给创作者死信细节。

---

## 5. B-35 · 通知链路（NotifyConsumer + `/notifications`）

### 5.1 链路总览（关页也收得到 = 异步、不依赖 SSE）

```
业务 Job 完成（导入/萃取/发布/评审）
  └─[同事务]→ INSERT outbox_events(notify.*)        # B-13，不丢
        └─ NotifyConsumer 拉取（顺序+xid 水位+幂等）  # B-14
              └─[同事务] INSERT notifications(站内)       # 立即可见，不丢
                       + INSERT notification_channels(待外发：飞书/邮件)
                       + 推进 cursor
              └─ 外发投递器读 notification_channels → 发飞书/邮件（失败重试，不卡 cursor）
```

- **通知不走 SSE**：SSE 要求页面在线，而导入完成通知的核心场景正是「关页也收得到」（导入-32/贯穿-03/导入-11）。故通知 = 持久站内表（`notifications`）+ 外部通道（飞书/邮件）。前端在线时靠轮询 `GET /notifications/unread-count`（或回页面时拉 `GET /notifications`）感知；离线靠飞书/邮件。
- 通知与 B-12 的 `done` 帧是**两条独立路径**：`done` 给「在线盯着的页面」即时关流；通知给「关了页面的人」事后触达。二者都由同一 Job 完成触发，互不替代。

### 5.2 通道与投递语义

| 通道 channel | 何时投 | 失败处理 | 关页可达 |
|---|---|---|---|
| `inapp`（站内） | 每条通知必落 | 落库即成功（同 cursor 事务） | 是（回页面/拉取可见） |
| `lark`（飞书） | 用户开启且配置可投 | 重试 N 次 → 该通道标 failed（不影响站内、不卡 cursor） | 是 |
| `email`（邮件） | 用户开启且有邮箱 | 同上 | 是 |

外发由 `notification_channels` 行驱动（`status: pending→sent/failed`），可由 NotifyConsumer 同进程异步发，或独立投递循环发；失败重试在 channel 行上记 attempts，耗尽标 failed + 告警，**不回滚已落的站内通知、不卡 cursor**（站内是可靠主通道，外发是尽力而为增强）。

### 5.3 通知数据模型 DDL

```sql
-- B-35 · 站内通知（持久、关页可达）
CREATE TABLE notifications (
  id            uuid        PRIMARY KEY DEFAULT gen_uuid_v7(),
  recipient_id  uuid        NOT NULL REFERENCES users(id),
  kind          text        NOT NULL,        -- import_completed|extract_completed|publish_completed|review_decided
  title         text        NOT NULL,        -- 人话标题（中文），禁错误码/堆栈（硬规则②）
  body          text,                        -- 人话正文，可空
  link          text,                        -- 把人带回完成态的应用内路径（如 /creator/builder?draftId=...&step=import）
  dedupe_key    text        NOT NULL,        -- = 源 event_id，幂等：同事件只一条站内通知
  read_at       timestamptz,                 -- NULL = 未读
  trace_id      text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_notif_dedupe UNIQUE (recipient_id, dedupe_key)  -- at-least-once 重放不产生重复站内通知
);
CREATE INDEX idx_notif_recipient_unread ON notifications (recipient_id, created_at DESC) WHERE read_at IS NULL;
CREATE INDEX idx_notif_recipient_all    ON notifications (recipient_id, created_at DESC);

-- B-35 · 外发通道明细（飞书/邮件投递状态，尽力而为，不卡 cursor）
CREATE TABLE notification_channels (
  id              uuid        PRIMARY KEY DEFAULT gen_uuid_v7(),
  notification_id uuid        NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  channel         text        NOT NULL,      -- inapp|lark|email
  status          text        NOT NULL DEFAULT 'pending', -- pending|sent|failed
  attempts        int         NOT NULL DEFAULT 0,
  last_error      jsonb,                     -- 人话错误（禁堆栈）
  sent_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_notif_channel UNIQUE (notification_id, channel)
);
CREATE INDEX idx_notif_channel_pending ON notification_channels (status, created_at) WHERE status = 'pending';
```

### 5.4 `/notifications` 端点契约

> 所有端点在 `/api/v1` 下，鉴权 = Logto JWT（脊柱 §10 / B-08）；只读/操作本人通知（`recipient_id = JWT sub 对应 userId`，越权读他人 → 404 `NOT_FOUND` 不暴露存在性）。

#### `GET /api/v1/notifications`

- **method + path**：`GET /api/v1/notifications`
- **鉴权**：JWT 必需；仅返回本人通知。
- **请求**：query = `PageQuery`（脊柱 §9：`cursor?`、`limit?`≤100 默认 20、`order?` 默认 `desc`）+ 可选 `filter=unread|all`（默认 `all`）。
- **响应**：`Paginated<NotificationView>`（cursor 分页，**不返 total**——未读数走专用端点）。
- **错误用例**：
  - 401 `UNAUTHENTICATED` / `escalate`（未登录 → 前端跳登录）。
  - 400 `VALIDATION_FAILED` / `change_input`（cursor 非法 / limit 越界）。
- **幂等/分页**：GET 天然幂等；cursor 唯一（脊柱 §2.3）。

#### `POST /api/v1/notifications/{notificationId}/read`

- **method + path**：`POST /api/v1/notifications/{notificationId}/read`
- **鉴权**：JWT；仅本人。
- **请求**：无 body；**须带 `Idempotency-Key`**（脊柱 §4，scope=`notification.read`；重复标已读为幂等无害操作，回放首次结果）。
- **响应**：`Envelope<NotificationView>`（更新后的通知，`readAt` 已填）。
- **错误用例**：
  - 404 `NOT_FOUND` / `change_input`（不存在或非本人）。
  - 401 `UNAUTHENTICATED` / `escalate`。
- **幂等**：重复标已读 → 回放（同 §4.2 矩阵「首次已完成→回放」）。

#### `POST /api/v1/notifications/read-all`

- **method + path**：`POST /api/v1/notifications/read-all`
- **鉴权**：JWT；仅本人。
- **请求**：无 body；**须带 `Idempotency-Key`**（脊柱 §4，scope=`notification.read_all`；写命令、重复全标已读为幂等无害操作，回放首次结果）。
- **响应**：`Envelope<{ updated: number }>`（本次置已读条数）。
- **错误用例**：401 `UNAUTHENTICATED` / `escalate`。
- **幂等**：重复调用 → 第二次 `updated:0`，对前端透明。

#### `GET /api/v1/notifications/unread-count`

- **method + path**：`GET /api/v1/notifications/unread-count`
- **鉴权**：JWT；仅本人。
- **请求**：无。
- **响应**：`Envelope<{ unread: number }>`（前端铃铛红点轮询用；轻量计 `read_at IS NULL`）。
- **错误用例**：401 `UNAUTHENTICATED` / `escalate`。
- **幂等/分页**：天然幂等；无分页。

---

## 6. B-16 · sweeper（job 对账 + orphan 清理 + outbox 滞留告警补投）

> sweeper = **全局单实例**后台循环，依赖 B-05（ObjectStore，orphan 清理）、B-10（jobs/fencing，对账）、B-13（outbox，滞留补投）。**只做三件事，不承担 consumer 保序**（脊柱 §6.2 / 技术方案 1.1）。

### 6.1 单活保证

- sweeper 进程启动拿 **Redis 锁（redis_hot）** `SET sweeper:lock {instanceId} NX PX {ttl}` + 周期续期（lease 续 TTL）。拿到才进循环；拿不到退出 / 待命。崩溃后 TTL 到期，另一实例接管。与 consumer 启动级防重（§3.1）同类机制、不同锁键。

### 6.2 job 对账（fencing 重入队）

- 周期扫 `SELECT id, attempt_no, fence_token FROM jobs WHERE status='running' AND lease_until < now()`（用索引 `idx_jobs_lease`，脊柱 §6.3）。
- **仅 `lease_until` 过期才重入队**（worker 死/卡）：`UPDATE jobs SET attempt_no = attempt_no + 1, fence_token = fence_token + 1, lease_owner = NULL, lease_until = NULL WHERE id = $id AND status='running' AND lease_until < now()` → 以**新 fence_token** 重新入 BullMQ。旧 worker 即便复活，写入带旧 `fence_token` → `WHERE ... AND fence_token=?` 0 行 → 安全退出（脊柱 §6.2 铁律）。**lease 未过期绝不抢**。该重入队是**单条原子 `UPDATE`**（条件 `status='running' AND lease_until < now()` 内联进 `WHERE`），遵脊柱 **§11.A 受保护写入**——无「先查后写」两步窗口（前一步的 `SELECT` 仅为列举待对账 id，真正换 fence 的写入靠本条单 SQL 的 WHERE 兜底，两实例并发也只有一个 `UPDATE` 命中、另一条 0 行）。
- 取消语义不归 sweeper（取消是 B-11 在线动作，标 cancelled + 换 fence），但被取消的 cancelled job 不会被 sweeper 重入队（条件限 `status='running'`）。

### 6.3 outbox 投递滞留巡查（告警 + 补投）

- 周期扫「写入已久但所有活跃 consumer 的 cursor 都没越过」的 outbox 行（滞留 = `created_at < now() - threshold` 且 `seq > max(consumer_cursors.last_seq for its topic)`）→ 告警（飞书，经 O-06 通道）。
- 对 `dead_events` 中 `status='dead' AND next_retry_at <= now()` 的可自动补投条：标 `retrying` → 重新触发对应 consumer 处理（按 `event_id` 幂等，重放安全）→ 成功标 `resolved`、失败 `attempts++` 重排 `next_retry_at`。**lifecycle 类不在 dead_events**（卡住等人工），sweeper 对 lifecycle 滞留只告警不自动补（避免乱序补造成市集状态错乱，贯穿-26）。

### 6.4 orphan 清理（依赖 B-05 ObjectStore）

- 周期扫「S3 里有对象但 PG 无引用」（导入上传后未建 job、或 job 失败后产物悬挂）→ 超龄（如 > 24h）orphan 对象清理。清理前比对 PG（raw_snapshots.s3_key / artifacts.s3_key），**只删确认无引用的**，且只删超龄的（避免删正在上传中的）。
- 清理操作只读 PG + 删 S3，不写业务态；删除记审计日志。

> sweeper 不暴露在线端点；其健康由进程存活 + Redis 锁持有 + 巡查心跳日志体现。对账/补投失败只告警，不影响在线请求（永不裸转圈：卡死 job 靠 sweeper 自愈而非永久转圈）。

---

## 7. outbox 各事件 payload schema

> payload 是 `outbox_events.payload`（jsonb）。consumer 与 NotifyConsumer 按 topic 解析。下为 zod 风格人读镜像（真源在 `src/shared/`）。所有 payload 含 `traceId` 以贯穿。**本期仅 `capability.*` 与 `notify.*` 实际产生**；`usage.metering` / `runtime.*` 仅冻结 schema、不产生。

```typescript
import type { CapabilityId, VersionId, JobId, UserId, Slug, TraceId, IsoDateTime } from '@shared/types';

// ---------- capability.* (lifecycle, MarketplaceProjection 消费) ----------
export interface CapabilityPublishedPayload {
  capabilityId: CapabilityId;
  versionId: VersionId;          // 被发布/回退到的版本（不可变寻址）
  slug: Slug;                    // 仅展示，寻址用 versionId（脊柱 §1.2）
  manifestHash: string;          // 冻结 manifest 的 hash
  reviewStatus: 'alpha_pending' | 'published'; // 发布即 alpha_pending；评审通过转 published
  isRollback: boolean;           // true = 评审拒绝后回退到上一 published 版（B-30）
  ownerUserId: UserId;
  traceId: TraceId;
  occurredAt: IsoDateTime;
}
export interface CapabilityUnpublishedPayload {
  capabilityId: CapabilityId;
  reason: 'review_rejected_no_prev'; // 拒绝且无上一版 → 下架（B-30）
  ownerUserId: UserId;
  traceId: TraceId;
  occurredAt: IsoDateTime;
}

// ---------- notify.* (NotifyConsumer 消费) ----------
interface NotifyBase {
  recipientId: UserId;           // = 触发 Job 的创作者
  link: string;                  // 把人带回完成态的应用内路径
  traceId: TraceId;
  occurredAt: IsoDateTime;
}
export interface NotifyImportCompletedPayload extends NotifyBase {
  jobId: JobId; attemptNo: number;
  snapshotId: string; segmentCount: number;     // 完成态摘要（用于通知正文人话）
}
export interface NotifyExtractCompletedPayload extends NotifyBase {
  jobId: JobId; attemptNo: number; candidateCount: number;
}
export interface NotifyPublishCompletedPayload extends NotifyBase {
  versionId: VersionId; capabilityId: CapabilityId; reviewStatus: 'alpha_pending';
}
export interface NotifyReviewDecidedPayload extends NotifyBase {
  capabilityId: CapabilityId; versionId: VersionId;
  decision: 'approved' | 'rejected';
  rejectReason?: string;         // 简单拒绝原因（人话，B-30）；approved 时空
}

// ---------- usage.metering (B-36, 冻结 schema、本期不产生) ----------
export interface UsageMeteringPayload {
  sessionId: string; turn: number; attempt: number;  // event_id=hash(session,turn,attempt)
  consumerKey: string;                               // 含匿名 hash(share_token+anon_cookie)
  tokens: number; costMicros: number; revenueMicros: number;
  mode: 'trial' | 'paid';                            // trial 计量隔离
  traceId: TraceId; occurredAt: IsoDateTime;
}

// ---------- runtime.session_event (B-40, 冻结 schema、本期不产生) ----------
export interface RuntimeSessionEventPayload {
  sessionId: string; commandId?: string;             // ctrl 流幂等（last_applied_command_id）
  phase: string;                                     // turn 状态机阶段
  traceId: TraceId; occurredAt: IsoDateTime;
}
```

---

## 8. 端口契约（B-04 / B-05 / B-06）

> 端口是 `domain/ports/` 声明的接口，app 层注入 infra 实现（六边形降级，技术方案 1.4 / 4.2）。domain 不 import infra，只依赖这些接口。下为接口形态契约（非实现）。

### 8.1 B-04 · Redis 双实例分工（redis_queue / redis_hot）

**两个物理实例，职责与持久化策略冲突，必须拆开**（技术方案 §4 / §6.1）：

| 实例 | 持久化/驱逐 | 承载 | 健康检查 | env |
|---|---|---|---|---|
| `redis_queue` | `appendonly yes`(AOF) + `maxmemory-policy noeviction`（队列绝不被驱逐） | **仅 BullMQ 队列**（jobId 去重、job 触发） | `PING` 通 → ok（计入 `/ready`，脊柱 §10，真失败） | `REDIS_QUEUE_URL` |
| `redis_hot` | `maxmemory` + `allkeys-lru`(eviction) | 事件 Streams（`events:{kind}:{id}`，SSE 源）、控制流、分布式锁（sweeper 单活、consumer lease）、限流计数 | `PING` 通 → ok（计入 `/ready`，真失败） | `REDIS_HOT_URL` |

```typescript
// domain/ports：本域只声明用到的最小面（队列触发不进 domain；hot 的 streams/lock 由 infra 直接用）
export interface QueuePort {            // redis_queue（BullMQ 抽象，app 层用）
  enqueue(jobType: JobType, jobId: JobId, fenceToken: number): Promise<void>; // jobId 去重 + 带 fence
  remove(jobId: JobId): Promise<void>;  // 取消时移除（B-11）
}
export interface EventStreamPort {      // redis_hot streams（SSE 源 + outbox 桥接不冲突）
  xadd(streamKey: string, frame: { event: string; data: unknown }): Promise<string>; // 返回 entry id（= SSE id）
  // 读/补发由 SSE Hub(B-12) 用，本域不重定义
}
export interface LockPort {             // redis_hot 锁（sweeper 单活、consumer lease 备选）
  acquire(key: string, ttlMs: number): Promise<{ token: string } | null>;
  renew(key: string, token: string, ttlMs: number): Promise<boolean>;
  release(key: string, token: string): Promise<void>;
}
```

> 两实例 compose / 健康检查 / env 全部独立。混一实例会让 BullMQ 的 noeviction 与热缓存的 eviction 互相污染（队列被驱逐 = 丢任务触发）。

### 8.2 B-05 · ObjectStore 端口（MinIO/S3，四桶）

```typescript
// domain/ports/object-store.ts —— domain 声明，infra/s3 实现
export type Bucket = 'agora-raw' | 'agora-artifacts' | 'agora-exports' | 'agora-experience';
export interface ObjectStorePort {
  // 预签名直传/直下（PG 只存 key，前端直传 S3，技术方案 §4）
  presignPut(bucket: Bucket, key: string, opts?: { contentType?: string; expiresSec?: number }): Promise<{ url: string; key: string }>;
  presignGet(bucket: Bucket, key: string, opts?: { expiresSec?: number }): Promise<{ url: string }>;
  // worker 拉原文（导入 B-19）
  getObject(bucket: Bucket, key: string): Promise<ReadableStream>;
  // sweeper orphan 清理（B-16 §6.4）：列举 + 删除（删前比对 PG 引用）
  list(bucket: Bucket, prefix: string): Promise<Array<{ key: string; size: number; lastModified: IsoDateTime }>>;
  delete(bucket: Bucket, key: string): Promise<void>;
  head(bucket: Bucket, key: string): Promise<{ size: number; lastModified: IsoDateTime } | null>;
}
```

- **健康检查**：MinIO 连通（bucket exists / ping）→ ok（计入 `/ready`，真失败，脊柱 §10）。env `S3_ENDPOINT/S3_ACCESS_KEY/S3_SECRET_KEY/S3_REGION`。
- 四桶：`agora-raw`（去敏快照）、`agora-artifacts`（产物）、`agora-exports`、`agora-experience`（经验体语料）。原文不落正式盘——导入处理完即弃（技术方案 1.2）。

### 8.3 B-06 · LLM Gateway 端口（限流 / 重试 / 计费 / 流式）

```typescript
// domain/ports/llm-gateway.ts —— domain 声明，infra/llm 实现
export type LlmTaskClass = 'extract' | 'structure_field' | 'embedding' | 'misc';
// 超时分级 40/45/60/180s 按 taskClass 选档（技术方案 1.4）
export interface LlmCallOptions {
  taskClass: LlmTaskClass;
  traceId: TraceId;
  ownerUserId?: UserId;       // 预算闸/计费归属
  anonKey?: string;           // 匿名按 token 限流（share_token 场景）
  stream?: boolean;           // 流式（结构化字段流 field_delta 的上游）
}
export interface LlmResult {
  text?: string;
  embedding?: number[];
  degraded: boolean;          // 上游不稳但有兜底 → 进度短语 + 退路（不裸转圈/不裸 502）
  usage: { promptTokens: number; completionTokens: number; costMicros: number }; // 审计落 audit_llm_calls（非计费真源）
}
export interface LlmGatewayPort {
  complete(prompt: string, opts: LlmCallOptions): Promise<LlmResult>;
  stream(prompt: string, opts: LlmCallOptions): AsyncIterable<{ deltaText: string }>; // → field_delta
  embed(input: string | string[], opts: LlmCallOptions): Promise<LlmResult>;
}
```

- **行为契约**：① 预算闸（成本上限 + 匿名按 token 限流）；② 超时分级（40/45/60/180s 按 taskClass）；③ **重试 ≤ 2** 后才落终态错误（脊柱 §3）；④ 审计落 `audit_llm_calls`（成本审计、**非计费真源**）；⑤ SSRF 闸（fetch_url 工具）；⑥ embedding 路由。
- **degraded 不算依赖失败**（脊柱 §10）：上游（OpenRouter）不稳 → `LlmResult.degraded=true` / 调用方返 `LLM_UPSTREAM_FAILED` + `action:'retry'|'wait'` + 进度短语，`/ready` 仍 `ready=true`（llm `required:false`）。**绝不裸转圈、绝不裸 502。**

```sql
-- B-06 · LLM 成本审计（非计费真源；计费真源是 usage_events，本期置空）
CREATE TABLE audit_llm_calls (
  id            uuid        PRIMARY KEY DEFAULT gen_uuid_v7(),
  owner_user_id uuid        REFERENCES users(id),
  anon_key      text,                          -- 匿名调用（share_token 场景）
  task_class    text        NOT NULL,          -- extract|structure_field|embedding|misc
  job_id        uuid        REFERENCES jobs(id),
  model         text,
  prompt_tokens int         NOT NULL DEFAULT 0,
  completion_tokens int     NOT NULL DEFAULT 0,
  cost_micros   bigint      NOT NULL DEFAULT 0,
  degraded      boolean     NOT NULL DEFAULT false,
  retries       int         NOT NULL DEFAULT 0, -- ≤2
  trace_id      text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_llm_owner_day ON audit_llm_calls (owner_user_id, created_at);
CREATE INDEX idx_audit_llm_job       ON audit_llm_calls (job_id);
```

---

## 9. 冻结 schema（本期只建表、不实现）

> B-36 / B-38 / B-40：DDL 进迁移、schema 进 `src/shared/`，但**不注册 consumer/processor、不产生数据、不挂端点**。建表是为「迁移只加不减、上线时不破坏兼容」。
>
> **FK 诚实原则（Codex#13）**：冻结表**不得自称 FK 闭合却无 FK**。本节对每张冻结表的每个引用列，要么**用后置 `ALTER TABLE` 补真 FK**（指向 users / capabilities / capability_versions / session_segments / runtime_sessions 等已存在的稳定表），要么**显式标注 `intentional loose`（有意不加 FK）并说明原因**。后置 ALTER 放在各冻结表 DDL 之后，避免建表期的前向引用顺序问题（部分被引用表如 runtime_sessions 在本节内才建）。

### 9.1 B-36 · 计量（usage_events / daily_*，置空不写）

```sql
-- 计费真源（effectively-once：event_id 幂等 + affected=1 才累加）。本期 MeteringConsumer 不启动、表空。
-- 引用列 FK 见本块末尾后置 ALTER（session_id → runtime_sessions 在 §9.3 才建，故后置补）。
CREATE TABLE usage_events (
  event_id      text        PRIMARY KEY,       -- = hash(session_id, turn, attempt)，幂等锚点
  session_id    uuid        NOT NULL,          -- → runtime_sessions（B-40，后置 FK）
  turn          int         NOT NULL,
  attempt       int         NOT NULL,
  consumer_key  text        NOT NULL,          -- 含匿名 hash(share_token+anon_cookie)；活跃消费者 COUNT(DISTINCT)
  capability_id uuid,                          -- → capabilities（后置 FK）
  creator_id    uuid,                          -- → users（后置 FK）
  mode          text        NOT NULL,          -- trial|paid（trial 计量隔离）
  tokens        int         NOT NULL DEFAULT 0,
  cost_micros   bigint      NOT NULL DEFAULT 0,
  revenue_micros bigint     NOT NULL DEFAULT 0,
  occurred_at   timestamptz NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_usage_creator_day ON usage_events (creator_id, occurred_at);

-- 按天聚合（活跃消费者不可从日聚合加和 → 单独桥表）。本期不跑聚合、表空。
-- ⚠️ 本域（70）是这三张 daily_* 表 + usage_events 的【唯一 DDL 真源】（B-36）。
--    工作台/主页域（60-dashboard-profile.md）只读这些表占位、不重定义；列名/PK 以本块为准。
CREATE TABLE daily_capability_stats (        -- 工作台能力表收益/sparkline + 主页总调用量公开口径数据源
  stat_date      date        NOT NULL,
  capability_id  uuid        NOT NULL REFERENCES capabilities(id) ON DELETE CASCADE,
  invocations    bigint      NOT NULL DEFAULT 0,
  tokens         bigint      NOT NULL DEFAULT 0,
  cost_micros    bigint      NOT NULL DEFAULT 0,   -- 消耗（成本，经营口径）
  revenue_micros bigint      NOT NULL DEFAULT 0,   -- 收益（经营口径；公开口径只 SELECT invocations）
  PRIMARY KEY (stat_date, capability_id)
);
CREATE INDEX idx_daily_cap_stats_cap ON daily_capability_stats (capability_id, stat_date);

CREATE TABLE daily_creator_consumers (       -- 活跃消费者桥表（COUNT(DISTINCT consumer_key)，含匿名）
  stat_date       date        NOT NULL,
  creator_id      uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  consumer_key    text        NOT NULL,            -- 含匿名键 hash(share_token+anon_cookie)（外壳首页-32）
  PRIMARY KEY (stat_date, creator_id, consumer_key) -- 当日去重；活跃消费者 = 跨天 COUNT(DISTINCT consumer_key)
);
CREATE INDEX idx_daily_consumers_creator ON daily_creator_consumers (creator_id, stat_date);

CREATE TABLE daily_creator_llm_stats (       -- 工作台 token-trend 数据源（双口径 tokens / invocations）
  stat_date      date        NOT NULL,
  creator_id     uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tokens         bigint      NOT NULL DEFAULT 0,   -- 合计 token（token-trend metric=tokens）
  invocations    bigint      NOT NULL DEFAULT 0,   -- 调用次数（token-trend metric=invocations）
  cost_micros    bigint      NOT NULL DEFAULT 0,
  PRIMARY KEY (stat_date, creator_id)
);
CREATE INDEX idx_daily_creator_llm_creator ON daily_creator_llm_stats (creator_id, stat_date);
```

### 9.2 B-38 · 经验体（experience_packs，不参与本期结构化）

```sql
-- B-25 本期直读 candidate_evidence/session_segments，不依赖此表（避免依赖倒挂）。仅冻结。
-- capability_id / segment_id 的 FK 见 §9.4 后置 ALTER（不在建表处内联，避免对建表顺序的前向依赖）。
CREATE TABLE experience_packs (
  id            uuid PRIMARY KEY DEFAULT gen_uuid_v7(),
  capability_id uuid NOT NULL,          -- 1:1 capability（→ capabilities，后置 FK）
  status        text NOT NULL DEFAULT 'frozen',
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_exp_pack_capability UNIQUE (capability_id)
);
CREATE TABLE experience_pack_items (
  id        uuid PRIMARY KEY DEFAULT gen_uuid_v7(),
  pack_id   uuid NOT NULL REFERENCES experience_packs(id) ON DELETE CASCADE,
  kind      text NOT NULL,              -- taste|rule|case
  content   jsonb NOT NULL
);
CREATE TABLE experience_pack_item_sources (
  item_id    uuid NOT NULL REFERENCES experience_pack_items(id) ON DELETE CASCADE,
  segment_id uuid NOT NULL,             -- 蒸馏血缘 → session_segments（后置 FK）
  PRIMARY KEY (item_id, segment_id)
);
```

### 9.3 B-40 · Runtime（runtime_sessions / artifacts，本期不交付）

```sql
-- 仅冻结表结构 + SSE session 型/ctrl 流 schema（§7 RuntimeSessionEventPayload）。不注册 processor、不挂 /runtime API。
-- 引用列 FK（capability_id / version_id）见本块末尾后置 ALTER。
CREATE TABLE runtime_sessions (
  id            uuid PRIMARY KEY DEFAULT gen_uuid_v7(),
  capability_id uuid NOT NULL,          -- → capabilities（后置 FK）
  version_id    uuid NOT NULL,          -- → capability_versions（后置 FK）
  mode          text NOT NULL,          -- trial|paid（trial 计量隔离）
  tier_code     text,
  phase         text NOT NULL DEFAULT 'init',  -- turn 状态机
  consumer_key  text,                   -- 含匿名
  last_applied_command_id text,         -- ctrl 流幂等（command_id）
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE artifacts (
  id            uuid PRIMARY KEY DEFAULT gen_uuid_v7(),
  session_id    uuid NOT NULL REFERENCES runtime_sessions(id) ON DELETE CASCADE,
  version_no    int  NOT NULL,
  base_version_no int,
  locked_blocks jsonb,
  gen_context   jsonb,
  s3_key        text,                   -- → agora-artifacts
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_artifact_session_ver UNIQUE (session_id, version_no)
);
```

### 9.4 冻结表后置 FK 补齐（Codex#13 · FK 诚实，不自称闭合却无 FK）

> 以下 `ALTER TABLE` 在 §9.1–§9.3 全部冻结表建好、且被引用的稳定表（`users` / `capabilities` / `capability_versions` / `session_segments` 已由脊柱/20/40 域先建）存在后执行，补齐冻结表引用列的真 FK。约束名固定，便于迁移与合并校验。30/40/50 域的复合血缘约束（candidate_evidence、publications、listings）见脊柱 §11.E 血缘约束注册表；**本域 `runtime_sessions(capability_id, version_id)` 亦为复合 FK**，复用 §11.E 注册的 `capability_versions (capability_id, id)` 父级唯一键（Codex#6-r2，下方 B-40 块），保证 session 的 version 必属其 capability。

```sql
-- B-36 · usage_events 引用列 FK（session_id 指向本节 §9.3 才建的 runtime_sessions，故此处后置补）
ALTER TABLE usage_events
  ADD CONSTRAINT fk_usage_events_session
    FOREIGN KEY (session_id) REFERENCES runtime_sessions (id),
  ADD CONSTRAINT fk_usage_events_capability
    FOREIGN KEY (capability_id) REFERENCES capabilities (id),
  ADD CONSTRAINT fk_usage_events_creator
    FOREIGN KEY (creator_id) REFERENCES users (id);

-- B-38 · experience_packs / item_sources 引用列 FK
ALTER TABLE experience_packs
  ADD CONSTRAINT fk_experience_packs_capability
    FOREIGN KEY (capability_id) REFERENCES capabilities (id) ON DELETE CASCADE;
ALTER TABLE experience_pack_item_sources
  ADD CONSTRAINT fk_exp_item_sources_segment
    FOREIGN KEY (segment_id) REFERENCES session_segments (id) ON DELETE CASCADE;

-- B-40 · runtime_sessions 引用列 复合 FK（Codex#6-r2 · 复用 00 §11.E 注册的父级唯一键）
--   原单列 FK（capability_id→capabilities、version_id→capability_versions(id)）不能证明
--   「version 属于该 capability」——DB 允许 session 的 version 属另一 capability。改为复合 FK，
--   引用 capability_versions 的 (capability_id, id) 唯一键（00 §11.E：uq_capability_versions_capability_id），
--   DB 层焊死「session.version 必属 session.capability」。capability/version 各自存在性由该复合父键
--   （capability_versions.capability_id 本身 FK→capabilities）transitively 保证，故删除原两条单列 FK。
ALTER TABLE runtime_sessions
  ADD CONSTRAINT fk_runtime_sessions_capability_version
    FOREIGN KEY (capability_id, version_id)
    REFERENCES capability_versions (capability_id, id);
```

> **intentional loose（有意不加 FK）声明**：
> - `usage_events.consumer_key` / `runtime_sessions.consumer_key`：含匿名 `hash(share_token+anon_cookie)`，**无对应实体表**，**intentional loose**（不加 FK；匿名身份本就无主体）。
> - `daily_creator_consumers.consumer_key`（§9.1）：同上，**intentional loose**。
> - `runtime_sessions.tier_code`、`artifacts.s3_key`、`*.last_applied_command_id`：值对象 / 外部对象键，非实体引用，**intentional loose**。
> - 其余 `*_id` 列均已补真 FK（上）或建表时内联（`daily_*` 的 capability_id/creator_id、`experience_pack_items.pack_id`、`artifacts.session_id`、`experience_pack_item_sources.item_id`）。**本节不再有「自称 FK 却无 FK」的列。**

---

## 10. 本域 TS 类型片段（归 `src/shared/`，不重定义脊柱 §9）

```typescript
import type {
  Id, UserId, JobId, CapabilityId, VersionId, TraceId, IsoDateTime,
  Envelope, Paginated, PageQuery,
} from '@shared/types';   // 脊柱 §9 共享类型，本域 import 不重定义

// ---------- outbox / topic ----------
export type OutboxTopic =
  | 'capability.published' | 'capability.unpublished'
  | 'notify.import_completed' | 'notify.extract_completed'
  | 'notify.publish_completed' | 'notify.review_decided'
  | 'usage.metering'         // B-36 冻结，本期不产生
  | 'runtime.session_event'; // B-40 冻结，本期不产生
export type TopicClass = 'lifecycle' | 'notify' | 'metering' | 'runtime';

export interface OutboxEvent<P = unknown> {
  id: Id;
  seq: number;
  eventId: string;          // 业务幂等键
  topic: OutboxTopic;
  aggregateId: Id;
  payload: P;
  traceId?: TraceId;
  createdAt: IsoDateTime;
}

// ---------- consumer / dead_events ----------
export interface ConsumerCursor {
  consumerName: string;
  topic: OutboxTopic;
  lastSeq: number;
  lastEventId?: string;
  updatedAt: IsoDateTime;
}
export type DeadEventStatus = 'dead' | 'retrying' | 'resolved';
export interface DeadEvent {
  id: Id;
  consumerName: string;
  topic: OutboxTopic;
  eventId: string;
  outboxSeq: number;
  attempts: number;
  status: DeadEventStatus;
  nextRetryAt?: IsoDateTime;
  // last_error 形态复用 ErrorEnvelope['error']（人话，禁堆栈）
  createdAt: IsoDateTime;
  resolvedAt?: IsoDateTime;
}

// ---------- 通知（B-35）----------
export type NotificationKind =
  | 'import_completed' | 'extract_completed' | 'publish_completed' | 'review_decided';
export type NotificationChannel = 'inapp' | 'lark' | 'email';
export interface NotificationView {
  id: Id;
  kind: NotificationKind;
  title: string;            // 人话（禁错误码/堆栈）
  body?: string;
  link?: string;            // 把人带回完成态
  readAt?: IsoDateTime | null;
  createdAt: IsoDateTime;
}
// 端点响应类型
export type NotificationsListResponse = Paginated<NotificationView>;
export type NotificationReadResponse  = Envelope<NotificationView>;
export type NotificationReadAllResponse = Envelope<{ updated: number }>;
export type UnreadCountResponse       = Envelope<{ unread: number }>;
export interface NotificationsListQuery extends PageQuery {
  filter?: 'unread' | 'all';   // 默认 all
}

// ---------- 端口（B-04/B-05/B-06）形态见 §8，类型别名汇出 ----------
export type { QueuePort, EventStreamPort, LockPort } from './ports/redis';
export type { ObjectStorePort, Bucket } from './ports/object-store';
export type { LlmGatewayPort, LlmCallOptions, LlmResult, LlmTaskClass } from './ports/llm-gateway';
```

---

## 11. 功能点覆盖表

| 功能点 | 名称 | 对应端点 | 对应表 | 验收用例模块 |
|---|---|---|---|---|
| **B-13** | outbox 同事务 + xid 水位 | （内部，无在线端点） | `outbox_events`（含 `xid`/`seq`/`event_id` UNIQ） | 发布-、接口- |
| **B-14** | consumer 顺序拉取 + 防重 + 提交序 + 幂等 | （内部，consumer 进程） | `consumer_cursors`（cursor 与处理同事务） | 发布-、接口-、贯穿-26/27 |
| **B-15** | 毒丸按 topic + dead_events | （内部；用户侧呈现经 §4.4） | `dead_events`（lifecycle 不进、notify/metering 进） | 发布-、接口-、贯穿-25/26、外壳首页-31 |
| **B-16** | sweeper：job 对账 / orphan / outbox 滞留补投 | （内部，sweeper 进程） | `jobs`(对账)、`outbox_events`(滞留)、`dead_events`(补投) | 贯穿-22、接口- |
| **B-35** | 通知链路 NotifyConsumer + `/notifications` | `GET /api/v1/notifications`、`POST /notifications/{id}/read`、`POST /notifications/read-all`、`GET /notifications/unread-count` | `notifications`、`notification_channels` | 导入-11/32、贯穿-03 |
| **B-04** | Redis 双实例分工 | （端口；健康检查计入 `/ready`） | （无表；env `REDIS_QUEUE_URL`/`REDIS_HOT_URL`） | 接口-、O-04 |
| **B-05** | S3 ObjectStore 端口 | （端口；健康检查计入 `/ready`） | （无表；s3_key 存于 raw_snapshots/artifacts；env `S3_*`） | 接口-、O-04 |
| **B-06** | LLM Gateway 端口 | （端口；degraded 不计 `/ready`） | `audit_llm_calls`（非计费真源） | 接口-、O-04、贯穿-（degraded 不裸转圈） |
| **B-36**（冻结） | 计量 usage_events / daily_* | （本期无端点、无 consumer） | `usage_events`、`daily_capability_stats`、`daily_creator_consumers`、`daily_creator_llm_stats` | 外壳首页-31、发布-16、贯穿-25（占位/「未入账 N 条」机制） |
| **B-38**（冻结） | 经验体 experience_packs | （本期无端点、不入结构化） | `experience_packs` + items + item_sources | 选择结构化-（冻结） |
| **B-40**（冻结） | Runtime 表 + 事件/SSE schema | （本期无端点、无 processor） | `runtime_sessions`、`artifacts`（`usage_events` 共用） | 接口-（schema 冻结） |

> 涉及的验收用例模块汇总：**贯穿-**（22 断线续传、25 未入账 N 条、26 lifecycle 卡住不放错、27 双标签不重复发布）、**导入-**（11 后台执行完成通知、32 站内+飞书/邮件关页可达）、**发布-**（事件投递可靠、16 上线后看用量占位）、**外壳首页-**（31 收益页未入账事件）、**接口-**（端口/表 schema 冻结）、**O-04**（五依赖健康检查口径）。

---

## 12. 合并校验摘要（供脊柱并行校验）

**对外端点清单（method + path）**
- `GET /api/v1/notifications` — 通知列表（cursor 分页，`Paginated<NotificationView>`）
- `POST /api/v1/notifications/{notificationId}/read` — 标已读（幂等，`Envelope<NotificationView>`）
- `POST /api/v1/notifications/read-all` — 全部已读（幂等，`Envelope<{updated}>`）
- `GET /api/v1/notifications/unread-count` — 未读数（`Envelope<{unread}>`）
- （健康检查 `GET /health` `GET /ready` 沿用脊柱 §10，本域补五依赖探针口径，不新增路径）

**表清单**
- 新增：`outbox_events`、`consumer_cursors`、`dead_events`、`notifications`、`notification_channels`、`audit_llm_calls`
- 冻结（schema-only）：`usage_events`、`daily_capability_stats`、`daily_creator_consumers`、`daily_creator_llm_stats`、`experience_packs`、`experience_pack_items`、`experience_pack_item_sources`、`runtime_sessions`、`artifacts`

**本域新增/收紧的约束名（固定，供合并校验；与 §11.E 注册表不重叠）**
- `dead_events`（Codex#12）：`fk_dead_events_event`（FK `event_id`→`outbox_events(event_id)`，目标列即 `uq_outbox_event_id`）、`uq_dead_event`（UNIQUE `(consumer_name, event_id)`，去 topic）、`ck_dead_status`（CHECK `status IN ('dead','retrying','resolved')`）、`ck_dead_attempts`（CHECK `attempts >= 0`）。
- 冻结表后置 FK（Codex#13，§9.4）：`fk_usage_events_session`/`fk_usage_events_capability`/`fk_usage_events_creator`、`fk_experience_packs_capability`、`fk_exp_item_sources_segment`。被引用表（`users`/`capabilities`/`capability_versions`/`session_segments`）由脊柱/20/40 域建，后置 ALTER 不改它们结构、仅加 FK。
- **`runtime_sessions` 复合 FK（Codex#6-r2，属 §11.E 注册表，非本域独有）**：`fk_runtime_sessions_capability_version (capability_id, version_id) → capability_versions(capability_id, id)`，复用 40 域 `uq_capability_versions_capability_id` 父级唯一键，**替换并删除原两条单列 FK**（`capability_id→capabilities`、`version_id→capability_versions(id)`）；保证 session 的 version 必属其 capability。建序：先 40 建唯一键，再本域 §9.4 后置 ALTER 加该复合 FK。
- `consumer_key` 类列（`usage_events`/`runtime_sessions`/`daily_creator_consumers`）= **intentional loose**（匿名 hash 无实体表），各域读这些表时不应假设其有 FK 完整性。

**SSE 事件清单**
- 本域**不新增** SSE event 类型（通知走站内表 + 外部通道，不走 SSE）。
- 复用脊柱 12 event 中的 `done`/`error`（由 B-12 SSE Hub 发，与通知是独立路径）；本域产生的 outbox 与 SSE 帧互不替代。
- redis_hot `EventStreamPort.xadd` 返回的 entry id = SSE 帧 `id:`（Last-Event-ID 锚点，端口契约见 §8.1）。

**引用到的脊柱共享类型（§9，import 不重定义）**
- `Id` / `UserId` / `JobId` / `CapabilityId` / `VersionId` / `TraceId` / `IsoDateTime`
- `Envelope<T>` / `Paginated<T>` / `PageQuery` / `Meta`（`placeholders` 用于「未入账 N 条」占位口径）
- `ErrorEnvelope`（`error` 形态复用于 `dead_events.last_error` / `notification_channels.last_error`，禁堆栈）、`ErrorAction`（401→escalate / 404→change_input / 423→wait 等缺省遵脊柱 §3.3）
- `JobType` / `JobStatus`（sweeper 对账 / QueuePort 触发）
- SSE 相关：`SSEFrame`（端口 xadd 返回 id）、`SSEStreamKind`（events:{kind} 命名）

**本域对脊柱的新增贡献（供其它域引用）**
- `OutboxTopic` / `TopicClass` 枚举 + topic 目录（§1）—— 发布域(B-27/28/30)、导入域(B-19)、提取域(B-22) 生产事件时按此 topic + event_id 模板（§2.3）写 outbox。
- `OutboxEvent<P>` 形态 + 各 payload schema（§7）—— 生产侧/消费侧共用。
- 端口接口 `QueuePort`/`EventStreamPort`/`LockPort`/`ObjectStorePort`/`LlmGatewayPort`（§8）—— 各域用例经这些端口而非直接碰 infra。

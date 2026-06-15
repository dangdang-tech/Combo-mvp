# 接口契约总览索引（创作者中心主链路）

> **本文是全部域契约的导航总览 + 全局清单**（端点 / 表 / SSE / 错误分类指针）。各域契约严格 import 脊柱 [`00-约定与状态机.md`](./00-约定与状态机.md)、不重定义共享约定。范围：**创作者中心主链路**（导入→提取→选择→结构化→发布 + 工作台/个人主页 + 鉴权 + 事件/基础设施），**排除消费链路 / 试用 / 计费**（这些仅冻结 schema、不挂可调用端点）。
>
> **真源优先级**：飞书《技术方案 · 创作者中心与消费链路》＞ `creator-builder/docs/01-详细技术方案.md`（62 功能点 / 数据模型 / 三条硬规则）＞ `docs/开工总纲-创作者中心主链路.md`（产品行为）＞ `docs/测试验收-创作者中心主链路.md`（验收口径）。TS 片段最终归 `src/shared/`（zod schema 即 OpenAPI 3.1 真源，本文档为人读镜像，冲突以 zod 为准）；DDL 归 `src/infra/pg/migrations/`。
>
> **一致性状态**：见 [`_consistency-report.md`](./_consistency-report.md)。Codex 对抗 R1 的 17 项裁定已全数落地（脊柱 §11.A~F 共识 + 各域实现）。**R2 复审 6 条残留阻塞项已逐条修复**：①ErrorEnvelope 字段统一 `userMessage`；②导入 SSE 鉴权改同源 Cookie（建流前 HTTP 失败）；③pairing 兑换绑 `pairId+code`、失败计数按 pairId 成立；④发布事务只接受 `draft`、被拒态终态不可变、`currentVersionId` 注释修正；⑤批量发布受保护写入补契约级 CTE 模板 A/B；⑥`runtime_sessions` 改复合 FK `(capability_id, version_id)→capability_versions(capability_id, id)`。
> **R3 复审 4 条残留阻塞项已逐条修复**：①20 域错误人话列/错误字段/文案残留 `message` 全部改 `userMessage`（修正 R2「全目录无残留」过度声明——见下「`message` 残留分类（据实）」）；②40 域 `POST /capabilities` 增 `fromVersionId` 分支，从本人 `review_rejected` 版派生新 `draft`（含首发被拒），50 重试/编辑入口指向该端点，「被拒→派生新 draft→重新发布」闭环成立；③B-21 上传鉴权 10↔20 统一为独立 PairAuth（`pairId`+`pairingCode`，不进 Logto JWT 中间件、无 token exchange），删 10 域「配对码换 JWT」表述；④批量发布计数幂等化——item 终态迁移与 batch 计数合成单条 CTE（item UPDATE 带 `state NOT IN ('published','failed')` 防重条件、计数只按 RETURNING 实际迁移行递增），终态回写重复执行不重复计数。
> **`message` 残留分类（据实，R2「全目录无残留」实为过度声明，现据实更正）**：全目录已无 ErrorEnvelope `message` schema 字段、无「错误 message / 端点 message」文案残留。`grep -rn "message"` 仅剩三类**合法非 schema 残留**——(a) `messageCount` / `message_count` 消息计数**数据字段**（20 域，13 处）；(b) zod `.refine({ message })` **校验参数**（40 域，3 处，非 ErrorEnvelope 字段）；(c) 脊柱/各域**规则声明 prose**（00/30 域，刻意提及 `message` 一词以**禁用**它，如「全契约不再有 `message` 同义字段」「`error.message` 字段引用即判违规」「替代 `message`」）。**这三类不是 ErrorEnvelope schema 残留，保留正确。**
> **R6 复审 2 条残留已逐条修复**：①`PATCH /drafts/{draftId}/selection` 鉴权口径全目录统一为 `requireAuth`+`requireRole('creator')`+owner（普通 HTTP、非 SSE 不走 §11.C），无残留「同源 Cookie」误标；②`POST /import/connect/pair` 等写命令 `Idempotency-Key` 由「可选/带」收紧为「必带 + 固定 scope」，新增 §2.10 写端点 × scope 总表（22 写端点全 ✅ + 已标注豁免）。
> **R7 复审 1 条残留已修复**：`auth/callback` 幂等豁免清单方法由误标的 `POST /auth/callback` 对齐为真实端点 `GET /api/v1/auth/callback`（OIDC browser redirect、code/state 一次性），从「POST 写命令豁免」移出、单列「GET 回调例外」（见下豁免清单）；`grep -rn "callback"` 全 11 处方法均为 GET、无 POST 残留，豁免清单 logout/presign/preview 方法标注与各域端点表一致（均 POST）。
> **可进入 Codex 复审。**

---

## 1. 各文件用途

| 文件 | 域 | 覆盖功能点 | 用途一句话 |
|---|---|---|---|
| [`00-约定与状态机.md`](./00-约定与状态机.md) | **脊柱（共享地基）** | B-07/B-09/B-10/B-11/B-12（机制）+ 全域引用 | 路由/版本、`Envelope`/`Paginated` 包络、`ErrorEnvelope`+action 五枚举、幂等矩阵+`idempotency_keys`、SSE 12 帧+`state_snapshot` 三型、jobs 状态机+fencing、`ProgressView`、`drafts`+`structure_state`、§9 全部共享 TS 类型、健康检查。**各域只引用、不重定义。** |
| [`10-auth-logto.md`](./10-auth-logto.md) | Auth / Logto | B-08（主）；为 B-21/B-30/B-32/B-33/B-34/F-04/O-04 提供被引契约 | Logto 自托管 OIDC 登录/回调/登出、`/me`、JWT 三守卫（`requireAuth`/`requireRole`/`optionalAuth`）、owner 可见性约定、share_token→匿名身份键、`users` 表（血缘根）。 |
| [`20-step1-import.md`](./20-step1-import.md) | STEP① 导入 | B-17/B-18/B-19/B-20/B-21 | 全量上传原文+云端去敏切段（两阶段时序）、直传 presign + 本机助手配对码直传、导入 Job 进度 SSE、快照统计/节选/去敏报告、`raw_snapshots`/`session_segments`（快照内去重）。 |
| [`30-step2-extract.md`](./30-step2-extract.md) | STEP② 提取 | B-22/B-23 | 萃取 Job（携 snapshot_id 只在该快照聚类）、候选逐个浮现 SSE、段级血缘下钻、单候选无连坐重试、`capability_candidates`/`candidate_evidence`。 |
| [`40-step3-4-structure.md`](./40-step3-4-structure.md) | STEP③选择 + STEP④结构化 | B-24/B-25/B-26（STEP③ 选择切换不写库、无 API；保存草稿/进入下一步有 API：`PATCH /api/v1/drafts/{draftId}/selection`） | 从候选建能力体 draft、manifest 软硬分层、结构化字段流 SSE（`field_*`+三退路）、软字段编辑/单字段重生成、published 后强制新版本、`capabilities`/`capability_versions`。 |
| [`50-step5-publish.md`](./50-step5-publish.md) | STEP⑤ 发布 | B-27/B-28/B-29/B-30/B-31（冻结） | 版本状态机+发布门同步事务、市集卡预览、批量发布无连坐 SSE、Alpha 人工评审+拒绝回退分流、`capability_tiers`/`publications`/`marketplace_listings`/`publish_batches`/`publish_batch_items`/`eval_reports`。 |
| [`60-dashboard-profile.md`](./60-dashboard-profile.md) | 工作台 + 个人主页 + 社交 | B-32/B-33/B-34（关联 B-30/F-15） | 工作台 5 聚合端点（usage 占位）、个人主页全六分区主聚合+4 子端点、社交 follows/likes、`creator_profiles`/`follows`/`likes`/`creator_capability_cooccur`。 |
| [`70-events-infra.md`](./70-events-infra.md) | 事件 / 基础设施 | B-13/B-14/B-15/B-16/B-35 + 端口 B-04/B-05/B-06；冻结 B-36/B-38/B-40 | outbox 同事务 + **应用层连续安全前缀水位（§11.D，SQL 不过滤 xid）**、consumer 保序+启动级防重、毒丸 dead_events（FK/CHECK 焊死 §12）、sweeper 三件事、通知链路+`/notifications`、Redis 双实例/ObjectStore/LLM Gateway 端口、`outbox_events`/`consumer_cursors`/`dead_events`/`notifications`/`notification_channels`/`audit_llm_calls` + 冻结表（**usage_events/daily_\* 的唯一 DDL 真源在此**；冻结表后置 FK 诚实 §13）。 |

---

## 2. 全端点一览（method + path → 功能点 → 鉴权 → 文件）

> **端点计数（本期可调用，Codex#19-r4 同步）**：§2.1–§2.8 共 **53** 行端点（其中 `/health` 与 `/ready` 合占一行、为 2 个基础设施探针路径，故按路径计为 54；两个 SSE 流端点已含在内）。本轮 §2.4 新增 STEP③ `PATCH /drafts/{draftId}/selection`，端点行数由 **52 → 53**（按路径 53 → 54）。§2.9 的 3 个消费链路读端点（`GET /market/listings`、`GET /apps/{slug}`、`GET /market/manifests/{versionId}`）**本期范围外、仅契约冻结、不计入**。§2.10 是写端点 × `Idempotency-Key` scope 总表（汇总既有写端点，不新增端点、不计入）。
>
> 鉴权速记：**Bearer** = Logto JWT requireAuth（创作者本人，handler 内 owner 校验）；**Role** = requireRole('creator')；**Opt** = optionalAuth（公开可匿名）；**Pair** = 配对码；**Public** = 无鉴权；**Reviewer** = 审核角色；**Auth** = requireAuth 任意已登录（非 creator-only，见脊柱 §11.F 社交写）。
>
> **SSE 鉴权统一（脊柱 §11.C）**：所有 SSE 流（`/jobs/{id}/events`、`/versions/{id}/structure/events`）= **同源 Cookie 会话**，禁 query-string token / 禁自定义 header 主鉴权；鉴权/权限失败在**建流前**返 HTTP `ErrorEnvelope`（401/403 escalate）、不走 `error` 帧。下表对 SSE 端点鉴权列一律标「同源 Cookie」即指此（Codex#5-r2）。非 SSE 的普通 HTTP 端点标「Bearer」沿用 Logto JWT（Cookie/Authorization 双来源，§10 §3.4）。

### 2.1 Auth（10）
| method + path | 功能点 | 鉴权 | 备注 |
|---|---|---|---|
| `GET /api/v1/auth/login` | B-08 | Public | 302 跳 Logto；`returnTo` 白名单防 open redirect |
| `GET /api/v1/auth/callback` | B-08 | Public | OIDC 回调换会话，302 回站内 |
| `POST /api/v1/auth/logout` | B-08 | Opt | 幂等，**不要求 Idempotency-Key**（脊柱例外，已标注） |
| `GET /api/v1/me` | B-08 | Bearer | `MeView`（账号/双角色/hasProfile+creatorId 引用） |

### 2.2 STEP① 导入（20）
| method + path | 功能点 | 鉴权 | 备注 |
|---|---|---|---|
| `POST /api/v1/import/uploads/presign` | B-20 | Bearer | 分批直传预签名 URL（不写库、非写命令，可不带 Idempotency-Key，scope `import.presign` 可选；与 market-card/preview 同属带体只读 POST） |
| `POST /api/v1/import/jobs` | B-19/B-20 | Bearer | 触发导入 Job（幂等 scope `import.create`） |
| `POST /api/v1/import/connect/pair` | B-21 | Bearer | 铸一次性配对码（写命令，必带 Idempotency-Key，scope `import.connect.pair`；写 `import_pairings` 行，缺 key→400） |
| `GET /api/v1/import/connect/script` | B-21 | Pair(query) | 返回 `text/javascript`（**非 JSON 包络**） |
| `POST /api/v1/import/connect/upload` | B-21/B-19 | Pair(Bearer) | `multipart/form-data`（**非 JSON 包络**），自动建 Job |
| `GET /api/v1/import/connect/pair/{pairId}` | B-21 | Bearer | 网页轮询配对/上传状态 |
| `GET /api/v1/snapshots/{snapshotId}` | B-19 | Bearer | 快照统计四格 + 去敏报告 |
| `GET /api/v1/snapshots/{snapshotId}/segments` | B-19 | Bearer | 会话节选只读列表（cursor） |
| `GET /api/v1/snapshots` | B-19 | Bearer | 快照列表（重导后旧快照仍可查） |

### 2.3 STEP② 提取（30）
| method + path | 功能点 | 鉴权 | 备注 |
|---|---|---|---|
| `POST /api/v1/snapshots/{snapshotId}/extract` | B-22/B-23 | Bearer | 触发萃取（202，幂等 scope `extract.create`） |
| `GET /api/v1/extract-jobs/{jobId}/candidates` | B-22/B-23 | Bearer | 列候选（cursor asc，`meta.confidenceSummary`） |
| `GET /api/v1/candidates/{candidateId}` | B-22 | Bearer | 候选详情 |
| `GET /api/v1/candidates/{candidateId}/evidence` | B-22 | Bearer | 段级血缘下钻（cursor） |
| `POST /api/v1/candidates/{candidateId}/retry` | B-23 | Bearer | 单候选无连坐重试（202，幂等 scope `candidate.retry`） |

### 2.4 STEP③④ 选择 + 结构化（40）
> STEP③ 选择：**选择切换不写库、无 API**（纯前端即时态，§1.1(a)）；**保存草稿 / 进入下一步有 API**——`PATCH .../drafts/{draftId}/selection` 持久化 `drafts.selection`（B-24 续传，Codex#19-r4）。
| method + path | 功能点 | 鉴权 | 备注 |
|---|---|---|---|
| `PATCH /api/v1/drafts/{draftId}/selection` | B-24/F-15 | Role | STEP③ 显式存草稿（普通 HTTP，`requireAuth`+`requireRole('creator')`+owner，40 §4.G／§4 头；持久化选择/进入下一步；幂等 scope `draft.selection.patch`，PATCH 最后写赢、无需 If-Match；失败 `ErrorEnvelope`）。选择切换本身不调本端点 |
| `POST /api/v1/capabilities` | B-24/B-26 | Role | 建能力体 draft 版本（幂等 scope `capability.create`），三分支：①从候选新建首版（`sourceCandidateId`）②published 后建新版本（`capabilityId`）③被拒重发派生新 draft（`fromVersionId`，从本人 review_rejected 版复制软字段，含首发被拒，Codex#4-r3） |
| `GET /api/v1/versions/{versionId}/manifest` | B-24/25/26 | Role | 读 manifest 软硬分层 + `structure_state`（普通 HTTP，`requireAuth`+`requireRole('creator')`+owner，40 §4.B） |
| `POST /api/v1/versions/{versionId}/structure` | B-25/26 | Role | 发起结构化 Job（幂等 scope `structure.start`） |
| `GET /api/v1/versions/{versionId}/structure/events` | B-25/B-12 | 同源 Cookie | 结构化字段流 SSE（kind=structure；脊柱 §11.C，禁 query/header token，建流前 HTTP 失败） |
| `PATCH /api/v1/versions/{versionId}/manifest` | B-26 | Role | 改软字段（幂等 scope `manifest.patch` + If-Match） |
| `POST /api/v1/versions/{versionId}/manifest/fields/{field}/regenerate` | B-26 | Role | 单软字段重生成（幂等 scope `manifest.regenerate_field`） |

### 2.5 STEP⑤ 发布（50）
| method + path | 功能点 | 鉴权 | 备注 |
|---|---|---|---|
| `POST /api/v1/versions/{versionId}/publish` | B-27/B-28 | Role | **同步事务**发布（幂等 scope `publish.version`） |
| `POST /api/v1/versions/{versionId}/market-card/preview` | B-28 | Bearer | 市集卡预览（无副作用、不写库、非写命令、不需 Idempotency-Key；带体只读 POST，与 presign 同类） |
| `POST /api/v1/publish-batches` | B-29 | Role | 批量发布（202+SSE，幂等 scope `publish_batch.create`；每 item 独立 key） |
| `GET /api/v1/publish-batches/{batchId}` | B-29 | Bearer | 查批次（恢复/轮询兜底） |
| `POST /api/v1/publish-batches/{batchId}/items/{itemId}/retry` | B-29 | Role | 单 item 重试（幂等 scope `publish_batch.item.retry`） |
| `POST /api/v1/publications/{capabilityId}/review` | B-30 | Reviewer | 评审裁决（人工/审核角色，幂等 scope `publish.review`） |
| `GET /api/v1/publications/{capabilityId}` | B-30 | Bearer | 查发布态（创作者只读） |

### 2.6 工作台 + 个人主页 + 社交（60）
| method + path | 功能点 | 鉴权 | usage 占位 |
|---|---|---|---|
| `GET /api/v1/dashboard/summary` | B-32 | Bearer | 含（本月调用） |
| `GET /api/v1/dashboard/metrics` | B-32 | Bearer | 4 卡其 3 占位 |
| `GET /api/v1/dashboard/token-trend` | B-32 | Bearer | 全占位 |
| `GET /api/v1/dashboard/capabilities` | B-32 | Bearer | 部分列占位（cursor） |
| `GET /api/v1/dashboard/drafts` | B-32/F-15 | Bearer | 否（`Paginated<DraftView>`，cursor） |
| `GET /api/v1/creators/{creatorId}/profile` | B-33 | Opt | 部分分区占位（六分区主聚合） |
| `GET /api/v1/creators/{creatorId}/capabilities?byDensity` | B-33 | Opt | 否（密度真实，cursor） |
| `GET /api/v1/creators/{creatorId}/heatmap` | B-33 | Opt | 否（按 happened_at 真实） |
| `GET /api/v1/creators/{creatorId}/network` | B-33 | Opt | 否（session/tag 共现即时生成） |
| `GET /api/v1/creators/{creatorId}/works` | B-33 | Opt | 调用次数占位（cursor） |
| `POST /api/v1/creators/{creatorId}/follows` | B-34 | Auth（任意已登录，非 creator-only，§11.F） | 否（写命令必带 Idempotency-Key，scope `social.follow`，§11.F） |
| `DELETE /api/v1/creators/{creatorId}/follows` | B-34 | Auth（任意已登录，§11.F） | 否（写命令必带 Idempotency-Key，scope `social.unfollow`，§11.F） |
| `POST /api/v1/capabilities/{capabilityId}/likes` | B-34 | Auth（任意已登录，非 creator-only，§11.F） | 否（写命令必带 Idempotency-Key，scope `social.like`，§11.F） |
| `DELETE /api/v1/capabilities/{capabilityId}/likes` | B-34 | Auth（任意已登录，§11.F） | 否（写命令必带 Idempotency-Key，scope `social.unlike`，§11.F） |

### 2.7 通知 + 健康检查（70）
| method + path | 功能点 | 鉴权 | 备注 |
|---|---|---|---|
| `GET /api/v1/notifications` | B-35 | Bearer | 通知列表（cursor，`filter=unread\|all`） |
| `POST /api/v1/notifications/{notificationId}/read` | B-35 | Bearer | 标已读（幂等 scope `notification.read`） |
| `POST /api/v1/notifications/read-all` | B-35 | Bearer | 全部已读（幂等 scope `notification.read_all`） |
| `GET /api/v1/notifications/unread-count` | B-35 | Bearer | 未读数轮询 |
| `GET /health` / `GET /ready` | O-04 | Public | 脊柱 §10；五依赖探针（**不在 /api/v1 前缀**） |

### 2.8 脊柱通用端点（跨域复用，各域不重定义）
| method + path | 功能点 | 鉴权 | 复用域 |
|---|---|---|---|
| `GET /api/v1/jobs/{jobId}/events` | B-12 | 同源 Cookie | 导入/提取/批量发布（kind=job 流；脊柱 §11.C，禁 query/header token，建流前 HTTP 失败） |
| `POST /api/v1/jobs/{jobId}/cancel` | B-11 | Bearer | 导入/提取/结构化（取消保留已完成产物；写命令必带 Idempotency-Key，scope `job.cancel`） |

### 2.9 消费链路读端点（**本期范围外，仅契约冻结**）
`GET /api/v1/market/listings`、`GET /api/v1/apps/{slug}`、`GET /api/v1/market/manifests/{versionId}`（B-39，P0a/P2，消费端 UI 定稿后启用；脊柱 §1.2 命名 + 50 域 `marketplace_listings` 投影为其数据源）。

### 2.10 写端点 × `Idempotency-Key` 固定 scope 总表（脊柱 §4.1 全覆盖自核验）

> **口径（脊柱 §4.1）**：所有**写命令**（POST / PATCH / DELETE，对持久化状态有副作用）**必带 `Idempotency-Key` + 固定 scope**，DELETE 不因天然幂等而豁免。下表是全域写端点逐个核对结果（**无任何写端点标成可选/无需/未提**）。**唯一豁免**已单列在「豁免」段，均已显式标注理由（会话销毁 / OAuth 一次性 / 不写库的带体只读 POST）。GET/SSE 读端点不在此表。

| 写端点（method + path） | 定义域 | 固定 scope | 必带 |
|---|---|---|---|
| `POST /api/v1/import/jobs` | 20 | `import.create` | ✅ |
| `POST /api/v1/import/connect/pair` | 20 | `import.connect.pair` | ✅（本轮 r6 由「可选」收紧；写 `import_pairings` 行） |
| `POST /api/v1/import/connect/upload` | 20 | `import.connect.upload`（由 pairId 派生） | ✅ |
| `POST /api/v1/jobs/{jobId}/cancel` | 00/20 | `job.cancel` | ✅（本轮 r6 显式补「必带」） |
| `POST /api/v1/snapshots/{snapshotId}/extract` | 30 | `extract.create` | ✅ |
| `POST /api/v1/candidates/{candidateId}/retry` | 30 | `candidate.retry`（每候选独立 key） | ✅ |
| `PATCH /api/v1/drafts/{draftId}/selection` | 40 | `draft.selection.patch` | ✅ |
| `POST /api/v1/capabilities` | 40 | `capability.create` | ✅ |
| `POST /api/v1/versions/{versionId}/structure` | 40 | `structure.start` | ✅ |
| `PATCH /api/v1/versions/{versionId}/manifest` | 40 | `manifest.patch`（+ If-Match） | ✅ |
| `POST /api/v1/versions/{versionId}/manifest/fields/{field}/regenerate` | 40 | `manifest.regenerate_field` | ✅ |
| `POST /api/v1/versions/{versionId}/publish` | 50 | `publish.version` | ✅ |
| `POST /api/v1/publish-batches` | 50 | `publish_batch.create`（批次级） | ✅ |
| （批量每 item） | 50 | `publish_batch.item`（每 item 独立 key，无连坐） | ✅ |
| `POST /api/v1/publish-batches/{batchId}/items/{itemId}/retry` | 50 | `publish_batch.item.retry` | ✅ |
| `POST /api/v1/publications/{capabilityId}/review` | 50 | `publish.review` | ✅ |
| `POST /api/v1/creators/{creatorId}/follows` | 60 | `social.follow` | ✅ |
| `DELETE /api/v1/creators/{creatorId}/follows` | 60 | `social.unfollow` | ✅（DELETE 不豁免，§11.F） |
| `POST /api/v1/capabilities/{capabilityId}/likes` | 60 | `social.like` | ✅ |
| `DELETE /api/v1/capabilities/{capabilityId}/likes` | 60 | `social.unlike` | ✅（DELETE 不豁免，§11.F） |
| `POST /api/v1/notifications/{notificationId}/read` | 70 | `notification.read` | ✅ |
| `POST /api/v1/notifications/read-all` | 70 | `notification.read_all` | ✅ |

**豁免（非写命令 / 已标注理由，脊柱 §4.1 唯一例外）**：
- `POST /api/v1/auth/logout`（10）—— 会话销毁、无产物、无连坐（脊柱例外，已标注）。
- `POST /api/v1/import/uploads/presign`（20，scope `import.presign` 可选）—— **不写库**、只签 URL，带体只读 POST，与 GET 同语义。
- `POST /api/v1/versions/{versionId}/market-card/preview`（50）—— **不写库**、只算预览，带体只读 POST。

**GET 回调例外（非 POST 写命令，列此存档口径自洽）**：
- `GET /api/v1/auth/callback`（10）—— OIDC browser redirect、code/state 一次性，本就是 GET，不属于 POST/PATCH/DELETE 写命令 `Idempotency-Key` 体系；一次性由 OAuth code/state 语义自带，无需 key（端点表见 §2.1 / 10-auth §3.2）。

---

## 3. 全表一览（按域 + 引用关系）

| 表 | 定义域文件 | 类别 | 关键唯一/去重键 | 被谁引用（FK） |
|---|---|---|---|---|
| `users` | 10 | 核心 | `logto_user_id` UNIQ、`account` UNIQ(lower) | jobs/drafts/capabilities/creator_profiles/follows/likes/… 的 owner（血缘根） |
| `jobs` | 00（脊柱 §6.3） | 核心 | PK id；fencing（fence_token） | raw_snapshots/capability_candidates/publish_batches/drafts |
| `idempotency_keys` | 00（脊柱 §4） | 核心 | PK (scope,key) | — |
| `drafts` | 00（脊柱 §8） | 核心 | PK id | import_pairings.draft_id |
| `raw_snapshots` | 20 | 导入 | `superseded_by` 重导血缘 | session_segments/capability_candidates/candidate_evidence |
| `session_segments` | 20 | 导入 | **UNIQUE(snapshot_id, content_hash)** 快照内去重；**`uq_session_segments_id_snapshot` UNIQUE(id, snapshot_id)**（§11.E，供 30 复合 FK） | candidate_evidence 复合 FK `fk_evidence_segment_snapshot` |
| `segment_contents`+`snapshot_segments` | 20 | 导入（**可选拆表，二选一**） | UNIQUE(snapshot_id, segment_content_id)；拆表下 `snapshot_segments` 同携 `uq_session_segments_id_snapshot`(id, snapshot_id) | （与 session_segments 语义等价） |
| `import_pairings` | 20 | 导入 | **`pairing_code_hash`（只存哈希、明文返一次）**；partial UNIQUE `uq_pairings_code_active`(active 谓词)；**兑换绑 `pairId+code`（先按 pairId=PK 定位行再校验码 hash），失败计数按 pairId 成立**（Codex#3-r2）；`attempt_count`/`max_attempts` 防暴力（§15） | — |
| `capability_candidates` | 30 | 提取 | **UNIQUE(extract_job_id, slug)**；**`uq_candidates_id_snapshot` UNIQUE(id, snapshot_id)**（§11.E，供 evidence 复合 FK） | candidate_evidence 复合 FK `fk_evidence_candidate_snapshot`/capability_versions.source_candidate_id/publish_batch_items |
| `candidate_evidence` | 30 | 提取 | **UNIQUE(candidate_id, segment_id)** 血缘去重；**两条复合 FK** `fk_evidence_candidate_snapshot`(candidate_id, snapshot_id)→candidates(id, snapshot_id) ON DELETE CASCADE、`fk_evidence_segment_snapshot`(segment_id, snapshot_id)→segments(id, snapshot_id)（§11.E） | creator_capability_cooccur 共现源 |
| `capabilities` | 40 | 结构化 | `slug` 全局唯一+不可变；`current_version_id` 复合 FK `fk_capabilities_current_version`(id, current_version_id)→versions(capability_id, id)（§11.E） | capability_versions/publications/tiers/likes/cooccur |
| `capability_versions` | 40 | 结构化 | UNIQUE(capability_id, version) semver；**`uq_capability_versions_capability_id` UNIQUE(capability_id, id)**（§11.E，供 50 / 70 复合 FK）；新增被拒线列 `reject_reason`/`rejected_at`（§8 被拒版本线真源；发布事务只接受 draft、被拒态终态不可变，Codex#4-r2） | capability_tiers/publications(复合 FK)/marketplace_listings(复合 FK)/runtime_sessions(复合 FK)/eval_reports |
| `capability_tiers` | 50 | 发布 | UNIQUE(version_id, tier_code) 价格冻结 | — |
| `publications` | 50 | 发布 | `capability_id` UNIQ、`share_token` UNIQ；**复合 FK `fk_publications_capability_version`(capability_id, current_version_id)→versions(capability_id, id)**；**去 `url_slug`**（公开路径 JOIN capabilities.slug，§16）；`reject_reason` 仅人话镜像投影 | — |
| `marketplace_listings` | 50 | 发布（消费读模型） | PK capability_id；search_tsv GIN；**`uq_listings_slug` UNIQUE(slug) + `trg_listing_slug` 焊死 capabilities.slug（§16）**；**复合 FK `fk_listings_capability_version`(capability_id, version_id)→versions(capability_id, id)** | — |
| `publish_batches` | 50 | 发布 | PK id | publish_batch_items |
| `publish_batch_items` | 50 | 发布 | **`idempotency_key` UNIQ** 无连坐；worker 写 item state/error 与 `publish_batches` 计数走契约级受保护 CTE 模板 A（中间态推进）/ B（item 终态迁移+batch 计数合成单条 CTE）；经 batch→job 校验 fence（Codex#5-r2/§11.A），**计数幂等化**：item 终态 UPDATE 带 `state NOT IN ('published','failed')` 防重、计数只按 RETURNING 实际迁移行递增（Codex#5-r3） | — |
| `eval_reports` | 50 | 发布（**冻结**，B-31 不写） | UNIQUE(version_id, manifest_hash) | — |
| `creator_profiles` | 60 | 主页 | PK user_id；`slug` UNIQ；社交冗余计数 | — |
| `follows` | 60 | 社交 | **PK (follower_id, followee_id)** + CHECK 防自关注 | — |
| `likes` | 60 | 社交 | **PK (user_id, capability_id)** | — |
| `creator_capability_cooccur` | 60 | 主页（共现物化） | PK(creator_id,a,b,basis) + CHECK a<b | — |
| `outbox_events` | 70 | 事件 | **`event_id` UNIQ** 生产防重；`xid`/`seq` 水位 | — |
| `consumer_cursors` | 70 | 事件 | PK (consumer_name, topic) | — |
| `dead_events` | 70 | 事件 | UNIQUE(consumer_name, event_id)（**有意不含 topic**，§12）；**`fk_dead_events_event` FK event_id→outbox_events(event_id)**；CHECK `ck_dead_status`/`ck_dead_attempts` | — |
| `notifications` | 70 | 通知 | UNIQUE(recipient_id, dedupe_key) | notification_channels |
| `notification_channels` | 70 | 通知 | UNIQUE(notification_id, channel) | — |
| `audit_llm_calls` | 70 | LLM 审计（非计费真源） | PK id | — |
| `usage_events` | 70（§9.1，**冻结 B-36**） | 计量（**唯一真源**） | PK event_id 幂等 | — |
| `daily_capability_stats` | 70（§9.1，**冻结 B-36**） | 计量读模型（**唯一真源**） | PK (stat_date, capability_id) | （60 域只读占位） |
| `daily_creator_consumers` | 70（§9.1，**冻结 B-36**） | 计量读模型（**唯一真源**） | PK (stat_date, creator_id, consumer_key) | （60 域只读占位） |
| `daily_creator_llm_stats` | 70（§9.1，**冻结 B-36**） | 计量读模型（**唯一真源**） | PK (stat_date, creator_id) | （60 域只读占位） |
| `experience_packs`(+items+item_sources) | 70（**冻结 B-38**） | 经验体 | UNIQUE(capability_id) | （B-25 本期不依赖） |
| `runtime_sessions`/`artifacts` | 70（**冻结 B-40**） | Runtime | UNIQUE(session_id, version_no)；**`runtime_sessions` 复合 FK `fk_runtime_sessions_capability_version`(capability_id, version_id)→versions(capability_id, id)**（§11.E，替原两条单列 FK，Codex#6-r2） | （本期无端点） |

> **迁移顺序约束（基表建序，跨域 FK 一律后置，Codex#18-r4）**：**阶段一 · 建基表**：`users` → `jobs`/`idempotency_keys` → **`drafts`（核心表，基表仅内联 `owner_user_id→users`/`extract_job_id→jobs`，跨域落点 FK 后置；00 §8.4）** → `raw_snapshots`/`session_segments`（导入）→ `import_pairings`（导入，`draft_id` 列先建、FK 后置）→ `capability_candidates`/`candidate_evidence`（提取）→ `capabilities`/`capability_versions`（结构化，`source_candidate_id` 依赖提取表在前）→ `capability_tiers`/`publications`/`marketplace_listings`/`publish_batches`/`publish_batch_items`（发布）→ `creator_profiles`/`follows`/`likes`/`creator_capability_cooccur`（主页）→ `outbox_events`/`consumer_cursors`/`dead_events`/`notifications`/`notification_channels`/`audit_llm_calls`（事件）→ 冻结表。**阶段二 · 后置 ALTER FK 闭合（全基表建完后统一执行，见下「后置 ALTER FK 闭合清单」）**。迁移只加不减、向后兼容（脊柱 §1.1）。
>
> **后置 ALTER FK 闭合清单（脊柱 §11.G，全 38 表 FK 在阶段二一次性建得出、无环）**：
> 1. **drafts 落点 + 反向（本轮 Codex#18-r4）**：`fk_drafts_snapshot`(`drafts.snapshot_id→raw_snapshots(id)`)、`fk_drafts_version`(`drafts.version_id→capability_versions(id)`)、`fk_drafts_batch`(`drafts.batch_id→publish_batches(id)`，**补齐此前缺失 FK**)、`fk_pairings_draft`(`import_pairings.draft_id→drafts(id)`，破「drafts↔import_pairings」环)。
> 2. **40 既有后置**：`fk_capabilities_current_version`(`capabilities(id, current_version_id)→capability_versions(capability_id, id)`，破「capabilities↔capability_versions」循环)。
> 3. **70 既有后置（§13 / §9.4）**：`fk_usage_events_*`/`fk_experience_packs_capability`/`fk_exp_item_sources_segment` + `runtime_sessions` 复合 FK `fk_runtime_sessions_capability_version`。
> 全部后置 ALTER 不改被引用表结构、仅加 FK；执行前其被引用表（`raw_snapshots`/`capability_versions`/`publish_batches`/`drafts`/`users`/`capabilities`/`session_segments`/`runtime_sessions`）均已在阶段一建好。
>
> **复合 FK 建序约束（§11.E）**：被引用侧复合唯一键必须先于引用侧复合 FK 建立——`session_segments.uq_session_segments_id_snapshot`/`capability_candidates.uq_candidates_id_snapshot` 先于 30 域 evidence 两条复合 FK；`capability_versions.uq_capability_versions_capability_id` 先于 40 域 `fk_capabilities_current_version` 与 50 域 `fk_publications_capability_version`/`fk_listings_capability_version`。`capabilities.current_version_id` 复合 FK 用后置 `ALTER`（破建表循环，已并入上「后置 ALTER FK 闭合清单」第 2 项）。
>
> **70 冻结表后置 FK 建序（§13）**：70 §9.4 的后置 `ALTER`（`fk_usage_events_*`/`fk_exp_item_sources_segment`/`fk_experience_packs_capability` + `runtime_sessions` 单条复合 FK `fk_runtime_sessions_capability_version`，Codex#6-r2）必须排在 `users`/`capabilities`/`capability_versions`（含其 `uq_capability_versions_capability_id` 唯一键）/`session_segments`（及 70 内部 `runtime_sessions`）创建之后；`consumer_key`/`tier_code`/`s3_key`/`last_applied_command_id` 显式标 intentional loose（有意不加 FK）。

---

## 4. 全 SSE 事件一览

> **SSE 流类型三型 `job | structure | session`（脊柱 §9 `SSEStreamKind`），但本期可调用 SSE 端点只有两个**（均脊柱 §5 形态、`text/event-stream`、首帧恒 `state_snapshot`、Last-Event-ID 续传、15s heartbeat、终态 `done`）：① `GET /jobs/{jobId}/events`（kind=job，导入/提取/批量发布复用）、② `GET /versions/{versionId}/structure/events`（kind=structure，结构化）。**第三型 session（kind=session）为 B-40 Runtime 冻结、本期无端点、不可调用**（70 §B-40），故与 §2 头「两个 SSE 流端点」口径一致：三型 ≠ 三端点。

| SSE event（脊柱 12 类） | job 流（导入/提取/批量发布） | structure 流（结构化） | 备注 |
|---|---|---|---|
| `state_snapshot` | ✓（progress 全量+items 摘要；批量发布 `done/total`=**processedCount/total**） | ✓（structureState 全量） | 连接首帧/重连超窗，硬规则①③ |
| `progress` | ✓（量化文案「已抓取/已识别 N/M」；批量发布「已处理 N/M=(published+failed)/total」，有失败也满进度，§7） | ✓（「正在补全字段 4/7」） | 单调不倒退 |
| `subtask` | ✓（导入五项/提取五项/发布批次阶段） | ✓（字段流为主） | 标准序见脊柱 §7 |
| `item-appended` | ✓（段/候选/批量 item 逐个浮现） | ✓（数组字段逐条） | 连字符命名 |
| `field_start` / `field_delta` / `field_done` / `field_stuck` | — | ✓（仅 7 软字段；硬字段不发） | 结构化专用，下划线命名 |
| `slow_hint` | ✓ | ✓ | degraded 也给短语 |
| `error` | ✓（整体失败；单候选/单 item 失败走 item-appended 不升级） | ✓（STRUCTURE_FIELD_FAILED 字段级） | 整体 ErrorEnvelope，硬规则② |
| `done` | ✓（result：snapshotId/candidateCount；批量发布 `processedCount===total` 即终，result 带 processed/published/failed 三计数，§7） | ✓（result：versionId/manifest） | 终止信号 |
| `heartbeat` | ✓ | ✓ | 15s 保活 |

> **不走 SSE 的域**：Auth（短同步）、单条发布（同步事务）、工作台/个人主页（同步聚合读，加载态走前端 skeleton 非 SSE）、通知（异步、关页可达：站内表+飞书/邮件+轮询 unread-count）。**全链路无新增 SSE event 类型**——只用脊柱 12 类。

---

## 5. 错误分类总表指针

- **唯一总表**：脊柱 [`00-约定与状态机.md` §3.3](./00-约定与状态机.md)（HTTP 状态 → 内部 code → retriable/action 缺省 → 人话 userMessage 模板）。**所有非 2xx、所有 SSE `error` 帧、所有前端可见失败只出 `ErrorEnvelope`**（脊柱 §3.1）；`action` 五枚举见 §3.2（`retry`/`change_input`/`escalate`/`wait`/`none`）。
- **收紧口径（脊柱 §11.B，Codex#11）**：UI 唯一可展示字段 = **`userMessage`**（人话）+ `action`（核心三类 `retry|change_input|escalate`）；`error.code` 仅日志/告警/文案映射、**UI 永不渲染**；各域错误用例表的「人话 userMessage」列即 `userMessage`。登录失败重定向用 opaque `failureId`（不带内部 code，不进 URL）。
- **各域扩展 code**（命名 `{DOMAIN}_{REASON}`，action/retriable **缺省遵脊柱 §3.3**）：

| 域 | 扩展 code（HTTP/action） |
|---|---|
| Auth（10） | `AUTH_STATE_MISMATCH`(400/change_input)、`AUTH_CONSENT_DENIED`(400/change_input)、`AUTH_CALLBACK_FAILED`(400/change_input)、`AUTH_UPSTREAM_UNAVAILABLE`(503/**escalate**，§11.B 收敛、不再用 wait)；对外鉴权失败统一收口 `UNAUTHENTICATED`(401/escalate)/`FORBIDDEN`(403/escalate)；登录失败回调用 opaque `failureId`(§11.B) |
| 导入（20） | `IMPORT_NO_CONTENT`(400/change_input)、`UPLOAD_INTERRUPTED`(409→retry) |
| 提取（30） | `EXTRACT_SNAPSHOT_NOT_READY`(409/change_input)、`CANDIDATE_ALREADY_READY`(409/none)、`EXTRACT_UPSTREAM_TIMEOUT`(502/retry，单项达上限升 escalate)、`EXTRACT_JOB_TIMEOUT`(504/retry) |
| 结构化（40） | `STRUCTURE_NO_EVIDENCE`(422/change_input)、`STRUCTURE_FIELD_FAILED`(422/retry，两次失败→escalate)、`HARD_FIELD_LOCKED`(422/change_input)、`PRECONDITION_FAILED`(412/retry，If-Match 乐观锁) |
| 发布（50） | `PUBLISH_MISSING_FIELDS`(422/change_input)、`PUBLISH_COVER_INVALID`(422/change_input)、`ALREADY_PUBLISHED`(409/none)（脊柱表内） |
| 工作台/主页（60） | `DASHBOARD_AGGREGATE_FAILED`(500/retry)、`PROFILE_AGGREGATE_FAILED`(500/retry)、`PROFILE_SECTION_FAILED`(500/retry，单分区局部)、`SOCIAL_SELF_FOLLOW`(422/change_input) |
| 事件/通知（70） | 无新增对外 code；`dead_events.last_error`/`notification_channels.last_error` 复用 `ErrorEnvelope.error` 形态（禁堆栈） |

- **硬约束（CI/评审守门）**：`userMessage` 永远是面向创作者的中文人话，禁含 HTTP 状态码 / `Error:` / stack trace / 异常类名 / 英文原始报错 / SQL·Redis·驱动报错串；`details` 只放结构化可安全展示补充（人话定位/字段名/可重试项 id），禁堆栈。**全契约无 `error.message` 字段（唯一权威名 `userMessage`）。**

---

## 6. 三条硬规则落地索引

| 硬规则 | 落地位置 |
|---|---|
| **永不裸转圈** | 脊柱 §5（SSE 12 帧）/§7（progress 量化）；导入五项子任务+落库卡、提取「已识别 N/M」+逐个浮现、结构化字段流+三退路、批量发布逐 item 浮现；工作台/主页 skeleton 占位（非转圈）；通知/sweeper 让关页/卡死有去向。 |
| **绝不裸露错误码** | 脊柱 §3（`ErrorEnvelope` 人话+action）；各域 message 人话+退路、单项失败副文（「上游解析中断·段5/9」）、拒绝原因人话落 `reject_reason`、毒丸「未入账 N 条」。 |
| **已生成内容不丢** | 脊柱 §6.1（取消保留产物）/§7/§8（drafts+structure_state 续传）；逐项落库（候选/字段/批量 item）、fencing 写入、重导新快照旧保留、`state_snapshot` 恢复、outbox 同事务、cursor 与处理同事务。 |

---

## 7. 功能点覆盖速查（62 功能点）

> 详见各域 §「功能点覆盖表」与 [`_consistency-report.md` §4](./_consistency-report.md)。本期范围 = 创作者中心主链路；消费链路（B-39 读端点）/试用/计量为冻结或范围外。

- **后端契约已覆盖（有端点/表/SSE）**：B-07~B-30、B-32~B-35（主链路 + 鉴权 + 工作台/主页/社交 + 通知）。
- **机制级（脊柱内）**：B-09/B-10/B-11/B-12/B-16（幂等/jobs/取消/SSE/sweeper 对账）。
- **端口契约**：B-04（Redis 双实例）/B-05（ObjectStore）/B-06（LLM Gateway）。
- **冻结 schema（建表/类型、不挂端点）**：B-31（eval_reports）/B-36（usage_events/daily_*）/B-38（experience_packs）/B-40（runtime_sessions/artifacts）；B-37（embedding/capability_relations 保持 P1，主页缩略不依赖）。
- **STEP③ 选择**：选择切换纯前端、不写库、无 API；**保存草稿 / 进入下一步有 API**——`PATCH /drafts/{draftId}/selection` 持久化 `drafts.selection`（40 §4.G，Codex#19-r4，已计入端点总数）。
- **纯基础设施/构建（无 API 契约面）**：B-01（脚手架四层目录）、B-03（迁移框架批次二，其表已分散定义）、O-01~O-07（Docker/compose/迁移序/健康检查/脚本/可观测/CI）。
- **前端（消费 B-* 契约，无独立后端契约）**：F-01~F-15（F-16 已删除，不交付）。

---

## 8. 跨域共识硬规则索引（脊柱 §11，Codex 对抗裁定 → 唯一权威）

> 这六条是 Codex 跨文件评审（`creator-builder/.reviews/phase1-codex-r1.txt`）的权威裁定，定义在脊柱 [`00-约定与状态机.md` §11](./00-约定与状态机.md)，各域**只引用、不重述/不偏移**。本表是导航 + 各域落点速查。

| 规则 | 内容一句话 | 引用/落点域 |
|---|---|---|
| **§11.A** 受保护写入 CTE | 所有 worker/sweeper 写 job/产物，fence 校验**内联进单条事务 CTE 的数据源**，禁「先查后写」两步；`rowCount=0` 是正常控制流（已被 fence out）安全退出 | 20（import worker 三条写入）、30（萃取/重试 worker）、40（structure_state/manifest）、50（批量 item/计数器/评审事务）、70（sweeper 重入队） |
| **§11.B** ErrorEnvelope 收紧 | UI 唯一可展示 = `userMessage`+`action`(retry/change_input/escalate)；`error.code` 仅日志/映射、UI 永不渲染；登录失败用 opaque `failureId` 不带内部 code | 10（登录 failureId、AUTH_UPSTREAM→escalate）、20/30/40/50/60/70（各域错误表「人话 userMessage」列 = `userMessage`） |
| **§11.C** SSE 同源 Cookie 鉴权 | 所有 SSE 流统一同源 Cookie，禁 query token / 禁自定义 header 主鉴权；鉴权/权限失败**建流前**返 HTTP `ErrorEnvelope`、不走 `error` 帧 | 40（structure SSE §4.D，旧 Bearer 表述作废）、20/30/50（job SSE）、10（提供中间件） |
| **§11.D** outbox 连续安全前缀 | 水位裁剪在**应用层**做、SQL 不过滤 `xid`；顺序扫描遇首条 `xid>=xmin` 即停，只提交连续安全前缀末尾 seq 为 cursor | 70（§3.2 唯一权威算法，所有顺序消费者引用） |
| **§11.E** 血缘约束注册表 | 8 个固定约束名的复合唯一键 + 复合 FK，schema 层焊死血缘，不得改名/弱化为单列 | 20（`uq_session_segments_id_snapshot` 建表）、30（`uq_candidates_id_snapshot`+evidence 两条复合 FK）、40（`uq_capability_versions_capability_id`+`fk_capabilities_current_version`）、50（`fk_publications_capability_version`/`fk_listings_capability_version`）、70（`fk_runtime_sessions_capability_version`，Codex#6-r2） |
| **§11.F** 社交写 = requireAuth | follow/like 及 DELETE 对任意已登录用户开放（非 creator-only）；未登录写 `401 UNAUTHENTICATED`+escalate；**POST 与 DELETE 都是写命令、统一必带 Idempotency-Key + 固定 scope**（POST=`social.follow`/`social.like`、DELETE=`social.unfollow`/`social.unlike`），不因 DELETE 天然幂等而豁免 | 10（§6.2 权限表）、60（社交写端点 11-14）、00（§11.F scope 命名） |
| **§11.G** 后置 FK 闭合清单 | 跨域/前向 FK 一律「先建基表 + 后置 ALTER ADD CONSTRAINT」；`drafts` 三条落点 FK（`fk_drafts_snapshot`/`fk_drafts_version`/`fk_drafts_batch`，**`batch_id` 本轮补齐缺失 FK**）+ `import_pairings.fk_pairings_draft` 后置以破建表顺序环；与既有 40/70 后置 FK 一并列全，保证全 38 表 FK 可建得出、无环（Codex#18-r4） | 00（§8.4 drafts 基表 + §11.G 清单）、20（`import_pairings.draft_id` 列+后置 FK）、40/50/70（既有后置 FK 复用同清单） |

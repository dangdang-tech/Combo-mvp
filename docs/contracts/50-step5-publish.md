# 50 · STEP⑤ 发布 域契约（B-27 ~ B-31）

> **本文是发布域的端到端契约**：版本状态机 + 发布门事务（B-27）、发布接入 API + 市集卡投影（B-28）、批量发布无连坐 P0（B-29）、Alpha 人工评审 + 拒绝分流（B-30）、Auto-Eval 仅 schema/开关预留（B-31）。
>
> **地基**：严格 import [`00-约定与状态机.md`](./00-约定与状态机.md)，不重定义。本文沿用：路由前缀 `/api/v1`、轻包络 `Envelope<T>`/`Paginated<T>`、错误信封 `ErrorEnvelope` + action 五枚举 + §3.3 错误分类表缺省、幂等 `Idempotency-Key` + §4 行为矩阵、SSE 帧 12 类 + 首帧 `state_snapshot` + Last-Event-ID 续传、jobs 状态机 + fencing（写入带 `WHERE job_id=? AND fence_token=?`）、`ProgressView` 形态、`drafts` step 五枚举（`publish` 步落点 `version_id`/`batch_id`）、§9 共享 TS 类型、健康检查口径。
>
> **真源**：产品行为以 `docs/开工总纲-创作者中心主链路.md` 第五/八章为准；验收口径以 `docs/测试验收-创作者中心主链路.md` 发布- / 选择结构化- / 主页- / 贯穿- 用例为准；技术架构以 `docs/01-详细技术方案.md` B-27~B-31 + §4 数据模型为准。
>
> **六项拍板决策中本域相关三条**（终稿，按固定形态正式验，不再「设计未定稿」）：
>
> - **④ STEP⑤ 固定**：发布即上架「Alpha·审核中」；拒绝后有上一 published 版回退该版、无上一版则下架；创作者侧落「简单拒绝原因 + 重试/编辑入口」可见状态（工作台能力表 / 主页作品墙 / 发布页三处同步）；**Auto-Eval 仅 schema/开关预留（默认关），不进本期发布路径**（发布前不出现自动评测门）。
> - **⑤ 批量发布无连坐 P0**：每 item 独立幂等键 + 独立状态机 + 失败只标该 item（不连累其余）+ 可单独重试该 item + 失败项「去补齐」回向导。
> - **②/③ usage 占位 / 试用不做**：市集卡「装机量/评分」用 `meta.placeholders` 占位（值 null）；「试用」按钮固定展示、点击落「本期未开放」、不进 runtime session（按钮契约不属本域写库，仅在卡投影里标记 `trialEnabled:false`）。
>
> **三条硬规则在本域的落点**：① 永不裸转圈 —— 发布/批量发布是耗时动作，单条发布 API 同步事务返回，批量发布走 `publish_batch` job + SSE（总进度 + 每 item 状态 + `item-appended`）；② 绝不裸露错误码 —— 发布失败、缺必填、幂等冲突只出 `ErrorEnvelope` 人话 + 退路；拒绝原因落人话 `reject_reason`（非内部状态码）；③ 已生成内容不丢 —— 发布失败保留封面/价格/软字段（前端态 + 草稿）；批量发布失败只标该 item、其余已发布产物保留；评审拒绝走事务回退保留上一 published 版。

---

## 1. 版本状态机 + 发布门事务（B-27）

### 1.1 版本状态机（`capability_versions.status`）

> **两条线分明（Codex#8 消除自相矛盾）**：本域有两条互不混淆的状态线——
>
> - **「版本」线**（`capability_versions.status`，本节）：描述某一**具体 version** 自身的生命周期；被拒的就是被拒版本自己，**不动**其它版本。
> - **「当前对外版本」线**（`publications.current_version_id` + `review_status`，§1.3 / §5）：描述能力体**对外滚动指向哪一版**。评审拒绝改的是这条线的指向（回退到上一版 / 下架），**不**把回退后那条对外版本标脏。
>
> 关键：**评审拒绝永远只把「被拒的那一版」标 `review_rejected`，从不把「回退后继续对外的上一版」标脏**（上一版仍是 `published`）。旧文「把 current version 标 review_rejected」即此矛盾，已按此节修正。

```
                              ┌──────────────────────────► review_rejected
                              │   (这一版自己被 Alpha 评审拒绝)
draft ──(publish 事务)──► published ───(再次 publish 新版)──► superseded
                              ▲
                              └──(评审拒绝且有上一版：上一版 superseded→published 复位为对外版)
   review_rejected ──(40 端点 A: POST /capabilities?fromVersionId=被拒版, 派生新 draft)──► （新 draft version，原被拒版保持 review_rejected）
                       └─ 首发被拒(无上一版)也走此派生路径，不再无路可走（Codex#4-r3）
```

> 注：被拒版本是**终态**（`review_rejected` 不再迁出）。创作者「编辑后重发」是**经 40 端点 A `POST /capabilities` 带 `fromVersionId=<被拒版>` 派生一条新 draft 版**（复制被拒版软字段、同能力体 bump minor、原被拒版不动），再走本域发布事务，原被拒版本永久保留 `review_rejected` + `reject_reason`/`rejected_at` 作历史，不就地改回 draft（避免版本血缘断裂）。**首发被拒（无上一 published 版）同样适用此派生入口**，闭环成立（Codex#4-r3）。

| status            | 含义                                                                                                        | 进入条件                                                   | 可见性                                                        |
| ----------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------- |
| `draft`           | 结构化产物，未发布                                                                                          | `POST /capabilities` 建版 / 结构化完成                     | 仅创作者；不进市集                                            |
| `published`       | 已发布（含 Alpha·审核中 与 已上架，二者由 `publications.review_status` 细分，不在 version.status 二次编码） | 发布事务成功；或评审拒绝回退后，上一版由 `superseded` 复位 | 市集可见（标 alpha_pending）/ 公开主页作品墙                  |
| `superseded`      | 被新版替代（仍可被「回退」复位为 published）                                                                | 同能力再次发布新版（旧版 superseded）                      | 不再对外滚动指向；manifest 仍可按 version_id 寻址（不可变）   |
| `review_rejected` | **这一版自己**被评审拒绝（终态；记 `reject_reason`/`rejected_at`）                                          | B-30 拒绝分流，**仅标被拒版自身**                          | 不进市集；创作者侧显示该版拒绝原因 + 重试/编辑（重发=开新版） |

> **状态机铁律**：
>
> - 一个能力体在市集**至多一条 active 发布**（`publications.capability_id` UNIQ，见 §5），再次发布强制开新版（发布-29）。
> - `published`/`superseded`/`review_rejected` 间的迁移**只由发布事务或评审事务驱动**，不接受裸 PATCH version.status。
> - **评审拒绝只标「被拒版」一条**：`review_rejected` 永远只落在被裁决的那一版；若有上一 published 版可回退，**上一版从 `superseded` 复位为 `published`**（它不是被拒版、绝不标脏）；若无上一版，能力体下架但被拒版仍只是它自己 `review_rejected`。
> - 「Alpha·审核中」与「已上架」的区分落在 `publications.review_status`（`alpha_pending`/`published`），**不**在 `capability_versions.status` 上再开两态——避免两份真源漂移（贯穿-26/发布-31 状态一致性）。

### 1.2 发布门事务（单 PG 事务，B-27）

`POST /versions/{versionId}/publish` 成功路径在**单 PG 事务**内原子完成（任一步失败整体回滚，不留半发布态，硬规则③）：

1. **校验**：version 属于调用者、**status 必须恰为 `draft`**（发布事务**只接受 `draft` 版本**，Codex#4-r2 拒绝态真源单一化）；manifest 必填软字段齐（name/tagline 非空）；发布入参齐（封面来源、价格、可见性）。缺字段 → `422 PUBLISH_MISSING_FIELDS`（见 §3 错误），details 列缺哪些（发布-24）。
   > **被拒重发不走本事务直接转态（Codex#4-r2 / Codex#4-r3）**：被拒版本（`review_rejected`）是**终态、不可变**，**绝不**被发布事务就地置 `published`。创作者「编辑后重发」必须**先从 rejected version 派生一条新的 `draft` version**（复制其 manifest 软字段为起点、新 version_id、status=`draft`），再以**该新 draft** 调用本发布事务；原 rejected version 永久保留 `status='review_rejected'` + `reject_reason`/`rejected_at` 作历史，**本事务不触碰它**。以 `review_rejected`（或 `superseded`）版本调本端点 → `409 STATE_CONFLICT`（人话「当前状态不支持发布，请基于被拒版编辑生成新版本再发布」）。**派生新 draft 的唯一入口 = 结构化域 40 端点 A `POST /api/v1/capabilities` 带 `fromVersionId=<被拒版>`**（40 §2.4 / §4.A ③分支：校验源版属本人且 `status='review_rejected'`、在同一能力体下复制软字段 bump minor 建新 draft，原被拒版不动）。**首发被拒（无上一 published 版）同样可派生**——`fromVersionId` 不要求存在 published 版，故首发被拒不再无路可走（Codex#4-r3 闭环修补）。本域只接受 40 该分支产出的 draft。
2. **冻结 manifest 记 hash**：`manifest_hash = sha256(canonical(manifest))` 写入 `capability_versions.manifest_hash`，**本 draft version.status → `published`**（只有 `draft` 能被本步推到 `published`；`review_rejected`/`superseded` 不在此列）。manifest 内容此刻冻结，**发布后改 manifest 强制开新版本**（B-26 PATCH 行为），不回写已发布版（发布-28/29）。
3. **价格固化**：把发布入参里的价格按 tier 写入 `capability_tiers(version_id, tier_code, price_micros, ...)`，**price_micros 在事务内冻结**，成为这版定价唯一真源；后续改 manifest/新版不回溯改写已发布版价格（发布-28）。
4. **旧版滚动 superseded**：若该能力已有 active 发布版（`publications.current_version_id` 指向旧版），把旧 version.status → `superseded`（发布-29）。
5. **写/更新 publications**：`upsert publications(capability_id, current_version_id=本版, share_token, visibility, review_status='alpha_pending', reject_reason=null)`。`capability_id` UNIQ 保证至多一条；`share_token` 仅在首次创建时生成、之后稳定（私享链接不因改版失效）。
6. **更新 capabilities.current_version_id** → 本版（公开主页/市集滚动指向）。
7. **写 outbox（同事务，两条）**：
   - `outbox_events(topic='capability.published', aggregate_id=capabilityId, payload=CapabilityPublishedPayload)`（70 §7 / shared 权威：`{ capabilityId, versionId, slug, manifestHash, reviewStatus:'alpha_pending', isRollback:false, ownerUserId, traceId, occurredAt }`；首发/改版发布 `isRollback=false`，回退场景见 §2.6.1）——lifecycle，MarketplaceProjection 消费投市集。
   - `outbox_events(topic='notify.publish_completed', aggregate_id=versionId, payload=NotifyPublishCompletedPayload)`（70 §7 / shared 权威：`{ recipientId, link, versionId, capabilityId, reviewStatus:'alpha_pending', traceId, occurredAt }`，event_id=`publish_done:{versionId}`）——notify，NotifyConsumer 通知创作者发布完成（关页也收得到）。
   - 两条同事务写入，`xid` 取 `pg_current_xact_id()` 作提交序水位（B-13）。本域 4 个 active topic 全集见 §5.1（此处单发布产生 lifecycle + notify 各一条；`capability.unpublished`/`notify.review_decided` 由评审事务 §2.6.1 产生）。
8. **写 idempotency_keys 回放引用**（§4，与业务同事务），`response_ref` = 本次发布结果。

事务提交后：MarketplaceProjection consumer 顺序消费 `capability.published` → upsert `marketplace_listings`（标 alpha_pending、刷新 `card`/`search_tsv`）。**投影是事务外异步**：市集卡可见性最终一致，卡住时宁可延迟、不放错状态（贯穿-26），由 sweeper outbox 兜底补投。

> **正确性决策（Phase 0）**：
>
> - **去重键**：`publications.capability_id` UNIQ（至多一条 active 发布）+ `idempotency_keys(scope='publish.version', key)` UNIQ（重复点/刷新/双标签页只一条发布记录，发布-20/贯穿-13/贯穿-27）。两道闸叠加。
> - **价格冻结血缘**：价格落 `capability_tiers(version_id, ...)` 而非 manifest，按不可变 version_id 寻址；已发布版价格 = 该 version_id 行的 price_micros，永不被后续 manifest 编辑回写。
> - **manifest 不可变寻址**：`manifest_hash` 冻结 + version_id 寻址（`GET /market/manifests/{versionId}`，脊柱 §1.2），改版必新 version_id（发布-29）。
> - **事务型 outbox**：两条 lifecycle（`capability.published`/`capability.unpublished`，市集投影源）与业务写同 PG 事务，保证「发布成功 ⟺ 事件必投」，杜绝发了不上架 / 上架了没发；同事务还写 notify 事件（`notify.publish_completed`/`notify.review_decided`，本域 4 个 active topic 全集见 §5.1），通知漏发不致命、走 notify 毒丸策略（70 §4）。

### 1.3 「当前对外版本」线 vs「被拒版本」线（Codex#8 两线分明）

发布域有两条**互不混淆**的状态线，分别由不同字段承载，评审拒绝只动「对外指向」、绝不把回退后的对外版本标脏：

| 线                 | 真源字段                                                                                                | 表达什么                                     | 评审拒绝时                                                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **当前对外版本线** | `publications.current_version_id` + `publications.review_status`                                        | 能力体当前对外滚动指向哪一版、该指向的审核态 | 指向**回退到上一 published 版**（无上一版则 `review_status='review_rejected'` 表能力下架）；**回退后那一版仍 `published`，不标脏** |
| **被拒版本线**     | 被拒 `capability_versions.status='review_rejected'` + `reject_reason` + `rejected_at`（落在被拒版自身） | 哪一个具体 version 被裁决拒绝、原因、时刻    | **只标被裁决的那一版**自身 review_rejected，记 `reject_reason`/`rejected_at`；不波及其它版本                                       |

> **铁律**：`reject_reason`/`rejected_at` 是「被拒版本」的属性，记在**被拒的那一版**（`capability_versions`）；`publications.reject_reason` 仅作创作者侧「当前能力体最近一次被拒原因」的**人话镜像投影**（供发布页/工作台/主页同步展示，发布-31），其权威来源仍是被拒版本行。两者语义不同：一个是版本历史事实，一个是对外展示态镜像。

---

## 2. 端点契约

> 所有端点在 `/api/v1` 前缀下；鉴权 = Logto JWT（创作者本人，按 `owner_user_id` 校验所有权），除明确标「公开只读」者。所有 POST 写命令**必带** `Idempotency-Key` + 固定 scope（脊柱 §4.1；唯一例外 = `market-card/preview` 不写库、非写命令）。错误一律 `ErrorEnvelope`。
>
> **错误信封口径（脊柱 §11.B 收紧，Codex#11）**：本域所有错误用例表的「人话 userMessage」列即脊柱 **`userMessage`**（唯一可对 UI 展示的人话）；`error.code` 仅供服务端日志/告警/文案映射、**UI 永不渲染**；`action` 收敛为 `retry|change_input|escalate` 三类核心退路（`wait|none` 为后台/信息态）。`PublishBatchItemView.error` / `publish_batch_items.error` / `publications.reject_reason` 同口径（人话镜像，非内部码、非堆栈）。下文各表「人话 userMessage」列均按此读为 `userMessage`。

### 2.1 `POST /api/v1/versions/{versionId}/publish` —— 发布单个能力（B-27/B-28）

- **method + path**：`POST /api/v1/versions/{versionId}/publish`
- **鉴权**：Logto JWT；version 必须属于调用者（否则 `403 FORBIDDEN`）。
- **幂等**：必带 `Idempotency-Key`；scope=`publish.version`。重复点/刷新/双标签页回放首次结果（脊柱 §4 行为矩阵：相同 hash 回放、租约中 423 wait、hash 异 409 conflict）。对应发布-20 / 贯穿-13 / 贯穿-27。
- **同步语义**：发布门是事务、非长任务，**同步返回**（不建 job、不走 SSE）。前端「发布中…」由请求 pending 表达，落明确成功/失败态、不裸转圈（发布-17）。

**请求 schema**（zod 风格）：

```typescript
const PublishVersionBody = z.object({
  // 封面（创作者发布前设定；三来源，发布-11/12/13/32）
  cover: z.object({
    source: z.enum(['glyph', 'image', 'html_snapshot']), // 字形图标/上传或AI图/HTML渲染产物快照
    // glyph: 无需额外（按产物类型自动生成，发布-12）
    // image: 已上传对象的 key（预签名直传后回填，发布-13）
    assetKey: z.string().optional(), // source=image 必填
    // html_snapshot: 渲染参数引用（异步渲染产物快照，发布-32）
    snapshotRef: z.string().optional(), // source=html_snapshot 必填
  }),
  // 定价（发布前设定，发布时冻结，发布-14/28）
  tiers: z
    .array(
      z.object({
        tierCode: z.string(), // 如 'standard'；本期单档即可
        priceMicros: z.number().int().nonnegative(), // 价格（微元，冻结真源）
      }),
    )
    .min(1),
  // 可见性（发布-27/33）
  visibility: z.enum(['public', 'unlisted']), // public=列入市集；unlisted=仅私享(share_token 可访问、不进公开目录)
});
```

> name / tagline / 简介 / 软字段**不在请求体**——它们取自 manifest 当前值（发布-04/30 联动），服务端发布时读 `capability_versions.manifest`。署名取自登录创作者账号（发布-05/26），创作者改不动。可信标记「源自一次真实会话」系统固定（发布-26）。

**响应 schema**（`Envelope<PublishResult>`，200）：

```typescript
interface PublishResult {
  versionId: VersionId;
  capabilityId: CapabilityId;
  slug: Slug; // 公开主页/市集路径 /a/{slug}
  shareToken: string; // 私享链接 token（visibility=unlisted 用；public 也生成、稳定）
  reviewStatus: 'alpha_pending'; // 发布即「Alpha·审核中」（发布-15）
  visibility: 'public' | 'unlisted';
  publishedVersionId: VersionId; // 滚动指向版本（= versionId 本次）
  supersededVersionId?: VersionId; // 若顶替了旧版（发布-29）
  marketUrl: string; // 市集/公开地址（发布-15「可访问的市集地址」）
  card: MarketCard; // 即时回投市集卡预览（与下一步展示一致）
}
```

**错误用例**（映射脊柱 §3.3）：

| 触发                                                                                       | HTTP | code                     | retriable | action         | 人话 userMessage                                                                               |
| ------------------------------------------------------------------------------------------ | ---- | ------------------------ | --------- | -------------- | ---------------------------------------------------------------------------------------------- |
| 名称/卖点/封面/价格缺（发布-24）                                                           | 422  | `PUBLISH_MISSING_FIELDS` | false     | `change_input` | 「市集卡还差点内容：{缺的位置}，补齐后再发布。」（details.missingFields 列字段，前端聚焦缺处） |
| version 已 published（重复发布，非幂等回放）                                               | 409  | `ALREADY_PUBLISHED`      | false     | `none`         | 「这个能力已发布过了，无需重复发布。」                                                         |
| version 状态非 `draft`（`review_rejected`/`superseded`，发布事务只接受 draft，Codex#4-r2） | 409  | `STATE_CONFLICT`         | false     | `change_input` | 「当前状态不支持发布，请基于被拒/旧版编辑生成新版本再发布。」                                  |
| 幂等 key 复用、body 不同                                                                   | 409  | `IDEMPOTENCY_CONFLICT`   | false     | `none`         | （脊柱 §4，通常对前端透明）                                                                    |
| 幂等 key 租约中（并发/刷新窗口）                                                           | 423  | `RESOURCE_LOCKED`        | true      | `wait`         | 「这条任务正在被处理，请稍候。」                                                               |
| 非本人 version                                                                             | 403  | `FORBIDDEN`              | false     | `escalate`     | 「你没有权限发布这个能力。」                                                                   |
| version 不存在                                                                             | 404  | `NOT_FOUND`              | false     | `change_input` | 「没找到对应能力，可能已被删除。」                                                             |
| 上传封面 asset 不存在                                                                      | 422  | `PUBLISH_COVER_INVALID`  | false     | `change_input` | 「封面图还没传好，换张图或换个封面来源再试。」                                                 |
| 事务内部失败 / DB 抖动                                                                     | 500  | `INTERNAL`               | true      | `retry`        | 「服务开小差了，请重试。」（发布-18：人话 + 重试，绝不甩堆栈）                                 |
| outbox 投递滞留（事务已提交、市集暂未刷新）                                                | —    | —                        | —         | —              | **不报错**：发布成功照常返回，市集最终一致由 sweeper 兜底（贯穿-26）                           |

> 发布失败保留已编辑内容（发布-19）：失败是同步返回 ErrorEnvelope，前端态里封面/价格/名称不清空，点重试用同 `Idempotency-Key` 重发原 body。

### 2.2 `POST /api/v1/versions/{versionId}/market-card/preview` —— 市集卡预览（B-28）

- **method + path**：`POST /api/v1/versions/{versionId}/market-card/preview`
- **鉴权**：Logto JWT；本人 version。
- **幂等**：无副作用（不写库），**用 POST 仅因带未持久化的封面/价格预览入参**；不需 `Idempotency-Key`。
- **用途**：发布前让创作者看「在市集里长什么样」（发布-01/03/贯穿-12）。入参是当前未发布的封面/价格选择 + 服务端读 manifest 软字段，组装一张 `MarketCard` 返回。封面/价格切换不丢由前端态承载（发布-10），本端点纯渲染投影。

**请求 schema**：

```typescript
const MarketCardPreviewBody = z.object({
  cover: z
    .object({
      // 与发布入参同形（可空 → 用默认字形图标，发布-25）
      source: z.enum(['glyph', 'image', 'html_snapshot']),
      assetKey: z.string().optional(),
      snapshotRef: z.string().optional(),
    })
    .optional(),
  tiers: z
    .array(
      z.object({
        tierCode: z.string(),
        priceMicros: z.number().int().nonnegative(),
      }),
    )
    .optional(), // 未设价 → priceMicros null + 待填提示（发布-25）
});
```

**响应 schema**（`Envelope<MarketCard>`）—— 市集卡定稿全位置（发布-03 缺一不可）：

```typescript
interface MarketCard {
  versionId: VersionId;
  capabilityId: CapabilityId;
  slug: Slug;
  cover: {
    // 封面（三来源之一，发布-11）
    source: 'glyph' | 'image' | 'html_snapshot';
    url: string | null; // 解析后的展示 URL（glyph 给生成图/字形描述；缺图前端兜底占位，主页-22）
  };
  typeLabel: string; // 类型标签（如「写作」），取自 manifest 产物类型
  name: string; // 软字段（manifest），可改、与上一步联动（发布-04/30）
  tagline: string; // 一句话卖点（软字段），同上
  summary: string; // 能力简介（软字段）
  byline: string; // 创作者署名（如 @WAYNE），系统自动取登录账号、不可改（发布-05/26）
  trustBadge: '源自一次真实会话'; // 可信标记，系统固定、不可改（发布-26）
  price: {
    priceMicros: number | null; // 创作者设定（发布-14）；未设为 null + 待填提示
    display: string | null; // 人话价格展示
  };
  trialEnabled: false; // 试用按钮固定展示、本期不接功能（发布-08，决策③）
  // usage 类：上线前不显示假数据（发布-07），走 meta.placeholders（值 null）
  installs: null; // 装机量（占位）
  rating: null; // 评分（占位）
}
```

> 响应 `meta.placeholders`：`{ installs: "上线后由真实数据填充", rating: "上线后由真实数据填充" }`（发布-07，脊柱 §2.2；非 0、非错误、非裸转圈）。
>
> **右侧来源映射**（发布-06）由前端依本 schema 静态渲染（名称/一句话=软字段可改、封面/价格=创作者定、署名=自动、装机量/评分=上线后填充、试用=系统固定），不另开端点。

**错误用例**：

| 触发                             | HTTP    | code                    | action                    | 人话 userMessage                                       |
| -------------------------------- | ------- | ----------------------- | ------------------------- | ------------------------------------------------------ |
| version 不存在/非本人            | 404/403 | `NOT_FOUND`/`FORBIDDEN` | `change_input`/`escalate` | 同 §2.1                                                |
| 软字段尚未生成完（结构化未完成） | 409     | `STATE_CONFLICT`        | `change_input`            | 「能力说明书还没整理好，回上一步把字段补全再来预览。」 |

### 2.3 `POST /api/v1/publish-batches` —— 创建批量发布（B-29，无连坐 P0）

- **method + path**：`POST /api/v1/publish-batches`
- **鉴权**：Logto JWT。
- **幂等**：**批次级必带** `Idempotency-Key`，scope=`publish_batch.create`（防重复建批次）。**每 item 另有独立幂等键**（见下，无连坐核心，决策⑤；scope=`publish_batch.item`，必带）。对应选择结构化-08（「批量发布」重复点/刷新只发一次）。
- **语义**：STEP③/STEP②「批量发布」→ 对**所选子集**（`SelectionDraft` 的 `subset.candidateIds`，N<total 或 N==total；「全部发布」是 N==全 ready 特例，40 §4.G）的一批候选/版本**逐个跑结构化 + 发布**（选择结构化-06/29、§5.2/§5.3）。建 `publish_batch` job（JobType=`publish_batch`），worker 编排，**每 item 独立状态机、失败只标该 item、不连累其余**。整体进度走 SSE（job 流，§4）。
  > **子集即建批入参（P0-1）**：建批 `items[]` 直接 = 所选子集（前端把 `subset.candidateIds` 一对一映射成 item），后端**不**校验「== 全 ready」、不重新派生全集——批次只处理传入的子集，`total` = 子集大小，进度/完成度据此（与 40 §4.G 子集放开同口径）。

**请求 schema**：

```typescript
const CreatePublishBatchBody = z.object({
  // 批量来源：STEP③/STEP② 选定的子集（subset.candidateIds，N<total 或 N==total；「全部发布」= 全 ready 特例）
  items: z
    .array(
      z
        .object({
          candidateId: CandidateId.optional(), // 从候选起（需先结构化）
          versionId: VersionId.optional(), // 或已有 draft 版本直接发布
          idempotencyKey: z.string(), // 【无连坐核心】每 item 独立幂等键，scope=publish_batch.item
          // 每 item 的发布入参（封面/价格/可见性；可给批量默认 + 逐项覆盖）
          cover: z
            .object({
              source: z.enum(['glyph', 'image', 'html_snapshot']),
              assetKey: z.string().optional(),
              snapshotRef: z.string().optional(),
            })
            .optional(), // 缺省 → 字形图标
          tiers: z
            .array(
              z.object({
                tierCode: z.string(),
                priceMicros: z.number().int().nonnegative(),
              }),
            )
            .optional(),
          visibility: z.enum(['public', 'unlisted']).optional(), // 缺省 public
        })
        .refine((v) => !!(v.candidateId ?? v.versionId), '需提供 candidateId 或 versionId'),
    )
    .min(1),
});
```

**响应 schema**（`Envelope<PublishBatchView>`，202 Accepted —— 已受理，进度走 SSE）：

```typescript
type BatchItemState =
  | 'pending' // 排队
  | 'structuring' // 正在结构化（candidateId 起的项）
  | 'publishing' // 正在跑发布事务
  | 'published' // 成功
  | 'failed'; // 失败（只标该 item，不连累其余）

interface PublishBatchItemView {
  itemId: Id;
  candidateId?: CandidateId;
  versionId?: VersionId; // 结构化后回填
  state: BatchItemState;
  missingFields?: string[]; // 结构化未补齐的软字段（失败/卡住时给「去补齐」用，决策⑤）
  error?: ErrorEnvelope['error']; // 该 item 的人话错误（非堆栈）
  capabilityId?: CapabilityId; // 发布成功后回填
}
interface PublishBatchView {
  batchId: BatchId;
  jobId: JobId; // publish_batch job，SSE 走 GET /jobs/{jobId}/events
  status: JobStatus; // 批次整体（queued/running/completed/...）：所有 item 终态后 completed（含部分 failed）
  total: number;
  // 【完成度三元（Codex#7）】processedCount = publishedCount + failedCount；完成态以 processed/total 判定
  processedCount: number; // 已终态项数（published + failed），进度分子，永远能追到 total
  publishedCount: number; // 成功数
  failedCount: number; // 失败数（只标该 item，不连累其余）
  items: PublishBatchItemView[];
}
```

> **完成度口径（Codex#7 修订，硬规则① 永不裸转圈 + 决策⑤ 逐项无连坐）**：批量发布的进度分子是 **`processedCount = publishedCount + failedCount`**（已达终态项），**分母是 `total`**。完成判定 = `processedCount === total`（**即便其中有失败项，进度也照样能走到 total / 100%，批次正常进 `completed`**）。**禁止**用 `publishedCount/total` 作完成度——一旦有失败项，`publishedCount` 永远到不了 `total`，会卡在不满进度=裸转圈，且与「逐项无连坐」矛盾。`doneCount` 旧字段废弃，统一用 `publishedCount`（语义更明确，避免与 `processedCount`/「完成」歧义）。

> **无连坐保证（决策⑤ / 选择结构化-29 / B-29）**：
>
> - 每 item 独立 `idempotency_key`（scope=`publish_batch.item`）→ 单 item 重试不影响其余、不重复发布。
> - 每 item 独立 `state` 状态机 `pending→structuring→publishing→published/failed`；**某 item failed 不停批、其余继续**（worker 逐项 try/catch，失败落该 item error，不抛断批）。
> - 批次整体 `status` 在 `processedCount === total`（所有 item 到终态，含 failed）后置 `completed`；批次不因个别失败而 failed（避免「一败全败」）。进度分子用 `processedCount`（=published+failed），保证有失败也走到 total、不裸转圈（Codex#7）。
> - 每个发布成功的 item 各自走 §1.2 单发布事务（各自一条 publications/tiers/outbox），互不串。

**错误用例**：

| 触发                                    | HTTP | code                   | action         | 人话 userMessage                           |
| --------------------------------------- | ---- | ---------------------- | -------------- | ------------------------------------------ |
| items 为空 / 项缺 candidateId&versionId | 400  | `VALIDATION_FAILED`    | `change_input` | 「这批没有可发布的能力，回上一步选一下。」 |
| 批次幂等 key 复用 body 异               | 409  | `IDEMPOTENCY_CONFLICT` | `none`         | （透明）                                   |
| 批次幂等回放（重复点「全部发布」）      | 202  | —                      | —              | 回放首次批次（选择结构化-08，不重复建批）  |

> 单 item 的失败**不**走 HTTP 错误，而是落在 `PublishBatchItemView.error` + SSE `item-appended`/`progress`（硬规则①②）。

### 2.4 `GET /api/v1/publish-batches/{batchId}` —— 查批次（轮询兜底 / 恢复）

- **method + path**：`GET /api/v1/publish-batches/{batchId}`
- **鉴权**：Logto JWT；本人批次。
- **响应**：`Envelope<PublishBatchView>`（同 §2.3）。SSE 是主路径；此端点供刷新/重进时拉全量（与 SSE `state_snapshot` 互补，硬规则③）。

### 2.5 `POST /api/v1/publish-batches/{batchId}/items/{itemId}/retry` —— 单 item 重试（B-29）

- **method + path**：`POST /api/v1/publish-batches/{batchId}/items/{itemId}/retry`
- **鉴权**：Logto JWT；本人批次。
- **幂等**：**必带** `Idempotency-Key`，scope=`publish_batch.item.retry`（防重复重试）。
- **语义**：仅对 `state=failed` 的 item 重试（结构化 / 发布）；**换该 item 的 fence、不影响其余 item、不重建批次**（选择结构化-29「单独重试不连累其余」）。可携新发布入参（修过封面/价格后重试）。

**请求 schema**：

```typescript
const RetryBatchItemBody = z
  .object({
    cover: z
      .object({
        source: z.enum(['glyph', 'image', 'html_snapshot']),
        assetKey: z.string().optional(),
        snapshotRef: z.string().optional(),
      })
      .optional(),
    tiers: z
      .array(
        z.object({
          tierCode: z.string(),
          priceMicros: z.number().int().nonnegative(),
        }),
      )
      .optional(),
    visibility: z.enum(['public', 'unlisted']).optional(),
  })
  .optional();
```

**响应**：`Envelope<PublishBatchItemView>`（该 item 回到 `pending`/`structuring`）。

**错误用例**：

| 触发                                        | HTTP    | code                     | action         | 人话 userMessage                                                                                 |
| ------------------------------------------- | ------- | ------------------------ | -------------- | ------------------------------------------------------------------------------------------------ |
| item 非 failed 态（已 published / 在跑）    | 409     | `STATE_CONFLICT`         | `none`         | 「这一项不需要重试。」                                                                           |
| item 缺软字段（结构化没补齐，需「去补齐」） | 422     | `PUBLISH_MISSING_FIELDS` | `change_input` | 「这一项还差几个字段，去补齐后再发布。」（details.missingFields；前端给「去补齐」回向导，决策⑤） |
| batch/item 不存在/非本人                    | 404/403 | `NOT_FOUND`/`FORBIDDEN`  | —              | 同上                                                                                             |

> **「去补齐」入口（决策⑤ / F-14）**：失败项 `error.action='change_input'` + `missingFields` → 前端引导回结构化向导补字段；补齐后回此端点重试（携新 versionId 由前端 selection 续接）。

### 2.6 评审端点（B-30，Alpha 人工评审）

> 本期评审是**人工**操作，不在创作者向导内，归运营/审核侧。契约在此冻结（创作者侧只读评审结果，见 §6）。评审动作走独立鉴权（审核角色），不暴露给创作者本人对自己能力放行。

#### 2.6.1 `POST /api/v1/publications/{capabilityId}/review` —— 评审裁决（人工）

- **method + path**：`POST /api/v1/publications/{capabilityId}/review`
- **鉴权**：Logto JWT + **审核角色**（reviewer claim）；创作者不可评审自己（`403`）。
- **幂等**：**必带** `Idempotency-Key`，scope=`publish.review`（同一裁决重复提交回放）。
- **语义**：对 `review_status=alpha_pending` 的发布做裁决；**裁决在单 PG 事务内 + 同事务写 outbox**（B-30）。

**请求 schema**：

```typescript
const ReviewBody = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('approve') }),
  z.object({
    decision: z.literal('reject'),
    rejectReason: z.string().min(1).max(500), // 简单拒绝原因（人话，落创作者可见状态，B-30）
  }),
]);
```

**裁决事务语义**（单 PG 事务内，受保护写入遵 `00` §11.A；两条状态线分明，遵 §1.1/§1.3，Codex#8）：

设「被裁决版」= `publications.current_version_id` 当前指向、`review_status='alpha_pending'` 的那一版（记为 `reviewedVersionId`）。

- `approve` → `publications.review_status='published'`（清「Alpha·审核中」徽章，发布-21）；`current_version_id` 不变（仍指被裁决版，其 status 保持 `published`）；发 `capability.published`（指当前版，市集刷新为正式上架）。
- `reject` → **只标被裁决版自身，按可回退性决定对外指向**（事务回退，B-30 / 发布-22/23）：
  - 第一步（两路共同，**被拒版本线**）：把**被裁决版自身** `capability_versions.status → 'review_rejected'`，在该版行记 `reject_reason` + `rejected_at`。**至此只动了被拒版自己**，不碰任何其它版本。
  - 第二步（**当前对外版本线**，按是否有上一版分流）：
    - **有上一 published 版**（即此前被它顶替、status=`superseded` 的那版）：把上一版 `capability_versions.status` 由 `superseded` **复位为 `published`**；`publications.current_version_id` 回退指向上一版；`publications.review_status='published'`（对外版本是正常上架的旧版，**不标脏**）；`capabilities.current_version_id` 同步回退。发 `capability.published`（指回退版）。市集回退展示上一版、能力不消失（发布-22 / 主页-24）。
    - **无上一 published 版**（首发被拒）：`publications.review_status='review_rejected'`（能力体整体下架，`current_version_id` 仍记被拒版供创作者侧追溯，但对外不可见）。发 `capability.unpublished`（下架）。市集找不到、作品墙不展示（发布-23 / 主页-23）。
- 两路都把被拒版的 `reject_reason` **镜像投影**到 `publications.reject_reason`（创作者侧可见态，发布页/工作台徽章/主页墙过滤三处经 `notify.review_decided` 事件同步，发布-31）；权威原因仍以被拒版本行的 `reject_reason`/`rejected_at` 为准（§1.3）。

> **绝不矛盾点（Codex#8）**：`review_rejected` 永远只落在「被裁决的那一版」；有上一版时，回退后继续对外的上一版是 `published`、**绝不**被标 `review_rejected`。这彻底消除旧文「状态表说回退、事务却把 current 标 review_rejected」的自相矛盾。

**响应**：`Envelope<PublicationView>`（见 §6 类型）。

**错误用例**：

| 触发                       | HTTP | code                | action         | 人话 userMessage       |
| -------------------------- | ---- | ------------------- | -------------- | ---------------------- |
| 非 alpha_pending（已裁决） | 409  | `STATE_CONFLICT`    | `none`         | 「这条已评审过了。」   |
| reject 缺 rejectReason     | 400  | `VALIDATION_FAILED` | `change_input` | 「拒绝需要填写原因。」 |
| 非审核角色 / 评审自己      | 403  | `FORBIDDEN`         | `escalate`     | 「你没有权限评审。」   |

#### 2.6.2 `GET /api/v1/publications/{capabilityId}` —— 查发布态（创作者只读）

- **method + path**：`GET /api/v1/publications/{capabilityId}`
- **鉴权**：Logto JWT；本人能力。
- **响应**：`Envelope<PublicationView>`（含 `reviewStatus` / `rejectReason` / `currentVersionId` / `rejectedVersionId`，供发布页拒绝提示 + 重试/编辑入口，发布-31 / B-30）。`reviewStatus='review_rejected'` 时前端「编辑重发」按钮指向 **40 端点 A `POST /api/v1/capabilities` 带 `fromVersionId=rejectedVersionId`**（派生新 draft、回结构化向导编辑），补齐后再走本域发布事务——闭环入口（含首发被拒，Codex#4-r3）。

---

## 3. SSE 事件（按脊柱帧协议，仅批量发布用）

> 单条发布是同步事务、**不走 SSE**。批量发布（`publish_batch` job）走 job 流：`GET /api/v1/jobs/{jobId}/events`（脊柱 §5），kind=`job`。

| event            | 何时发                                                                    | payload 要点                                                                                                                                                                                                        | 对应硬规则/验收                                      |
| ---------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `state_snapshot` | 连接首帧 / 重连超窗                                                       | `{ kind:'job', progress: ProgressView }`——`progress.items` = 全量 `PublishBatchItemView[]` 摘要、`subtasks`=批次阶段、`done/total` = **processedCount/total**（已终态项=published+failed，非仅 published，Codex#7） | ①③ 刷新/重进恢复全量，已发布不丢（贯穿-22）          |
| `progress`       | 批次推进                                                                  | `{ percent, phrase:"已处理 5 / 9 个能力（成功 3 · 失败 2）", done, total, unit:"个能力" }`——`done = processedCount`（=published+failed），`percent = round(processedCount/total*100)`，**有失败也能走到 100%**      | ① 不裸转圈（批量耗时长，靠进度规避；有失败也满进度） |
| `subtask`        | 批次阶段变化                                                              | `{ subtasks:[{key:'structuring',...},{key:'publishing',...}] }`（批次级阶段，非单 item）                                                                                                                            | ① 阶段点亮                                           |
| `item-appended`  | 单 item 状态变化（每项发布完/失败浮现一条）                               | `{ item: PublishBatchItemView }`（state=published/failed + error?）                                                                                                                                                 | ①③ 逐个浮现、失败只标该项（选择结构化-29 不漏不重）  |
| `slow_hint`      | 批次偏慢                                                                  | `{ phrase:"还在逐个发布，稍候…", elapsedMs }`                                                                                                                                                                       | ① 慢任务给短语、配 action=wait                       |
| `error`          | 批次级失败（极少；单 item 失败不走这）                                    | `ErrorEnvelope`（仅批次整体不可继续时）                                                                                                                                                                             | ② 不裸错误码                                         |
| `done`           | 所有 item 到终态（`processedCount === total`，含部分 failed 也照常 done） | `{ status:'completed', result:{ batchId, processedCount, publishedCount, failedCount } }`                                                                                                                           | 终止信号，前端关流                                   |
| `heartbeat`      | 15s 保活                                                                  | `{ ts }`                                                                                                                                                                                                            | ① 连接活着                                           |

> `item-appended` 用连字符（对齐验收「逐个浮现」），与脊柱 §5.3 一致。单 item 的失败落 `item.error`（人话 + action change_input/retry），**不**升级为批次 `error` 帧（无连坐，硬规则①②）。批次内某项慢/卡 → 该项 state 停在 structuring/publishing + 批次 `slow_hint`，不裸转圈。

---

## 4. 幂等与防重汇总（B-09 落点）

| scope                      | 端点                            | 防什么                             | 对应验收                    |
| -------------------------- | ------------------------------- | ---------------------------------- | --------------------------- |
| `publish.version`          | §2.1 单发布                     | 重复点/刷新/双标签页只一条发布记录 | 发布-20 / 贯穿-13 / 贯穿-27 |
| `publish_batch.create`     | §2.3 建批                       | 重复点「全部发布」只一个批次       | 选择结构化-08               |
| `publish_batch.item`       | 批内每 item（请求体内独立 key） | 单 item 不重复发布、无连坐         | 选择结构化-29 / 决策⑤       |
| `publish_batch.item.retry` | §2.5 单 item 重试               | 重复重试不重复发布                 | 选择结构化-29               |
| `publish.review`           | §2.6.1 评审                     | 同一裁决不重复执行回退/上架        | 发布-31                     |

> 三道防重叠加（脊柱 §4 + B-29）：① app 层 `idempotency_keys(scope,key)` UNIQ + request_hash + 租约；② `publications.capability_id` UNIQ（至多一条 active 发布）；③ BullMQ `jobId` 去重（同 publish_batch job 不重复入队）。

---

## 5. DDL（PostgreSQL，体现 Phase 0 正确性决策）

> 沿用脊柱：UUID v7 主键、对外 ID string。引用 `capabilities`/`capability_versions`/`users`/`jobs`/`outbox_events`（基表，本 DDL 假定已建）。本域建：`capability_tiers`、`publications`、`marketplace_listings`、`publish_batches`、`publish_batch_items`，并给出 `outbox_events` 发布事件投影约定 + `eval_reports`（B-31 仅冻结）。
>
> **对 40 域（`capability_versions` 属主）的两项依赖（合并校验项）**：
>
> 1. **复合唯一键**：`capability_versions` 须有 `uq_capability_versions_capability_id UNIQUE (capability_id, id)`（00 §11.E），本域 `fk_publications_capability_version` / `fk_listings_capability_version` 两条复合 FK 引用它。**40 不加此唯一键则本域复合 FK 无法建立。**
> 2. **被拒版本线字段**：`capability_versions` 须有 `reject_reason text` + `rejected_at timestamptz`（落在被拒版自身，§1.1/§1.3 Codex#8 被拒版本线真源）。评审事务（§2.6.1）写这两列到被裁决版行。**本域 `publications.reject_reason` 仅作镜像投影**，权威原因/时刻在 `capability_versions` 被拒版行。

```sql
-- ───────────────────────────────────────────────
-- capability_tiers：定价（发布时冻结，定价唯一真源；非 manifest 字段）  B-27/发布-28
-- 价格血缘绑 version_id（不可变寻址）：已发布版价格永不被后续 manifest 编辑回写
-- ───────────────────────────────────────────────
CREATE TABLE capability_tiers (
  id            uuid        PRIMARY KEY DEFAULT gen_uuid_v7(),
  version_id    uuid        NOT NULL REFERENCES capability_versions(id) ON DELETE CASCADE,
  tier_code     text        NOT NULL,                 -- 如 'standard'（本期单档）
  price_micros  bigint      NOT NULL CHECK (price_micros >= 0), -- 价格（微元），发布事务内冻结
  quota         jsonb,                                -- 档位配额（预留：调用上限等；本期可空）
  frozen_at     timestamptz NOT NULL DEFAULT now(),   -- 冻结时刻（= 发布事务提交时）
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (version_id, tier_code)                      -- 同版同档唯一（定价唯一真源）
);
CREATE INDEX idx_tiers_version ON capability_tiers (version_id);

-- ───────────────────────────────────────────────
-- publications：当前发布态（至多一条 active 发布 / 能力）  B-27/B-30
-- 去重键：capability_id UNIQ（重复发布/改版只一条 active；配合 idempotency_keys）
-- slug 一致性（Codex#16）：不存冗余 url_slug，公开路径一律 JOIN capabilities.slug 读取，
--   消除「publications.url_slug ≡ capabilities.slug」漂移面（slug 本就不可变、能力级唯一，无需在此重复存）
-- 血缘焊死（Codex#6 / 00 §11.E）：current_version_id 复合 FK 保证「对外版属同一 capability」
-- ───────────────────────────────────────────────
CREATE TABLE publications (
  id                 uuid        PRIMARY KEY DEFAULT gen_uuid_v7(),
  capability_id      uuid        NOT NULL REFERENCES capabilities(id) ON DELETE CASCADE,
  current_version_id uuid        NOT NULL,            -- 市集滚动指向版（拒绝回退会改这里）；复合 FK 见下
  share_token        text        NOT NULL,            -- 私享链接 token（首发生成、稳定，改版不失效）
  -- url_slug 已移除（Codex#16）：公开路径 JOIN capabilities.slug，不再冗余存、不再可能漂移
  visibility         text        NOT NULL DEFAULT 'public', -- public（列入市集）| unlisted（仅私享）  发布-27/33
  review_status      text        NOT NULL DEFAULT 'alpha_pending', -- alpha_pending | published | review_rejected  B-30
  reject_reason      text,                            -- 当前能力体「最近一次被拒原因」人话镜像（投影；权威在被拒版本行）  B-30/发布-31/§1.3
  reviewed_at        timestamptz,                     -- 评审裁决时刻
  published_at       timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (capability_id),                             -- 至多一条 active 发布（发布-29）
  UNIQUE (share_token),                               -- 私享 token 全局唯一
  CHECK (visibility IN ('public','unlisted')),
  CHECK (review_status IN ('alpha_pending','published','review_rejected')),
  -- 复合 FK（00 §11.E 固定约束名）：current_version 必属同一 capability，DB 层杜绝跨 capability 错指
  CONSTRAINT fk_publications_capability_version
    FOREIGN KEY (capability_id, current_version_id)
    REFERENCES capability_versions (capability_id, id)
);
CREATE INDEX idx_pub_review_status ON publications (review_status);
CREATE INDEX idx_pub_current_version ON publications (current_version_id);

-- ───────────────────────────────────────────────
-- marketplace_listings：消费读模型（MarketplaceProjection 投影目标，消费链路预留）  B-28/B-39
-- 投影源 = outbox capability.published / capability.unpublished（事务外异步、最终一致）
-- 血缘焊死（Codex#6 / 00 §11.E）：version_id 复合 FK 保证「对外版属同一 capability」
-- slug 一致性（Codex#16）：slug 加 UNIQUE（防公开路径冲突）+ trigger 与 capabilities.slug 焊死（防漂移）
--   说明：slug 在 listing 上仍冗余存（投影读模型需自包含、避免每次查市集都 JOIN），
--   但用 trigger 保证它恒等于 capabilities.slug（capabilities.slug 不可变，故 trigger 仅插入时校验/回填）
-- ───────────────────────────────────────────────
CREATE TABLE marketplace_listings (
  capability_id  uuid        PRIMARY KEY REFERENCES capabilities(id) ON DELETE CASCADE,
  version_id     uuid        NOT NULL,                -- 当前对外展示版（拒绝回退随之改）；复合 FK 见下
  slug           text        NOT NULL,                -- ≡ capabilities.slug（trigger 焊死 + UNIQUE 防冲突，Codex#16）
  card           jsonb       NOT NULL,                -- MarketCard 投影（封面/名称/卖点/署名/价格/类型…）
  search_tsv     tsvector,                            -- 全文检索（name/tagline/summary/tags）
  status         text        NOT NULL DEFAULT 'alpha_pending', -- alpha_pending | published | unlisted | delisted（软删，贯穿-26）
  listed_at      timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (status IN ('alpha_pending','published','unlisted','delisted')),
  CONSTRAINT uq_listings_slug UNIQUE (slug),          -- 公开路径 /a/{slug} 全局唯一，防冲突（Codex#16）
  -- 复合 FK（00 §11.E 固定约束名）：listing 版本必属同一 capability
  CONSTRAINT fk_listings_capability_version
    FOREIGN KEY (capability_id, version_id)
    REFERENCES capability_versions (capability_id, id)
);
CREATE INDEX idx_listings_search ON marketplace_listings USING GIN (search_tsv);
CREATE INDEX idx_listings_slug_trgm ON marketplace_listings USING GIN (slug gin_trgm_ops); -- pg_trgm 模糊
CREATE INDEX idx_listings_status ON marketplace_listings (status) WHERE status IN ('alpha_pending','published');

-- slug 焊死 trigger（Codex#16）：投影 upsert 时强制 listing.slug = capabilities.slug，杜绝漂移。
-- capabilities.slug 不可变（00 §1.2/§1.3），故 listing.slug 一旦由本能力 slug 回填即恒等、不需后续追平。
CREATE OR REPLACE FUNCTION enforce_listing_slug() RETURNS trigger AS $$
BEGIN
  SELECT slug INTO NEW.slug FROM capabilities WHERE id = NEW.capability_id;
  IF NEW.slug IS NULL THEN
    RAISE EXCEPTION 'capability % has no slug', NEW.capability_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_listing_slug
  BEFORE INSERT OR UPDATE OF capability_id ON marketplace_listings
  FOR EACH ROW EXECUTE FUNCTION enforce_listing_slug();

-- ───────────────────────────────────────────────
-- publish_batches：批量发布批次（无连坐 P0）  B-29
-- ───────────────────────────────────────────────
CREATE TABLE publish_batches (
  id            uuid        PRIMARY KEY DEFAULT gen_uuid_v7(),
  owner_user_id uuid        NOT NULL REFERENCES users(id),
  job_id        uuid        NOT NULL REFERENCES jobs(id),  -- publish_batch job（SSE/fencing 走 jobs）
  total         int         NOT NULL,
  -- 完成度三元（Codex#7）：processed = published + failed；完成态以 processed_count = total 判定
  published_count int       NOT NULL DEFAULT 0,            -- 成功计数
  failed_count    int       NOT NULL DEFAULT 0,            -- 失败计数（只标该 item，不连坐）
  processed_count int       NOT NULL GENERATED ALWAYS AS (published_count + failed_count) STORED, -- 已终态项，进度分子
  status        text        NOT NULL DEFAULT 'queued',     -- 镜像 jobs.status（processed_count=total 即 completed，含 failed item）
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_batches_owner ON publish_batches (owner_user_id, created_at DESC);

-- ───────────────────────────────────────────────
-- publish_batch_items：批内单项（每 item 独立幂等键 + 独立状态机 + 独立失败）  B-29/决策⑤
-- 无连坐核心：idempotency_key UNIQ（单项重试不重复发布）、state 独立、error 只标该项
-- 受保护写入（00 §11.A）：worker 对 item state/error 与 publish_batches 计数器的写入，
--   必须用单条事务 CTE 把 fence 内联进数据源（经 publish_batches.job_id→jobs 校验
--   j.id=:jobId AND j.fence_token=:fence AND j.status='running'），禁止「先 SELECT 校验再独立 UPDATE」两步；
--   rowCount=0 = 已被 fence out，干净退出本 attempt、不报错不重试。processed_count 为 generated 列，
--   随 published/failed 自洽。
-- 【计数幂等化 Codex#5-r3】item 终态迁移与 batch 计数**合成单条 CTE**：item 终态 UPDATE 带防重条件
--   `state NOT IN ('published','failed')`、batch 计数只按其 RETURNING 实际迁移行递增（0 行→0 递增），
--   故终态回写被重复执行（重投/重试/双消费）不重复递增计数，「全部发布不漏不重」成立。
--   可复制契约级模板见本表 DDL 之后「受保护写入契约级 CTE 模板」模板 A（中间态推进）/ B（终态迁移+计数幂等）。
-- ───────────────────────────────────────────────
CREATE TABLE publish_batch_items (
  id              uuid        PRIMARY KEY DEFAULT gen_uuid_v7(),
  batch_id        uuid        NOT NULL REFERENCES publish_batches(id) ON DELETE CASCADE,
  candidate_id    uuid        REFERENCES capability_candidates(id), -- 从候选起（需先结构化）
  version_id      uuid        REFERENCES capability_versions(id),   -- 结构化后回填 / 直接发布版
  capability_id   uuid        REFERENCES capabilities(id),          -- 发布成功回填
  idempotency_key text        NOT NULL,                  -- 【无连坐】每 item 独立幂等键（scope=publish_batch.item）
  state           text        NOT NULL DEFAULT 'pending', -- pending|structuring|publishing|published|failed
  missing_fields  text[],                                -- 结构化未补齐软字段（失败/卡住→「去补齐」）
  error           jsonb,                                 -- 该 item 人话错误（ErrorEnvelope.error，非堆栈）
  attempt_no      int         NOT NULL DEFAULT 0,         -- 单 item 重试计数（与 job fence 配合）
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (idempotency_key),                              -- 单项幂等：重试/重复不重复发布（不连坐）
  CHECK (state IN ('pending','structuring','publishing','published','failed')),
  CHECK (candidate_id IS NOT NULL OR version_id IS NOT NULL)
);
CREATE INDEX idx_batch_items_batch ON publish_batch_items (batch_id, created_at);
CREATE INDEX idx_batch_items_failed ON publish_batch_items (batch_id) WHERE state = 'failed';

-- ───────────────────────────────────────────────
-- 受保护写入契约级 CTE 模板（00 §11.A，Codex#5-r2 + Codex#5-r3 计数幂等化）
--   fence 血缘路径：publish_batch_items.batch_id → publish_batches.job_id → jobs。
--   所有写入把 fence 校验 j.id=:jobId AND j.fence_token=:fence AND j.status='running'
--   内联进同一条 SQL 的数据源，单语句、无「先 SELECT 校验再独立 UPDATE」两步。
--   rowCount=0 = 已被 fence out，干净退出本 attempt（不报错不重试）。
--
--   【Codex#5-r3 幂等化关键】item 终态迁移与 batch 计数递增**合成单条 CTE**：
--   item 终态 UPDATE 带 `WHERE state NOT IN ('published','failed')`（防重条件——只允许从非终态进终态），
--   batch 计数**只按该 UPDATE 的 RETURNING 实际迁移行递增**（0 行迁移 → 0 递增）。
--   故同一 item 终态回写被重复执行（重投/重试/双消费）时，第二次起 item UPDATE 命中 0 行、
--   计数 +0，不重复递增 published_count/failed_count，「全部发布不漏不重」成立。
-- ───────────────────────────────────────────────

-- 模板 A · 中间态推进（item 进 structuring/publishing；非终态、不触计数）
-- 仅推进非终态进度态，不动批次计数（计数只在「进终态」那一刻、由模板 B 合成 CTE 处理）。
WITH guard AS (
  SELECT bi.id
  FROM publish_batch_items bi
  JOIN publish_batches b ON b.id = bi.batch_id
  JOIN jobs j           ON j.id = b.job_id
  WHERE bi.id = :itemId
    AND j.id = :jobId
    AND j.fence_token = :fence
    AND j.status = 'running'      -- fence 经 item→batch→job 联表内联校验
  FOR UPDATE OF bi
)
UPDATE publish_batch_items bi
SET state = :state,                -- 仅 'structuring' | 'publishing'（中间态）
    version_id = COALESCE(:versionId, bi.version_id),
    capability_id = COALESCE(:capabilityId, bi.capability_id),
    updated_at = now()
FROM guard
WHERE bi.id = guard.id
  AND bi.state NOT IN ('published','failed');  -- 终态不可回退到中间态（终态不可变）

-- 模板 B · item 终态迁移 + batch 计数（合成单条 CTE，计数幂等化，Codex#5-r3）
-- 某 item 跑到 published/failed 时：① 受 fence + 防重条件迁移 item 终态，② 按【实际迁移的行】递增 batch 计数。
-- 防重条件 `state NOT IN ('published','failed')` 保证「刚从非终态进入终态」才递增；重复回写命中 0 行、计数 +0。
WITH
guard AS (                          -- fence 经 item→batch→job 联表内联校验
  SELECT bi.id AS item_id, b.id AS batch_id, b.total
  FROM publish_batch_items bi
  JOIN publish_batches b ON b.id = bi.batch_id
  JOIN jobs j           ON j.id = b.job_id
  WHERE bi.id = :itemId
    AND j.id = :jobId
    AND j.fence_token = :fence
    AND j.status = 'running'
  FOR UPDATE OF bi, b              -- 同条 CTE 内同时锁 item 与 batch 行，防与 sweeper / 并发 item 竞争
),
moved AS (                          -- 仅当 item 当前为非终态时迁移；RETURNING 出实际迁移的终态
  UPDATE publish_batch_items bi
  SET state = :state,              -- 'published' | 'failed'
      error = :error,             -- 仅 failed 时人话 ErrorEnvelope.error；published 置 NULL
      missing_fields = :missingFields,
      version_id = COALESCE(:versionId, bi.version_id),
      capability_id = COALESCE(:capabilityId, bi.capability_id),
      updated_at = now()
  FROM guard
  WHERE bi.id = guard.item_id
    AND bi.state NOT IN ('published','failed')  -- 防重：只允许「非终态 → 终态」，重复回写命中 0 行
  RETURNING bi.id, bi.state        -- 0 行 = 已被 fence out 或已是终态（重复执行）→ 下面计数 +0
)
UPDATE publish_batches b
SET published_count = b.published_count
      + (SELECT count(*) FROM moved WHERE moved.state = 'published')::int,  -- 仅实际迁移行计入
    failed_count    = b.failed_count
      + (SELECT count(*) FROM moved WHERE moved.state = 'failed')::int,
    -- processed_count 为 GENERATED 列（=published+failed）、不直写；完成判定 = processed=total（含 failed，Codex#7）
    status = CASE
      WHEN (b.published_count + b.failed_count
            + (SELECT count(*) FROM moved)::int) >= guard.total
      THEN 'completed'
      ELSE 'running' END,            -- 未到 total 时镜像 jobs.status='running'（fence 已保证 job running）
    updated_at = now()
FROM guard
WHERE b.id = guard.batch_id
  AND EXISTS (SELECT 1 FROM moved);  -- 无实际迁移行（fence out / 已终态）→ 整条不改批次，杜绝重复递增

-- 备选（等价、更抗漂移）：从 items 聚合重算 batch counters，而非增量递增——
--   SET published_count = (SELECT count(*) FROM publish_batch_items WHERE batch_id=guard.batch_id AND state='published'),
--       failed_count    = (SELECT count(*) FROM publish_batch_items WHERE batch_id=guard.batch_id AND state='failed')
--   同样置于 item 终态迁移之后的同条 CTE 内（先 moved 迁移、再按全量聚合重算），天然幂等（重算结果恒等真值）。

-- ───────────────────────────────────────────────
-- eval_reports：自动评测门（B-31，仅 schema/开关预留，不进本期发布路径）
-- S⑤ 已固定为发布即上架 Alpha，Auto-Eval 不前置；本表本期不写
-- ───────────────────────────────────────────────
CREATE TABLE eval_reports (
  id            uuid        PRIMARY KEY DEFAULT gen_uuid_v7(),
  version_id    uuid        NOT NULL REFERENCES capability_versions(id) ON DELETE CASCADE,
  manifest_hash text        NOT NULL,                  -- 评测绑 manifest 快照
  report        jsonb,                                 -- 格式/复现/安全/质量（后续按开关启用）
  passed        boolean,                               -- 评测结论（本期不参与发布门）
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (version_id, manifest_hash)
);
```

### 5.1 outbox_events 发布事件投影约定（B-13 / B-28 / B-30）

发布域写入 `outbox_events`（脊柱基表，结构见技术方案 §4），**与业务写同 PG 事务**，`xid xid8 DEFAULT pg_current_xact_id()` 作提交序水位。本域四类事件——两条 lifecycle（`capability.*`，仅 `MarketplaceProjection` 消费，payload 无 `recipientId/link`、不进 NotifyConsumer）+ 两条 notify（`notify.*`，`NotifyConsumer` 消费，创作者通知一律走此系列、不靠 lifecycle topic）：

| topic                      | 何时写                                                 | aggregate_id | payload 要点                                                                                                                                                                                                                                                                                                                                                   | 消费方                                                                          |
| -------------------------- | ------------------------------------------------------ | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `capability.published`     | 发布事务成功（§1.2）/ 评审 approve / 拒绝回退上一版    | capabilityId | `CapabilityPublishedPayload`（70 §7 / shared 权威：`{ capabilityId, versionId, slug, manifestHash, reviewStatus:'alpha_pending'｜'published', isRollback, ownerUserId, traceId, occurredAt }`；`slug` 仅展示，投影 upsert listings 时 `listing.slug` 由 `trg_listing_slug` 强制对齐、不靠 payload，Codex#16；`isRollback=true` = 拒绝回退到上一 published 版） | MarketplaceProjection（upsert listings）——lifecycle，仅此一消费方（70 §1）      |
| `capability.unpublished`   | 评审拒绝且无上一版（下架，§2.6.1）                     | capabilityId | `CapabilityUnpublishedPayload`（70 §7 / shared 权威：`{ capabilityId, reason:'review_rejected_no_prev', ownerUserId, traceId, occurredAt }`；拒绝且无上一版可回退 → 下架）                                                                                                                                                                                     | MarketplaceProjection（status→delisted 软删）——lifecycle，仅此一消费方（70 §1） |
| `notify.publish_completed` | 发布成功（§1.2，B-28）/ 批量单项发布完成（§2.3，B-29） | versionId    | `NotifyPublishCompletedPayload`（70 §7 / shared 权威：`{ recipientId, link, versionId, capabilityId, reviewStatus:'alpha_pending', traceId, occurredAt }`；单 version 维度，event_id=`publish_done:{versionId}`，批量按 batchItem 逐项各发一条、不做 batch-wide 合并）                                                                                         | NotifyConsumer（通知创作者发布完成，关页也收得到）                              |
| `notify.review_decided`    | 评审裁决落定（approve/reject 均发，供工作台/主页同步） | capabilityId | `NotifyReviewDecidedPayload`（70 §7 权威：`{ recipientId, capabilityId, versionId, decision:'approved'｜'rejected', rejectReason?, link, traceId, occurredAt }`；reject 携被拒版本线原因，§1.3）                                                                                                                                                               | NotifyConsumer（创作者侧拒绝原因 + 重试/编辑提示，发布-31）                     |

> **投影正确性（贯穿-26）**：listings 由事件投影、非发布事务内直写——市集可见性最终一致；事件卡住时 listings 宁可延迟、不放错状态；sweeper 巡查 outbox 滞留补投。`xid` 水位保证 consumer 按提交序处理、cursor 与处理同事务（不跨 in-flight）。

---

## 6. 该域 TS 类型片段

> import 脊柱 §9 共享类型（`Id/CapabilityId/VersionId/BatchId/CandidateId/Slug/JobId/JobStatus/Envelope/Paginated/ErrorEnvelope/ProgressView/SSEFrame/StateSnapshotPayload` 等），本域只补发布特有类型。

```typescript
import type {
  Id,
  CapabilityId,
  VersionId,
  BatchId,
  CandidateId,
  JobId,
  Slug,
  JobStatus,
  ErrorEnvelope,
  Envelope,
} from '../shared';

// ───────── 版本 / 发布态 ─────────
export type VersionStatus = 'draft' | 'published' | 'superseded' | 'review_rejected';
export type Visibility = 'public' | 'unlisted';
export type ReviewStatus = 'alpha_pending' | 'published' | 'review_rejected';

export interface PublicationView {
  capabilityId: CapabilityId;
  currentVersionId: VersionId; // 当前对外滚动指向版（拒绝回退会改，§1.3 当前对外版本线）。
  //   语义随 reviewStatus 而定：reviewStatus=alpha_pending/published 时指向一条 published 版
  //   （审核中/已上架）；reviewStatus=review_rejected（首发被拒、无上一版可回退、能力下架）时
  //   仍记被拒版供创作者侧追溯，此时该版 status=review_rejected（终态）、对外不可见。
  //   故 currentVersionId 并非「恒为 published 态」——见 §2.6.1 reject 分流（Codex#4-r2 修正旧注）。
  slug: Slug; // = capabilities.slug，服务端 JOIN 出（不存冗余 url_slug，Codex#16）
  shareToken: string;
  visibility: Visibility;
  reviewStatus: ReviewStatus; // alpha_pending（审核中徽章）| published | review_rejected
  rejectReason?: string; // 当前能力体最近一次被拒原因人话镜像（权威在被拒版本行，§1.3）；发布页/工作台/主页可见，B-30
  rejectedVersionId?: VersionId; // 被拒的那一版（被拒版本线；供创作者侧定位「哪版被拒、去编辑重发」，Codex#8）
  rejectedAt?: string; // IsoDateTime；被拒版裁决时刻（镜像）
  publishedAt: string; // IsoDateTime
  reviewedAt?: string;
}

// ───────── 封面 / 定价（发布入参 + 投影） ─────────
export type CoverSource = 'glyph' | 'image' | 'html_snapshot';
export interface CoverInput {
  source: CoverSource;
  assetKey?: string; // source=image
  snapshotRef?: string; // source=html_snapshot
}
export interface TierInput {
  tierCode: string;
  priceMicros: number; // 发布时冻结
}

// ───────── 发布请求 / 结果 ─────────
export interface PublishVersionBody {
  cover: CoverInput;
  tiers: TierInput[]; // ≥1
  visibility: Visibility;
}
export interface PublishResult {
  versionId: VersionId;
  capabilityId: CapabilityId;
  slug: Slug;
  shareToken: string;
  reviewStatus: 'alpha_pending';
  visibility: Visibility;
  publishedVersionId: VersionId;
  supersededVersionId?: VersionId;
  marketUrl: string;
  card: MarketCard;
}

// ───────── 市集卡（B-28 投影；发布-03 全位置） ─────────
export interface MarketCard {
  versionId: VersionId;
  capabilityId: CapabilityId;
  slug: Slug;
  cover: { source: CoverSource; url: string | null };
  typeLabel: string;
  name: string; // 软字段（manifest）
  tagline: string; // 软字段
  summary: string; // 软字段
  byline: string; // 署名（自动取登录账号，不可改）
  trustBadge: '源自一次真实会话'; // 系统固定
  price: { priceMicros: number | null; display: string | null };
  trialEnabled: false; // 试用本期不接（决策③）
  installs: null; // usage 占位（meta.placeholders）
  rating: null; // usage 占位
}

// ───────── 批量发布（无连坐 P0，B-29/决策⑤） ─────────
export type BatchItemState = 'pending' | 'structuring' | 'publishing' | 'published' | 'failed';
export interface CreatePublishBatchItem {
  candidateId?: CandidateId; // 二选一：候选起（需结构化）
  versionId?: VersionId; // 或已有版本直接发
  idempotencyKey: string; // 每 item 独立幂等键（scope=publish_batch.item）
  cover?: CoverInput;
  tiers?: TierInput[];
  visibility?: Visibility;
}
export interface CreatePublishBatchBody {
  items: CreatePublishBatchItem[];
} // ≥1
export interface PublishBatchItemView {
  itemId: Id;
  candidateId?: CandidateId;
  versionId?: VersionId;
  capabilityId?: CapabilityId;
  state: BatchItemState;
  missingFields?: string[]; // 「去补齐」用
  error?: ErrorEnvelope['error']; // 该 item 人话错误（不连坐）
}
export interface PublishBatchView {
  batchId: BatchId;
  jobId: JobId; // SSE: GET /jobs/{jobId}/events
  status: JobStatus; // processedCount===total 后 completed（含部分 failed）
  total: number;
  processedCount: number; // = publishedCount + failedCount；进度分子、完成判定用（Codex#7）
  publishedCount: number; // 成功数
  failedCount: number; // 失败数（不连坐）
  items: PublishBatchItemView[];
}
export interface RetryBatchItemBody {
  cover?: CoverInput;
  tiers?: TierInput[];
  visibility?: Visibility;
}

// ───────── 评审（B-30，人工） ─────────
export type ReviewBody = { decision: 'approve' } | { decision: 'reject'; rejectReason: string };

// ───────── 发布域错误 code（扩脊柱 §3.3，action/retriable 遵缺省表） ─────────
export type PublishErrorCode =
  | 'PUBLISH_MISSING_FIELDS' // 422 change_input：市集卡缺必填（发布-24）
  | 'PUBLISH_COVER_INVALID' // 422 change_input：封面 asset 无效
  | 'ALREADY_PUBLISHED' // 409 none：已发布（脊柱表内）
  | 'STATE_CONFLICT' // 409 change_input/none：状态不允许（脊柱表内）
  | 'IDEMPOTENCY_CONFLICT' // 409 none（脊柱 §4）
  | 'RESOURCE_LOCKED'; // 423 wait（脊柱 §4 租约中）
```

---

## 7. 功能点覆盖表

| 功能点   | 说明                                                                                                               | 对应端点                                                                                                                        | 对应表                                                                                                                                                                                                                                    | 验收模块                                                |
| -------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| **B-27** | 版本状态机 + 发布门事务（draft→published→superseded/review_rejected；冻结 manifest 记 hash + tiers 固化 + Outbox） | `POST /versions/{ver}/publish`（§2.1）                                                                                          | `capability_versions`(status/hash)、`capability_tiers`、`publications`、`outbox_events`                                                                                                                                                   | 发布-15/28/29、贯穿-12/13                               |
| **B-28** | 发布接入 API（幂等）+ 市集卡投影数据                                                                               | `POST /versions/{ver}/publish`（§2.1）、`POST /versions/{ver}/market-card/preview`（§2.2）                                      | `marketplace_listings`、`publications`、`capability_tiers`                                                                                                                                                                                | 发布-01/03/04/05/06/07/08/09/10/11~14/25/26/30、贯穿-12 |
| **B-29** | 批量发布（无连坐 P0：逐项独立幂等键/状态机/失败只标该项/单独重试/去补齐）                                          | `POST /publish-batches`（§2.3）、`GET /publish-batches/{id}`（§2.4）、`POST /publish-batches/{id}/items/{itemId}/retry`（§2.5） | `publish_batches`、`publish_batch_items`、`jobs`(type=publish_batch)                                                                                                                                                                      | 选择结构化-06/08/29、发布（批量结果列表）               |
| **B-30** | Alpha 人工评审 + 拒绝按可回退性分流（两线分明：被拒版本线 vs 当前对外版本线，Codex#8）+ 简单拒绝态落可见状态       | `POST /publications/{capId}/review`（§2.6.1）、`GET /publications/{capId}`（§2.6.2）                                            | `publications`(review_status/reject_reason 镜像/current_version_id 回退)、`capability_versions`(被拒版 status/reject_reason/rejected_at + 上一版复位)、`outbox_events`(capability.published/capability.unpublished/notify.review_decided) | 发布-15/21/22/23/31、主页-19/23/24                      |
| **B-31** | Auto-Eval 仅 schema/开关预留，不进本期发布路径                                                                     | （无端点；发布前不出现评测门）                                                                                                  | `eval_reports`（仅冻结、本期不写）                                                                                                                                                                                                        | 发布-02 改判（不出现自动评测门）、发布门覆盖反向验      |

> **跨域可见性（B-30 三处同步，发布-31）**：本域产出 `publications.review_status/reject_reason` + `notify.review_decided` 事件；工作台域（F-05）读 review_rejected 徽章/原因 + 重试/编辑入口，主页域（B-33/F-06 作品墙）按评审结果过滤/回退展示，发布页（F-14）显示拒绝提示 + 重试/编辑。三处经同一 publications/事件真源，状态一致不滞后。

---

## 摘要（供合并校验）

**端点清单（method + path）**

- `POST /api/v1/versions/{versionId}/publish` —— 发布单个能力（B-27/B-28，同步事务、幂等 scope=publish.version）
- `POST /api/v1/versions/{versionId}/market-card/preview` —— 市集卡预览（B-28，无副作用）
- `POST /api/v1/publish-batches` —— 创建批量发布（B-29，幂等 scope=publish_batch.create，202+SSE）
- `GET /api/v1/publish-batches/{batchId}` —— 查批次（恢复/轮询兜底）
- `POST /api/v1/publish-batches/{batchId}/items/{itemId}/retry` —— 单 item 重试（B-29，幂等 scope=publish_batch.item.retry）
- `POST /api/v1/publications/{capabilityId}/review` —— 评审裁决（B-30，人工/审核角色，幂等 scope=publish.review）
- `GET /api/v1/publications/{capabilityId}` —— 查发布态（创作者只读）
- （SSE 复用脊柱）`GET /api/v1/jobs/{jobId}/events` —— 批量发布进度流

**表清单（新建）**

- `capability_tiers`（version_id+tier_code UNIQ，price_micros 发布冻结，定价唯一真源）
- `publications`（capability_id UNIQ、share_token UNIQ、review_status、reject_reason 镜像、visibility、current_version_id；**去掉冗余 url_slug 改 JOIN capabilities.slug**，Codex#16；**`fk_publications_capability_version` 复合 FK**，Codex#6/00 §11.E）
- `marketplace_listings`（capability_id PK、card jsonb、search_tsv GIN、status 软删；**`uq_listings_slug` slug 唯一 + `trg_listing_slug` 与 capabilities.slug 焊死**，Codex#16；**`fk_listings_capability_version` 复合 FK**，Codex#6/00 §11.E）
- `publish_batches`（job_id、total、**published_count/failed_count/processed_count(generated=published+failed)**、status；完成度三元，Codex#7）
- `publish_batch_items`（idempotency_key UNIQ、state 状态机、missing_fields、error；无连坐核心；worker 写入遵 00 §11.A 受保护 CTE）
- `eval_reports`（B-31 仅冻结，version_id+manifest_hash UNIQ，本期不写）
- 复用 `outbox_events`（本域 4 个 active topic：capability.published / capability.unpublished / notify.publish_completed / notify.review_decided；与 §5.1 / 70 §1·§2.3 / shared events.ts 字段级一致。两条 lifecycle 由 MarketplaceProjection 消费、两条 notify 由 NotifyConsumer 消费）
- **对 40 域依赖（合并校验）**：`capability_versions` 须有 `uq_capability_versions_capability_id UNIQUE (capability_id, id)`（供本域两条复合 FK 引用，00 §11.E）+ `reject_reason`/`rejected_at` 两列（被拒版本线真源，Codex#8）。

**SSE 事件清单（批量发布 job 流，kind=job）**
`state_snapshot`（全量 items 恢复，`done/total` = **processedCount/total**）、`progress`（**已处理 N/M = (published+failed)/total**，有失败也满进度，Codex#7）、`subtask`（批次阶段）、`item-appended`（单 item published/failed 浮现，无连坐）、`slow_hint`、`error`（仅批次级）、`done`（`processedCount===total` 即终，result 带 processed/published/failed 三计数）、`heartbeat`。单条发布同步、不走 SSE。

**引用到的脊柱共享类型**
`Id`、`CapabilityId`、`VersionId`、`BatchId`、`CandidateId`、`JobId`、`Slug`、`JobStatus`、`Envelope<T>`、`Paginated<T>`、`Meta`（placeholders 用于装机量/评分占位）、`ErrorEnvelope` + `ErrorAction`、`ProgressView`、`SubtaskView`、`SSEFrame`、`SSEEventType`、`SSEStreamKind`、`StateSnapshotPayload`、`DonePayload`、`IsoDateTime`、`JobType`(publish_batch)。复用脊柱 `idempotency_keys` 表、`jobs` 表 + fencing、§4 幂等行为矩阵、§3.3 错误分类缺省。

**关键决策声明（供合并冲突检查）**

- 单条发布**同步事务**（非 job/SSE）；仅批量发布建 `publish_batch` job + SSE。
- **发布事务只接受 `draft` 版本（Codex#4-r2）**：`review_rejected` 是终态、不可变，绝不被发布事务就地置 `published`；被拒重发先从 rejected version 派生新 `draft`（新 version_id，由 40 域入口建），原 rejected version 保留 `status/reject_reason/rejected_at` 不动。以非 draft 版调发布 → `409 STATE_CONFLICT`。被拒线（`capability_versions` 被拒版自身）与当前对外版线（`publications.current_version_id` 回退/下架）两线单一真源。
- **批量发布受保护写入有契约级 CTE 模板（Codex#5-r2 + #5-r3 计数幂等化 / §11.A）**：模板 A（中间态推进）与模板 B（item 终态迁移 + batch 计数，**合成单条 CTE**）均经 `publish_batches.job_id→jobs` 校验 `j.id=:jobId AND j.fence_token=:fence AND j.status='running'`、单语句、`rowCount=0` 安全退出。**计数幂等化**：模板 B 的 item 终态 UPDATE 带防重条件 `state NOT IN ('published','failed')`，batch 计数只按 RETURNING 实际迁移行递增（0 行→0 递增），终态回写被重复执行不重复递增 `published_count/failed_count`，「全部发布不漏不重」成立（备选：从 items 聚合重算计数，天然幂等）。见 §5 DDL 后模板。
- 「Alpha·审核中」vs「已上架」落 `publications.review_status`（不在 `capability_versions.status` 二次编码），避免双真源漂移。
- 价格冻结落 `capability_tiers(version_id,…)`、按不可变 version_id 寻址；改 manifest 不回写已发布版价格。
- 去重三道闸：`idempotency_keys(scope,key)` + `publications.capability_id` UNIQ + BullMQ jobId。
- 无连坐：`publish_batch_items.idempotency_key` UNIQ + 独立 state + 单 item 失败落 error/不断批。批次完成度用 **`processedCount = published + failed`**，完成判定 `processedCount === total`，有失败也走到 100%（Codex#7，永不裸转圈）。
- 评审为**人工**端点（审核角色），创作者侧只读结果。**拒绝两线分明（Codex#8）**：`review_rejected` 只标被拒版自身（记 `capability_versions.reject_reason`/`rejected_at`）；当前对外版本线回退到上一 published 版（上一版由 `superseded` 复位 `published`、**绝不被标脏**），无上一版则 `publications.review_status='review_rejected'` 下架。`publications.reject_reason` 仅作创作者侧人话镜像，权威在被拒版本行。
- **slug 一致性（Codex#16）**：去掉 `publications.url_slug`，公开路径一律 JOIN `capabilities.slug`；`marketplace_listings.slug` 加 `uq_listings_slug` 唯一 + `trg_listing_slug` 触发器与 `capabilities.slug` 焊死，防冲突/漂移。
- **复合 FK（Codex#6 / 00 §11.E）**：`fk_publications_capability_version (capability_id, current_version_id)` 与 `fk_listings_capability_version (capability_id, version_id)` 均引用 `capability_versions (capability_id, id)`，DB 层保证「对外版属同一 capability」。
- B-31 Auto-Eval 仅冻结 `eval_reports`，发布前**不出现**自动评测门（按决策④覆盖验收 发布-02 的「设计未定稿」旧措辞）。

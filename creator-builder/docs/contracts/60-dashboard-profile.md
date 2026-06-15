# 60 · 工作台 + 个人主页 域契约（B-32 / B-33 / B-34）

> **本文是「工作台聚合 + 个人主页聚合 + 社交」域的对外契约**，覆盖功能点 **B-32（工作台聚合）/ B-33（个人主页聚合，全六分区 P0）/ B-34（社交 follows/likes）**。
>
> **依赖脊柱**：本文严格 import `contracts/00-约定与状态机.md`（下称「脊柱」）已定义的一切，**不重定义**：路由前缀 `/api/v1`（§1）、轻包络 `Envelope<T>` / `Paginated<T>` 与占位语义 `meta.placeholders`（§2）、错误信封 `ErrorEnvelope` + action 五枚举 + 错误分类表缺省（§3）、幂等 `Idempotency-Key` + 行为矩阵 + `idempotency_keys` 表（§4）、SSE 帧协议（§5，本域几乎不用，仅草稿条状态由 jobs 流间接体现）、jobs 状态机 + fencing（§6）、`ProgressView`（§7）、`drafts` 表 + step 五枚举（§8）、§9 全部共享 TS 类型、健康检查口径（§10）。
>
> **真源**：技术架构以飞书《技术方案 · 创作者中心与消费链路》为权威，本地落地以 `creator-builder/docs/01-详细技术方案.md` 为准（B-32/B-33/B-34、数据模型 §4、差异 §9 第 7/9 条）；产品行为以 `docs/开工总纲-创作者中心主链路.md` 为准；验收口径以 `docs/测试验收-创作者中心主链路.md`（外壳首页- / 主页- 两模块）为准。
>
> **本域的四条本期基线（来自六项已拍板决策，全文据此自洽）**：
> 1. **usage 类指标本期统一占位**（决策②）。本月消耗、累计/本月调用、活跃消费者、token 趋势点、能力表 sparkline/收益、主页总调用量、作品墙调用次数、最热主题里的「热度数字」——这些字段一律返回 **`null` 值 + `meta.placeholders[field]="暂无数据 / 上线后填充"`**（脊柱 §2.2），不查 `usage_events`/`daily_*`、不返 0、不空错误、不裸转圈。非 usage 字段（已发布能力数、草稿条、能力名/状态、关注/粉丝/获赞计数、能力点数、知识领域数、热力图格子、密度榜、能力网络缩略边）正常返回真实值。
> 2. **个人主页全六分区 P0**（决策⑥）。`GET /creators/{creatorId}/profile` 单次返回六分区全量，逐分区落字段；公开只读、访客同视图、钱/经营动作不外泄。
> 3. **能力网络缩略不依赖 embedding**（决策⑥ + 差异 §9 第 9 条）。缩略关系用 **session/tag 共现即时生成**（同一 snapshot/session 命中多能力 → 共现边；`tags[]` 重叠 → 标签边），**不读 `capability_relations`、不依赖 B-37**。
> 4. **作品墙按 B-30 评审结果过滤/回退**（决策④）。`alpha_pending` / `published` 上墙；被拒下架（无上一版）不上墙；被拒回退则展示上一 `published` 版口径；公开口径绝不带 `review_rejected` 原始状态、不带钱/成本。
>
> 本文只写契约（markdown + TS 类型片段 + SQL DDL），不写业务实现代码。TS 片段最终归集到 `src/shared/`（zod schema 即 OpenAPI 3.1 真源），DDL 归 `src/infra/pg/migrations/`。

---

## 0. 端点总览

| # | method + path | 鉴权 | 功能点 | usage 占位 |
|---|---|---|---|---|
| 1 | `GET /api/v1/dashboard/summary` | 创作者本人 | B-32 | 含（本月调用） |
| 2 | `GET /api/v1/dashboard/metrics` | 创作者本人 | B-32 | 含（4 卡其 3） |
| 3 | `GET /api/v1/dashboard/token-trend` | 创作者本人 | B-32 | 全占位 |
| 4 | `GET /api/v1/dashboard/capabilities` | 创作者本人 | B-32 | 部分列（调用/sparkline/收益） |
| 5 | `GET /api/v1/dashboard/drafts` | 创作者本人 | B-32 / F-15 | 否（真实） |
| 6 | `GET /api/v1/creators/{creatorId}/profile` | 公开（可匿名） | B-33 | 部分分区（总调用量/作品墙调用次数） |
| 7 | `GET /api/v1/creators/{creatorId}/capabilities?byDensity` | 公开（可匿名） | B-33 | 否（密度真实，趋势真实） |
| 8 | `GET /api/v1/creators/{creatorId}/heatmap` | 公开（可匿名） | B-33 | 否（按 happened_at 算格子） |
| 9 | `GET /api/v1/creators/{creatorId}/network` | 公开（可匿名） | B-33 | 否（共现即时生成） |
| 10 | `GET /api/v1/creators/{creatorId}/works` | 公开（可匿名） | B-33 | 调用次数占位 |
| 11 | `POST /api/v1/creators/{creatorId}/follows` | `requireAuth`（任意已登录，非 creator-only，脊柱 §11.F） | B-34 | 否 |
| 12 | `DELETE /api/v1/creators/{creatorId}/follows` | `requireAuth`（任意已登录，脊柱 §11.F） | B-34 | 否 |
| 13 | `POST /api/v1/capabilities/{capabilityId}/likes` | `requireAuth`（任意已登录，非 creator-only，脊柱 §11.F） | B-34 | 否 |
| 14 | `DELETE /api/v1/capabilities/{capabilityId}/likes` | `requireAuth`（任意已登录，脊柱 §11.F） | B-34 | 否 |

> **设计取舍：工作台拆 5 个聚合端点，不做单一巨胖端点。** 理由：(1) 验收里指标卡（外壳首页-09）、趋势图（外壳首页-10）、能力表（外壳首页-11）、草稿条（外壳首页-16）是各自加载/各自空态/各自失败重试的（外壳首页-24/25），分端点能局部失败不连坐、局部重试（与「已生成不丢」「带退路」一致）；(2) 能力表是分页列表（cursor），趋势/指标是单体，混在一个端点形态不统一；(3) 时间范围 `range` 作为公共 query 参数，谁需要谁带。
>
> **设计取舍：个人主页拆「主聚合 + 4 个可独立加载分区」。** `GET .../profile` 默认一次返回六分区全量（满足主页-01 一屏六分区顺序加载）；但密度榜（分页/展开，主页-06）、热力图（半年格子，主页-09）、能力网络（共现计算，主页-10）、作品墙（分页网格，主页-11）**各有独立子端点**，供「分区局部失败局部重试不整页崩」（主页-17）、密度榜展开更多（主页-06）、作品墙翻页使用。主聚合端点内嵌各分区**首屏切片**（密度榜前 3、作品墙首页、热力图全量、网络缩略全量），分区子端点用于翻页/重试/展开。

---

## 1. 工作台聚合（B-32）

> 全部端点：**鉴权 = 创作者本人**（JWT subject == 资源 owner）。工作台是经营后台，**只对本人可见**（外壳首页-20）；非本人访问任一 `dashboard/*` 端点返回 `403 FORBIDDEN`（脊柱 §3.3，action=`escalate`）。钱/成本/经营动作只在此域，绝不出现在 `/creators/{id}/profile`（外壳首页-21、主页-25/26）。
>
> **公共 query：时间范围 `range`**（外壳首页-19，三档）。`range ∈ {'7d','30d','all'}`，缺省 `'30d'`。影响 summary 的「本月调用」窗口、metrics 的环比基期、token-trend 的时间跨度、capabilities 的本月调用/收益区间。本期这些 usage 维度全占位，`range` 仍照常解析、回显（前端切换三档不报错、当前档有选中标识，外壳首页-19）。

### 1.1 `GET /api/v1/dashboard/summary` — 页头经营摘要（外壳首页-08）

页头标题固定「创作者中心」+ 一句经营摘要，把**已发布能力体数量（真实）**与**本月被调用次数（usage，占位）**说清楚。

**请求**

```ts
// query
const DashboardSummaryQuery = z.object({
  range: z.enum(['7d', '30d', 'all']).default('30d'),
});
```

**响应** `Envelope<DashboardSummary>`

```ts
export interface DashboardSummary {
  title: string;                 // 固定「创作者中心」
  publishedCount: number;        // 已发布能力体数量（真实，非占位）
  monthlyInvocations: number | null; // usage：本期 null + placeholder
  // 摘要句模板，前端用真实 publishedCount + 占位文案拼装：
  //   有 usage 后：「你发布的 {publishedCount} 个能力体，本月被调用 {monthlyInvocations} 次」
  //   本期占位：  「你发布的 {publishedCount} 个能力体，调用数据上线后填充」（得体文案，非裸 0）
  summaryTemplate: string;       // 含占位符的人话句式（前端负责代入）
}
```

```jsonc
// 本期典型返回（已发布 8 个、usage 占位）
{
  "data": {
    "title": "创作者中心",
    "publishedCount": 8,
    "monthlyInvocations": null,
    "summaryTemplate": "你发布的 {publishedCount} 个能力体，{monthlyInvocations} 次调用"
  },
  "meta": {
    "traceId": "01J...",
    "placeholders": { "monthlyInvocations": "暂无数据 / 上线后填充" }
  }
}
```

> 验收对齐：外壳首页-08「摘要数字与指标卡一致、非写死占位」——`publishedCount` 真实且与 metrics 卡一致；`monthlyInvocations` 本期占位（验收口径已改判：摘要数字以得体文案表达暂无即过，§测试验收受影响用例表）。

### 1.2 `GET /api/v1/dashboard/metrics` — 四张大数字卡 + 环比（外壳首页-09 / 29）

横向四卡：**已发布能力体（真实）/ 累计调用（usage 占位）/ 本月消耗（usage 占位）/ 活跃消费者（usage 占位）**，每卡一个大数字 + 一个环比（涨/跌幅度）。四卡缺一不可。

**请求**：query 同 1.1（`range`，影响环比基期）。

**响应** `Envelope<DashboardMetrics>`

```ts
export type MetricKey = 'published' | 'invocationsTotal' | 'spendThisMonth' | 'activeConsumers';

export interface MetricCard {
  key: MetricKey;
  label: string;                 // 人话卡名：已发布能力体 / 累计调用 / 本月消耗 / 活跃消费者
  value: number | null;          // usage 卡本期 null；published 卡真实
  // 环比：usage 卡本期占位；published 卡有真实环比（与上一区间发布数比）
  deltaPercent: number | null;   // 环比百分比，正=涨负=跌；usage 卡 null
  deltaDirection: 'up' | 'down' | 'flat' | null; // 方向，usage 卡 null
  unit?: string;                 // 如「次」「能力体」「人」「tokens」
}
export interface DashboardMetrics {
  range: '7d' | '30d' | 'all';
  cards: MetricCard[];           // 恒四张，顺序固定 published→invocationsTotal→spendThisMonth→activeConsumers
}
```

> **usage 卡的占位落点**：`value`/`deltaPercent`/`deltaDirection` 三者均为 `null`，`meta.placeholders` 标注三键（如 `"invocationsTotal":"暂无数据 / 上线后填充"`）。`published` 卡 `value` 真实、`deltaPercent`/`deltaDirection` 真实（真实环比，验收外壳首页-29 涨跌方向正确）。
>
> **活跃消费者口径**（差异 §9 第 7 条、外壳首页-32）：上线后 = `daily_creator_consumers` 桥表 `COUNT(DISTINCT consumer_key)`（含匿名键 = `hash(share_token + anon_cookie)`，distinct 不可从日聚合加和）。**本期不聚合、占位**；本契约冻结读模型口径（见 §4 DDL `daily_creator_consumers`），上线即按此读。
>
> 验收对齐：外壳首页-09（四卡齐全带环比）、外壳首页-29（大数字/环比 usage 部分占位、published 真实）、外壳首页-32（活跃消费者含匿名、与主页公开计数不混口径——此卡 usage 占位，主页社交计数是另一组真实计数，见 §2.1）。

### 1.3 `GET /api/v1/dashboard/token-trend` — 每日 token 消耗趋势（外壳首页-10 / 26）

折线+面积趋势，双口径切换（tokens / 调用次数），标峰值。本期**整图占位**。

**请求**

```ts
const TokenTrendQuery = z.object({
  range: z.enum(['7d', '30d', 'all']).default('30d'),
  metric: z.enum(['tokens', 'invocations']).default('tokens'), // 双口径开关
});
```

**响应** `Envelope<TokenTrend>`

```ts
export interface TrendPoint { date: IsoDateTime; value: number | null; }
export interface TokenTrend {
  range: '7d' | '30d' | 'all';
  metric: 'tokens' | 'invocations';
  points: TrendPoint[];          // 本期空数组 []（无数据），不是转圈、不是报错
  peak: TrendPoint | null;       // 峰值标注，本期 null
  empty: boolean;                // true = 该区间无数据，前端渲染「暂无消耗」空态（外壳首页-26）
}
```

> 本期 `points:[]`、`peak:null`、`empty:true`，`meta.placeholders["points"]="暂无数据 / 上线后填充"`。切换 `metric`/`range` 照常返回（不报错，外壳首页-10），纵轴含义由 `metric` 决定。区间内无消耗（外壳首页-26）= `empty:true`，前端给「暂无消耗」空态/贴零线，**不误标峰值**（`peak:null`）、不破图。
>
> 验收对齐：外壳首页-10（双口径切换不报错）、外壳首页-26（无消耗区间空态、不误标峰值）。

### 1.4 `GET /api/v1/dashboard/capabilities` — 能力体列表（外壳首页-11 / 14 / 15 / 30-B30）

「我的能力体」表格，**cursor 分页**（脊柱 §2.3）。每行：名称+一句话简介、状态、本月调用（usage 占位）、消耗趋势迷你图 sparkline（usage 占位）、收益（usage 占位）、操作（试用/编辑/更多）。

**请求**

```ts
const DashboardCapabilitiesQuery = z.object({
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(20),
  order: z.enum(['asc', 'desc']).default('desc'), // 默认最新在前
  range: z.enum(['7d', '30d', 'all']).default('30d'),
  status: z.enum(['all', 'alpha_pending', 'published', 'review_rejected', 'draft']).default('all'),
});
```

**响应** `Paginated<DashboardCapabilityRow>`

```ts
// 评审/上架状态（工作台【展示层派生】枚举；非 publications.review_status 的存储枚举）。
// 派生映射（B-30）：发布域 publications.review_status 只存 3 值 'alpha_pending'|'published'|'review_rejected'（50 域 §5 CHECK）；
//   本枚举在其上派生两个展示态：
//     'draft'        ← 该能力无 publications 行 / capability_versions.status='draft'（未发布）
//     'unpublished'  ← review_status='review_rejected' 且无上一 published 版（被拒下架）。
// 工作台据此渲染状态列，但绝不把 'draft'/'unpublished' 写回 publications.review_status。
export type CapabilityReviewStatus =
  | 'alpha_pending'   // Alpha·审核中（发布即此态；= review_status）
  | 'published'       // 已上架（评审通过；= review_status）
  | 'review_rejected' // 已退回（被拒有上一版回退/或被拒；= review_status）
  | 'draft'           // 【派生】草稿（未发布，对应 capability_versions.status=draft）
  | 'unpublished';    // 【派生】已下架（review_rejected 且无上一版）

export interface DashboardCapabilityRow {
  capabilityId: CapabilityId;
  versionId: VersionId;          // 当前展示版本（被拒回退则指回退版）
  slug: Slug;
  name: string;                  // manifest 软字段（真实）
  tagline: string;               // 一句话简介（manifest 软字段，真实）
  reviewStatus: CapabilityReviewStatus;
  statusLabel: string;           // 人话状态：「Alpha·审核中」「已上架」「已退回」「草稿」「已下架」
  rejectReason: string | null;   // 仅 review_rejected：简单拒绝原因（人话；B-30 三处可见之一）
  retryEditable: boolean;        // review_rejected → true，前端给「重试/编辑」入口
  monthlyInvocations: number | null;  // usage 占位
  spendSparkline: TrendPoint[] | null; // usage 占位（消耗趋势迷你图）
  revenueMicros: number | null;       // usage 占位（收益）
  // 操作能力（前端据此渲染操作列；不返回真实动作 URL，前端按 capabilityId 拼路由）
  actions: {
    trial: { enabled: false; hint: '本期未开放' }; // 试用本期不做（决策③），按钮在、点击落占位
    edit: boolean;                                  // 进草稿/编辑（外壳首页-15）
    more: boolean;                                  // 更多菜单：下架/改价/查看（外壳首页-35）
  };
  publishedAt: IsoDateTime | null;
  updatedAt: IsoDateTime;
}
```

> **usage 列占位**：`monthlyInvocations`/`spendSparkline`/`revenueMicros` 本期 `null`，`meta.placeholders` 逐键标注。名称/简介/状态/操作真实。
>
> **试用占位**（决策③、外壳首页-14、F-05）：`actions.trial` 恒 `{enabled:false,hint:"本期未开放"}`——按钮存在且文案正确，点击落「本期未开放」占位、不进 runtime session（验收外壳首页-14「进入运行态」本期挂起）。
>
> **拒绝态可见**（B-30、外壳首页-11 行内、F-05 status 列）：`reviewStatus='review_rejected'` 时 `statusLabel="已退回"`、`rejectReason` 给简单人话原因、`retryEditable=true`。这是 B-30「三处同步可见」的工作台落点。
>
> **数据源**：`capabilities` + `capability_versions`（name/tagline/status）+ `publications`（review_status/reject_reason）。被拒回退时 `versionId` 指 `capabilities.current_version_id`（已回退到上一 published），状态展示回退后口径。
>
> 验收对齐：外壳首页-11（列项齐全、usage 子断言占位）、外壳首页-14（试用占位）、外壳首页-15（编辑入口）、外壳首页-35（更多菜单可达）、外壳首页-30/B-30（拒绝态徽章+原因+重试编辑）。

### 1.5 `GET /api/v1/dashboard/drafts` — 草稿与上传中条（外壳首页-16/17/33/34，F-15）

工作台横向胶囊条，列未完成上传任务，标所处步骤 + 进度（如「结构化中 60%」）。**真实数据，非 usage**。多条逐条可区分、各回各的中断处。

**请求**

```ts
const DashboardDraftsQuery = z.object({
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(20),
  order: z.enum(['asc', 'desc']).default('desc'), // 最近更新在前
});
```

**响应** `Paginated<DraftView>`（直接复用脊柱 §9 `DraftView`，不重定义）

```ts
// 来自脊柱 §9：
// DraftView { id, status, currentStep, stepProgress{percent,phrase}, title?,
//             snapshotId?, extractJobId?, selection?, versionId?, batchId?, createdAt, updatedAt }
// 本端点只返回 status='active' 的草稿（completed/abandoned 不上草稿条）。
```

> **续传落点**（外壳首页-17/33，脊柱 §8.4 注）：每条 `DraftView` 携 `currentStep` + 对应落点引用（`snapshotId`/`extractJobId`/`selection`/`versionId`/`batchId`）+ `stepProgress.phrase`（如「结构化中 60%」）。前端点「去上传流程」→ 读 `currentStep` + 落点 → 回精确断点；步内细粒度走 SSE `state_snapshot`（job/structure 流）恢复，已生成内容原样回显（外壳首页-30、贯穿-28）。**本域只读 drafts 表、不建任务、不发 SSE**；续传的 SSE 由 jobs/structure 流（脊柱 §5）承担。
>
> **多条不串台**（外壳首页-34）：`drafts` 表 `(owner_user_id, status, updated_at DESC)` 索引保证各自独立；每条 `id`/`title`/落点独立，点 A 不会回到 B。
>
> **空态**（外壳首页-23）：无 active 草稿 → `data:[]` + `page.hasMore:false`，前端渲染「暂无未完成的上传」或不显示该条，**不出空白胶囊**。
>
> 验收对齐：外壳首页-16（草稿条列未完成+步骤）、外壳首页-17（一键回中断步）、外壳首页-23（空态）、外壳首页-33（进度与步骤一致、落点对得上）、外壳首页-34（多条可区分各回各处）。

### 1.6 工作台错误用例（映射脊柱 §3）

| 场景（验收） | HTTP | code | retriable | action | 人话 userMessage |
|---|---|---|---|---|---|
| 非本人访问 dashboard/*（外壳首页-20） | 403 | `FORBIDDEN` | false | `escalate` | 「你没有权限查看这个工作台。」 |
| 聚合查询取不到数据/后台失败（外壳首页-25） | 500 | `DASHBOARD_AGGREGATE_FAILED` | true | `retry` | 「经营数据没能加载，请重试。」 |
| 聚合慢（外壳首页-24，不裸转圈） | — | — | — | — | 前端渲染**灰色加载条占位**（非转圈）；服务端正常聚合，慢则后端可在响应头给 `Server-Timing`，但 UI 占位由前端 skeleton 承担（聚合是同步读，无 SSE，无 slow_hint） |
| `range` 非法值 | 400 | `VALIDATION_FAILED` | false | `change_input` | 「时间范围参数不对，换一档再试。」 |
| cursor 失效/越界（能力表/草稿条） | 400 | `VALIDATION_FAILED` | false | `change_input` | 「翻页参数失效了，回到第一页重试。」 |

> **局部失败不连坐**（外壳首页-25、对齐主页-17 思想）：5 个工作台端点各自独立，趋势图失败不影响指标卡/能力表渲染；前端按端点粒度展示局部错误 + 重试，外壳与其他区块仍在。这是「拆 5 端点」取舍的兑现。

---

## 2. 个人主页聚合（B-33，全六分区 P0）

> **鉴权 = 公开只读（可匿名）**。`GET /creators/{creatorId}/profile` 及四个分区子端点对登录用户与匿名访客返回**同一张公开名片**（主页-13）；本人视角与访客视角数据一致、全程只读（主页-13/25）。**钱/成本/经营动作绝不出现**（主页-04/25/26、外壳首页-21）：无收益/消耗/token 趋势/草稿续传/上传入口；总调用量只读不下钻（主页-04）。
>
> **`creatorId` 寻址**：用 UUID（脊柱 §1.3）。slug 仅展示。`creatorId` 不存在/已注销 → `404 NOT_FOUND`（action=`change_input`）。
>
> **六分区顺序固定**（主页-01）：① Hero 身份区 → ② 指标带 → ③ 能力按会话密度榜 → ④ 会话足迹热力图 → ⑤ 能力网络缩略 → ⑥ 作品墙。主聚合端点 `sections` 按此顺序返回，前端按返回顺序渲染、不乱序、不缺分区。

### 2.0 `GET /api/v1/creators/{creatorId}/profile` — 主聚合（六分区首屏全量）

**请求**

```ts
// path: creatorId
// query: 无（主聚合不分页；分区翻页/展开走各子端点）
```

**响应** `Envelope<CreatorProfile>`

```ts
export interface CreatorProfile {
  creatorId: UserId;
  slug: Slug;                    // 展示用 /a/{slug} 或 /c/{slug}
  sectionsOrder: ProfileSectionKey[]; // 固定 ['hero','metrics','density','heatmap','network','works']
  hero: ProfileHero;             // ① 身份区
  metrics: ProfileMetricsBand;   // ② 指标带
  density: ProfileDensitySlice;  // ③ 能力密度榜（首屏前 3）
  heatmap: ProfileHeatmap;       // ④ 热力图（近半年全量）
  network: ProfileNetwork;       // ⑤ 能力网络缩略（全量缩略边）
  works: ProfileWorksSlice;      // ⑥ 作品墙（首屏首页）
  heatmapEnabled: boolean;       // 创作者关闭热力图时 false（主页-20），则 heatmap 省略/前端不渲染该分区
}
export type ProfileSectionKey = 'hero' | 'metrics' | 'density' | 'heatmap' | 'network' | 'works';
```

> **设计取舍：主聚合返回各分区首屏切片，翻页/展开/重试走子端点。** 一次请求满足主页-01（一屏六分区顺序加载、不缺分区）；密度榜展开更多（主页-06）、作品墙翻页（主页-11）、单分区失败重试（主页-17）用对应子端点（§2.3/§2.6/§2.4/§2.5）。
>
> **热力图开关**（主页-20）：`heatmapEnabled=false` 时主聚合不含 `heatmap` 数据（或置空标记），前端**不渲染该分区**、其余五分区顺序不乱、访客同样看不到、不出空框。`sectionsOrder` 仍含 `'heatmap'` 占位键供前端判断顺序，但渲染层据 `heatmapEnabled` 跳过。

### 2.1 ① Hero 身份区（主页-02 / 21）

头像、昵称、≥1 身份标签 pill、一句话简介、三社交计数（关注/粉丝/获赞）。**社交计数真实**（不是 usage，是 follows/likes 读模型，见 §3）。

```ts
export interface ProfileHero {
  avatarUrl: string | null;      // 缺省走前端兜底占位（非破图）
  displayName: string;
  identityTags: string[];        // 身份标签 pill，≥1（如「保险经纪」「增长黑客」）
  bio: string;                   // 一句话简介
  social: {
    following: number;           // 关注数（真实）
    followers: number;           // 粉丝数（真实）
    likes: number;               // 获赞数（真实，= 该创作者名下能力被点赞总和）
    // 当前查看者关系（登录态才有；匿名为 null，不影响只读展示）
    viewerIsFollowing: boolean | null;
  };
}
```

> **社交计数 ≠ usage**（外壳首页-32 口径分离）：following/followers/likes 是真实计数（§4 `creator_profiles` 冗余计数列 + §3 follows/likes 写路径维护），与工作台「活跃消费者」（usage 占位）是两套口径，不混淆、不互相回填。
>
> **大数显示**（主页-21）：计数为 number，前端负责千分位/万-k 缩写规整显示，契约只保证返回精确整数。
>
> 验收对齐：主页-02（六项齐全、计数真实）、主页-21（大数规整由前端、契约给真实整数）。

### 2.2 ② 指标带（主页-03 / 04 / 26）

四项：能力点数（真实）/ 知识领域数（真实）/ 总调用量（usage 占位）/ 最热主题（主题名真实、热度数字占位）。**只读、不下钻、不带经营维度**（主页-04/26）。

```ts
export interface ProfileMetricsBand {
  capabilityCount: number;       // 能力点数（真实，= 上墙能力数）
  domainCount: number;           // 知识领域数（真实，= distinct tags[domain]）
  totalInvocations: number | null; // 总调用量（usage 占位）
  hottestTopic: {
    name: string | null;         // 最热主题名（真实：按 tag/密度榜首推主题；无则 null）
    heatValue: number | null;    // 热度数字（usage 占位）
  };
  readonly: true;                // 恒 true，前端据此禁用任何点击下钻（主页-04）
}
```

> **usage 占位**：`totalInvocations`、`hottestTopic.heatValue` 为 `null` + `placeholders`。`hottestTopic.name` **真实**（按能力 `tags` / 密度榜首主题推算，不依赖 usage；无能力则 null 但前端显示「暂无主题」而非空白，主页-03 要求显示主题名而非空白/数字）。
>
> **只读不下钻**（主页-04）：契约层 `readonly:true` 是硬约束信号；指标带不返回任何下钻 URL/明细引用；点击无反应（前端据 `readonly` 禁用）；绝不含收益/金额/收入字段（主页-04/26、外壳首页-21）。
>
> **公开口径不串数**（主页-26）：`totalInvocations` 是「可对外公开的调用量口径」（上线后 = `capabilities.total_invocations` 之和或公开聚合），**不附带成本/收益/token 消耗**，与工作台 metrics 的「累计调用」分属公开口径 vs 经营口径，本期同为占位、上线后各自口径独立。
>
> 验收对齐：主页-03（四项齐全、最热主题是名称非空白）、主页-04（只读不下钻、无经营维度）、主页-26（公开口径不带钱、不下钻）。

### 2.3 ③ 能力按会话密度榜 — 子端点 `GET /api/v1/creators/{creatorId}/capabilities?byDensity`（主页-05/06/07/08）

密度排行，默认前 3 + 展开更多。每条：密度条 + 支撑会话段数（真实）+ 趋势箭头（真实，按会话足迹时间分布算）。**只读，无管理操作**（主页-08）。

**请求**

```ts
const ProfileDensityQuery = z.object({
  byDensity: z.literal(true),    // 标记密度排序口径
  cursor: z.string().optional(), // 展开更多翻页（主页-06）
  limit: z.number().int().min(1).max(50).default(3), // 默认前 3（主页-05）
});
```

**响应** `Paginated<DensityRankRow>`（主聚合内嵌前 3 = 此端点首页切片 `ProfileDensitySlice`）

```ts
export interface DensityRankRow {
  rank: number;                  // 1-based 名次
  capabilityId: CapabilityId;
  slug: Slug;
  name: string;
  densityScore: number;          // 0-100 密度归一值（真实，按支撑段数/活跃度算）
  supportingSegments: number;    // 支撑会话段数（真实，= candidate_evidence/段级血缘计数；信任货币）
  trend: 'up' | 'down' | 'flat'; // 趋势箭头（真实，按 session_segments.happened_at 时间分布算，不依赖 usage）
  readonly: true;                // 无发布/编辑/下架/改价等管理操作（主页-08）
}
export interface ProfileDensitySlice {
  rows: DensityRankRow[];        // 前 3
  hasMore: boolean;              // true → 前端显示「展开更多」（主页-06）
}
```

> **密度/趋势均真实、不依赖 usage**：`supportingSegments` 来自段级血缘（`candidate_evidence` × `session_segments`，技术方案 §4「N 段会话支撑」信任货币）；`trend` 按会话足迹时间分布算。这两者是个人主页的「信任度」展示，与 usage 调用量无关。
>
> **逐条下钻**（主页-07）：是「按会话密度的查看下钻」（看更细密度构成），**不是管理操作**。本端点每行返回 `capabilityId`，前端据此请求密度详情视图（密度详情子视图若需服务端数据，复用 `supportingSegments` 明细，本契约不单列端点，留前端展开或后续补；主页-07 为 P1）。
>
> **只读**（主页-08）：`readonly:true`，无任何管理动作字段；管理操作只在工作台（§1.4）。
>
> **空态**（主页-14）：无能力 → `rows:[]` + `hasMore:false`，前端「还没有能力」友好空态。
>
> 验收对齐：主页-05（前 3、密度条/段数/趋势）、主页-06（展开更多）、主页-07（逐条密度下钻，P1）、主页-08（只读无管理）。

### 2.4 ④ 会话足迹热力图 — 子端点 `GET /api/v1/creators/{creatorId}/heatmap`（主页-09 / 20）

GitHub 风格热力图，近半年按天网格。格子颜色反映活跃密度；**只算格子数量、绝不暴露会话原文**（主页-09）。按 `session_segments.happened_at` 算，**不依赖 usage**（决策⑥）。

**请求**

```ts
const ProfileHeatmapQuery = z.object({
  // 默认近半年（约 183 天）；range 仅做窗口微调，缺省 'half_year'
  range: z.enum(['half_year', 'year']).default('half_year'),
});
```

**响应** `Envelope<ProfileHeatmap>`

```ts
export interface HeatmapCell {
  date: string;                  // YYYY-MM-DD（按天格子）
  count: number;                 // 当天会话活跃量（段数计；真实，仅数量）
  level: 0 | 1 | 2 | 3 | 4;      // 颜色档（0=空/浅 → 4=深），服务端按分位算好
}
export interface ProfileHeatmap {
  range: 'half_year' | 'year';
  start: string;                 // 窗口起始日 YYYY-MM-DD
  end: string;                   // 窗口结束日（今天）
  cells: HeatmapCell[];          // 仅有活跃的日子，或全量按天（前端补空格）
  maxCount: number;              // 用于图例/分档说明
  enabled: boolean;              // 创作者关闭则 false（主页-20），前端不渲染分区
}
```

> **隐私硬约束**（主页-09、技术方案 §4 `session_segments.happened_at`）：格子**只含 `date`/`count`/`level`，绝不含任何会话正文/标题/片段**。悬停展示日期+当天数量（前端用 `count`），看不到内容。
>
> **不依赖 usage**：完全按 `session_segments.happened_at` 聚合（决策⑥），usage 置空不影响热力图——热力图是本期个人主页**少数有真实数字的分区**之一。
>
> **开关**（主页-20）：创作者在设置关闭 → `enabled:false`（与主聚合 `heatmapEnabled` 一致），本人与访客都不渲染该分区、其余五分区顺序不乱、不出空框/报错。
>
> **空态**（主页-14）：新创作者无会话 → `cells:[]` + `maxCount:0`，前端「暂无会话足迹」空态。
>
> 验收对齐：主页-09（近半年格子、颜色密度、只数量不露原文）、主页-14（空态）、主页-20（关闭后本人/访客都不显示）。

### 2.5 ⑤ 能力网络缩略 — 子端点 `GET /api/v1/creators/{creatorId}/network`（主页-10）

以创作者为中心的能力图谱**缩略预览**，**无展开入口**（主页-10）。缩略边用 **session/tag 共现即时生成**，**不读 `capability_relations`、不依赖 embedding/B-37**（决策⑥、差异 §9 第 9 条）。

**请求**：仅 path `creatorId`（无分页；缩略图量小，一次返回全量缩略边）。

**响应** `Envelope<ProfileNetwork>`

```ts
export type NetworkEdgeBasis = 'session_cooccur' | 'tag_overlap'; // 共现来源（即时生成）

export interface NetworkNode {
  capabilityId: CapabilityId;
  slug: Slug;
  name: string;
  size: number;                  // 节点大小提示（按 supportingSegments / 密度，真实）
  isCenter: boolean;             // 创作者中心锚点节点之一标记（缩略以创作者为中心）
}
export interface NetworkEdge {
  source: CapabilityId;
  target: CapabilityId;
  weight: number;                // 共现强度（同 snapshot/session 命中次数 或 重叠 tag 数）
  basis: NetworkEdgeBasis;       // 'session_cooccur'：同一 snapshot/session 命中多能力
                                 // 'tag_overlap'：tags[] 重叠
}
export interface ProfileNetwork {
  nodes: NetworkNode[];
  edges: NetworkEdge[];          // 缩略边集合（即时生成）
  thumbnailOnly: true;           // 恒 true：仅缩略、无展开（主页-10）
  // 契约硬约束：不返回任何「展开图谱/查看完整图谱/进入图谱」URL/入口字段
}
```

> **数据源即时生成（不依赖 embedding）**：`edges` 由本次请求即时计算——`session_cooccur`：同一 `snapshot_id`（或 session）下被多条 `candidate_evidence` 命中的能力两两连边；`tag_overlap`：`capabilities.tags[]`（audience/domain/scene 三类）重叠的能力连边。**不查 `capability_relations`、不触发/不读 embedding**（B-37 保持 P1、限定后续搜索增强，不作主页缩略数据源）。为避免每次重算成本，可由 §4 读模型 `creator_capability_cooccur` 物化（见 DDL），但口径仍是 session/tag 共现，**不是 embedding 相似度**。
>
> **仅缩略无展开**（主页-10）：`thumbnailOnly:true`，响应**不含任何展开/完整图谱入口字段**；前端分区内无「展开图谱/查看完整图谱」按钮、点不进完整图谱页。
>
> **空态**（主页-14）：< 2 能力或无共现 → `edges:[]`（或仅孤立节点），前端渲染中心单点/空缩略，不报错。
>
> 验收对齐：主页-10（以创作者为中心的缩略预览、分区内无展开入口）。

### 2.6 ⑥ 作品墙 — 子端点 `GET /api/v1/creators/{creatorId}/works`（主页-11/12/19/22/23/24，B-30）

网格展示已发布能力卡，每张：封面 + 名称 + 调用次数（usage 占位）。**按 B-30 评审结果过滤/回退**（决策④）。**cursor 分页**。

**请求**

```ts
const ProfileWorksQuery = z.object({
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(60).default(24),
  order: z.enum(['asc', 'desc']).default('desc'),
});
```

**响应** `Paginated<WorkCard>`（主聚合内嵌首页 = 此端点首页切片 `ProfileWorksSlice`）

```ts
export interface WorkCard {
  capabilityId: CapabilityId;
  versionId: VersionId;          // 展示版本（被拒回退则指回退后的上一 published 版，主页-24）
  slug: Slug;                    // 点卡进公开页 /a/{slug}（主页-12）
  coverUrl: string | null;       // 封面；null → 前端兜底占位图/底色（主页-22，不破图）
  name: string;                  // 能力名（manifest 软字段，公开口径）
  invocations: number | null;    // 调用次数（usage 占位）
  // 公开口径：不含 review_rejected 原始状态、不含钱/成本（主页-19/23/24）
  // alpha_pending 也上墙，但对外只显示公开口径，不暴露内部审核状态码（主页-19）
}
export interface ProfileWorksSlice {
  cards: WorkCard[];
  hasMore: boolean;
}
```

> **B-30 过滤/回退口径（决策④，作品墙是 B-30「三处可见」的主页落点）**：
> - `publications.review_status ∈ {alpha_pending, published}` → **上墙**（`alpha_pending` 按公开口径展示，**不暴露内部审核状态码**，主页-19）。
> - 被拒**且无上一版**（下架，`unpublished`）→ **不上墙**（主页-23：被拒下架不残留、不暴露 `review_rejected`）。
> - 被拒**且有上一 published 版**（回退）→ **上墙，展示回退后的上一 published 版口径**（主页-24：`versionId` 指回退版，名称/封面/调用次数都是该版，能力不消失、不展示被拒新版、不裸露内部回退状态）。
>
> **usage 占位**：`invocations` 本期 `null` + `placeholders`（主页-11/19/24 调用次数子断言改占位）。`coverUrl`/`name` 真实。
>
> **点卡进公开页**（主页-12）：返回 `slug`，前端拼公开页/市集展示路径，**不进编辑/管理**（公开只读）。
>
> **封面缺图**（主页-22）：`coverUrl:null` → 前端统一兜底占位（契约只返回 null，不返回破图 URL）。
>
> **空态**（主页-14）：无上墙能力 → `cards:[]` + `hasMore:false`，「还没有已发布的能力」空态；草稿/未提交**不上墙**（主页-11）。
>
> 验收对齐：主页-11（卡含封面/名称/调用次数、只已发布上墙）、主页-12（点卡进公开页不进管理）、主页-19（Alpha 不污染公开口径）、主页-22（缺图兜底）、主页-23（被拒下架不上墙）、主页-24（回退展示上一版）。

### 2.7 个人主页错误用例（映射脊柱 §3）

| 场景（验收） | HTTP | code | retriable | action | 人话 userMessage |
|---|---|---|---|---|---|
| creatorId 不存在/已注销 | 404 | `NOT_FOUND` | false | `change_input` | 「没找到这个创作者，可能链接失效了。」 |
| 主页/分区接口失败（主页-16） | 500 | `PROFILE_AGGREGATE_FAILED` | true | `retry` | 「内容没能加载，请重试。」 |
| 单分区失败、整页不崩（主页-17） | 500 | `PROFILE_SECTION_FAILED` | true | `retry` | 「这个分区没能加载，请重试。」（仅该分区局部错误+重试，已成功分区不清空） |
| 加载中（主页-15，不裸转圈） | — | — | — | — | 前端各分区**灰色加载条占位**（skeleton），数据到替换；聚合是同步读、无 SSE/无 slow_hint |
| 重导期间访问（主页-18，旧内容不丢） | 200 | — | — | — | 正常返回**当前已生成内容**（旧快照/旧能力照常展示）；新快照聚合中不阻塞读、不清空（已生成不丢，硬规则③） |
| 翻页 cursor 失效（密度榜/作品墙） | 400 | `VALIDATION_FAILED` | false | `change_input` | 「翻页参数失效了，回到开头重试。」 |

> **局部失败不连坐**（主页-17）：主聚合端点对各分区**容错聚合**——某分区数据源失败时，该分区字段置 `null` 并在 `meta` 标注分区级错误（或前端改走该分区子端点重试），**已成功分区照常返回**，整页不崩成错误页。子端点（密度/热力图/网络/作品墙）天然独立，单端点失败只影响对应分区。
>
> **重导不丢**（主页-18，硬规则③）：主页读的是**当前生效**的能力/作品/段（`capabilities.current_version_id`、当前 snapshot 的段集）。重导生成**新快照**（技术方案 §4：旧快照及其段保留），聚合期间主页仍读旧的已生效内容，**不清空、不报错**；新数据 ready 后按新值更新。

---

## 3. 社交（B-34，follows / likes，P1）

> **鉴权 = `requireAuth`（任意已登录用户，不限 creator role）**——遵脊柱 **§11.F 社交写权限（Codex#17）**唯一权威裁定。社交关注/点赞是消费侧基础互动，普通登录用户即可关注创作者/点赞能力，**不挂 `requireRole('creator')`**（10-auth §6.2 已据 §11.F 把「社交写→`requireRole('creator')`」修正为 `requireAuth`，两域口径一致）。匿名（`optionalAuth`）不可写，未登录写 → `401 UNAUTHENTICATED` + `action:'escalate'`（§3.5）。所有 POST/DELETE 写命令**必须带 `Idempotency-Key`**（脊柱 §4），重复点/双标签页不产生重复计数（行为矩阵：回放首次结果，对前端透明）。
>
> **owner/业务校验与权限口径无关**（§11.F）：「自己不能关注/点赞自己」是 60 域业务校验（§3.5、§4.2 `CHECK (follower_id <> followee_id)`），在 `requireAuth` 通过之后由 handler 判定，不收紧鉴权角色。
>
> follows/likes 多对多（技术方案 §4）；计数聚合（冗余计数列，见 §4 DDL），读路径（Hero 三计数、作品墙获赞）直接读冗余列、不实时 `COUNT(*)`。

### 3.1 `POST /api/v1/creators/{creatorId}/follows` — 关注

```ts
// guard: requireAuth（任意已登录用户；不加 requireRole('creator')，脊柱 §11.F）
// header: Idempotency-Key (必填, scope='social.follow')
// body: 无（关注对象在 path）
// 自己关注自己 → 422 业务拒绝（requireAuth 通过后由 handler 判定，与角色无关）
```

**响应** `Envelope<FollowResult>`

```ts
export interface FollowResult {
  creatorId: UserId;
  following: boolean;            // true（关注成功/已关注回放）
  followersCount: number;        // 被关注者更新后的粉丝数（冗余计数）
}
```

### 3.2 `DELETE /api/v1/creators/{creatorId}/follows` — 取关

guard `requireAuth`（任意已登录用户，脊柱 §11.F）。**写命令，必带 `Idempotency-Key`，scope=`social.unfollow`**（脊柱 §4 / §11.F：所有写操作含 DELETE 统一带 key + 固定 scope，不因 DELETE 天然幂等而豁免；重复请求按 §4 行为矩阵回放首次结果、不重复减计数）。响应同 `FollowResult`（`following:false`）。

### 3.3 `POST /api/v1/capabilities/{capabilityId}/likes` — 点赞能力

```ts
// guard: requireAuth（任意已登录用户；不加 requireRole('creator')，脊柱 §11.F）
// header: Idempotency-Key (必填, scope='social.like')
// body: 无（点赞对象 capabilityId 在 path）
```

**响应** `Envelope<LikeResult>`

```ts
export interface LikeResult {
  capabilityId: CapabilityId;
  liked: boolean;               // true
  likesCount: number;           // 该能力更新后的获赞数（冗余计数）
}
```

### 3.4 `DELETE /api/v1/capabilities/{capabilityId}/likes` — 取消点赞

guard `requireAuth`（任意已登录用户，脊柱 §11.F）。**写命令，必带 `Idempotency-Key`，scope=`social.unlike`**（脊柱 §4 / §11.F：所有写操作含 DELETE 统一带 key + 固定 scope，不因 DELETE 天然幂等而豁免；重复请求按 §4 行为矩阵回放首次结果、不重复减计数）。响应同 `LikeResult`（`liked:false`）。

### 3.5 社交错误用例（映射脊柱 §3 + §4）

> 表内「人话 userMessage」列即脊柱 **§11.B 的 `userMessage`**（唯一可对 UI 展示的人话）；`code` 仅日志/告警/文案映射、UI 永不渲染。

| 场景 | HTTP | code | retriable | action | 人话 userMessage（= `userMessage`） |
|---|---|---|---|---|---|
| 未登录关注/点赞（`requireAuth` 未过） | 401 | `UNAUTHENTICATED` | false | `escalate` | 「登录后才能关注/点赞，请先登录。」 |
| 关注自己 | 422 | `SOCIAL_SELF_FOLLOW` | false | `change_input` | 「不能关注自己。」 |
| 目标创作者/能力不存在 | 404 | `NOT_FOUND` | false | `change_input` | 「对象不存在，可能已被删除。」 |
| 缺 Idempotency-Key（写） | 400 | `VALIDATION_FAILED` | false | `change_input` | 「请求缺少必要参数，请重试。」 |
| 同 key 在租约中（双击/双标签页并发） | 423 | `RESOURCE_LOCKED` | true | `wait` | 「这条操作正在处理，请稍候。」（脊柱 §4.2，前端稍候重试同 key） |
| 同 key request_hash 不同 | 409 | `IDEMPOTENCY_CONFLICT` | false | `none` | （脊柱 §4，对前端透明/拒绝复用） |
| 重复关注/点赞（同 key 已完成） | 200 | — | — | — | 回放首次结果（`following/liked` 不重复加计数，对前端透明） |

> **无「缺 creator 角色」403 用例**（脊柱 §11.F）：社交写守卫是 `requireAuth`，**不存在**「已登录但非 creator → 403 FORBIDDEN」这条社交写用例——任意已登录用户都能 follow/like。未登录唯一被拒口径就是上表 `401 UNAUTHENTICATED` + `escalate`。（403 只在「私有经营数据非本人访问」即工作台 §1.6 出现，与社交写无关。）
>
> **前端权限态**（脊柱 §11.F 对齐）：关注/点赞按钮对**任意已登录用户**可点（不按 creator 角色灰置）；未登录态点击 → 前端据 `401 + escalate` 引导登录（而非按角色隐藏按钮）。`viewerIsFollowing`（§2.1 Hero）仅登录态有值，用于切换「关注/已关注」文案，与是否 creator 无关。
>
> **计数一致性**：follow/like 写入与冗余计数列更新在**同一 PG 事务**内（UNIQUE 约束防重 + 事务保证计数不重复加），叠加幂等键（脊柱 §4）双重防重复——双击/刷新/双标签页不会把粉丝/获赞计成多个。

---

## 4. 数据模型（DDL，PostgreSQL）

> 体现 Phase 0 关键正确性决策：**去重键**（社交关系唯一约束）、**fence/血缘**（密度榜按段级血缘、热力图按 snapshot 段的 `happened_at`，与 jobs fencing 写入的产物对账一致）、**读模型**（社交冗余计数、共现物化、daily 聚合 schema 冻结）。所有 usage 类 daily/共识聚合表本期**仅冻结 schema、不跑聚合**（决策②）。
>
> 前置依赖表（脊柱 §6/§8 与发布域/导入域已定义，本文 FK 引用、不重建）：`users`、`jobs`、`raw_snapshots`、`session_segments`、`capabilities`、`capability_versions`、`publications`、`candidate_evidence`、`drafts`、`idempotency_keys`。

### 4.1 `creator_profiles` — 个人主页公开名片（1:1 user，B-33）

```sql
CREATE TABLE creator_profiles (
  user_id         uuid        PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  slug            text        NOT NULL UNIQUE,        -- 公开主页路径 /c/{slug}，URL 安全、可双向解析
  display_name    text        NOT NULL,
  avatar_url      text,                               -- null → 前端兜底占位
  identity_tags   text[]      NOT NULL DEFAULT '{}',  -- 身份标签 pill（主页-02，≥1 由 app 校验）
  bio             text        NOT NULL DEFAULT '',    -- 一句话简介
  heatmap_enabled boolean     NOT NULL DEFAULT true,  -- 会话足迹热力图开关（主页-20）
  -- 社交冗余计数（读路径直读，写路径事务内维护；非 usage、是真实计数）
  followers_count integer     NOT NULL DEFAULT 0 CHECK (followers_count >= 0),
  following_count integer     NOT NULL DEFAULT 0 CHECK (following_count >= 0),
  likes_count     integer     NOT NULL DEFAULT 0 CHECK (likes_count >= 0), -- 名下能力获赞总和
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_creator_profiles_slug ON creator_profiles (slug);
```

### 4.2 `follows` — 关注关系（去重键，B-34）

```sql
CREATE TABLE follows (
  follower_id  uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,  -- 关注者
  followee_id  uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,  -- 被关注者
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_id, followee_id),               -- 去重键：同一对只一行（防重复关注计数）
  CHECK (follower_id <> followee_id)                    -- 不能关注自己（主页/§3.5）
);
CREATE INDEX idx_follows_followee ON follows (followee_id);  -- 反查粉丝列表/计数对账
CREATE INDEX idx_follows_follower ON follows (follower_id);  -- 反查关注列表/viewerIsFollowing
```

### 4.3 `likes` — 能力点赞（去重键，B-34）

```sql
CREATE TABLE likes (
  user_id        uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  capability_id  uuid        NOT NULL REFERENCES capabilities(id) ON DELETE CASCADE,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, capability_id)                  -- 去重键：同一用户对同一能力只一行
);
CREATE INDEX idx_likes_capability ON likes (capability_id); -- 反查某能力获赞计数对账
CREATE INDEX idx_likes_user ON likes (user_id);            -- viewer 是否点赞
```

> 计数维护：`POST follow/like` 在同事务内 `INSERT ... ON CONFLICT DO NOTHING` + 仅当真正插入时 `UPDATE creator_profiles SET followers_count = followers_count + 1`；`DELETE` 反之。UNIQUE PK + 事务 + 幂等键（脊柱 §4）三重防重复计数。

### 4.4 `creator_capability_cooccur` — 能力网络缩略读模型（共现物化，B-33）

> **能力网络缩略的可选物化表**：口径是 **session/tag 共现**（决策⑥），**不是 embedding**，**与 `capability_relations`（B-37）无关**。`network` 端点可即时计算或读此物化表；物化由导入/提取/发布写路径增量更新（同 snapshot 命中多能力 → cooccur；tags 重叠 → tag_overlap）。

```sql
CREATE TABLE creator_capability_cooccur (
  creator_id     uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  capability_a   uuid        NOT NULL REFERENCES capabilities(id) ON DELETE CASCADE,
  capability_b   uuid        NOT NULL REFERENCES capabilities(id) ON DELETE CASCADE,
  basis          text        NOT NULL,                 -- 'session_cooccur' | 'tag_overlap'
  weight         integer     NOT NULL DEFAULT 1 CHECK (weight > 0), -- 共现强度（命中次数/重叠 tag 数）
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (creator_id, capability_a, capability_b, basis),
  CHECK (capability_a < capability_b)                  -- 规范化无向边（去重，只存一向）
);
CREATE INDEX idx_cooccur_creator ON creator_capability_cooccur (creator_id, weight DESC);
```

> **段级血缘对账（fence 一致性）**：`session_cooccur` 边的来源是 `candidate_evidence (candidate_id, segment_id)` × `session_segments (snapshot_id)`——同一 `snapshot_id` 下被多能力命中即共现。这条血缘与 jobs fencing（脊柱 §6.2「worker 写入带 `WHERE job_id=? AND fence_token=?`」）写入的 candidate/evidence 是同一份产物，缩略边只读已 fence 落库的证据，不读半成品。

### 4.5 usage 读模型（本期仅冻结 schema、不跑聚合，决策②）

> 这些表是 B-32/B-33 usage 字段（本月调用/累计调用/本月消耗/活跃消费者/总调用量/作品墙调用次数/token 趋势/收益）上线后的数据源。**本期 MeteringConsumer 不启动、表为空、所有读返回占位**（脊柱 §2.2）。冻结 schema 是为「上线即接、口径不变」。
>
> **⚠️ DDL 真源归属（避免重复定义）**：`usage_events` 与三张 `daily_*`（`daily_capability_stats` / `daily_creator_consumers` / `daily_creator_llm_stats`）的**唯一 DDL 真源在事件/基础设施域 `70-events-infra.md` §9.1（B-36）**。本域**只读这些表占位、不重定义建表语句**；下表仅列「本域读取用到的列与口径约定」（列名/PK 以 70 域为准，本域不再 `CREATE TABLE`，防止两份 schema 漂移）。

| 表（真源 70 域 §9.1） | 本域读取场景 | 关键列与口径 |
|---|---|---|
| `daily_capability_stats` (`PRIMARY KEY (stat_date, capability_id)`) | 能力表本月调用/sparkline/收益（§1.4）、主页总调用量公开口径（§2.2） | `invocations`（公开口径只 SELECT 此列，不带钱）、`tokens`、`cost_micros`/`revenue_micros`（经营口径，仅工作台） |
| `daily_creator_consumers` (`PRIMARY KEY (stat_date, creator_id, consumer_key)`) | 活跃消费者卡（§1.2，含匿名键） | `consumer_key` 含 `hash(share_token+anon_cookie)`；活跃消费者 = 区间内 `COUNT(DISTINCT consumer_key)` |
| `daily_creator_llm_stats` (`PRIMARY KEY (stat_date, creator_id)`) | token 趋势双口径（§1.3） | `tokens`（metric=tokens）、`invocations`（metric=invocations）、`cost_micros` |

> **活跃消费者口径冻结**（差异 §9 第 7 条、外壳首页-32）：`daily_creator_consumers` 存「当日去重的 consumer_key 明细」，活跃消费者 = 选定区间内 `COUNT(DISTINCT consumer_key)`——**不能把每日 distinct 数加和**（会重复计跨天同人）。匿名键也计入。本期此表空、卡占位。
>
> **总调用量公开口径**（主页-26）：上线后 = 某创作者名下能力的 `daily_capability_stats.invocations` 聚合（或 `capabilities.total_invocations`），**只露调用量、不带 cost/revenue**——与工作台经营口径（含 cost/revenue）字段分离，公开端点查询时只 SELECT invocations 列，不带钱列。

---

## 5. 本域 TS 类型片段汇总

> 归集到 `src/shared/`（zod schema 即 OpenAPI 真源；下为人读镜像）。**import 脊柱 §9 共享类型**：`Id/UserId/JobId/SnapshotId/CapabilityId/VersionId/Slug/TraceId/IsoDateTime`、`Envelope`、`Meta`、`PageMeta`、`Paginated`、`PageQuery`、`ErrorAction`、`ErrorEnvelope`、`DraftView`、`DraftStep`、`DraftStatus`，本文不重定义。下为本域**新增**类型清单（已在上文分散给出，此处汇总）。

```typescript
// ===== 工作台（B-32）=====
export type MetricKey = 'published' | 'invocationsTotal' | 'spendThisMonth' | 'activeConsumers';
export interface DashboardSummary { title: string; publishedCount: number; monthlyInvocations: number | null; summaryTemplate: string; }
export interface MetricCard { key: MetricKey; label: string; value: number | null; deltaPercent: number | null; deltaDirection: 'up'|'down'|'flat'|null; unit?: string; }
export interface DashboardMetrics { range: '7d'|'30d'|'all'; cards: MetricCard[]; }
export interface TrendPoint { date: IsoDateTime; value: number | null; }
export interface TokenTrend { range: '7d'|'30d'|'all'; metric: 'tokens'|'invocations'; points: TrendPoint[]; peak: TrendPoint | null; empty: boolean; }
export type CapabilityReviewStatus = 'alpha_pending' | 'published' | 'review_rejected' | 'draft' | 'unpublished';
export interface DashboardCapabilityRow {
  capabilityId: CapabilityId; versionId: VersionId; slug: Slug; name: string; tagline: string;
  reviewStatus: CapabilityReviewStatus; statusLabel: string; rejectReason: string | null; retryEditable: boolean;
  monthlyInvocations: number | null; spendSparkline: TrendPoint[] | null; revenueMicros: number | null;
  actions: { trial: { enabled: false; hint: '本期未开放' }; edit: boolean; more: boolean };
  publishedAt: IsoDateTime | null; updatedAt: IsoDateTime;
}
// 草稿条直接复用脊柱 §9 DraftView（Paginated<DraftView>）

// ===== 个人主页（B-33）=====
export type ProfileSectionKey = 'hero' | 'metrics' | 'density' | 'heatmap' | 'network' | 'works';
export interface ProfileHero {
  avatarUrl: string | null; displayName: string; identityTags: string[]; bio: string;
  social: { following: number; followers: number; likes: number; viewerIsFollowing: boolean | null };
}
export interface ProfileMetricsBand {
  capabilityCount: number; domainCount: number; totalInvocations: number | null;
  hottestTopic: { name: string | null; heatValue: number | null }; readonly: true;
}
export interface DensityRankRow { rank: number; capabilityId: CapabilityId; slug: Slug; name: string; densityScore: number; supportingSegments: number; trend: 'up'|'down'|'flat'; readonly: true; }
export interface ProfileDensitySlice { rows: DensityRankRow[]; hasMore: boolean; }
export interface HeatmapCell { date: string; count: number; level: 0|1|2|3|4; }
export interface ProfileHeatmap { range: 'half_year'|'year'; start: string; end: string; cells: HeatmapCell[]; maxCount: number; enabled: boolean; }
export type NetworkEdgeBasis = 'session_cooccur' | 'tag_overlap';
export interface NetworkNode { capabilityId: CapabilityId; slug: Slug; name: string; size: number; isCenter: boolean; }
export interface NetworkEdge { source: CapabilityId; target: CapabilityId; weight: number; basis: NetworkEdgeBasis; }
export interface ProfileNetwork { nodes: NetworkNode[]; edges: NetworkEdge[]; thumbnailOnly: true; }
export interface WorkCard { capabilityId: CapabilityId; versionId: VersionId; slug: Slug; coverUrl: string | null; name: string; invocations: number | null; }
export interface ProfileWorksSlice { cards: WorkCard[]; hasMore: boolean; }
export interface CreatorProfile {
  creatorId: UserId; slug: Slug; sectionsOrder: ProfileSectionKey[];
  hero: ProfileHero; metrics: ProfileMetricsBand; density: ProfileDensitySlice;
  heatmap: ProfileHeatmap; network: ProfileNetwork; works: ProfileWorksSlice; heatmapEnabled: boolean;
}

// ===== 社交（B-34）=====
export interface FollowResult { creatorId: UserId; following: boolean; followersCount: number; }
export interface LikeResult { capabilityId: CapabilityId; liked: boolean; likesCount: number; }
```

---

## 6. SSE 说明（本域几乎不用）

本域端点**全部是同步聚合读**（GET）+ 社交写命令（POST/DELETE），**不产生 jobs、不开 SSE 流**：

- 工作台「加载中」（外壳首页-24）/ 个人主页「加载中」（主页-15）= **前端 skeleton 灰条占位**，由前端在等待 HTTP 响应时渲染，**不是 SSE、不是转圈**（脊柱硬规则①：聚合是快查、无耗时子任务、无 slow_hint）。
- 工作台**草稿条**展示的「结构化中 60%」进度（外壳首页-33）来自 `drafts.step_progress`（脊柱 §8 持久化），是**读快照**；真正的续传细粒度恢复发生在用户点回向导后，由该步对应的 **jobs 流 / structure 流**（脊柱 §5）下发 `state_snapshot` + 增量——那属于导入/提取/结构化/发布域契约，**不在本域**。
- 因此本域**不引入新 SSE event 类型**，沿用脊柱 §5 的 12 类（仅在草稿续传跳转后由其他域流承载）。

---

## 7. 功能点覆盖表

### 7.1 功能点 → 端点 / 表

| 功能点 | 名称 | 本域端点 | 涉及表 |
|---|---|---|---|
| **B-32** | 工作台聚合 API | `GET /dashboard/summary`、`/dashboard/metrics`、`/dashboard/token-trend`、`/dashboard/capabilities`、`/dashboard/drafts` | 读：`capabilities`、`capability_versions`、`publications`、`drafts`（脊柱）；usage 占位（不查）：`daily_capability_stats`、`daily_creator_consumers`、`daily_creator_llm_stats` |
| **B-33** | 个人主页聚合 API（全六分区 P0） | `GET /creators/{id}/profile`、`/creators/{id}/capabilities?byDensity`、`/creators/{id}/heatmap`、`/creators/{id}/network`、`/creators/{id}/works` | `creator_profiles`、`follows`、`likes`、`capabilities`、`capability_versions`、`publications`、`candidate_evidence`、`session_segments`、`creator_capability_cooccur`；usage 占位：`daily_capability_stats` |
| **B-34** | 社交 API（follows/likes，P1） | `POST/DELETE /creators/{id}/follows`、`POST/DELETE /capabilities/{id}/likes` | `follows`、`likes`、`creator_profiles`（冗余计数）、`idempotency_keys`（脊柱） |
| 关联 B-30 | 评审状态可见（作品墙过滤/回退、能力表拒绝态） | 体现于 `/dashboard/capabilities`（拒绝徽章/原因/重试）、`/creators/{id}/works`（过滤/回退） | `publications`（review_status/reject_reason）、`capabilities.current_version_id` |
| 关联 F-15 | 草稿条续传 | `/dashboard/drafts` | `drafts`（脊柱 §8） |

### 7.2 涉及的验收用例模块

| 模块 | 用例编号（本域覆盖） | 本期口径 |
|---|---|---|
| **外壳首页-**（工作台） | 08（摘要）、09（四卡环比）、10（趋势双口径）、11（能力表列项）、14（行内试用）、15（行内编辑）、16/17/18（草稿条/续传）、19（时间范围三档）、20（只对本人可见）、21（钱不外泄）、22（新账号空态）、23（无草稿空态）、24（加载占位不转圈）、25（失败带退路）、26（无消耗空态）、29（大数字环比）、30（续传不丢）、32（活跃消费者含匿名）、33/34（草稿条进度/多条不串台）、35（更多菜单） | usage 类（08/09/10/11/19/20/26/29/32）按占位「暂无数据/上线后填充」判过；试用类（14）按钮在+落「本期未开放」、运行态本期挂起；30/33/34 续传按 P0 真实验；20/21/25 只读/退路/不裸码照常 P0 验 |
| **主页-**（个人主页） | 01（六分区顺序）、02（Hero 六项+真实计数）、03（指标带四项）、04（总调用量只读不下钻）、05（密度榜前3）、06（展开更多）、07（逐条密度下钻 P1）、08（密度榜只读无管理）、09（热力图近半年只数量）、10（网络仅缩略无展开）、11（作品墙卡三项）、12（点卡进公开页）、13（访客同视图只读）、14（新账号各分区空态）、15（加载占位不转圈）、16（失败带退路不裸码）、17（分区局部失败不丢）、18（重导旧内容不丢）、19（Alpha 不污染公开口径）、20（关闭热力图）、21（大数社交计数）、22（封面缺图兜底）、23（被拒下架不上墙）、24（回退展示上一版）、25（无上传/草稿入口）、26（公开口径不串数） | usage 类（03/04/11/19/24/26）按占位判过；个人主页升格全六分区 P0（01/02/03/04/05/08/09/10/11 + 15/16 按 P0 验）；23/24（B-30 过滤/回退）去★待定按固定形态正式验 |

### 7.3 被改判 / 挂起的验收用例（本域 usage 占位与试用占位口径）

| 改判类型 | 本域涉及用例 | 本期判定 |
|---|---|---|
| **usage 置空/占位** | 外壳首页-08（摘要调用次数）、-09（本月消耗/活跃消费者卡）、-10（token 趋势）、-11（能力表本月调用/趋势/收益）、-19（时间切换 usage 部分）、-20（本月消耗/收益/token 趋势 usage 部分）、-26（无消耗趋势）、-29（大数字环比 usage 部分）、-32（活跃消费者含匿名）；主页-03（总调用量）、-04（总调用量只读不下钻 usage 值）、-11/-19/-24（作品墙调用次数）、-26（总调用量公开口径） | usage 字段返回 `null`+`placeholders["..."]="暂无数据 / 上线后填充"` 即过（非空错误、非裸转圈、非误导 0）；「数字与真实一致」断言**本期挂起**，记「依赖计量回流，随 usage 上线复测」；非 usage 维度（卡在不在、占位态规范、只读不下钻、计数真实）照常验 |
| **试用本期不做** | 外壳首页-14（能力表行内试用进运行态） | 改判：试用按钮存在且文案正确、点击落「本期未开放」占位、不进 runtime session 即过；「进入该能力运行态」**本期挂起**，记「随 Trial 上线单独验收」 |
| **个人主页升格全六分区 P0** | 主页-01~26 全部 | 由「最小公开页」升为全六分区 P0 必做：六分区逐项、顺序正确、网络仅缩略无展开（主页-10）、各项只读不下钻（主页-04/08）按 P0 验；其中 usage 类按上一行占位口径 |
| **STEP⑤ 固定（B-30 衔接）** | 主页-23（被拒下架不上墙）、主页-24（回退展示上一版） | 去★待定标注、按固定发布形态正式验：作品墙按 `review_status` 过滤/回退（§2.6），三处可见状态同步作为本期正式口径 |

---

## 8. 给合并校验的精炼摘要

**端点清单（method + path，14 个）**
- `GET /api/v1/dashboard/summary`（B-32，页头摘要）
- `GET /api/v1/dashboard/metrics`（B-32，四卡+环比）
- `GET /api/v1/dashboard/token-trend`（B-32，趋势双口径）
- `GET /api/v1/dashboard/capabilities`（B-32，能力表，cursor 分页）
- `GET /api/v1/dashboard/drafts`（B-32/F-15，草稿条，cursor 分页，返回 `Paginated<DraftView>`）
- `GET /api/v1/creators/{creatorId}/profile`（B-33，六分区主聚合）
- `GET /api/v1/creators/{creatorId}/capabilities?byDensity`（B-33，密度榜，cursor 分页）
- `GET /api/v1/creators/{creatorId}/heatmap`（B-33，热力图）
- `GET /api/v1/creators/{creatorId}/network`（B-33，能力网络缩略，session/tag 共现）
- `GET /api/v1/creators/{creatorId}/works`（B-33，作品墙，cursor 分页）
- `POST /api/v1/creators/{creatorId}/follows`（B-34，关注，Idempotency-Key scope `social.follow`）
- `DELETE /api/v1/creators/{creatorId}/follows`（B-34，取关，Idempotency-Key scope `social.unfollow`）
- `POST /api/v1/capabilities/{capabilityId}/likes`（B-34，点赞，Idempotency-Key scope `social.like`）
- `DELETE /api/v1/capabilities/{capabilityId}/likes`（B-34，取消点赞，Idempotency-Key scope `social.unlike`）

**表清单（新建 4 + 引用脊柱/他域若干）**
- 新建：`creator_profiles`、`follows`、`likes`、`creator_capability_cooccur`
- 引用（不重建）：`users`、`capabilities`、`capability_versions`、`publications`、`candidate_evidence`、`session_segments`、`drafts`、`idempotency_keys`、`jobs`；usage 读模型 `daily_capability_stats`、`daily_creator_consumers`、`daily_creator_llm_stats`（**DDL 真源在 70 域 §9.1 / B-36，本域只读占位、不建表**）

**SSE 事件清单**
- 本域**不新增 SSE event 类型、不开新流**（全部同步聚合读 + 社交写）。草稿条续传跳转后由 jobs/structure 流（脊柱 §5 的 12 类）承载，属其他域。

**引用到的脊柱共享类型（§9，import 不重定义）**
- `Id`、`UserId`、`CapabilityId`、`VersionId`、`Slug`、`TraceId`、`IsoDateTime`
- `Envelope<T>`、`Meta`（`placeholders` usage 占位 / `degraded`）、`PageMeta`、`Paginated<T>`、`PageQuery`
- `ErrorAction`、`ErrorEnvelope`（错误用例全映射 §3 分类表缺省 + action 五枚举）
- `DraftView`、`DraftStep`、`DraftStatus`（草稿条直接复用，`Paginated<DraftView>`）

**关键基线锚点（供交叉校验）**
- 社交写权限（§3、端点 11-14）= **`requireAuth`（任意已登录用户，非 creator-only）**，遵脊柱 §11.F（Codex#17）；与 10-auth §6.2「社交写→`requireAuth`」对齐，无「缺 creator 角色 → 403」社交写用例，未登录写 → `401 UNAUTHENTICATED + escalate`。
- 占位口径统一走脊柱 §2.2 `meta.placeholders[field]="暂无数据 / 上线后填充"`、值 `null`。
- 写命令（follows/likes 的 **POST 与 DELETE 都是写命令**）走脊柱 §4 幂等（**统一必带 `Idempotency-Key`**，固定 scope：POST=`social.follow`/`social.like`，DELETE=`social.unfollow`/`social.unlike`；行为矩阵回放首次结果、不重复增减计数；不因 DELETE 天然幂等而豁免 key，脊柱 §11.F）。
- 分页全 cursor（脊柱 §2.3），不返 total。
- 能力网络缩略 = session/tag 共现即时生成（`creator_capability_cooccur`），**不依赖 embedding / 不读 `capability_relations`（B-37 保持 P1）**。
- 作品墙 / 能力表拒绝态 = B-30 `publications.review_status` 过滤/回退（alpha_pending/published 上墙、被拒无上一版下架不上墙、被拒回退展示上一 published 版）。
- 活跃消费者口径冻结：`daily_creator_consumers` `COUNT(DISTINCT consumer_key)` 含匿名键、不可日聚合加和（本期占位）。

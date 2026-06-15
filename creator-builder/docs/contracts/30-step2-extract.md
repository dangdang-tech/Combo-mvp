# 30 · STEP② 提取（萃取候选）域契约

> **范围**：创作者中心主链路第 2 步「提取」。覆盖功能点 **B-22**（萃取 Job + 候选/证据落库 + 候选流）、**B-23**（萃取接入 API + 单候选重试）。
>
> **上游**：STEP① 导入产出去敏 `raw_snapshots`（新快照）+ 隶属该快照的 `session_segments`（段级真源，`(snapshot_id, content_hash)` 快照内去重）。本步以「某一个 snapshot」为输入。
> **下游**：STEP③ 选择（纯前端，从候选里选一个/全部，不写库）→ STEP④ 结构化（`POST /capabilities` 从选定候选建 draft 版本，worker 直读 `candidate_evidence / session_segments`）。
>
> **本文只写契约**：markdown + TS 类型片段 + SQL DDL，不写业务实现代码。TS 片段最终归集到 `src/shared/`（zod schema 即 OpenAPI 3.1 真源，本文为人读镜像，冲突以 zod 为准）；DDL 归 `src/infra/pg/migrations/`。
>
> **强制对齐脊柱**：本文 **import** `00-约定与状态机.md` 的全部约定，不重定义。具体引用：
> - 路由前缀 `/api/v1` + 复数资源 + 动作子路径（脊柱 §1）。
> - 成功包络 `Envelope<T>` / `Paginated<T>`、占位语义 `meta.placeholders`（脊柱 §2）。
> - 错误信封 `ErrorEnvelope`、`action` 五枚举、错误分类表缺省（脊柱 §3）——任何对外失败只出 `ErrorEnvelope`。
> - 写命令带 `Idempotency-Key` + 行为矩阵 + `idempotency_keys` 表（脊柱 §4）。
> - SSE 端点形态、首帧 `state_snapshot`、12 个 event 类型、Last-Event-ID 续传、心跳/done（脊柱 §5）。
> - jobs 状态机 + fencing 字段 + 写入带 `WHERE job_id=? AND fence_token=?`（脊柱 §6）。
> - `ProgressView` 形态 + 提取子任务标准序（脊柱 §7）。
> - 共享 TS 类型（脊柱 §9）：`Id/UserId/JobId/SnapshotId/CandidateId/TraceId/IsoDateTime`、`Envelope<T>`、`Meta`、`Paginated<T>`、`PageQuery`、`ErrorEnvelope`、`ErrorAction`、`JobType`、`JobStatus`、`JobView`、`ProgressView`、`SubtaskView`、`SubtaskStatus`、`SSEEventType`、`SSEStreamKind`、`SSEFrame`、`StateSnapshotPayload`、`DonePayload`。
> - **跨域共识硬规则（脊柱 §11，强制引用、不偏移）**：§11.A 受保护写入 CTE 模板（萃取 worker 写 candidates/evidence）、§11.B ErrorEnvelope 收紧 + `userMessage`（域内所有错误形态）、§11.C SSE 同源 Cookie 鉴权（job 流建流前 HTTP 失败）、§11.E 血缘约束注册表固定约束名（`uq_candidates_id_snapshot`、`fk_evidence_candidate_snapshot`、`fk_evidence_segment_snapshot`，依赖 20 域 `uq_session_segments_id_snapshot`）。
>
> **三条硬规则在本域的落地点**：
> 1. **永不裸转圈** —— 提取经 jobs + SSE 推「总进度 + 五项子任务清单 + 量化文案『已识别 3 / 9』 + 候选逐个浮现 + 占位骨架」；慢任务发 `slow_hint`；degraded 也给进度短语。落地于 §3 SSE。
> 2. **绝不裸露错误码** —— 整体失败出 `ErrorEnvelope`；单候选失败走 `item-appended`（status=`failed`）携人话错误副文（如「上游解析中断 · 段 5/9」），绝不裸 500/堆栈/英文。落地于 §2.1 触发、§3.4 失败行、§4 错误用例。
> 3. **已生成内容不丢** —— 每个候选 + 段级证据**逐项落库**；中断/超时/取消保留已识别候选；刷新/重连走 `state_snapshot` 恢复已识别清单与计数；单候选重试只动该行、不连坐。落地于 §3.2 snapshot、§5 DDL、§2.3 重试。

---

## 1. 域内资源与端点总览

| # | method + path | 作用 | 鉴权 | 幂等 | 功能点 |
|---|---|---|---|---|---|
| 1 | `POST /api/v1/snapshots/{snapshotId}/extract` | 对某去敏快照触发萃取 Job（入队，秒回 jobId） | 需登录（快照属主） | `Idempotency-Key`，scope=`extract.create` | B-22 / B-23 |
| 2 | `GET  /api/v1/extract-jobs/{jobId}/candidates` | 列某次萃取的候选（cursor 分页，追加流用 `asc`） | 需登录（job 属主） | 读，天然幂等 | B-22 / B-23 |
| 3 | `GET  /api/v1/candidates/{candidateId}` | 取单个候选详情（含 scope/reusability 摘要） | 需登录（候选属主） | 读，天然幂等 | B-22 |
| 4 | `GET  /api/v1/candidates/{candidateId}/evidence` | 列某候选的段级血缘证据（下钻，cursor 分页） | 需登录（候选属主） | 读，天然幂等 | B-22 |
| 5 | `POST /api/v1/candidates/{candidateId}/retry` | 单候选重试（失败行不阻塞其余，无连坐） | 需登录（候选属主） | `Idempotency-Key`，scope=`candidate.retry` | B-23 |

> SSE 端点不在本表单列：复用脊柱 §5 的 `GET /api/v1/jobs/{jobId}/events`（`kind=job`）。本域不新增 SSE 端点，只定义该流上「候选逐个浮现 / 失败行 / 计数」的 payload 形态（见 §3）。
>
> **路由说明**：触发用子资源 `/snapshots/{id}/extract`（对快照执行的领域命令，POST）。候选列表挂在 `/extract-jobs/{jobId}/candidates` 而非 `/snapshots/{id}/candidates`——因为 `(extract_job_id, slug)` 是去重键，「一次萃取 = 一个 job = 一批候选」，按 job 寻址与 fencing/重入队语义对齐（同一快照可被多次萃取，每次新 job 一批独立候选，互不串）。`extract-jobs` 是 `jobs`（type=extract）的别名视图前缀，鉴权口径同 `jobs`。

---

## 2. 端点详情

### 2.1 触发萃取 — `POST /api/v1/snapshots/{snapshotId}/extract`

对一份去敏快照发起萃取：建 `jobs(type=extract)` + BullMQ 入队（`jobId` 去重），**秒回 jobId**，此后耗时步骤全程走 SSE。worker 携 `snapshot_id` **只在该快照段集内聚类**（候选证据不跨快照，对齐提取-33），经 LLM Gateway 归纳 → `capability_candidates` + `candidate_evidence` 逐项落库 + XADD 候选流。

**鉴权**：登录态（Logto JWT）；`snapshotId` 必须属于当前用户（`raw_snapshots.owner_user_id = sub`），否则 `404 NOT_FOUND`（不暴露他人快照存在性）。

**请求**：
- Header：`Idempotency-Key: <uuid-v7>`（必填，scope=`extract.create`，见脊柱 §4）。
- Path：`snapshotId`。
- Body：可空 `{}`；可选 `options`（本期不开放任何可调参数，预留位，传了忽略）：

```typescript
// 请求 body（zod 镜像）
export interface ExtractCreateRequest {
  options?: {
    // 预留：草稿引擎选择（默认 'v3-singlepass'）。本期仅 schema，传值忽略、不报错。
    engine?: 'v3-singlepass' | 'crune-deterministic' | 'llm-oneshot';
  };
}
```

**响应**：`202 Accepted`，`Envelope<ExtractJobAccepted>`：

```typescript
export interface ExtractJobAccepted {
  jobId: JobId;
  snapshotId: SnapshotId;
  status: JobStatus;          // 入队即 'queued'
  // 前端拿到即连 SSE：GET /api/v1/jobs/{jobId}/events
  eventsUrl: string;          // "/api/v1/jobs/{jobId}/events"，前端直连，不裸转圈
}
```

```jsonc
// 202 示例
{
  "data": {
    "jobId": "018f9c...",
    "snapshotId": "018f9b...",
    "status": "queued",
    "eventsUrl": "/api/v1/jobs/018f9c.../events"
  },
  "meta": { "traceId": "018f9c-trace" }
}
```

**幂等行为**（脊柱 §4 行为矩阵，对齐提取-25「连点两次/刷新只跑一次」）：
- key 首次 → 取租约 → 建 job + 入队 → 落 `response_ref` → 202。
- key 重复 + hash 同 + 首次已完成 → 回放首次 202（同 jobId，**对前端透明**，不产生第二个萃取 job、不重复候选）。
- key 重复 + hash 同 + 首次仍在租约 → `423 RESOURCE_LOCKED` + `action:'wait'`。
- key 重复 + hash 不同 → `409 IDEMPOTENCY_CONFLICT`。
- BullMQ `jobId` 去重是第二道闸。

**错误用例**（缺省遵脊柱 §3.3，userMessage 必人话）：

| HTTP | code | retriable | action | 触发场景 / userMessage |
|---|---|---|---|---|
| 401 | `UNAUTHENTICATED` | false | `escalate` | 登录态失效。「登录态失效了，请重新登录。」 |
| 404 | `NOT_FOUND` | false | `change_input` | 快照不存在/非本人。「没找到对应的原始数据，可能已被删除。」 |
| 409 | `STATE_CONFLICT` | false | `change_input` | 快照仍在导入中/未就绪（无段可萃取）。「这份原始数据还没处理好，请稍候再提取。」 |
| 423 | `RESOURCE_LOCKED` | true | `wait` | 同 key 萃取在途。「这次提取正在进行，请稍候。」 |
| 409 | `IDEMPOTENCY_CONFLICT` | false | `none` | 同 key 不同 body（脊柱 §4）。 |

> **注**：「原始数据太少/太杂识别不出能力」**不是触发期错误**——触发成功仍 202，萃取跑完落「空态」由 SSE `done`（result 标注 `degraded`/空候选）+ 候选列表为空表达，前端渲染空态退路（提取-26）。不在触发时报错，避免「能不能提取」与「提取出几个」混淆。

---

### 2.2 列候选 — `GET /api/v1/extract-jobs/{jobId}/candidates`

列某次萃取产出的候选。供两类场景：(1) 提取完成后进入结果态拉全量（提取-24「离开再回来不重跑」）；(2) SSE 重连超窗后兜底对账。逐个浮现的实时增量走 SSE `item-appended`，不靠轮询本端点。

**鉴权**：登录态；`jobId` 必须 `type=extract` 且属本人，否则 `404`。

**请求**：`GET /api/v1/extract-jobs/{jobId}/candidates?cursor=&limit=20&order=asc`
- 分页：cursor 唯一（脊柱 §2.3），`PageQuery`。
- **`order` 默认 `asc`**（追加流：先识别的在前，与逐个浮现顺序一致，对齐提取-30「不发生内容跳变」）。
- 可选过滤 `status`（多值逗号分隔）：`?status=ready,failed`。默认返回全部状态（含 failed 行，对齐提取-17「失败行也在列表里」）。

```typescript
export interface CandidateListQuery extends PageQuery {
  status?: string; // "ready" | "failed" | "generating" 逗号分隔，缺省全部
}
```

**响应**：`200`，`Paginated<CandidateView>`。`CandidateView` 见 §6。

```jsonc
{
  "data": [
    {
      "id": "018f-c1",
      "extractJobId": "018f9c...",
      "snapshotId": "018f9b...",
      "status": "ready",
      "name": "港险资格打分器",
      "intent": "根据客户资料判断是否符合投保资格并打分",
      "slug": "hk-insurance-eligibility-scorer",
      "type": "core-workflow",
      "confidence": "high",
      "segmentCount": 18,
      "frequencyRatio": 0.86,
      "scopeCoherence": 0.91,
      "splitSuggested": false,
      "error": null,
      "retryCount": 0,
      "createdAt": "2026-06-15T10:00:01Z"
    },
    {
      "id": "018f-c7",
      "extractJobId": "018f9c...",
      "snapshotId": "018f9b...",
      "status": "failed",
      "name": "港险资格打分器",         // 失败行仍带已知名（来自聚类草稿），用于「! 名称 · 错误副文」
      "intent": null,
      "slug": "hk-insurance-eligibility-scorer-2",
      "type": null,
      "confidence": null,
      "segmentCount": null,
      "frequencyRatio": null,
      "scopeCoherence": null,
      "splitSuggested": null,
      "error": {                          // 人话错误副文（提取-17/18），非裸错误码（脊柱 §11.B）
        "code": "EXTRACT_UPSTREAM_TIMEOUT",  // 仅日志/告警/文案映射，UI 永不渲染
        "userMessage": "这一项没能识别出来，可点重试。",  // 唯一可展示人话
        "retriable": true,
        "action": "retry",
        "traceId": "018f-trace",
        "details": { "stuckAt": "段 5 / 9" }   // 渲染「上游解析中断 · 段 5/9」
      },
      "retryCount": 1,
      "createdAt": "2026-06-15T10:00:05Z"
    }
  ],
  "meta": {
    "traceId": "018f-trace",
    "page": { "nextCursor": null, "hasMore": false, "limit": 20, "order": "asc" },
    "confidenceSummary": { "high": 4, "med": 3, "low": 2 }  // 置信分布摘要（提取-12），仅本端点 meta 扩展
  }
}
```

> **`meta.confidenceSummary`**：底部置信分布（提取-12「高 4 / 中 3 / 低 2」）。仅统计 `status=ready` 的候选；三数之和 = ready 候选总数（与页面 ready 行数一致）。这是本端点对 `Meta` 的领域扩展（脊柱允许 meta 新增字段、向后兼容）。**计数不靠分页 total**（脊柱 §2.3）；它是萃取产出的稳定统计，与 SSE `done.total` 口径一致。

**错误用例**：401 `UNAUTHENTICATED` / 404 `NOT_FOUND`（job 非本人或非 extract 类型）。

---

### 2.3 单候选重试 — `POST /api/v1/candidates/{candidateId}/retry`

对一个 `status=failed` 的候选单独重新识别（提取-19）。**单项失败不阻塞其余、无连坐**（B-23 核心）：重试只针对该候选，复用原萃取 job 的 snapshot 段集（同一 `snapshot_id`），其余候选与勾选状态不受影响（提取-29）。

> **为什么重试不复用原 job 流（Codex#4）**：原萃取 job 跑完即终态（已发过 `done`、流已关闭、fence 已是终态上下文），**不能**在一个已 terminal 的 job 流后追加新结果——那会让前端永远收不到回填帧（`done` 后前端已关 EventSource、不再重连），也违反「`done` 是终止信号」的脊柱 §5.5 语义。故每次单候选重试**创建一个新的 retry job**（`jobs(type=extract)`，全新 `fence_token`、全新 SSE 流），结果经该 **retry job 的新 `eventsUrl`** 推回，而非原 job 流。retry job 是「重识别该候选」的最小作用域 job，与原萃取 job 仅共享只读输入（snapshot 段集），不共享 fence/流/终态。

**鉴权**：登录态；候选必须属本人，否则 `404`。

**请求**：
- Header：`Idempotency-Key: <uuid-v7>`（必填，scope=`candidate.retry`；**每个候选独立 key**，无连坐）。
- Path：`candidateId`。
- Body：空 `{}`。

**响应**：`202 Accepted`，`Envelope<CandidateRetryAccepted>`。重试是异步：该候选立刻转 `status=generating`；服务端**建一个新 retry job** 并秒回其 `retryJobId` + 全新 `eventsUrl`，前端**改连这条新流**收回填，结果以 `item-appended`（同 candidateId、status 更新）+ `done` 推回。**不在原萃取 job 的（已 terminal）流上追加任何帧。**

```typescript
export interface CandidateRetryAccepted {
  candidateId: CandidateId;
  extractJobId: JobId;       // 原萃取 job（候选归属、列表寻址用，只读引用）
  retryJobId: JobId;         // 本次重试新建的 job（type=extract，全新 fence/流）
  status: 'generating';      // 重试入队即 generating（行内进入「重试中」态）
  retryCount: number;        // 本次重试后的累计次数（达上限语义见下）
  eventsUrl: string;         // 新 retry job 流："/api/v1/jobs/{retryJobId}/events"（前端改连此流，非原 job 流）
}
```

> **前端续连**：前端拿到 `eventsUrl`（= retry job 流）立即连接，先收 `state_snapshot`（kind=job，含该候选当前 `generating` 态）再续 `item-appended`/`done`，全程不裸转圈（硬规则①）。回填到列表/卡片靠 `item.id == candidateId` 对位，与原萃取 job 流无关。

**状态流转（候选级，详见 §5.2）**：`failed → generating →（成功）ready /（再失败）failed`。

**重试语义与硬规则**：
- **逐项落库不丢**：重试 worker 用脊柱 §11.A 受保护写入（fence 取自**新 retry job**），只改该 candidate 行、其余候选与证据原样保留（硬规则③）；fence 不匹配写 0 行、干净退出（见 §5.1/§5.2 受保护写入模板）。
- **再次失败仍落带退路失败态**（提取-20）：重试再失败 → 回 `failed` + 仍带人话 `error`（脊柱 §11.B 收紧形态：`userMessage` + `action`，UI 不渲染 `code`）+ `action:'retry'`，**不停在转圈、不裸错误码**。
- **重试上限**：服务端跟踪 `retry_cnt`。同一处重试达上限（默认 2，对齐脊柱「LLM 调用重试 ≤2」与「同处两次仍失败落 escalate」）后，再次调用本端点仍 202 受理（仍建新 retry job），但若再失败，`error.action` 升级为 `escalate`（「转人工 / 反馈」带 traceId），retriable 仍可由前端决定是否再点。

**幂等行为**（脊柱 §4）：
- key 首次 → 受理重试 → 202。
- key 重复 + hash 同 + 在途 → `423` + `wait`。
- key 重复 + hash 同 + 已完成 → 回放该次 202（不重复入队）。
- key 重复 + hash 不同 → `409 IDEMPOTENCY_CONFLICT`。

**错误用例**：

| HTTP | code | retriable | action | 场景 / userMessage |
|---|---|---|---|---|
| 404 | `NOT_FOUND` | false | `change_input` | 候选不存在/非本人。「没找到这一项，可能已刷新。」 |
| 409 | `STATE_CONFLICT` | false | `none` | 候选已是 `ready`（无需重试）。「这一项已经识别成功了，无需重试。」 |
| 423 | `RESOURCE_LOCKED` | true | `wait` | 该候选重试在途。「这一项正在重试，请稍候。」 |
| 502 | `EXTRACT_UPSTREAM_TIMEOUT` | true | `retry` | （异步落 SSE/列表 `error`，非同步响应）上游不稳。「这一项没能识别出来，可点重试。」 |

---

### 2.4 候选详情 / 证据下钻（B-22 血缘）

#### `GET /api/v1/candidates/{candidateId}`
取单候选详情（`CandidateView` 全量，§6）。供结果态展开卡或选择步带详情用。鉴权同上。错误：401 / 404。

#### `GET /api/v1/candidates/{candidateId}/evidence`
列该候选的段级血缘证据（提取-34「频次条段数 = 下钻段条数」、提取-31「证据是去敏后内容、不出现隐私原文」）。cursor 分页，`order` 默认 `asc`。

**响应**：`200`，`Paginated<CandidateEvidenceView>`：

```typescript
export interface CandidateEvidenceView {
  id: Id;                    // candidate_evidence.id
  candidateId: CandidateId;
  segmentId: Id;             // 指向 session_segments（某 snapshot 下具体段）
  snapshotId: SnapshotId;    // 该段所属快照（可回溯，证据不跨快照）
  // 段级摘要（去敏后；绝不返回未去敏原文，对齐提取-31）
  title: string | null;      // 段标题/会话标题
  source: string | null;     // 来源标记（如 'claude' | 'codex'），用于来源色标
  quote: string | null;      // 去敏后的代表性片段（手机号/密钥已抹除）
  happenedAt: IsoDateTime | null; // 会话发生时间（热力图/新近度）
  project: string | null;    // 项目归属（跨项目信号）
}
```

> **血缘一致性约束**：本端点返回条数（跨页累加）= `CandidateView.segmentCount` = 频次条段数（提取-34）。`segmentCount` 由 `candidate_evidence` 行数派生（落库时同事务回填，见 §5.1），保证「频次条 18 段 ↔ 下钻 18 条」不漂。
>
> **去敏防线**：`quote` 取自 `session_segments` 的去敏正文（导入期已去敏，原文不落盘）。萃取链路只读去敏段，候选证据天然不含隐私原文（提取-31，无需本端点二次脱敏，但 CI 守门断言 quote 不含手机号/密钥模式）。

**错误用例**：401 / 404。

---

## 3. SSE 事件（候选逐个浮现 · 计数 · 占位骨架 · 失败行）

> 复用脊柱 §5 的 job 流：`GET /api/v1/jobs/{jobId}/events`，`kind=job`（`{jobId}` 为原萃取 job 或单候选重试新建的 retry job，见 §2.3）。事件源 = Redis Streams `events:job:{jobId}`（worker `XADD`）。本域只规定该流上各帧的 payload 形态，帧格式（`id:`/`event:`/`data:`）、Last-Event-ID 续传、心跳/done 全遵脊柱 §5。
>
> **SSE 鉴权遵脊柱 §11.C（Codex#5）**：job 流统一**同源 Cookie 会话鉴权**，禁 query-string token；鉴权/权限（非本人/非 extract 类型 job）失败必须在**建流之前**返 HTTP `ErrorEnvelope`（`401 UNAUTHENTICATED`/`403 FORBIDDEN`，`action:'escalate'`），**绝不**用 SSE `error` 帧表达鉴权失败（`error` 帧只表达已建流后的业务失败终态）。

### 3.1 本域用到的事件类型

| event | 何时发 | 本域 payload 要点 | 对应硬规则 / 验收 |
|---|---|---|---|
| `state_snapshot` | 连接首帧 / 重连超窗 | `kind:'job'` + `progress` 全量（含已追加候选摘要 `items[]` + 计数 `done/total`） | ①③ 提取-23/24，刷新已识别不丢 |
| `progress` | 总进度推进 + 计数更新 | `{ percent, phrase:"已识别 3 / 9 能力项…", done, total, unit:"能力项" }` | ① 提取-07/21，计数实时、有进展感 |
| `subtask` | 五项子任务依次点亮 | `{ subtasks: SubtaskView[] }` 或单条 `{ key, status }` | ① 提取-03 |
| `item-appended` | 每识别出一个候选 / 失败行 / 重试结果 | `{ item: CandidateItem }`（含 `status`、`isNew`，失败时含人话 `error`） | ①③ 提取-04/05/06/17/19 逐个浮现、失败行、重试回填 |
| `slow_hint` | 整体偏慢 | `{ phrase, elapsedMs }` 进度短语 | ① 提取-21，degraded 也给短语、不裸转圈 |
| `error` | 整体失败终态 | `ErrorEnvelope`（人话 + 退路） | ② 提取-22，整体失败不裸错误码 |
| `done` | 任务终止（completed/failed/cancelled） | `{ status, result?: { candidateCount, degraded }, error? }` | 终止信号，前端关流 |
| `heartbeat` | 周期保活（15s） | `{ ts }` | ① 连接活着 |

> 本域**不使用** `field_*` 帧（那是结构化域 STEP④ 的字段流）。逐个浮现用连字符 `item-appended`（对齐验收「逐个浮现」措辞）。

### 3.2 state_snapshot（kind=job）— 刷新/重连恢复已识别清单

连接首帧恒为 `state_snapshot`。本域 `progress` 全量内含**已识别候选摘要 `items[]`** 与**计数 `done/total`**，前端据此重置 UI：已识别卡片原样回显、计数对得上、未识别位渲染占位骨架（提取-23/06），不打回从头重扫。

```jsonc
id: 1718450000-0
event: state_snapshot
data: {
  "kind": "job",
  "progress": {
    "percent": 55,
    "phrase": "已识别 5 / 9 能力项…",
    "done": 5, "total": 9, "unit": "能力项",
    "subtasks": [
      { "key": "analyze", "label": "分析会话段落",       "status": "done" },
      { "key": "cluster", "label": "聚类相似工作流",     "status": "done" },
      { "key": "form",    "label": "形成候选能力",       "status": "running" },
      { "key": "score",   "label": "评估频率与可打包度", "status": "pending" },
      { "key": "rank",    "label": "按成功率排序",       "status": "pending" }
    ],
    "items": [
      { "id": "018f-c1", "status": "ready",  "name": "港险资格打分器", "confidence": "high", "type": "core-workflow", "segmentCount": 18, "isNew": false },
      { "id": "018f-c7", "status": "failed", "name": "保单条款比对器", "error": { "code": "EXTRACT_UPSTREAM_TIMEOUT", "userMessage": "这一项没能识别出来，可点重试。", "retriable": true, "action": "retry", "traceId": "018f-t", "details": { "stuckAt": "段 5 / 9" } }, "isNew": false }
    ],
    "slow": false
  }
}
```

### 3.3 提取子任务标准序（脊柱 §7，对齐提取-03）

五项，依次点亮（`pending → running → done/failed`）：

| key | label（人话，对齐验收逐字） |
|---|---|
| `analyze` | 分析会话段落 |
| `cluster` | 聚类相似工作流 |
| `form` | 形成候选能力 |
| `score` | 评估频率与可打包度 |
| `rank` | 按成功率排序 |

### 3.4 候选逐个浮现 / 失败行 / 重试回填 — `item-appended`

**首次萃取期间**（原萃取 job 流）：每识别出一个候选 XADD 一帧 `item-appended`，前端追加一张卡（提取-04/05）。失败候选也走 `item-appended`（`status:'failed'` + 人话 `error`），渲染为「! 名称 · 错误副文」失败行 + 行内重试（提取-17/18）。原萃取 job 发完所有候选即 `done`、流终止。

**单候选重试回填**（新 retry job 流，**非原萃取 job 流**，Codex#4）：重试在**新 retry job 的 SSE 流**上推回填——原萃取 job 已 terminal（`done` 已发、流已关），**不在其上追加任何帧**。前端连 `CandidateRetryAccepted.eventsUrl`（= retry job 流），收 `item-appended`：重试成功发一帧 `status:'ready'`（同 candidateId），前端原地把失败行替换为正常卡（提取-19）；重试再失败发一帧 `status:'failed'`（提取-20）；该 retry job 随后 `done`、流终止。回填靠 `item.id == candidateId` 对位（跨流、与原萃取 job 无关）。

```jsonc
// 新识别一个候选（带「刚识别出」角标）
id: 1718450003-0
event: item-appended
data: { "item": {
  "id": "018f-c3", "status": "ready", "isNew": true,
  "name": "短视频脚本生成器", "intent": "按选题与受众生成口播脚本",
  "type": "recurring", "confidence": "med", "segmentCount": 9, "scopeCoherence": 0.74, "splitSuggested": false
}}

// 失败行（人话错误副文，不裸错误码；脊柱 §11.B：userMessage 唯一可展示，code 仅日志/映射、UI 不渲染）
id: 1718450007-0
event: item-appended
data: { "item": {
  "id": "018f-c7", "status": "failed", "isNew": true, "name": "保单条款比对器",
  "error": { "code": "EXTRACT_UPSTREAM_TIMEOUT", "userMessage": "这一项没能识别出来，可点重试。", "retriable": true, "action": "retry", "traceId": "018f-t", "details": { "stuckAt": "段 5 / 9" } }
}}

// 单候选重试成功后回填（同 id，status 变 ready）
id: 1718450050-0
event: item-appended
data: { "item": {
  "id": "018f-c7", "status": "ready", "isNew": false, "name": "保单条款比对器",
  "type": "occasional", "confidence": "low", "segmentCount": 6, "error": null
}}
```

`CandidateItem`（SSE `item-appended` 与 `state_snapshot.progress.items[]` 共用的轻摘要，见 §6）。

### 3.5 计数与终止

- **计数**（提取-07/08）：`progress.done/total` = 已识别/总数，`phrase` 形如「已识别 3 / 9 能力项…」。`total` 在聚类成型（`form` 子任务）后确定并稳定；`done` 单调不倒退（脊柱 §7）。完成时 `done==total`。
- **slow_hint**（提取-21）：整体偏慢发 `slow_hint` + 进度短语，前端保持「在做什么、到哪一步」信号，不裸转圈；degraded（LLM 不稳）同样给短语、不停服（脊柱 §10）。
- **done.result**（提取-08/26）：

```jsonc
id: 1718450099-0
event: done
data: { "status": "completed", "result": { "candidateCount": 9, "readyCount": 7, "failedCount": 2, "analyzedSegments": 215, "degraded": false } }
```

  - 正常完成：`result.candidateCount > 0`，前端进结果态、渲染结果横幅「已分析 215 段原始数据，识别出 9 个能力项…」（`analyzedSegments` 供横幅段数）。
  - **空态**（提取-26）：`status:'completed'` 但 `result.candidateCount == 0` → 前端渲染空态 + 「回去多导入一些历史再试」退路，**不是错误、不裸转圈、不给空列表配可点下一步**。
  - **整体失败**（提取-22）：先发 `error`（`ErrorEnvelope`，见 §4），再发 `done`（`status:'failed'`，`error` 同体），前端落带退路错误态。

---

## 4. 错误用例汇总（映射脊柱 §3 分类）

> 域内错误 code 命名 `EXTRACT_*` / `CANDIDATE_*`，扩展自脊柱分类表，**action/retriable 缺省遵脊柱**，userMessage 必中文人话、禁含 HTTP 状态/堆栈/英文报错（CI 守门）。

| 场景 | HTTP | code | retriable | action | 人话 userMessage |
|---|---|---|---|---|---|
| 未登录 / 登录失效 | 401 | `UNAUTHENTICATED` | false | `escalate` | 登录态失效了，请重新登录。 |
| 快照/候选不存在或非本人 | 404 | `NOT_FOUND` | false | `change_input` | 没找到对应内容，可能已被删除或刷新。 |
| 快照未就绪（导入未完成、无段可萃取） | 409 | `EXTRACT_SNAPSHOT_NOT_READY` | false | `change_input` | 这份原始数据还没处理好，请稍候再提取。 |
| 候选已 ready 仍调重试 | 409 | `CANDIDATE_ALREADY_READY` | false | `none` | 这一项已经识别成功了，无需重试。 |
| 同 key 萃取/重试在途 | 423 | `RESOURCE_LOCKED` | true | `wait` | 这次提取正在进行，请稍候。 |
| 幂等 key 复用于不同 body | 409 | `IDEMPOTENCY_CONFLICT` | false | `none` | （通常对前端透明，见脊柱 §4） |
| 上游 LLM 超时/不稳（整体或单候选） | 502 | `EXTRACT_UPSTREAM_TIMEOUT` | true | `retry` | 提取暂时没能完成，请稍后重试。（单候选：这一项没能识别出来，可点重试。） |
| 萃取任务整体超时 | 504 | `EXTRACT_JOB_TIMEOUT` | true | `retry` | 这一步超时了，可重试或稍后再看。 |
| 依赖恢复中（db/redis/minio/llm 网关降级） | 503 | `DEPENDENCY_UNAVAILABLE` | true | `wait` | 系统正在恢复，请稍候再试。 |
| 同处重试 2 次仍失败 | （沿用 502 的 error） | `EXTRACT_UPSTREAM_TIMEOUT` | true | `escalate` | 这一项多次没能识别出来，可反馈给我们。（带 traceId） |
| 服务内部异常 | 500 | `INTERNAL` | true | `retry` | 服务开小差了，请重试。（绝不带 500/堆栈进 userMessage） |

> **整体失败 vs 单候选失败的边界**（B-23 无连坐核心）：
> - **整体失败**（job 级，如快照读取失败、聚类阶段崩）→ SSE `error` + `done(failed)`，前端整页错误态（提取-22）。
> - **单候选失败**（某候选 LLM 没出/超时）→ **不影响 job 状态**，job 仍可 `completed`；失败候选以 `status=failed` + 人话 `error` 落库 + `item-appended` 推送（提取-17/29），前端只在该行显示失败 + 行内重试，其余候选正常可勾选、可进下一步。

---

## 5. DDL（PostgreSQL，Phase 0 正确性决策落地）

> 主键 UUID v7（`gen_uuid_v7()`，脊柱 §1.3）。**worker/sweeper 写入全程遵脊柱 §11.A「受保护写入规范模式」**：fence 校验内联进单条事务 CTE 的数据源（`... FROM jobs WHERE id=:jobId AND fence_token=:fence AND status='running'`），**禁止「先 SELECT 校验、再独立 INSERT/UPDATE」两步写法**（TOCTOU 窗口）。`jobs` 表见脊柱 §6.3（本域萃取 = `jobs.type='extract'`，不重复建表）。血缘约束（复合唯一键 + 复合 FK）固定约束名遵脊柱 §11.E 注册表。

### 5.1 capability_candidates（萃取候选）

```sql
CREATE TABLE capability_candidates (
  id              uuid        PRIMARY KEY DEFAULT gen_uuid_v7(),
  extract_job_id  uuid        NOT NULL REFERENCES jobs(id),           -- 所属萃取 job（type=extract）
  snapshot_id     uuid        NOT NULL REFERENCES raw_snapshots(id),  -- 候选来源快照（证据不跨快照，提取-33）
  owner_user_id   uuid        NOT NULL REFERENCES users(id),          -- 冗余属主，鉴权/列表过滤免 join

  -- 状态机（候选级，逐项落库不连坐）
  status          text        NOT NULL DEFAULT 'generating', -- generating|ready|failed
  error           jsonb,                                     -- 失败时 ErrorEnvelope.error（人话，非堆栈）；ready 时 NULL
  retry_cnt       int         NOT NULL DEFAULT 0,            -- 单项重试次数（B-23），达上限升级 action=escalate

  -- 候选身份与展示（来自聚类草稿 DraftCandidate）
  slug            text        NOT NULL,                      -- 去重键组成，URL 安全；建能力时可继承
  name            text,                                      -- 中文能力名（草稿，可改）；失败行也可有名
  intent          text,                                      -- 一句话描述（结果态行内副文）
  type            text,                                      -- core-workflow|recurring|occasional（提取-10）
  confidence      text,                                      -- high|med|low（提取-09 徽章 / -12 分布）

  -- 频率/可打包信号（确定性算出，提取-11/12/34）
  segment_count   int,                                       -- 支撑段数 = candidate_evidence 行数（频次条口径，提取-11/34）
  frequency_ratio numeric(4,3),                              -- 0~1，段数/最大段数（频次条相对高低）
  reusability     numeric(4,3),                              -- 0~1，overall 可复用分（排序用，提取-08「按成功率排序」）
  scope_coherence numeric(4,3),                              -- 0~1，范围一致度（低=建议拆分）
  split_suggested boolean      NOT NULL DEFAULT false,       -- scope_coherence 低于阈值 → 建议拆分
  scope           jsonb,                                     -- {language,domain,input_type,scale,preconditions[],out_of_scope[]}
  reusability_breakdown jsonb,                               -- {frequency,crossProject,recency,timeCost} 明细（可选展示）

  -- 时间戳
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  -- Phase 0 去重键：一次萃取内 slug 唯一（同一 job 不产重复候选，对齐提取-32 计数不翻倍）
  CONSTRAINT uq_candidate_job_slug UNIQUE (extract_job_id, slug),
  -- 血缘复合唯一键（脊柱 §11.E 注册表，供 candidate_evidence 复合 FK 引用）：
  --   保证「证据的候选 + 快照配套」在 schema 层焊死，DB 杜绝「候选属快照 A、证据伪填快照 B」
  CONSTRAINT uq_candidates_id_snapshot UNIQUE (id, snapshot_id),
  CONSTRAINT ck_candidate_status   CHECK (status IN ('generating','ready','failed')),
  CONSTRAINT ck_candidate_type     CHECK (type IS NULL OR type IN ('core-workflow','recurring','occasional')),
  CONSTRAINT ck_candidate_conf     CHECK (confidence IS NULL OR confidence IN ('high','med','low'))
);

-- 列候选（按 job，追加流 asc，created_at + id 做 cursor）
CREATE INDEX idx_candidates_job        ON capability_candidates (extract_job_id, created_at, id);
-- 属主维度（鉴权/草稿工作台）
CREATE INDEX idx_candidates_owner      ON capability_candidates (owner_user_id, created_at DESC);
-- 状态过滤（?status=ready,failed）
CREATE INDEX idx_candidates_job_status ON capability_candidates (extract_job_id, status);
```

> **去重键 `(extract_job_id, slug)`（Phase 0 决策）**：去重作用域是「一次萃取」，不是跨快照/跨用户全局（对齐技术方案 §4 `session_segments` 的快照内去重哲学）。同一快照可多次萃取 → 每次新 `extract_job_id` 一批独立候选，互不串（提取-33）。底层段已在导入快照层去重，萃取基于去重后段，候选不重、计数不翻倍（提取-32）。
>
> **受保护写入（脊柱 §11.A，Codex#3）**：worker 写候选**不得**用「先查 `jobs.fence_token` 再 INSERT」两步，**必须**用 §11.A 模板 2——把 fence 校验内联进 INSERT 的数据源（`extract_job_id` 即本表的 job 血缘列，支撑 fence 守门）：
>
> ```sql
> -- 受保护 INSERT 候选（fence 守门 + 业务去重键叠加，§11.A 模板 2）
> INSERT INTO capability_candidates (id, owner_user_id, extract_job_id, snapshot_id, status, slug, /* … */)
> SELECT gen_uuid_v7(), :ownerUserId, j.id, :snapshotId, 'generating', :slug, /* … */
> FROM jobs j
> WHERE j.id = :jobId
>   AND j.fence_token = :fence
>   AND j.status = 'running'
> ON CONFLICT (extract_job_id, slug) DO NOTHING;  -- fence 守门 + (extract_job_id, slug) 去重叠加
> -- 应用层：rowCount=0 ⇒ 已被 fence out（或去重命中），正常控制流、干净退出本 attempt、不报错不重试。
> ```
>
> sweeper 重入队后旧 worker fence 不匹配 → 数据源 `SELECT` 命中 0 行 → 写 0 行 → 不产生重复候选/不覆盖新执行（脊柱 §11.A/§6 铁律、技术方案 B-10）。取消萃取（脊柱 §6.1）换 fence → 已落候选保留（硬规则③）。写候选 `status/error/segment_count` 等后续 UPDATE 同遵 §11.A：fence 经 `jobs` 联表内联校验（模板 3 思路，`extract_job_id` 为联表键），不两步。
>
> **`segment_count` 口径**：= 该候选 `candidate_evidence` 行数，落库时同事务回填（见 5.2），保证频次条段数 == 下钻证据条数（提取-34）。单候选重试成功重算证据时在同事务内一并更新，不漂。

### 5.2 candidate_evidence（候选 ← 段级血缘）

```sql
CREATE TABLE candidate_evidence (
  id            uuid        PRIMARY KEY DEFAULT gen_uuid_v7(),
  candidate_id  uuid        NOT NULL,                                  -- 候选（复合 FK 带 snapshot_id 配套，见下）
  segment_id    uuid        NOT NULL,                                  -- 指向某 snapshot 下具体段（复合 FK 带 snapshot_id 配套，提取-34）
  snapshot_id   uuid        NOT NULL REFERENCES raw_snapshots(id),     -- 该段所属快照（证据不跨快照；由两条复合 FK 共同钉死同源）
  created_at    timestamptz NOT NULL DEFAULT now(),

  -- Phase 0 血缘去重：同一候选不重复挂同一段（频次段数诚实、不翻倍，提取-32/34）
  CONSTRAINT uq_evidence_candidate_segment UNIQUE (candidate_id, segment_id),

  -- 血缘复合 FK（脊柱 §11.E 注册表，固定约束名，不得改名/弱化为单列 FK）：
  --   证据的「候选 + 快照」必须配套 → DB 杜绝「候选属快照 A、证据伪填快照 B」
  CONSTRAINT fk_evidence_candidate_snapshot
    FOREIGN KEY (candidate_id, snapshot_id)
    REFERENCES capability_candidates (id, snapshot_id) ON DELETE CASCADE,
  --   证据的「段 + 快照」必须配套 → DB 杜绝「段属快照 B、证据伪填快照 A」
  CONSTRAINT fk_evidence_segment_snapshot
    FOREIGN KEY (segment_id, snapshot_id)
    REFERENCES session_segments (id, snapshot_id)
);

-- 证据下钻（按候选列，asc，与 segment_count 一致）
CREATE INDEX idx_evidence_candidate ON candidate_evidence (candidate_id, created_at, id);
-- 反查：某段被哪些候选引用（增量/调试）
CREATE INDEX idx_evidence_segment   ON candidate_evidence (segment_id);
```

> **段级血缘（B-22 核心 / 信任货币）**：每条证据回溯到「某 snapshot 下具体段」（`segment_id` + 冗余 `snapshot_id`）。萃取 Job 携 `snapshot_id`、只在该快照段集内聚类 → 证据天然不跨快照（提取-33）。`candidate_evidence` 行数 = `segment_count` = 频次条段数 = 下钻条数（提取-11/34，一处真源）。
>
> **schema 层焊死血缘（脊柱 §11.E / Codex#2）**：`candidate_evidence` 不再用单列 FK（`candidate_id→candidate(id)`、`segment_id→segment(id)`），而是两条**复合 FK**（固定约束名 `fk_evidence_candidate_snapshot` / `fk_evidence_segment_snapshot`），分别把「候选 + 快照」「段 + 快照」配套钉死。被引用侧的复合唯一键由 30 域（`capability_candidates` 的 `uq_candidates_id_snapshot`）与 20 域（`session_segments` 的 `uq_session_segments_id_snapshot`，**本表复合 FK 依赖 20 域提供该唯一键**）提供。两条复合 FK 共同约束 `snapshot_id` 同源，DB 层杜绝「证据跨快照 / 候选段不同源」，证据血缘可回溯到具体 snapshot（B-22 信任货币）。`candidate_id` 的级联删由 `fk_evidence_candidate_snapshot` 的 `ON DELETE CASCADE` 承载（候选清理时证据随删，不留孤儿血缘）。
>
> **隐私防线（提取-31）**：`segment_id` 指向的 `session_segments` 是导入期去敏后的段（原文不落盘）。证据下钻 `quote` 取去敏正文，不含手机号/密钥原文。萃取链路只读去敏段，隐私不外泄。
>
> **`ON DELETE CASCADE`**（落在复合 FK `fk_evidence_candidate_snapshot` 上）：候选被清理（如重萃覆盖、草稿放弃）时证据随删，不留孤儿血缘。重试**不删候选行**（只改 status/重算证据），故 CASCADE 不影响重试语义。
>
> **重试时的证据更新（受保护写入，脊柱 §11.A）**：单候选重试成功 → **同一事务**内 `DELETE` 该候选旧证据 + 重新 `INSERT` + 回写 `capability_candidates.segment_count`，保证血缘与频次条一致、不出现「频次 18 段但下钻 5 段」（提取-34）。fence 取自**新 retry job**（非原萃取 job），写入**不得**用「先查 fence 再写」两步，须把 fence 校验内联进事务数据源（§11.A 模板 3 思路，经 `jobs` 联表校验 retry job 的 `fence_token` + `status='running'`）；fence 不匹配 → 命中 0 行 → 旧 worker 干净退出、不改证据、不改 `segment_count`。重写证据 INSERT 仍受复合 FK（`fk_evidence_candidate_snapshot`/`fk_evidence_segment_snapshot`）约束，重试也不能写出跨快照证据。

---

## 6. 域内 TS 类型片段

> 归集到 `src/shared/`（与脊柱 §9 共享类型同目录，zod schema 即 OpenAPI 真源；下为人读镜像）。import 脊柱 §9 类型，不重定义 `Id/JobId/SnapshotId/CandidateId/Envelope/Paginated/PageQuery/ErrorEnvelope/JobStatus/SubtaskView` 等。

```typescript
import type {
  Id, JobId, SnapshotId, CandidateId, TraceId, IsoDateTime,
  Envelope, Paginated, PageQuery, ErrorEnvelope, JobStatus,
} from '../shared';

// ---------- 枚举 ----------
export type CandidateStatus = 'generating' | 'ready' | 'failed';
export type CapabilityType  = 'core-workflow' | 'recurring' | 'occasional'; // 提取-10
export type Confidence      = 'high' | 'med' | 'low';                        // 提取-09/12

// ---------- 候选适用范围（来自聚类，证据画像；详见 raw-to-capability scope）----------
export interface CandidateScope {
  language?: string;          // 'zh' | 'en' | 'mixed'
  domain?: string;            // 垂类，如 'SaaS路演'
  inputType?: string;         // '录音' | '代码仓库' | '文档' | '截图'
  scale?: string;             // '早期' | '30-60min' | '单文件'
  preconditions?: string[];   // 必须为真才能跑
  outOfScope?: string[];      // 已知不适用
}
export interface ReusabilityBreakdown {
  frequency?: number;         // 0~1
  crossProject?: number;      // 0~1
  recency?: number;           // 0~1
  timeCost?: number;          // 0~1
}

// ---------- 候选全量视图（GET .../candidates 列表项 & GET /candidates/{id} 单体）----------
export interface CandidateView {
  id: CandidateId;
  extractJobId: JobId;
  snapshotId: SnapshotId;
  status: CandidateStatus;
  name: string | null;            // 失败行也可有名（来自聚类草稿）
  intent: string | null;
  slug: string;
  type: CapabilityType | null;    // failed 时可为 null
  confidence: Confidence | null;
  segmentCount: number | null;    // 频次条段数 = 证据行数（提取-11/34）
  frequencyRatio: number | null;  // 0~1
  reusability: number | null;     // 0~1，排序用
  scopeCoherence: number | null;  // 0~1
  splitSuggested: boolean | null;
  scope: CandidateScope | null;
  reusabilityBreakdown?: ReusabilityBreakdown | null;
  error: ErrorEnvelope['error'] | null; // failed 时人话错误（提取-17/18），非堆栈
  retryCount: number;
  createdAt: IsoDateTime;
}

// ---------- 候选轻摘要（SSE item-appended & state_snapshot.progress.items[]）----------
export interface CandidateItem {
  id: CandidateId;
  status: CandidateStatus;
  isNew?: boolean;                // 「刚识别出」角标（提取-05）
  name: string | null;
  intent?: string | null;
  type?: CapabilityType | null;
  confidence?: Confidence | null;
  segmentCount?: number | null;
  scopeCoherence?: number | null;
  splitSuggested?: boolean | null;
  error?: ErrorEnvelope['error'] | null; // failed 行人话错误副文
}

// ---------- 段级证据视图（GET /candidates/{id}/evidence）----------
export interface CandidateEvidenceView {
  id: Id;
  candidateId: CandidateId;
  segmentId: Id;
  snapshotId: SnapshotId;
  title: string | null;
  source: string | null;          // 来源色标
  quote: string | null;           // 去敏后片段（提取-31，不含隐私原文）
  happenedAt: IsoDateTime | null;
  project: string | null;
}

// ---------- 请求 / 响应包络 ----------
export interface ExtractCreateRequest {
  options?: { engine?: 'v3-singlepass' | 'crune-deterministic' | 'llm-oneshot' };
}
export interface ExtractJobAccepted {
  jobId: JobId;
  snapshotId: SnapshotId;
  status: JobStatus;
  eventsUrl: string;
}
export interface CandidateRetryAccepted {
  candidateId: CandidateId;
  extractJobId: JobId;       // 原萃取 job（候选归属/列表寻址，只读引用）
  retryJobId: JobId;         // 本次重试新建的 job（type=extract，全新 fence/流）
  status: 'generating';
  retryCount: number;
  eventsUrl: string;         // = "/api/v1/jobs/{retryJobId}/events"（新流，非原 job 流）
}
export interface CandidateListQuery extends PageQuery {
  status?: string;                // "ready,failed"
}

// 列候选 meta 扩展：置信分布摘要（提取-12）
export interface ConfidenceSummary { high: number; med: number; low: number; }

export type ExtractCreateResponse   = Envelope<ExtractJobAccepted>;
export type CandidateRetryResponse  = Envelope<CandidateRetryAccepted>;
export type CandidateDetailResponse = Envelope<CandidateView>;
export type CandidateListResponse   = Paginated<CandidateView> & {
  meta: { confidenceSummary?: ConfidenceSummary };
};
export type CandidateEvidenceResponse = Paginated<CandidateEvidenceView>;

// done.result（萃取完成产物摘要，SSE done payload 的 result）
export interface ExtractDoneResult {
  candidateCount: number;         // 0 → 空态（提取-26）
  readyCount: number;
  failedCount: number;
  analyzedSegments: number;       // 结果横幅段数（提取-08）
  degraded: boolean;              // LLM degraded 完成（脊柱 §10）
}
```

---

## 7. 功能点覆盖表

### 7.1 功能点 → 端点 / 表 / SSE

| 功能点 | 名称 | 端点 | 表 | SSE | 验收模块 |
|---|---|---|---|---|---|
| **B-22** | 萃取 Job + 候选/证据落库 + 候选流（携 snapshot_id 只在该快照段集聚类） | `POST /snapshots/{id}/extract`（建 job）、`GET /extract-jobs/{jobId}/candidates`、`GET /candidates/{id}`、`GET /candidates/{id}/evidence` | `capability_candidates`、`candidate_evidence`（+ 复用 `jobs` type=extract、`raw_snapshots`、`session_segments`） | `state_snapshot`、`progress`（计数）、`subtask`（五项）、`item-appended`（逐个浮现/失败行）、`slow_hint`、`done` | 提取- |
| **B-23** | 萃取接入 API + 单候选重试（失败行不阻塞其余、无连坐；重试建新 retry job + 新流，Codex#4） | `POST /snapshots/{id}/extract`、`POST /candidates/{id}/retry`（建新 retry job，返回 `retryJobId`+新 `eventsUrl`） | `capability_candidates`（`status/error/retry_cnt`）、`jobs`（新建 retry job type=extract）、`idempotency_keys`（脊柱 §4，scope=`extract.create` / `candidate.retry`） | `item-appended`（重试回填 ready/再失败 failed，**在新 retry job 流**）、`error`（整体失败） | 提取- |

### 7.2 涉及的验收用例模块

**模块：提取-**（提取-01 ～ 提取-34，本域全覆盖）。关键映射：

| 验收用例 | 本契约落点 |
|---|---|
| 提取-01/02 发起进加载态、策略文案 | `POST .../extract` 202 + `eventsUrl` 立连，不空白页 |
| 提取-03 五项子任务依次点亮 | SSE `subtask`，标准序 analyze→cluster→form→score→rank（§3.3） |
| 提取-04/05/06 逐个浮现 + 「刚识别出」角标 + 占位骨架 | SSE `item-appended`（`isNew`） + `progress.done/total`（未识别位渲染骨架） |
| 提取-07/08 计数实时 + 结果横幅 | `progress.phrase「已识别 3/9」` + `done.result.{candidateCount,analyzedSegments}` |
| 提取-09/10/11/12 行字段组合 / 类型 / 频次条 / 置信分布 | `CandidateView`（name/confidence/type/segmentCount/frequencyRatio）+ `meta.confidenceSummary` |
| 提取-13 识别多于展示只展前 N | 前端展示策略；后端 `candidateCount` 全量 + cursor 分页支撑前 N |
| 提取-14/15/16/28/29 勾选 / 主按钮动态 / 不带 0 项 / 带入下一步 / 失败不阻塞 | 纯前端选择态（STEP③）；本域保证 `status=ready` 行可勾选、failed 行不入选 |
| 提取-17/18 失败行 + 人话错误副文 | `CandidateView.error` / `CandidateItem.error`（人话 + `details.stuckAt`） |
| 提取-19/20 行内重试 / 重试再失败仍带退路 | `POST /candidates/{id}/retry`（建新 retry job + 新 `eventsUrl`）+ 新 retry job 流上 `item-appended` 回填；§2.3 重试上限/escalate |
| 提取-21 慢任务有进展感 | SSE `slow_hint` + 持续 `progress`/`subtask`（§3.5） |
| 提取-22 整体失败带退路不裸码 | SSE `error`（`ErrorEnvelope`）+ `done(failed)`（§4） |
| 提取-23/24 刷新/重连已识别不丢、不重跑 | `state_snapshot(job)` 含 `items[]`+计数（§3.2）；`GET .../candidates` 兜底 |
| 提取-25 连点/刷新只跑一次 | 幂等 `Idempotency-Key` scope=`extract.create`（脊柱 §4）+ BullMQ jobId 去重 |
| 提取-26 空态可操作退路 | `done.result.candidateCount==0` + 候选列表空（非错误、非裸转圈） |
| 提取-27 底栏步数文案 | 纯前端；后端无关 |
| 提取-30 内容不跳变 | 候选 `order=asc` 稳定排序 + 落库即定值（加载态=结果态同源） |
| 提取-31 证据去敏不出隐私原文 | `candidate_evidence` 只挂去敏 `session_segments`；`quote` 去敏正文（§5.2） |
| 提取-32 去重不翻倍 | `(extract_job_id, slug)` + `(candidate_id, segment_id)` 双去重键（§5.1/5.2） |
| 提取-33 重导新快照不串、旧可查 | 候选/证据带 `snapshot_id`，只在该快照段集聚类；每次萃取独立 job（§5.1） |
| 提取-34 频次段数血缘可追溯 | `segment_count` = `candidate_evidence` 行数 = 下钻条数（§5.1/5.2/§2.4） |

**贯穿-** 相关（断点续传/幂等/不裸转圈/不丢，跨域共用脊柱机制，本域承接）：贯穿-22（断线续传到真实状态，靠 `state_snapshot`）、贯穿-27（双标签页不重复，靠幂等键）。

**接口-** 相关：本域端点的契约一致性（包络/错误信封/分页/幂等）由脊柱 §2/§3/§4 统一守门，本域不另立口径。

---

## 8. 返回精炼摘要（供合并校验）

**端点清单（method + path）**
1. `POST /api/v1/snapshots/{snapshotId}/extract` — 触发萃取（202，幂等 scope=`extract.create`）
2. `GET  /api/v1/extract-jobs/{jobId}/candidates` — 列候选（cursor，order=asc，`meta.confidenceSummary`）
3. `GET  /api/v1/candidates/{candidateId}` — 候选详情
4. `GET  /api/v1/candidates/{candidateId}/evidence` — 段级血缘下钻（cursor）
5. `POST /api/v1/candidates/{candidateId}/retry` — 单候选重试（202，幂等 scope=`candidate.retry`，无连坐）。**返回新建 retry job 的 `retryJobId` + 新 `eventsUrl`**（不复用原萃取 job 的已 terminal 流，Codex#4）。

（SSE 复用脊柱 `GET /api/v1/jobs/{jobId}/events`，kind=job，不新增端点；`{jobId}` 可为原萃取 job 或单候选 retry job）

**表清单（DDL）**
- `capability_candidates` —— 去重键 `(extract_job_id, slug)`；**血缘复合唯一键 `uq_candidates_id_snapshot UNIQUE (id, snapshot_id)`**（脊柱 §11.E，供 evidence 复合 FK 引用）；`status/error/retry_cnt`（单项重试）；`type/confidence/segment_count/frequency_ratio/reusability/scope_coherence/split_suggested/scope`；含 `snapshot_id`（不跨快照）+ `owner_user_id`（鉴权）；三索引（job 追加流 / owner / job+status）。
- `candidate_evidence` —— 血缘去重键 `(candidate_id, segment_id)`；**两条血缘复合 FK（脊柱 §11.E 固定约束名）`fk_evidence_candidate_snapshot (candidate_id, snapshot_id)→capability_candidates(id, snapshot_id) ON DELETE CASCADE`、`fk_evidence_segment_snapshot (segment_id, snapshot_id)→session_segments(id, snapshot_id)`**（替代原单列 FK，schema 层焊死证据血缘回溯到具体 snapshot）；`snapshot_id` 仍单列 FK→`raw_snapshots`；两索引（候选下钻 / 段反查）。
- 复用（不新建）：`jobs`（type=extract，脊柱 §6.3，fencing；单候选重试新建一条 retry job）、`idempotency_keys`（脊柱 §4）、`raw_snapshots`、`session_segments`（导入域，**须带 §11.E `uq_session_segments_id_snapshot (id, snapshot_id)` 唯一键供本域复合 FK 引用**）。

**SSE 事件清单（job 流 payload）**
`state_snapshot`（kind=job，含 `items[]`+计数，恢复已识别）、`progress`（计数「已识别 3/9」）、`subtask`（五项：analyze/cluster/form/score/rank）、`item-appended`（候选逐个浮现 / 失败行 / 重试回填，payload=`CandidateItem`；**重试回填在新 retry job 流，非原萃取 job 流**）、`slow_hint`、`error`（`ErrorEnvelope`，脊柱 §11.B 收紧形态 `userMessage`+`action`）、`done`（result=`ExtractDoneResult`，空态/完成/失败）、`heartbeat`。本域不用 `field_*`。SSE 鉴权遵 §11.C 同源 Cookie、建流前 HTTP 失败。

**引用到的脊柱共享类型（§9，import 不重定义）**
`Id`、`JobId`、`SnapshotId`、`CandidateId`、`TraceId`、`IsoDateTime`、`Envelope<T>`、`Meta`、`Paginated<T>`、`PageQuery`、`ErrorEnvelope`、`ErrorAction`、`JobType`（extract）、`JobStatus`、`JobView`、`ProgressView`、`SubtaskView`、`SubtaskStatus`、`SSEEventType`、`SSEStreamKind`（job）、`SSEFrame<P>`、`StateSnapshotPayload`、`DonePayload`。

**新增域内类型**：`CandidateStatus`、`CapabilityType`、`Confidence`、`CandidateScope`、`ReusabilityBreakdown`、`CandidateView`、`CandidateItem`、`CandidateEvidenceView`、`ExtractCreateRequest`、`ExtractJobAccepted`、`CandidateRetryAccepted`、`CandidateListQuery`、`ConfidenceSummary`、`ExtractDoneResult`。

**新增错误 code（扩展脊柱分类，action/retriable 遵缺省）**：`EXTRACT_SNAPSHOT_NOT_READY`(409/change_input)、`CANDIDATE_ALREADY_READY`(409/none)、`EXTRACT_UPSTREAM_TIMEOUT`(502/retry，单项可升 escalate)、`EXTRACT_JOB_TIMEOUT`(504/retry)。复用脊柱：`UNAUTHENTICATED`/`NOT_FOUND`/`RESOURCE_LOCKED`/`IDEMPOTENCY_CONFLICT`/`DEPENDENCY_UNAVAILABLE`/`INTERNAL`。

**功能点覆盖**：B-22（萃取 Job + 候选/证据 + 候选流）、B-23（萃取 API + 单候选重试）。验收模块：提取-（01～34 全覆盖）+ 贯穿-22/27 + 接口-（口径随脊柱）。

**本轮共识修订（Codex 对抗，供合并校验）**
- **Codex#2 / §11.E（对外影响约束名）**：`candidate_evidence` 单列 FK → 两条复合 FK：`fk_evidence_candidate_snapshot (candidate_id, snapshot_id) → capability_candidates(id, snapshot_id) ON DELETE CASCADE`、`fk_evidence_segment_snapshot (segment_id, snapshot_id) → session_segments(id, snapshot_id)`。父表新增唯一键 `uq_candidates_id_snapshot UNIQUE (id, snapshot_id)`（本域 `capability_candidates`）。**依赖 20 域**提供 `uq_session_segments_id_snapshot UNIQUE (id, snapshot_id)`（否则 `fk_evidence_segment_snapshot` 无法建）——20 域须确认该唯一键存在，约束名不得偏离。
- **Codex#4（对外影响字段/语义）**：`POST /candidates/{id}/retry` 不再复用原萃取 job 的（已 terminal）流；改为**新建 retry job**（`jobs.type='extract'`，新 `fence_token`/新流）。`CandidateRetryAccepted` 新增字段 **`retryJobId: JobId`**，`eventsUrl` 改指 `/api/v1/jobs/{retryJobId}/events`（原 `extractJobId` 保留为只读引用）。重试回填帧在新 retry job 流，前端靠 `item.id == candidateId` 跨流对位。**对 70 域/sweeper 影响**：retry job 与普通 extract job 同 schema、同 fencing/重入队语义，无新表、无新 job type。
- **Codex#3 / §11.A（写入模式）**：萃取 worker 写 `capability_candidates`/`candidate_evidence` 改为 §11.A 受保护写入（fence 内联进单条事务 CTE 数据源 `FROM jobs WHERE id=:jobId AND fence_token=:fence AND status='running'`），禁两步「查后写」；`rowCount=0` 为正常控制流。重试写入 fence 取自新 retry job。纯文档/SQL DDL 约束，不改对外字段。
- **§11.B（错误形态对齐）**：域内所有错误对象人话字段统一为 **`userMessage`**（替代 `message`），`code` 仅日志/映射、UI 不渲染。错误用例表「人话 userMessage」列即 `userMessage`。
- **§11.C（SSE 鉴权对齐）**：job 流（含 retry job 流）统一同源 Cookie 鉴权，建流前 HTTP `ErrorEnvelope` 失败，不用 `error` 帧表鉴权失败。

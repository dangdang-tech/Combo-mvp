# 40 · STEP③④ 选择 + 结构化（域契约）

> **域范围**：功能点 **B-24**（从选定候选建能力体 draft 版本）、**B-25**（结构化 Job：软字段逐字段流 + 硬字段平台锁定，worker 直读 `candidate_evidence / session_segments`）、**B-26**(结构化接入 API + 单软字段重生成 + published 后 PATCH 强制新版本)。
>
> **本文只写契约**（markdown + TS 类型片段 + SQL DDL），不写业务实现代码。
>
> **强依赖脊柱**：本文严格 import `00-约定与状态机.md`（下称「脊柱」）的路由前缀、`Envelope<T>` / `Paginated<T>` 包络、`ErrorEnvelope` + action 五枚举 + 错误分类表缺省、`Idempotency-Key` 行为矩阵、SSE 帧协议（首帧 `state_snapshot`、12 个 event、Last-Event-ID 续传、心跳/done）、jobs 状态机 + fencing、`ProgressView`、drafts step 五枚举与 `structure_state` 字段级续传、§9 全部共享 TS 类型、健康检查口径。**凡脊柱已定义者本文不重定义、只引用并标注落点。**
>
> **三条硬规则在本域的落点**：
> 1. **永不裸转圈** —— 结构化耗时步骤经 `jobs(type=structure)` + Redis Streams 推「字段流（`field_start/field_delta/field_done`）+ 子任务进度短语『正在补全字段 4 / 6』+ 边生成边显示数组项」；偏慢发 `field_stuck`（三退路）/ `slow_hint`；连接首帧恒为 `state_snapshot(kind=structure)`。落于 §3 SSE、§4 端点 D。
> 2. **绝不裸露错误码** —— 单**软**字段两次重试仍失败落 `ErrorEnvelope`（脊柱 §11.B 收紧：UI 唯一可展示 = `userMessage` 人话 + `action` 三选一 retry/change_input/escalate；内部 `code=STRUCTURE_FIELD_FAILED` 仅日志/告警/映射、UI 永不渲染）；硬字段锁定不参与生成、不报字段级错误（`details.field` 恒 SoftFieldKey）。落于 §3.4、§4 各端点错误用例。
> 3. **已生成内容不丢** —— 每个软字段、每个数组项**生成完即落 `capability_versions.structure_state`**；中断/超时/取消/失败保留已完成字段；刷新/重连走 `state_snapshot(structure)` 精确回显（贯穿-28 只补未生成字段）；硬字段始终在。落于 §3.2、§5 DDL `structure_state`、§4 端点 D。

---

## 1. 域边界与 STEP③ 说明（选择切换不写库、无 API；保存草稿 / 进入下一步有 API：`PATCH /api/v1/drafts/{draftId}/selection`）

### 1.1 STEP③ 选择：选变不写库（即时无加载态），但可显式存草稿（精确续传）

STEP③（选择）UI：顶部「全部发布（不逐个选）」整体选项 + 「或逐个选定」单选互斥列表（每行四项：能力名称 / 一句话类型 / 支撑段数 / 置信度）。

**契约口径（对齐脊柱 §8 `select` 步 + PRD 第五章「每步可存草稿、精确续传」+ 验收 选择结构化-30）——区分两条路径**：

**(a) 选择变化 = 纯前端，不自动写库、即时无加载态**：
- 改选 / 切「全部发布」↔「逐个选」**全程纯向导状态，不调模型、不建任务、不产生能力体/上架记录、不自动写 `drafts.selection`**。每次点选**绝不触发网络往返、绝不裸转圈**（验收 选择结构化-30：选择切换即时响应）。
- 选择结果暂存在前端向导状态，在进入下一步（结构化 / 批量发布）时随该步请求体发出：
  - 逐个选 → 选中的 `candidateId` 作为 **STEP④ 入口端点 A**（`POST /capabilities`）的 `sourceCandidateId`（验收 选择结构化-07：右侧当前能力名称对得上）。
  - 全部发布 → 选中的 `candidateIds[]` 进入**发布域批量发布**（`POST /publish-batches`，见发布域契约 B-29；本域不覆盖）。

**(b) 保存草稿 / 进入下一步 = 持久化 selection（PRD「每步可存草稿」落地）**：
- 顶栏「保存草稿」按钮 → 调本域**端点 G**（`PATCH /api/v1/drafts/{draftId}/selection`，§4.G）把当前选择**显式持久化** `drafts.selection`（`{ mode, candidateId?, candidateIds? }`）+ `drafts.current_step='select'`，使工作台草稿条出现「选择中」、可断点续传回精确选择态。这是**用户显式动作或自动节流保存**，不是「每次点选写库」——避免选择步退化成有加载态的写操作。
- 进入下一步：端点 A（逐个选→建 version）/ 发布域批量发布（全部发布）在创建产物时，**同事务回填** `drafts.selection` + 推进 `drafts.current_step`（端点 A 还回填 `drafts.version_id`，见 §4.A），等价于「下一步提交也持久化 selection」，无需先单独存草稿。
- 续传恢复：工作台续传读 `drafts.current_step='select'` + `drafts.selection` → 回到 STEP③ 并按 `selection` 预置选择态（恢复 schema 见 §4.G `SelectionDraft`，前端据 `DraftView.selection` 渲染）。

> 验收映射：选择结构化-01~06、25、29、30、贯穿-15/16（草稿续传 / 已完成步回看，STEP③ 由端点 G + `DraftView.selection` 支撑）。选择结构化-29「全部发布逐个跑结构化与发布、不漏不重」在**发布域 B-29** 落地（本域只提供单条 version 的建立 + 结构化端点供其逐项复用）。

### 1.2 本域端点总览（STEP③ 存草稿 1 个 + STEP④ 结构化 5 个 + 1 个读 manifest）

| # | method + path | 说明 | 功能点 |
|---|---|---|---|
| G | `PATCH /api/v1/drafts/{draftId}/selection` | STEP③ 显式存草稿：持久化选择（`drafts.selection` + `current_step='select'`），供精确续传 | B-24（STEP③ 续传）|
| A | `POST /api/v1/capabilities` | 建能力体 draft 版本——三分支：①从候选新建首版 ②published 后建新版本（`capabilityId`）③被拒重发派生新 draft（`fromVersionId`，复制被拒版 manifest 软字段） | B-24/B-26 |
| B | `GET /api/v1/versions/{versionId}/manifest` | 读 manifest（软硬分层 + `structure_state` 快照，续传/回看用） | B-24/B-25/B-26 |
| C | `POST /api/v1/versions/{versionId}/structure` | 发起结构化 Job（软字段逐字段生成、硬字段锁定），返回 `jobId`；SSE 走 §3 | B-25/B-26 |
| D | `GET /api/v1/versions/{versionId}/structure/events` | 结构化字段流 SSE（首帧 `state_snapshot(structure)`） | B-25/B-12 |
| E | `PATCH /api/v1/versions/{versionId}/manifest` | 改单/多软字段（手动编辑）；published 后强制建新版本 | B-26 |
| F | `POST /api/v1/versions/{versionId}/manifest/fields/{field}/regenerate` | 单软字段重新生成（只重生成卡住/指定字段，其余不动） | B-26 |

> 端点 G 是 STEP③ 的**显式存草稿**通道（PRD「每步可存草稿」）；选择切换本身不调它（纯前端，§1.1(a)）。`drafts` 表属脊柱（§8.4），本域只新增对其 `selection` / `current_step` 的写语义，不重定义表。

> 取消结构化 Job 复用脊柱通用端点 `POST /api/v1/jobs/{jobId}/cancel`（B-11，本域不重定义，仅在 §4.C 标注语义：取消保留已生成字段）。job 流 SSE 通用端点 `GET /api/v1/jobs/{jobId}/events` 与 structure 流端点 D 同源（脊柱 §5.1 复用 + `kind` 区分），本域结构化 UI 推荐用端点 D（直接拿 `state_snapshot(structure)`）。

---

## 2. manifest 模型（App Identity 软硬分层）

> **取舍（对齐技术方案差异表第 5 条）**：manifest 是 App Identity 的**一等软硬分层结构**（不只是 UI 分组标记）：软字段经 LLM 逐字段生成、可改可重生成；硬字段平台锁定、不参与生成。落库为 `capability_versions.manifest`（单个 JSONB，扁平存全字段 + `__locked` 标记软硬归属，沿用扁平说明书结构，对齐验收 选择结构化-31），软硬只是**结构分组 + 锁定语义**，不拆两张表。`manifest_hash` 仅在发布步固化（本域 draft 不算 hash，发布域 B-27 负责）。

### 2.1 软字段（7 个，可改 / 可重生成，对齐技术方案行 39 + 验收 选择结构化-27/09）

| manifest key | 人话标签（界面/Figma） | 类型 | 生成形态 | 备注 |
|---|---|---|---|---|
| `name` | 名称 / 对外显示名称 | `string` | 单值流 | 必填，发布前不可空 |
| `tagline` | 一句话卖点 / 一句话定位 | `string` | 单值流 | 一句话 |
| `role` | 它扮演的角色 | `string` | 单值流 | — |
| `goal` | 它要达成的目标 | `string` | 单值流 | — |
| `instructions` | 工作步骤 / 说明（系统指令） | `string`（含运行时占位）| 单值流（可长）| **硬字段 `inputs.schema` 从此抽取**（§2.3） |
| `skill_set` | 拿手本事 / 技能集 | `string[]` | **数组逐项流** | 一条条补齐（验收 选择结构化-24、贯穿-07） |
| `starter_prompts` | 给消费者的起手示例 / 起手提示 | `string[]` | **数组逐项流** | 一条条补齐 |

### 2.2 硬字段（6 类，平台锁定 / 不参与生成 / 无加载条，对齐技术方案行 39 + 验收 选择结构化-11/27）

| manifest key | 人话标签 | 类型 | 取值 / 锁定语义 |
|---|---|---|---|
| `id` | 唯一标识 | `string`（= versionId 派生 / capabilityId）| 平台分配，锁定 |
| `version` | 版本号 | `string`（semver，见 §2.4）| 平台管理，锁定 |
| `status` | 当前状态 | `'draft'`（界面显示「未提交的草稿」）| draft 是硬字段（差异表第 5 条）；改软字段不改写它（验收 选择结构化-31） |
| `inputs.schema` | 运行时输入项（消费者要填什么）| `InputSchema`（见 §2.3）| **系统从 `instructions` 占位抽取**、随软字段指令更新、但本身锁定不可手改（验收 选择结构化-28） |
| `output.type` | 产出物形态 | `OutputType` 枚举（见 §2.3）| 平台锁定（本期默认形态，可由抽取推断但不可手改）|
| `boundaries` | 风险等级与红线 | `Boundaries`（见 §2.3）| 平台锁定 |

> 硬字段全程 `FieldStatus='locked'`（脊柱 §9），SSE 不对其发 `field_*` 帧、不显示加载条；`inputs.schema` 的「随 `instructions` 更新」是结构化 Job / PATCH 软字段时的**系统派生重算**（见 §4.E 派生规则），不是用户编辑、不破坏锁定语义。

### 2.3 硬字段内部结构（TS 片段）

```typescript
// 运行时输入项：系统从 instructions 占位抽取，锁定不可手改（验收 选择结构化-28）
export interface InputField {
  key: string;             // 占位键，如 "product_idea"
  label: string;           // 人话提示，如 "你想做的产品/功能，一句话是什么？"
  type: 'string' | 'text' | 'enum' | 'number';
  required: boolean;
  options?: string[];      // type=enum 时
  derivedFrom: 'instructions'; // 血缘标记：来自软字段 instructions 的抽取（非手填）
}
export interface InputSchema {
  fields: InputField[];
}

export type OutputType =
  | 'text'          // 文本产物（默认）
  | 'structured'    // 结构化文档（如 PRD）
  | 'score'         // 打分/评估结果
  | 'checklist';    // 核查清单
export interface OutputSpec {
  type: OutputType;
  // 本期形态固定，描述性字段平台默认，不暴露可编辑
}

export interface Boundaries {
  riskLevel: 'low' | 'medium' | 'high';
  redLines: string[];      // 红线条目（平台默认 + 可由抽取补充，锁定）
}
```

### 2.4 版本号语义（semver）

- `capability_versions.version` 为 **semver 字符串**（如 `0.1.0`）。首版 draft = `0.1.0`。
- **published 后 PATCH manifest 强制建新版本**（脊柱 §1.4 + B-26）：在已 published 的能力上改软字段 → 端点 E 返回 `409 STATE_CONFLICT`(`action:'change_input'`) 提示「需基于新版本编辑」，前端再调端点 A 的「建新版本」分支（`POST /capabilities` 带 `capabilityId` 复用已有能力体、bump minor → `0.2.0`，status=draft）。draft 态内 PATCH 不 bump、原地改。
- **被拒后「编辑重发」派生新 draft（`fromVersionId` 分支，B-26 / 50 §1.1 F-14）**：评审拒绝是终态（被拒版 `status='review_rejected'`、不可变）。创作者重发不就地改回被拒版，而是调端点 A 带 `fromVersionId=<被拒版>`：在**同一能力体**下复制被拒版 manifest 软字段、bump minor 建一条新 `draft`（原被拒版永久保留 `review_rejected` + `reject_reason`/`rejected_at` 作历史）。首发被拒（无上一 published 版）同样适用——`fromVersionId` 只校验「源版属本人且为 review_rejected」，不要求存在 published 版，故首发被拒也有派生路径，闭环成立。新 draft 再走 50 §1.2 发布事务即「被拒→派生新 draft→重新发布」全闭环。
- semver bump 规则本域约束「published→新 draft bump minor」与「review_rejected→派生新 draft bump minor」；major/patch 策略后续版本演进，本期不暴露给创作者手选。

### 2.5 manifest 完整 schema（TS 片段）

```typescript
import type { CapabilityId, VersionId } from '@/shared/ids';

export type SoftFieldKey =
  | 'name' | 'tagline' | 'role' | 'goal'
  | 'instructions' | 'skill_set' | 'starter_prompts';

export type HardFieldKey =
  | 'id' | 'version' | 'status' | 'inputs' | 'output' | 'boundaries';

export const SOFT_FIELD_KEYS: SoftFieldKey[] = [
  'name', 'tagline', 'role', 'goal', 'instructions', 'skill_set', 'starter_prompts',
];

// manifest（扁平存，软硬归属由 SOFT_FIELD_KEYS / 下列结构区分；落库沿用扁平结构，验收 选择结构化-31）
export interface Manifest {
  // —— 硬字段（平台锁定）——
  id: string;                         // = capabilityId（对外唯一标识）
  version: string;                    // semver，如 "0.1.0"
  status: 'draft';                    // 本域恒为 draft；发布步置 published（发布域）
  inputs: InputSchema;                // 从 instructions 抽取、锁定
  output: OutputSpec;                 // 锁定
  boundaries: Boundaries;             // 锁定
  // —— 软字段（可改 / 可重生成）——
  name: string;
  tagline: string;
  role: string;
  goal: string;
  instructions: string;
  skill_set: string[];
  starter_prompts: string[];
}

// manifest 视图（带软硬锁定标记，端点 B 返回，供前端一眼区分软硬，验收 选择结构化-09）
export interface ManifestView {
  versionId: VersionId;
  capabilityId: CapabilityId;
  slug: string;
  manifest: Manifest;
  locked: HardFieldKey[];             // = ['id','version','status','inputs','output','boundaries']
  structureState: StructureState;     // 字段级状态快照（脊柱 §9），续传/回看真源
}
```

---

## 3. SSE 字段流（kind=structure，B-25/B-12）

> 严格遵循脊柱 §5 帧协议：帧格式 `id:`(=Redis Stream entry id) / `event:` / `data:`；连接首帧恒为 `state_snapshot`；心跳默认 15s；终态 `done` 前端关流；Last-Event-ID 在窗内补增量、超窗先推 snapshot 再续。事件源 = Redis Streams `events:structure:{versionId}`。

### 3.1 首帧 state_snapshot(kind=structure)（硬规则①③落点）

连接建立 / 重连超窗后第一帧恒为 `state_snapshot`，`kind='structure'`，`payload.structureState` 为 `capability_versions.structure_state` 全量（每软字段状态 / 已生成值 / 卡住时长 + 硬字段 `locked` 值）。前端用它重置 UI：已生成字段直接显示终值、未生成显示加载条、硬字段锁定显示（贯穿-28：只补未生成、不打回已生成）。

```
id: 1718460000-0
event: state_snapshot
data: {"kind":"structure","structureState":{"versionId":"01J...","fields":[
  {"field":"name","status":"done","value":"需求炼金师"},
  {"field":"tagline","status":"done","value":"把一段杂乱想法，炼成结构清晰、可执行的 PRD。"},
  {"field":"role","status":"done","value":"..."},
  {"field":"goal","status":"done","value":"..."},
  {"field":"instructions","status":"generating","value":null},
  {"field":"skill_set","status":"pending","value":[]},
  {"field":"starter_prompts","status":"pending","value":[]},
  {"field":"id","status":"locked","value":"01J..."},
  {"field":"version","status":"locked","value":"0.1.0"},
  {"field":"status","status":"locked","value":"draft"},
  {"field":"inputs","status":"locked","value":{"fields":[...]}},
  {"field":"output","status":"locked","value":{"type":"structured"}},
  {"field":"boundaries","status":"locked","value":{"riskLevel":"low","redLines":[...]}}
],"doneCount":4,"totalCount":7}}
```

### 3.2 事件序列（正常生成，对齐 Figma generating 态 + 验收 选择结构化-10/24、贯穿-07）

> 软字段逐个生成、一项项蹦出来；数组字段（`skill_set` / `starter_prompts`）逐项补齐；子任务进度短语「正在补全字段 4 / 6」走 `progress`/`subtask`（脊柱 §7 结构化口径）。**仅对 7 个软字段发 `field_*`；硬字段不发**。

| event | payload 形态（本域具体化脊柱 §5.3）| 何时发 |
|---|---|---|
| `state_snapshot` | `{ kind:'structure', structureState }` | 首帧 / 超窗重连 |
| `field_start` | `{ field: SoftFieldKey, index, total: 7 }` | 某软字段开始生成 |
| `field_delta` | `{ field, deltaText }`（单值）/ `{ field, itemIndex, deltaText }`（数组项流）| 流式增量 |
| `field_done` | `{ field, value }`（已落 `structure_state`，单值 string / 数组 string[]）| 该字段完成 |
| `item-appended` | `{ field, itemIndex, value }` | 数组字段补齐一条（`skill_set`/`starter_prompts` 逐条浮现，验收 选择结构化-24）|
| `progress` | `{ percent, phrase:"正在补全字段 4 / 6", done:4, total:7, unit:"字段" }` | 字段计数推进 |
| `subtask` | `{ key:'fields', label:'正在补全字段', status:'running' }`（结构化以字段流为主，subtask 表整体进度）| 状态变化 |
| `field_stuck` | `{ field: SoftFieldKey, elapsedMs, options:['continue','regen','wait'] }` | 某**软**字段偏慢（§3.3；硬字段不发）|
| `slow_hint` | `{ phrase:"这一步比平时久了…", elapsedMs }` | 整体偏慢 |
| `error` | 完整 `ErrorEnvelope`（线上帧外形 `data: {"error": {...}}`，脊柱 §3.1/§5.3；§3.4 软字段级失败终态；内层 `error.details.field` ∈ SoftFieldKey）| 同处重试 2 次仍失败 |
| `done` | `{ status: JobStatus, result?:{ versionId, manifest }, error? }` | 任务终止 |
| `heartbeat` | `{ ts }`（或 `:hb`）| 每 15s |

```
id: 1718460010-0
event: field_start
data: {"field":"instructions","index":4,"total":7}

id: 1718460011-0
event: field_delta
data: {"field":"instructions","deltaText":"第一步，澄清用户想做的产品一句话…"}

id: 1718460012-0
event: field_done
data: {"field":"instructions","value":"第一步…；第二步…"}

id: 1718460013-0
event: field_start
data: {"field":"skill_set","index":5,"total":7}

id: 1718460014-0
event: item-appended
data: {"field":"skill_set","itemIndex":0,"value":"把模糊想法拆成结构化问题"}

id: 1718460015-0
event: item-appended
data: {"field":"skill_set","itemIndex":1,"value":"按 PRD 模板组织输出"}

id: 1718460016-0
event: field_done
data: {"field":"skill_set","value":["把模糊想法拆成结构化问题","按 PRD 模板组织输出","..."]}

id: 1718460020-0
event: progress
data: {"percent":86,"phrase":"正在补全字段 6 / 7","done":6,"total":7,"unit":"字段"}

id: 1718460099-0
event: done
data: {"status":"completed","result":{"versionId":"01J...","manifest":{...}}}
```

### 3.3 卡住三退路（field_stuck，硬规则①，验收 选择结构化-15~18、贯穿-08）

某软字段生成偏慢（超阈值）→ 发 `field_stuck`，`options:['continue','regen','wait']`，前端渲染三条人话退路（对齐 Figma toolong 态文案），**绝不裸转圈、不清掉已生成字段**：

| option | 含义 | 服务端动作 | 验收 |
|---|---|---|---|
| `continue`（用已生成的部分先继续，剩下手动填）| 放行进入后续编辑 / 下一步 | **纯前端动作，不回服务端**；已生成字段全带走，卡住字段留空可手填 | 选择结构化-16 |
| `regen`（只重生成卡住的字段）| 只重跑该字段 | 调端点 F（§4.F），仅该字段重生成；其余不动、不重跑 | 选择结构化-17、26 |
| `wait`（再等一会儿，后台继续跑）| 继续等待，页面其余可操作 | 不发请求，继续跟流；该字段后台跑完发 `field_done` | 选择结构化-18 |

> **字段级帧仅限软字段（SoftFieldKey）**：`field_stuck` / `error`（`STRUCTURE_FIELD_FAILED`）只对 7 个软字段发；硬字段（`id`/`version`/`status`/`inputs`/`output`/`boundaries`）平台锁定、不参与生成，故**永不发字段级卡住/失败帧**（验收 选择结构化-11/27）。

```
id: 1718460030-0
event: field_stuck
data: {"field":"instructions","elapsedMs":48000,"options":["continue","regen","wait"]}
```

### 3.4 同处重试两次失败 → 人话错误态（硬规则②，验收 选择结构化-19/20、贯穿-08 兜底）

对同一**软字段**（结构化 Job 内部重试 ≤2，或用户经端点 F `regen` 累计）**重试两次仍失败** → 该字段落终态错误，发 `error` 帧（**完整 `ErrorEnvelope`**，线上帧外形 `data: {"error": {...}}`，脊柱 §3.1/§5.3），内层 `error.code='STRUCTURE_FIELD_FAILED'`、`error.action` 三选一（`retry` / `change_input` / `escalate`，对齐 Figma「重试 / 改输入 / 转人工」）。**字段级失败只可能发生在 7 个软字段（`error.details.field` ∈ `SoftFieldKey`）**；硬字段锁定不生成、永不落字段级失败（验收 选择结构化-11/27）：

```
id: 1718460040-0
event: error
data: {"error":{"code":"STRUCTURE_FIELD_FAILED","userMessage":"这个字段没生成出来，可重试、改输入或转人工。","retriable":true,"action":"escalate","traceId":"01J...","details":{"field":"instructions","attempts":2}}}
```

- 线上帧外形是**完整 `ErrorEnvelope`**（`data: {"error": {...}}`，与 import/job 流 `error` 帧外形一致，脊柱 §3.1/§5.3）；内层 `error` 遵脊柱 §11.B 收紧：UI 唯一可展示 = `error.userMessage`（人话）+ `error.action`；`error.code='STRUCTURE_FIELD_FAILED'` 仅日志/告警/文案映射、UI 永不渲染；`error.traceId` 可作「反馈代码」展示。`error.details.field` ∈ `SoftFieldKey`。**DB 持久化**（`capability_versions.structure_state[field].error`）可继续存内层 `ErrorEnvelope['error']`，但 SSE 线上帧必须是完整信封。
- `userMessage` 人话、**禁含 500 / 堆栈 / ERR_xxx / 英文报错**（脊柱 §3.1 / §11.B 硬约束、验收 选择结构化-19）。
- 错误是**字段级**：其余已生成软字段 + 锁定硬字段全部保留（`structure_state` 不清，验收 选择结构化-20）。Job 整体不因单字段失败转 `failed`（除非全部失败或不可恢复）；字段级失败后 Job 可仍 `completed`，前端按 `structure_state[field].status='failed'` 渲染错误态 + 退路。
- 终止帧 `done` 在失败时 `status` 仍可为 `completed`（其余字段成功），`error` 字段携最后失败信息；整 Job 不可恢复才 `done.status='failed'`。

### 3.5 断线重连续传（脊柱 §5.4，验收 选择结构化-22、贯穿-10/28）

- 每帧 `id:` = Redis Stream entry id；客户端 `Last-Event-ID` 重连。
- 窗内 → 从该 id 后补增量（不重推 snapshot）；超窗 / 无 Last-Event-ID → 先推 `state_snapshot(structure)` 重置再续。
- 续传精度靠 `structure_state`：**已生成软字段原样回显、只补未生成字段、不打回加载条**（贯穿-28）。

---

## 4. 端点契约

> **鉴权分层（脊柱 §11.C 仅管 SSE、普通 HTTP 走 §6.2/§6.3 Bearer/Role+owner）**：
> - **普通 HTTP 端点（A/B/E/F/G 等本域全部非 SSE 端点）= `requireAuth` + `requireRole('creator')` + handler owner 校验**（Logto JWT，Cookie/Authorization 双来源，10-auth §6.2/§6.3；建/改能力体属创作者私有写读，须 creator 角色 + 该 version/draft 属 `ctx.userId`，非本人 `403 FORBIDDEN`）。
> - **唯一例外 = SSE 端点 D（`GET .../structure/events`）= 同源 Cookie-only**（脊柱 §11.C：EventSource 原生不支持自定义头，故 SSE 统一同源 Cookie、禁 query/header token、鉴权/权限失败建流前 HTTP 失败；详见 §4.D）。
>
> 写命令（POST/PATCH）必带 `Idempotency-Key`（脊柱 §4）。响应成功裹 `Envelope<T>`，失败只出 `ErrorEnvelope`（脊柱 §11.B 收紧：UI 唯一可展示 = `userMessage` 人话 + `action`，`error.code` 仅日志/告警/文案映射、UI 永不渲染）。下文各端点错误用例表「userMessage（人话）」列即 `userMessage`，action/retriable 遵脊柱 §3.3 缺省。

### 4.G `PATCH /api/v1/drafts/{draftId}/selection` — STEP③ 显式存草稿（持久化选择，B-24 续传）

**鉴权**：普通 HTTP — `requireAuth` + `requireRole('creator')` + handler owner 校验（草稿 owner 本人，10-auth §6.2/§6.3；Bearer JWT，非 SSE 不走 §11.C）。**幂等/并发**：必带 `Idempotency-Key`，scope=`draft.selection.patch`；同 `draftId` 重复保存覆盖即可（PATCH 局部更新语义，最后写赢；无需 `If-Match`，选择态本就以「最后一次保存」为准）。**用途**：仅 STEP③ 顶栏「保存草稿」按钮 / 前端节流自动保存调用；**选择切换本身不调本端点**（纯前端、即时无加载态，§1.1(a)）。

**请求 schema（zod 风格）**：

```typescript
// SelectionDraft = drafts.selection 的权威形态（持久化 + 续传恢复 schema）
export const SelectionDraft = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('single'),
    candidateId: z.string().uuid(),          // 逐个选：选中的候选
  }),
  z.object({
    mode: z.literal('all'),
    candidateIds: z.array(z.string().uuid()).min(1), // 全部发布：纳入批量的候选集合
  }),
]);
export const PatchSelectionBody = z.object({
  selection: SelectionDraft,
});
```

**响应** `200`：`Envelope<DraftView>`（脊柱 §9 `DraftView`，回 `currentStep='select'` + `selection` 全量，供前端确认已存草稿）。

**行为**：
- 校验 `draftId` 属当前 `ctx.userId`（非 owner → `403`）；校验 `selection` 内候选属同一来源快照 / 属本人（非法候选 → `404`/`400`）。
- 单 PG 事务写 `drafts.selection = :selection`、`drafts.current_step='select'`、`drafts.step_progress` 更新「选择中」短语、`updated_at=now()`。**不建任务、不调模型、不产生能力体**（与端点 A 区分：端点 G 只存选择草稿；端点 A 才建 version 并推进到 `structure`）。
- 续传：工作台续传读 `DraftView.currentStep='select'` + `DraftView.selection`（= `SelectionDraft`）→ 回 STEP③ 预置选择态（恢复 schema 即本端点 `SelectionDraft`，前端一一映射 single/all）。

**错误用例**：

| HTTP | code | retriable | action | userMessage（人话）|
|---|---|---|---|---|
| 400 | `VALIDATION_FAILED` | false | `change_input` | 「选择内容格式不对，重选一下再保存。」 |
| 403 | `FORBIDDEN` | false | `escalate` | 「你没有权限修改这个草稿。」 |
| 404 | `NOT_FOUND` | false | `change_input` | 「没找到对应草稿或候选，可能已被删除。」 |
| 409 | `IDEMPOTENCY_CONFLICT` | false | `none` | （key 复用于不同 body，对前端透明处理）|

> 端点 G 让 STEP③ 满足 PRD「每步可存草稿」：选择是纯前端即时态（不写库、无转圈，§1.1(a)），但用户按「保存草稿」或进入下一步会把 `selection` 持久化，工作台据此精确续传（贯穿-15/16）。

---

### 4.A `POST /api/v1/capabilities` — 从候选建能力体 draft 版本（B-24）

**鉴权**：普通 HTTP — `requireAuth` + `requireRole('creator')` + handler owner 校验（创作者本人，10-auth §6.2/§6.3；Bearer JWT，非 SSE 不走 §11.C）。**幂等**：必带 `Idempotency-Key`，scope=`capability.create`（同一候选/同一建新版本逻辑复用同 key；重复点 / 刷新只建一次，验收 选择结构化-08）。

**请求 schema（zod 风格）**：

```typescript
// 三种用途：①从候选新建能力体（首版）②在已 published 能力上建新 draft 版本（B-26 强制新版本）
//          ③从本人【被拒版】(review_rejected) 派生新 draft（被拒后「编辑重发」，§2.4 / 50 §1.1）
export const CreateCapabilityBody = z.object({
  sourceCandidateId: z.string().uuid().optional(),  // ①新建：来自 STEP③ 选中候选（验收 选择结构化-07）
  capabilityId: z.string().uuid().optional(),        // ②建新版本（published 后编辑）：复用已有能力体，§2.4
  fromVersionId: z.string().uuid().optional(),       // ③被拒重发：从本人 review_rejected 版复制 manifest 软字段派生新 draft（§2.4、50 §1.1 F-14）
  draftId: z.string().uuid().optional(),             // 可选：回填该草稿的 version_id（续传衔接）
}).refine(b => !!b.sourceCandidateId || !!b.capabilityId || !!b.fromVersionId,
  { message: '需指定来源候选、已有能力体或被拒版本' })
  .refine(b => !(b.sourceCandidateId && b.fromVersionId) && !(b.capabilityId && b.fromVersionId),
  { message: '来源候选 / 已有能力体 / 被拒版本三选一，不可同传' });
// 注：slug 由服务端从候选名/能力名生成（URL 安全、唯一、不可变），不由客户端传
// 注：fromVersionId 分支沿用被拒版所属 capabilityId（同能力体续命脉），bump minor 建新 draft；slug 不变
```

**响应 schema** `201`：

```typescript
export interface CreateCapabilityResult {
  capabilityId: CapabilityId;
  versionId: VersionId;          // 新建的 draft 版本
  slug: Slug;                    // 不可变业务 slug（首次创建定）
  version: string;               // semver，如 "0.1.0"（新建）/ "0.2.0"（建新版本 bump minor）
  manifest: Manifest;            // 初始 manifest：硬字段已锁定填充、软字段空待结构化
  structureState: StructureState;// 软字段全 pending、硬字段 locked
}
// → Envelope<CreateCapabilityResult>
```

**行为**（三分支，按入参判别）：
- **① `sourceCandidateId`（从候选新建首版）**：单 PG 事务建 `capabilities`(slug 唯一、不可变) + `capability_versions`(status=draft、空软字段 manifest)。`sourceCandidateId` 落 `capability_versions.source_candidate_id`（血缘）。
- **② `capabilityId`（published 后建新版本）**：校验该能力体属本人、当前 `current_version_id` 为 published，bump minor 建新 draft version（§2.4）。
- **③ `fromVersionId`（被拒重发派生，§2.4 / 50 §1.1 F-14）**：校验源版 `capability_versions.id=:fromVersionId` 属本人（经 `capabilities.creator_user_id` 验属主）且**源版 `status` 恰为 `review_rejected`**（非被拒态 → `409 STATE_CONFLICT`）；通过则在**源版所属同一 `capability_id`** 下 `INSERT` 一条新 `capability_versions`：复制源被拒版 `manifest` 的**软字段**为起点（硬字段按平台规则重锁、`status='draft'`、新 `version_id`、bump minor 版本号），`source_candidate_id` 沿用源被拒版的血缘值（可空）。**原 `review_rejected` 版不被触碰**——其 `status` / `reject_reason` / `rejected_at` 永久保留作历史（终态不可变，与 50 §1.1 铁律一致）。此分支是「被拒→派生新 draft→重新发布」闭环的派生端（重新发布由 50 §1.2 发布事务接收本分支产出的 draft）。
- 幂等回放：同 key + 同 hash + 已完成 → 回放首次 `CreateCapabilityResult`（不建第二条能力体/版本，验收 选择结构化-08、贯穿-27）。
- `draftId` 提供 → 同事务回填 `drafts.version_id = 新 versionId`、`drafts.current_step='structure'`，并把本次选择固化进 `drafts.selection`（候选来源时 `{ mode:'single', candidateId: sourceCandidateId }`；被拒重发时沿用源版选择血缘，「进入下一步也持久化 selection」，§1.1(b)，续传衔接，脊柱 §8）。

**错误用例**：

| HTTP | code | retriable | action | userMessage（人话）|
|---|---|---|---|---|
| 400 | `VALIDATION_FAILED` | false | `change_input` | 「输入有点问题：缺少来源候选、能力体或被拒版本，改一下再试。」 |
| 404 | `NOT_FOUND` | false | `change_input` | 「没找到对应的候选 / 版本，可能已被删除或链接失效。」（含 `fromVersionId` 指向不存在版本）|
| 403 | `FORBIDDEN` | false | `escalate` | 「你没有权限基于这个版本建新草稿。」（`fromVersionId` 非本人版本）|
| 409 | `IDEMPOTENCY_CONFLICT` | false | `none` | （key 复用于不同 body，对前端透明处理）|
| 409 | `STATE_CONFLICT` | false | `change_input` | 「当前版本状态不支持新建草稿：`capabilityId` 分支需已发布版本、`fromVersionId` 分支需被拒版本（review_rejected）。」 |
| 423 | `RESOURCE_LOCKED` | true | `wait` | 「这条正在被处理，请稍候。」（同 key 仍在租约中）|
| 502 | `LLM_UPSTREAM_FAILED` | true | `retry` | 「上游处理暂时不稳定，请稍后重试。」（slug 生成若依赖模型；通常不涉）|

---

### 4.B `GET /api/v1/versions/{versionId}/manifest` — 读 manifest（软硬分层 + structure_state）

**鉴权**：普通 HTTP — `requireAuth` + `requireRole('creator')` + handler owner 校验（创作者本人，10-auth §6.2/§6.3；Bearer JWT，非 SSE 不走 §11.C；published 版本另由市集只读端点 `GET /market/manifests/{versionId}` 服务，属发布/消费域，本端点为创作者编辑态读）。**幂等**：GET 天然幂等，无 Idempotency-Key。

**响应** `200`：`Envelope<ManifestView>`（见 §2.5）。

**用途**：续传 / 回看（贯穿-16 已完成步骤回看）/ 进结构化前读初始态 / SSE 断流兜底。`structureState` 为字段级真源，前端据此渲染软字段（done 显终值、generating/pending 显加载条、failed 显错误态）、硬字段（locked 显锁定）。

**错误用例**：

| HTTP | code | retriable | action | userMessage |
|---|---|---|---|---|
| 401 | `UNAUTHENTICATED` | false | `escalate` | 「登录态失效了，请重新登录。」 |
| 403 | `FORBIDDEN` | false | `escalate` | 「你没有权限查看这个能力。」 |
| 404 | `NOT_FOUND` | false | `change_input` | 「没找到对应版本，可能已被删除。」 |

---

### 4.C `POST /api/v1/versions/{versionId}/structure` — 发起结构化 Job（B-25/B-26）

**鉴权**：普通 HTTP — `requireAuth` + `requireRole('creator')` + handler owner 校验（本人，10-auth §6.2/§6.3；Bearer JWT，非 SSE 不走 §11.C）。**幂等**：必带 `Idempotency-Key`，scope=`structure.start`。同 version 重复发起回放同一 `jobId`（不重复跑、不重复字段，验收 选择结构化-26、贯穿-27）；已 running 的同 version 直接回放运行中 jobId。

**请求 schema**：

```typescript
export const StartStructureBody = z.object({
  fields: z.array(z.enum([
    'name','tagline','role','goal','instructions','skill_set','starter_prompts',
  ])).optional(),   // 不传 = 全部 7 软字段；传子集 = 仅生成这些（续传时只补未生成）
}).optional();
```

**响应** `202`：

```typescript
export interface StartStructureResult {
  jobId: JobId;               // type=structure
  versionId: VersionId;
  eventsUrl: string;          // = /api/v1/versions/{versionId}/structure/events（端点 D）
  structureState: StructureState; // 受理即回当前状态（已生成不丢）
}
// → Envelope<StartStructureResult>
```

**行为**：
- 建 `jobs(type=structure, subject_ref={versionId})` + BullMQ 入队（jobId 去重，脊柱 §6）。秒回 jobId，前端连端点 D 跟字段流。
- worker（B-25）**直接读 `candidate_evidence` + `session_segments`**（不依赖 ExperiencePack，避免依赖倒挂；萃取 Job 携 snapshot_id，证据不跨快照）经 LLM Gateway **逐字段生成软字段、锁定硬字段、`inputs.schema` 从 `instructions` 抽取**。
- **每字段 / 每数组项生成完即落 `capability_versions.structure_state`**（硬规则③）→ XADD 字段流。落库**必须用脊柱 §11.A 受保护写入模板 3**（单条事务 CTE，fence 经 jobs 联表内联进数据源 `... FROM jobs WHERE id=:jobId AND fence_token=:fence AND status='running' AND v.id=:versionId`），见下「受保护写入」。
- worker 写入遵脊柱 §11.A（收紧 §6.2 铁律）：所有写 `structure_state` / `manifest` 采用**单条事务 CTE**、fence 校验内联进同一条 SQL 的数据源，**禁止「先 SELECT 校验 fence、再独立 UPDATE」两步写法**（TOCTOU）。`rowCount=0` = 已被 fence out，是正常控制流（干净退出本 attempt、不报错、不重试），防旧执行覆盖、防重复字段。
- **取消**（复用 `POST /jobs/{jobId}/cancel`，B-11）：标 cancelled + 换 fence → 旧执行的受保护写入因 `status` 不再是 `running` 且 fence 不匹配命中 0 行 → 无法回写 → **已生成字段保留**（硬规则③、验收 选择结构化-16/22）。

**受保护写入（脊柱 §11.A 模板 3 实例，结构化 worker 写 `structure_state` / `manifest` 必照此）**：

```sql
-- 每字段/数组项落 structure_state（fence 经 jobs 联表内联，单条事务 CTE，无两步查写）
UPDATE capability_versions v
SET structure_state = :state, updated_at = now()
FROM jobs j
WHERE j.id = :jobId
  AND j.fence_token = :fence
  AND j.status = 'running'      -- 取消/重入队换 fence 或离开 running → 命中 0 行
  AND v.id = :versionId;        -- 产物经 job 联表校验 fence；rowCount=0 = 安全退出本 attempt
-- manifest 软字段落库同模式（SET manifest=:manifest），fence 三要素恒定 id+fence_token+status='running'。
```

**错误用例**：

| HTTP | code | retriable | action | userMessage |
|---|---|---|---|---|
| 404 | `NOT_FOUND` | false | `change_input` | 「没找到对应版本，可能已被删除。」 |
| 409 | `STATE_CONFLICT` | false | `change_input` | 「当前状态不支持结构化（如已发布需建新版本）。」 |
| 409 | `IDEMPOTENCY_CONFLICT` | false | `none` | （key 复用于不同 body）|
| 422 | `STRUCTURE_NO_EVIDENCE` | false | `change_input` | 「这个能力支撑的会话内容不足，回上一步换个候选或补充内容。」（candidate_evidence 为空）|
| 423 | `RESOURCE_LOCKED` | true | `wait` | 「结构化正在进行，请稍候。」 |
| 502 | `LLM_UPSTREAM_FAILED` | true | `retry` | 「上游处理暂时不稳定，请稍后重试。」 |
| 503 | `DEPENDENCY_UNAVAILABLE` | true | `wait` | 「系统正在恢复，请稍候再试。」 |

> LLM degraded 不停服（脊柱 §10）：worker 仍推进度短语 `slow_hint`、字段级失败按 §3.4 落 `STRUCTURE_FIELD_FAILED`，绝不裸转圈、绝不裸 502。

---

### 4.D `GET /api/v1/versions/{versionId}/structure/events` — 结构化字段流 SSE（B-25/B-12）

**鉴权（遵脊柱 §11.C，唯一权威）**：**同源 Cookie 会话**（与「Logto 自托管 · 同源 Cookie 会话」一致）。`EventSource` / `fetch-event-source` 自动携带同源会话 Cookie，中间件按脊柱 §11.C 校验后才建流。**禁 query-string token、禁自定义 header token 作主鉴权**（token 进访问日志/referer/历史，泄漏面大）。owner 校验同口径：该 version 必属当前 `ctx.userId`，否则建流前 `403`。

**协议**：见 §3（脊柱 §5）。`Content-Type: text/event-stream`，关代理缓冲，长读超时，支持 `Last-Event-ID` 头续传。首帧恒 `state_snapshot(kind=structure)`。终态发 `done` 前端关流。

**错误（遵脊柱 §11.C）**：**鉴权 / 权限失败必须在「建流之前」以普通 HTTP 返 `ErrorEnvelope`**——未登录 `401 UNAUTHENTICATED`（`action:'escalate'`）、非 owner `403 FORBIDDEN`（`action:'escalate'`）。**绝不**用 SSE `error` 帧表达鉴权 / 权限失败；SSE `error` 帧只表达「已建流、已鉴权后的业务失败终态」（如 §3.4 字段级失败）。流中途 Cookie 过期不强断已建立的流；下次重连握手期失效即握手期返 HTTP `401`（非帧），前端据此跳登录，重连握手发生在帧流之前、不破坏「先 `state_snapshot` 再续增量」恢复。

---

### 4.E `PATCH /api/v1/versions/{versionId}/manifest` — 改软字段（手动编辑，B-26）

**鉴权**：普通 HTTP — `requireAuth` + `requireRole('creator')` + handler owner 校验（本人，10-auth §6.2/§6.3；Bearer JWT，非 SSE 不走 §11.C）。**幂等/并发**：必带 `Idempotency-Key`，scope=`manifest.patch`；并发用 `If-Match`（manifest 版本 ETag，乐观锁，对齐脊柱 §1.4 PATCH 语义）。

**请求 schema**（只允许改软字段；硬字段拒绝）：

```typescript
export const PatchManifestBody = z.object({
  name: z.string().optional(),
  tagline: z.string().optional(),
  role: z.string().optional(),
  goal: z.string().optional(),
  instructions: z.string().optional(),
  skill_set: z.array(z.string()).optional(),
  starter_prompts: z.array(z.string()).optional(),
}).refine(b => Object.keys(b).length > 0, { message: '没有可保存的改动' });
// 任何硬字段键（id/version/status/inputs/output/boundaries）出现 → 422 拒绝
```

**响应** `200`：`Envelope<ManifestView>`（回改后全量 + `structureState`）。

**行为 / 派生规则（验收 选择结构化-13/28/31）**：
- 仅改软字段并落 `manifest`（扁平结构，沿用扁平说明书；硬字段含 `status=draft` 不被改写，验收 选择结构化-31）。改动持久保留（同会话切走切回仍在，验收 选择结构化-13）。
- 改 `instructions` → **系统重算 `inputs.schema`**（从指令占位重新抽取、`derivedFrom:'instructions'`），硬字段 `inputs` 随之更新但**仍锁定不可手改**（验收 选择结构化-28）。`output.type` 可由抽取推断更新但锁定。
- **published 后改 → `409 STATE_CONFLICT`**（`action:'change_input'`，提示「需基于新版本编辑」），引导调端点 A 建新版本（§2.4、B-26）。

**错误用例**：

| HTTP | code | retriable | action | userMessage |
|---|---|---|---|---|
| 400 | `VALIDATION_FAILED` | false | `change_input` | 「没有可保存的改动，或字段格式不对。」 |
| 403 | `FORBIDDEN` | false | `escalate` | 「你没有权限编辑这个能力。」 |
| 404 | `NOT_FOUND` | false | `change_input` | 「没找到对应版本，可能已被删除。」 |
| 409 | `STATE_CONFLICT` | false | `change_input` | 「这个能力已发布，请基于新版本再编辑。」 |
| 412 | `PRECONDITION_FAILED` | true | `retry` | 「内容刚被改过，刷新后再保存。」（If-Match 不符，乐观锁冲突）|
| 422 | `HARD_FIELD_LOCKED` | false | `change_input` | 「这部分是平台锁定的，改不了；可改软字段间接影响。」（请求里含硬字段键）|

> 412 `PRECONDITION_FAILED` 是本域在脊柱缺省表上扩的 code（HTTP 412），retriable/action 沿脊柱「retry」语义（刷新重取后重试）。

---

### 4.F `POST /api/v1/versions/{versionId}/manifest/fields/{field}/regenerate` — 单软字段重生成（B-26）

**鉴权**：普通 HTTP — `requireAuth` + `requireRole('creator')` + handler owner 校验（本人，10-auth §6.2/§6.3；Bearer JWT，非 SSE 不走 §11.C）。**幂等**：必带 `Idempotency-Key`，scope=`manifest.regenerate_field`；同字段连点重试只产生一个结果、不叠加 / 不重复追加数组项（验收 选择结构化-26）。**path 约束**：`{field}` ∈ 7 软字段；硬字段 → `422 HARD_FIELD_LOCKED`。

**请求 schema**：

```typescript
// path: field ∈ SoftFieldKey；body 可空
export const RegenerateFieldBody = z.object({
  reason: z.enum(['stuck', 'manual']).optional(),  // stuck=卡住三退路里「只重生成」；manual=主动重生成
}).optional();
```

**响应** `202`：

```typescript
export interface RegenerateFieldResult {
  jobId: JobId;          // 复用 / 新建 structure Job（仅该字段）
  field: SoftFieldKey;
  eventsUrl: string;     // = 端点 D（同一字段流，前端按 field 过滤帧）
}
// → Envelope<RegenerateFieldResult>
```

**行为（验收 选择结构化-14/17/26）**：
- **只重生成该字段**：其位置回 `generating`（加载条），**其余已生成软字段 + 硬字段原样不动、不重跑、不清空**（structure_state 仅该字段改写）。
- 数组字段重生成 = 整字段重算（替换，不追加），避免重复追加（验收 选择结构化-26）。
- 经 jobs/fence 写入**用脊柱 §11.A 受保护写入模板 3**（单条事务 CTE，fence 内联进数据源，禁两步查写；同 §4.C「受保护写入」），SSE 走端点 D 发 `field_start/field_delta/field_done`（仅该 field）。
- **累计重试 2 次仍失败** → 该字段落 `error`（§3.4，`STRUCTURE_FIELD_FAILED`，action 三选一），其余不丢（验收 选择结构化-19/20）。

**错误用例**：

| HTTP | code | retriable | action | userMessage |
|---|---|---|---|---|
| 404 | `NOT_FOUND` | false | `change_input` | 「没找到对应版本或字段。」 |
| 409 | `STATE_CONFLICT` | false | `change_input` | 「已发布版本不能重生成字段，请基于新版本编辑。」 |
| 422 | `HARD_FIELD_LOCKED` | false | `change_input` | 「这部分是平台锁定的，不能重新生成。」 |
| 422 | `STRUCTURE_FIELD_FAILED` | true | `retry` | 「这个字段没生成出来，可重试、改输入或转人工。」（两次失败落 escalate）|
| 423 | `RESOURCE_LOCKED` | true | `wait` | 「这个字段正在生成，请稍候。」 |
| 502 | `LLM_UPSTREAM_FAILED` | true | `retry` | 「上游处理暂时不稳定，请稍后重试。」 |

---

## 5. DDL（PostgreSQL，B-24/B-25）

> 引用脊柱已定表（`jobs` / `idempotency_keys` / `drafts` / `users` / `raw_snapshots`）不重定义。本域定义 `capabilities` 与 `capability_versions`，并引用提取域 `candidate_evidence`（外键血缘）。`capability_tiers` / `publications` 属发布域，本域不定义。

### 5.1 capabilities（能力体，不可变 slug，B-24）

```sql
CREATE TABLE capabilities (
  id                 uuid        PRIMARY KEY DEFAULT gen_uuid_v7(),
  creator_user_id    uuid        NOT NULL REFERENCES users(id),
  slug               text        NOT NULL,                 -- 不可变、URL 安全；公开主页/市集路径 /a/{slug}
  current_version_id uuid,                                  -- 当前生效版本（FK 见下，建版后回填，避免循环建表）
  -- 三类标签（audience/domain/scene），主页/检索用；本域建体时可空，结构化/发布补
  tags               text[]      NOT NULL DEFAULT '{}',
  total_invocations  bigint,                                -- usage 类：本期置 null + meta.placeholders（脊柱 §2.2）
  embedding          vector(1536),                          -- pgvector，P1 能力网络用；本域可空
  status             text        NOT NULL DEFAULT 'active', -- active|archived（能力体级软删，区别于版本 status）
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_capabilities_slug UNIQUE (slug)             -- slug 全局唯一（双向解析 API↔公开路径）
);
CREATE INDEX idx_capabilities_creator ON capabilities (creator_user_id, created_at DESC);
-- slug 不可变由应用层守门（无 UPDATE slug 路径）；如需 DB 级可加触发器禁改 slug
```

### 5.2 capability_versions（版本 = manifest App Identity，B-24/B-25）

```sql
CREATE TABLE capability_versions (
  id                  uuid        PRIMARY KEY DEFAULT gen_uuid_v7(),
  capability_id       uuid        NOT NULL REFERENCES capabilities(id) ON DELETE CASCADE,
  version             text        NOT NULL,                 -- semver，如 '0.1.0'（首版）/'0.2.0'（published 后新 draft）
  status              text        NOT NULL DEFAULT 'draft', -- draft|published|superseded|review_rejected（本域只产 draft；后续态发布域 B-27）
  -- manifest = App Identity（软生成 + 硬锁定），扁平 JSONB（沿用扁平说明书结构，验收 选择结构化-31）
  manifest            jsonb       NOT NULL DEFAULT '{}'::jsonb,
  manifest_hash       text,                                  -- 仅发布步固化（发布域 B-27 记 hash）；draft 态为 null
  -- structure_state：字段级流式 / 续传真源（每软字段状态/已生成值/卡住时长 + 硬字段 locked 值）
  structure_state     jsonb       NOT NULL DEFAULT '{}'::jsonb, -- StructureState（脊柱 §9），state_snapshot(structure) 全量来源
  -- 血缘：本版来自哪个候选（B-24 选定候选建体）
  source_candidate_id uuid        REFERENCES capability_candidates(id), -- 提取域表；可空（建新版本时无候选）
  -- 被拒版本线真源（脊柱 §11.E 相邻；发布域 50 Codex#8）：评审拒绝时落在【被裁决的那一版自身】。
  -- 本域建表即提供这两列（表归本域所有）；写入由发布/评审域（B-30 §2.6.1 评审事务）完成，本域不产被拒态。
  -- 权威：被拒原因/时刻以本两列为准；publications.reject_reason 仅人话镜像投影（50 §1.3 铁律）。
  reject_reason       text,                                  -- 该版被拒人话原因（终态 review_rejected 时写；非内部状态码）
  rejected_at         timestamptz,                           -- 该版被裁决拒绝时刻
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_capability_version UNIQUE (capability_id, version),  -- 同能力体内 semver 唯一（防重复版本号）
  -- 脊柱 §11.E 血缘约束注册表：为「版本属同一 capability」复合 FK 提供被引用唯一键
  -- 与 uq_capability_version 并存：本键供下游复合 FK（publications/listings/current_version_id），后者防重号
  CONSTRAINT uq_capability_versions_capability_id UNIQUE (capability_id, id)
);
CREATE INDEX idx_capver_capability ON capability_versions (capability_id, created_at DESC);
CREATE INDEX idx_capver_status ON capability_versions (status);
CREATE INDEX idx_capver_source_candidate ON capability_versions (source_candidate_id); -- 血缘回溯

-- capabilities.current_version_id 外键（建版后回填，单独加约束破循环）
-- 脊柱 §11.E：升级为复合 FK，DB 层焊死「当前生效版本必属本能力体」（防 current_version_id 指向他人 capability 的版本）
-- 引用 uq_capability_versions_capability_id 提供的 (capability_id, id) 唯一键
ALTER TABLE capabilities
  ADD CONSTRAINT fk_capabilities_current_version
  FOREIGN KEY (id, current_version_id) REFERENCES capability_versions (capability_id, id);
```

**Phase 0 关键正确性决策（DDL 体现）**：
- **去重 / 唯一键**：`capabilities.slug` 全局唯一（不可变业务键，API↔公开路径双向解析）；`(capability_id, version)` 唯一防同能力体重复版本号（published 后 bump minor 不撞）；另加 `uq_capability_versions_capability_id` = `(capability_id, id)` 唯一（脊柱 §11.E），与版本号唯一键并存，供下游复合 FK（`capabilities.current_version_id`、发布域 `publications.current_version_id` / `marketplace_listings.version_id`、70 域 `runtime_sessions.(capability_id, version_id)`，Codex#6-r2）焊死「引用的版本必属同一 capability」。
- **复合 FK 焊死版本归属**：`capabilities.current_version_id` 由单列 FK 升级为复合 FK `fk_capabilities_current_version` = `(id, current_version_id) → capability_versions(capability_id, id)`（脊柱 §11.E），DB 层杜绝「当前生效版本指向他人能力体的版本」；发布域 50 的 `publications` / `marketplace_listings` 按同注册表升级（约束名 `fk_publications_capability_version` / `fk_listings_capability_version`，本域不定义、仅提供被引用唯一键）。
- **血缘**：`capability_versions.source_candidate_id → capability_candidates.id`（B-24 候选→能力体可回溯到候选→进而经 `candidate_evidence` 回溯到 `session_segments` / snapshot，支撑「N 段会话支撑」信任货币，B-25 worker 据此直读证据）。
- **fence / 不丢**：结构化 worker 写 `capability_versions.structure_state` / `manifest` 必用**脊柱 §11.A 受保护写入模板 3**（单条事务 CTE，fence 经 `jobs` 联表内联进数据源 `... FROM jobs WHERE id=:jobId AND fence_token=:fence AND status='running' AND v.id=:versionId`，禁两步「查后写」），fence 不匹配 / 离开 running → 命中 0 行、旧执行安全退出（`rowCount=0` 是正常控制流），防重复字段 / 旧覆盖新；`structure_state` 字段级落库 = 已生成不丢的存储基座（硬规则③）。具体 SQL 见 §4.C「受保护写入」。
- **status 分层**：版本级 `status`（draft→…）与能力体级 `capabilities.status`（active/archived）分离，避免软删与发布态耦合；本域只产 `draft`，后续态由发布域演进（只加不减、向后兼容）。

> `capability_candidates` / `candidate_evidence` / `session_segments` / `raw_snapshots` 由导入/提取域契约定义，本域仅作外键引用（迁移顺序：提取域表先于本域 `source_candidate_id` 外键）。

---

## 6. 本域 TS 类型片段（归集 src/shared/，import 脊柱不重定义）

```typescript
import type {
  CapabilityId, VersionId, CandidateId, JobId, Slug, DraftId,
  StructureState,            // 脊柱 §9：字段级真源
  FieldStatus, FieldState,   // 脊柱 §9
  JobStatus, DraftView,      // 脊柱 §9（DraftView 为端点 G 响应类型）
} from '@/shared';

// ===== manifest 软硬分层（见 §2）=====
export type SoftFieldKey =
  | 'name' | 'tagline' | 'role' | 'goal'
  | 'instructions' | 'skill_set' | 'starter_prompts';
export type HardFieldKey =
  | 'id' | 'version' | 'status' | 'inputs' | 'output' | 'boundaries';

export interface InputField {
  key: string; label: string;
  type: 'string' | 'text' | 'enum' | 'number';
  required: boolean; options?: string[];
  derivedFrom: 'instructions';
}
export interface InputSchema { fields: InputField[]; }
export type OutputType = 'text' | 'structured' | 'score' | 'checklist';
export interface OutputSpec { type: OutputType; }
export interface Boundaries { riskLevel: 'low' | 'medium' | 'high'; redLines: string[]; }

export interface Manifest {
  id: string; version: string; status: 'draft';
  inputs: InputSchema; output: OutputSpec; boundaries: Boundaries;
  name: string; tagline: string; role: string; goal: string;
  instructions: string; skill_set: string[]; starter_prompts: string[];
}
export interface ManifestView {
  versionId: VersionId; capabilityId: CapabilityId; slug: Slug;
  manifest: Manifest; locked: HardFieldKey[]; structureState: StructureState;
}

// ===== STEP③ 选择草稿（端点 G，drafts.selection 权威形态 + 续传恢复 schema）=====
export type SelectionDraft =
  | { mode: 'single'; candidateId: CandidateId }
  | { mode: 'all'; candidateIds: CandidateId[] };
export interface PatchSelectionBody { selection: SelectionDraft; }
// 端点 G 响应 = 脊柱 §9 DraftView（其 selection 字段即 SelectionDraft）

// ===== 端点 I/O =====
export interface CreateCapabilityBody {
  sourceCandidateId?: CandidateId;   // ①从候选新建首版
  capabilityId?: CapabilityId;       // ②published 后建新版本
  fromVersionId?: VersionId;         // ③被拒重发：从本人 review_rejected 版派生新 draft（§2.4、50 §1.1 F-14）
  draftId?: DraftId;
  // 约束：sourceCandidateId / capabilityId / fromVersionId 三选一（至少一个、fromVersionId 不与前两者并存）
}
export interface CreateCapabilityResult {
  capabilityId: CapabilityId; versionId: VersionId; slug: Slug;
  version: string; manifest: Manifest; structureState: StructureState;
}
export interface StartStructureBody { fields?: SoftFieldKey[]; }
export interface StartStructureResult {
  jobId: JobId; versionId: VersionId; eventsUrl: string; structureState: StructureState;
}
export interface PatchManifestBody {
  name?: string; tagline?: string; role?: string; goal?: string;
  instructions?: string; skill_set?: string[]; starter_prompts?: string[];
}
export interface RegenerateFieldBody { reason?: 'stuck' | 'manual'; }
export interface RegenerateFieldResult { jobId: JobId; field: SoftFieldKey; eventsUrl: string; }

// ===== SSE 字段流 payload（本域具体化脊柱 §5.3；字段级 field 一律 SoftFieldKey，硬字段不发字段级帧）=====
export interface FieldStartPayload { field: SoftFieldKey; index: number; total: number; }
export interface FieldDeltaPayload { field: SoftFieldKey; deltaText: string; itemIndex?: number; }
export interface FieldDonePayload { field: SoftFieldKey; value: string | string[]; }
export interface FieldItemAppendedPayload { field: SoftFieldKey; itemIndex: number; value: string; }
// 本域收紧脊柱 §9 的 FieldStuckPayload.field（脊柱为 string）为 SoftFieldKey：硬字段锁定，永不发 field_stuck
export interface StructureFieldStuckPayload {
  field: SoftFieldKey;
  elapsedMs: number;
  options: Array<'continue' | 'regen' | 'wait'>;
}
// 字段级失败：error 帧线上外形为完整 ErrorEnvelope（data: {"error":{...}}）；下为其内层 error.details 形态，error.details.field 限定 SoftFieldKey（硬字段不报字段级生成错误）
export interface StructureFieldFailedDetails { field: SoftFieldKey; attempts: number; }
// StateSnapshotPayload / DonePayload 直接用脊柱 §9，不重定义
```

---

## 7. 功能点覆盖表

| 功能点 | 说明 | 对应端点 | 对应表 | 验收用例模块 |
|---|---|---|---|---|
| **B-24** | 从候选建能力体（draft 版本）| A `POST /capabilities`、B `GET .../manifest` | `capabilities`、`capability_versions` | 选择结构化-07/08、贯穿-27 |
| **B-25** | 结构化 Job（软字段流 + 硬字段锁定，直读 candidate_evidence/session_segments）| C `POST .../structure`、D `GET .../structure/events`（SSE）| `capability_versions.structure_state`、`jobs(type=structure)`；引用 `candidate_evidence`/`session_segments` | 选择结构化-09/10/11/15~24/27、贯穿-07/08/10/28 |
| **B-26** | 结构化 API + 单软字段重生成 / 软字段编辑 / published 后强制新版本 / 被拒重发派生新 draft | E `PATCH .../manifest`、F `POST .../fields/{field}/regenerate`、A（`capabilityId` 建新版本分支 + `fromVersionId` 被拒重发派生分支）| `capability_versions`（manifest/structure_state/version semver；`fromVersionId` 读源被拒版软字段）| 选择结构化-13/14/17/19/20/26/28/31 |
| STEP③（选变纯前端 + 可存草稿）| 选择切换纯前端即时（不写库）；「保存草稿」/ 进入下一步持久化 `selection`（精确续传）| G `PATCH /drafts/{draftId}/selection`、A（下一步固化 selection）| （脊柱 `drafts.selection`/`current_step`）| 选择结构化-01~06/25/29/30、贯穿-15/16 |

**涉及验收用例模块**：
- **选择结构化-01~31**（本域主体；其中 -01~06/25/29/30 = STEP③ 选择「选变纯前端 + 可存草稿」，-07~24/26~28/31 = STEP④ 结构化）。
- **贯穿-07**（字段流逐项 + 数组逐条 + 硬字段锁定）、**贯穿-08**（卡住三退路）、**贯穿-10**（中断已生成不丢）、**贯穿-15/16**（草稿续传 / 已完成步骤回看，本域提供 manifest 回看端点 B）、**贯穿-22**（断线续传，SSE 端点 D）、**贯穿-27**（双标签页不重复，幂等）、**贯穿-28**（结构化续传只补未生成字段）。

> 选择结构化-29「全部发布逐个跑结构化与发布」由发布域 B-29 编排，逐项复用本域端点 A/C/E/F；本域只保证单条 version 的建立与结构化契约可被批量复用（每 item 独立 Idempotency-Key、独立 structure Job、失败只标该 item 不连坐）。

---

## 8. 对齐合并校验摘要

**端点清单（method + path）**
- `PATCH /api/v1/drafts/{draftId}/selection`（G · B-24 STEP③ 存草稿；scope=`draft.selection.patch`）
- `POST /api/v1/capabilities`（A · B-24）
- `GET /api/v1/versions/{versionId}/manifest`（B · B-24/25/26）
- `POST /api/v1/versions/{versionId}/structure`（C · B-25/26）
- `GET /api/v1/versions/{versionId}/structure/events`（D · SSE · B-25/12）
- `PATCH /api/v1/versions/{versionId}/manifest`（E · B-26）
- `POST /api/v1/versions/{versionId}/manifest/fields/{field}/regenerate`（F · B-26）
- 复用脊柱通用端点（本域不重定义）：`POST /api/v1/jobs/{jobId}/cancel`（取消结构化，保留已生成）、`GET /api/v1/jobs/{jobId}/events`（job 流，与 D 同源）。

**鉴权口径（分层，§4 头权威）**：
- **普通 HTTP 端点（A/B/E/F/G 等全部非 SSE）= `requireAuth` + `requireRole('creator')` + handler owner 校验**（Logto JWT，Cookie/Authorization 双来源，10-auth §6.2/§6.3；建/改能力体属创作者私有写读，须 creator 角色 + 资源属 `ctx.userId`，非本人 `403 FORBIDDEN`）。
- **唯一例外 = SSE 端点 D（`GET .../structure/events`）= 同源 Cookie-only**（脊柱 §11.C）：EventSource 原生不支持自定义头，故 SSE 统一同源 Cookie、禁 query-string token / 禁自定义 header 主鉴权，鉴权/权限失败在**建流前**返 HTTP `ErrorEnvelope`（401/403，不走 `error` 帧）+ owner 校验。

**表清单**
- 本域定义：`capabilities`（slug 唯一、不可变；`current_version_id` **复合 FK** `fk_capabilities_current_version`=`(id,current_version_id)→capability_versions(capability_id,id)`，脊柱 §11.E）、`capability_versions`（semver、manifest 软硬 JSONB、structure_state、source_candidate_id 血缘、fence 经 jobs；新增唯一键 `uq_capability_versions_capability_id`=`(capability_id,id)` 供下游复合 FK）。
- 引用不定义：`jobs`/`idempotency_keys`/`drafts`（端点 G 写其 `selection`/`current_step`）/`users`/`raw_snapshots`（脊柱）、`capability_candidates`/`candidate_evidence`/`session_segments`（提取/导入域，外键血缘）。

**对其他域的约束名 / 字段变化（供并行合并校验）**
- **新增唯一键 `uq_capability_versions_capability_id` = `UNIQUE (capability_id, id)`**（脊柱 §11.E 注册表）：**发布域 50** 的 `fk_publications_capability_version`（`publications(capability_id,current_version_id)`）与 `fk_listings_capability_version`（`marketplace_listings(capability_id,version_id)`）必须 FK 引用本键（不得引用 `capability_versions(id)` 单列）。本域负责建该唯一键，50 负责按注册表名建复合 FK。
- **`capabilities.current_version_id` 升级为复合 FK**（约束名 `fk_capabilities_current_version`，引用 `(capability_id,id)`）：迁移顺序需先有 `uq_capability_versions_capability_id`。
- **`capability_versions` 新增被拒版本线两列 `reject_reason text` + `rejected_at timestamptz`**（发布域 50 Codex#8）：表归本域、本域建列；写入由发布/评审域（50 §2.6.1 评审事务）落在【被裁决版自身】。被拒原因/时刻权威在本两列，`publications.reject_reason`（50 域）仅人话镜像投影。本域只产 `draft`、不写被拒态，但 schema 必须提供这两列，否则 50 评审事务无处落库（拒绝态单一真源贯穿工作台/主页/发布页的存储基座）。
- **字段级 SSE / 错误一律 `SoftFieldKey`**：`field_start/field_delta/field_done/item-appended/field_stuck` 的 `field`、`error` 帧 `details.field` 全限定为 7 软字段；硬字段（`id/version/status/inputs/output/boundaries`）锁定、不发字段级帧、不报 `STRUCTURE_FIELD_FAILED`。脊柱 §9 通用 `FieldStuckPayload.field`（string）本域收紧为 `StructureFieldStuckPayload.field: SoftFieldKey`。
- **错误信封字段名 `userMessage`**（脊柱 §11.B）：各错误用例表「userMessage（人话）」列 = `userMessage`；`error.code` 仅日志/映射、UI 永不渲染。
- **受保护写入用脊柱 §11.A 模板 3**：结构化 worker 写 `structure_state`/`manifest` 为单条事务 CTE、fence 内联（见 §4.C「受保护写入」SQL）；70 域 sweeper 重入队同遵 §11.A。

**SSE 事件清单（kind=structure，端点 D）**
- `state_snapshot`(首帧, structureState 全量) · `field_start` · `field_delta` · `field_done` · `item-appended`(数组逐条) · `progress`(「正在补全字段 4/7」) · `subtask` · `field_stuck`(三退路 continue/regen/wait) · `slow_hint` · `error`(STRUCTURE_FIELD_FAILED) · `done` · `heartbeat`。**字段级帧 `field` 恒 SoftFieldKey，硬字段不发 `field_*`/`field_stuck`/字段级 `error`。**

**引用到的脊柱共享类型**
- ID：`CapabilityId`/`VersionId`/`CandidateId`/`JobId`/`Slug`/`DraftId`。
- 包络/错误：`Envelope<T>`、`Meta`(placeholders for `total_invocations`)、`ErrorEnvelope`(§11.B 收紧形态，`userMessage`/`action`)、`ErrorAction`。
- jobs/progress：`JobType('structure')`、`JobStatus`、`JobView`、`ProgressView`、`SubtaskView`/`SubtaskStatus`。
- SSE：`SSEEventType`、`SSEStreamKind('structure')`、`SSEFrame<P>`、`StateSnapshotPayload`、`FieldStuckPayload`(本域收紧为 `StructureFieldStuckPayload`)、`DonePayload`。
- 结构化字段：`FieldStatus`(含 `locked`)、`FieldState`、`StructureState`。
- drafts：`DraftStep('select'|'structure')`、`DraftView`(端点 G 响应)、`DraftStatus`；`selection` 字段权威形态 = 本域 `SelectionDraft`。

**本域在脊柱缺省表上扩的 code**（action/retriable 遵脊柱缺省语义）
- `STRUCTURE_NO_EVIDENCE`(422/change_input)、`STRUCTURE_FIELD_FAILED`(422/retry，两次失败→escalate)、`HARD_FIELD_LOCKED`(422/change_input)、`PRECONDITION_FAILED`(412/retry，If-Match 乐观锁)。其余沿用脊柱 §3.3。

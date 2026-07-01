# apps/runtime（试用端 · 对话式能力运行时）

类 Chat Agent 的独立后端：用户在此把【已发布能力】跑起来——加载能力包契约 → 注入 pi agent 的
systemPrompt → 流式对话 → 生成并渲染产物（类 Claude Artifacts）→ 带 session 管理与续话。

配套前端在 `apps/runtime-web`（Vite+React 双栏 UI：对话流 + 产物面板）。

## 与 authoring 的边界（铁律）

- 只依赖 `@cb/shared`（含 `domains/skill-package.ts` 契约缝 + `domains/runtime-api.ts`）与本应用自有代码。
- **禁止 import `apps/authoring/**` 的任何代码**；两个应用只在能力包契约 + `capability.published` 事件流相遇。
- 加载已发布投影走方案 A：直读 `capability_versions`（`status='published'`，经 `capabilities.current_version_id`），
  用 `@cb/shared.toRuntimeView` 组装契约、`modules/capability/manifest-hash.ts` 校验内容指纹。
  实现藏在 `getPublishedCapability(slugOrId)` 接口后，将来要换「事件驱动读模型」只改 loader 一处。

## 结构

- `platform/`：config/env · infra/db(pg) · http/{identity(匿名cookie),errors,health} · bootstrap。
- `modules/capability/`：loader（直读+校 hash+可见性闸）· list（试用市集）· manifest-hash（sha256，与 authoring 同算法）。
- `modules/session/`：会话/对话消息持久化（rt_chat_* 表）。
- `modules/artifact/`：upsert_artifact pi-tool（解耦成 onArtifact 回调）+ 产物版本存储。
- `modules/agent/`：model（双 provider）· compose-prompt · build-agent（注入 systemPrompt + rehydrate 转录）·
  agui-emitter（@ag-ui/encoder 发标准 AG-UI 事件）· agui-run（pi 事件 → AG-UI 事件 → 落库）。
- `processes/api.ts`：Fastify HTTP + SSE 单进程入口。

## 对话线协议：AG-UI

对话走开源标准 **AG-UI**（github.com/ag-ui-protocol/ag-ui，MIT），pi 仍是执行层：

- 后端 `agui-run` 把 pi 事件翻成标准 AG-UI 事件流（SSE）：`RUN_STARTED → TEXT_MESSAGE_START/CONTENT/END → RUN_FINISHED`；
  失败 `RUN_ERROR`（终态）。**产物走共享状态**：`STATE_DELTA`（RFC 6902 JSON Patch）`add /artifacts/<key>` + `/activeArtifactKey`。
- 前端用官方 `@ag-ui/client` 的 `HttpAgent` 消费，自管 messages + state；砖红双栏 UI 不变（见 apps/runtime-web）。
- 端点 `POST /runtime/agui`，body 为 `RunAgentInput`（threadId 即 sessionId，只取最新一条 user 消息当输入，其余以服务端 transcript 为真源）。
- 合规由 `@ag-ui/client` 内置 `verifyEvents` 顺序状态机校验（冒烟已过）。

## LLM provider

`pi` 执行层支持双 provider，按 key 自动判定（或显式 `RUNTIME_LLM_PROVIDER`）：

- `anthropic`：直连，读 `ANTHROPIC_API_KEY`，默认模型 `claude-sonnet-4-5`（可 `RUNTIME_LLM_MODEL` 覆盖为 `claude-opus-4-8` 等）。
- `openrouter`：OpenAI 兼容（与本仓 authoring 同口径），读 `OPENROUTER_API_KEY`，默认 `anthropic/claude-sonnet-4.6`。

缺 key 不阻塞启动，仅对话端点降级报错。

## 本地起跑

```bash
# 1) 建表（新增 0015：rt_chat_sessions / rt_chat_messages / rt_chat_artifacts / rt_chat_artifact_versions）
DATABASE_URL=postgres://<u>:<p>@localhost:5432/<db> pnpm -F @cb/db run migrate

# 2) 播种 demo 能力（需库里至少有一个 user 作创作者归属）
DATABASE_URL=... pnpm -F @cb/runtime run seed

# 3) 起 api（默认 3100）
DATABASE_URL=... OPENROUTER_API_KEY=... RUNTIME_LLM_PROVIDER=openrouter \
  PORT=3100 NODE_ENV=development pnpm -F @cb/runtime dev

# 4) 起前端（默认 5174，代理 /api → 3100）
pnpm -F @cb/runtime-web dev
```

API（均在 `/api/v1`）：`GET /runtime/capabilities`、`GET /runtime/capabilities/:slugOrId`（公开视图，不下发 instructions）、
`POST /runtime/sessions`、`GET /runtime/sessions`、`GET /runtime/sessions/:id`（详情，前端据此 seed AG-UI 客户端）、
`POST /runtime/agui`（AG-UI 标准端点，body=RunAgentInput，回 AG-UI 事件流）。

## 命名说明（与 0008 冻结表的关系）

`0008_frozen_tables.sql` 早已【冻结预留】另一套 `runtime_sessions` / `artifacts`（事件溯源消费模型：
mode/tier_code/phase/consumer_key/last_applied_command_id），那是 B-40 更重的未来设计。本 MVP 是「对话式
Artifacts runtime」，与冻结设计不同形态，故用独立前缀 `rt_chat_*`，**不动**冻结预留表；两套设计的归并留作后续决策。

## 待办 / 硬化

- 匿名身份（rt_uid cookie）未签名；上线前接 Logto 或签名 cookie。
- inputs/output 仅写进提示词约束，未做强校验（契约文档「第一版」口径，留后续）。
- 升格 `platform/` 为 `packages/platform` 共享（README 原计划）；运行期独立最小只读凭据。

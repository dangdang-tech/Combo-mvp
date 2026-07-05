# apps/runtime（试用端 · 能力项播放器）

创作者对某个 Capability 开会话试用的独立后端：形态类 Claude Artifacts（左聊天流右产物画布）。
单进程（api），对话生成在进程内异步跑（生命周期不绑 HTTP 连接）。

## 与 authoring 的边界（铁律）

- 只依赖 `@cb/shared`，**禁止 import `apps/authoring/**` 的任何代码\*\*。
- 两个服务只在两处相遇：同一个 PG（读 `capabilities` 表 + 写试用层四表
  `sessions/messages/stream_events/artifacts`）和 MinIO（按 `capabilities.storage_key`
  读 CapabilityDefinition JSON，桶 `agora-artifacts`）。
- 身份：验创作端同一个登录 Cookie（`cb_session`，Logto access_token；dev 环境兼容
  authoring dev-login 签发的 HS256 token）。runtime 只验不签、不建用户，同库查 `users` 解出 userId。

## 结构

- `platform/`：config/env · infra（db / object-store / llm provider / logto / dev-session /
  进程内事件总线）· middleware/auth（登录态校验）· http（错误信封 / 健康检查 / client-events）· observability。
- `modules/capability/`：loader（owner 本人 OR published 才放行 → MinIO 读定义 → schema 校验，
  version 不认识报「能力格式过新」）· 试用入口列表。
- `modules/session/`：sessions/messages 两表 SQL（appendMessage 锁行分配 seq；content 写入前
  过 pi 原生消息块 schema，坏块拒写）· 会话端点 handler。
- `modules/agent/`：build-agent（instructions 组系统提示词 + messages 历史以 pi 原生格式喂回）·
  run-turn（一轮编排：会话级并发闸 / pi 事件翻 AG-UI / 双写）· stream（SSE，Last-Event-ID 表补发 + 实时）·
  event-log / turn-emitter。
- `modules/artifact/`：upsert_artifact pi 工具（内容写 MinIO `artifacts/{sessionId}/{artifactId}`，
  无版本原地覆盖）· 内容回读端点。
- `processes/api.ts`：Fastify HTTP + SSE 单进程入口（默认端口 3100，避开 authoring 的 3000）。

## 对话线协议：AG-UI

pi 是执行层，事件翻成标准 AG-UI 事件：`RUN_STARTED → TEXT_MESSAGE_START/CONTENT/END → RUN_FINISHED`，
失败/打断 `RUN_ERROR`（终态）；产物走共享状态 `STATE_DELTA`（`add /artifacts/<id>` + `/activeArtifactId`）。
`stream_events` 表是真源（断线凭 Last-Event-ID 从表补发再切实时），进程内总线只服务在线订阅者。
正常结束把整轮 assistant/toolResult 消息落 `messages`（completed），失败/打断落一条 failed 消息。

## LLM provider

`pi` 执行层支持双 provider，按 key 自动判定（或显式 `RUNTIME_LLM_PROVIDER`）：

- `anthropic`：直连，读 `ANTHROPIC_API_KEY`，默认模型 `claude-sonnet-4-5`（可 `RUNTIME_LLM_MODEL` 覆盖）。
- `openrouter`：OpenAI 兼容（与本仓 authoring 同口径），读 `OPENROUTER_API_KEY`，默认 `anthropic/claude-sonnet-4.6`。

缺 key 不阻塞启动，仅对话轮次降级报错、`/ready` 标 degraded。

## 端点

全部在 `/api/v1` 前缀下、全部要求登录态（SSE 仅同源 Cookie）：

- `GET  /runtime/capabilities` 试用入口列表（我的全部 + 已发布的）
- `POST /runtime/sessions` 开会话 · `GET /runtime/sessions` 我的会话列表（可带 `?capabilityId=` 只列某个能力下的会话）
- `GET  /runtime/sessions/:id` 详情（消息按 seq + 产物 + 能力摘要，含定义里的开场表单字段与提示语）
- `POST /runtime/sessions/:id/messages` 发消息（异步生成立即返回；生成中再发 → 409 SESSION_BUSY）
- `POST /runtime/sessions/:id/interrupt` 打断当前轮
- `GET  /runtime/sessions/:id/stream` 流式生成事件（SSE，心跳 15s，Last-Event-ID 续传）
- `GET  /runtime/artifacts/:id/content` 产物内容回读（带正确 Content-Type）
- `GET /health` · `GET /ready`（db/minio/logto required + llm degraded）

## 本地起跑

```bash
# 1) 建库（基线 schema 0000）后，用 authoring 的上传→提取产出能力项，或手工插 capabilities 行 + MinIO 定义。

# 2) 起 api（默认 3100；dev 登录态需与 authoring 共享 DEV_SESSION_SECRET）
DATABASE_URL=... S3_ENDPOINT=http://localhost:9000 \
  DEV_LOGIN_ENABLED=true DEV_SESSION_SECRET=... \
  OPENROUTER_API_KEY=... RUNTIME_LLM_PROVIDER=openrouter \
  PORT=3100 NODE_ENV=development pnpm -F @cb/runtime dev
```

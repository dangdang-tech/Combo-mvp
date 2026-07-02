# 创作者中心主链路 · monorepo

Agora「创作者中心主链路」的生产栈骨架：脊柱契约（`@cb/shared`）+ 四层应用（api / web / db / infra）。
本阶段交付的是 **可编译、可启动的骨架**：脚手架 / 配置 / 迁移 / 基础设施 / 共享类型全部真实可用、`tsc` 通过；
业务路由按契约挂好路径 / 方法 / 鉴权链 / 幂等 scope，handler 暂为 `501` 占位（Phase 3 填）。

三条硬规则贯穿全栈：**永不裸转圈**、**绝不裸露错误码**（统一 `ErrorEnvelope`，只给 `userMessage` + `action`）、**已生成内容不丢**。

---

## 前置要求

| 工具   | 版本                                  | 说明                                                      |
| ------ | ------------------------------------- | --------------------------------------------------------- |
| Node   | `>= 24`（仓库锁 `.nvmrc` = 24）       | 用到 `--experimental-strip-types` 直跑迁移 TS             |
| pnpm   | `>= 11`（`packageManager` 锁 11.0.9） | 唯一包管理器，`corepack enable` 即可                      |
| Docker | 仅「compose 起全栈」需要              | **当前开发机无 Docker，全栈启动推迟**；本地子集开发不需要 |

唯一权威接口契约在 `docs/contracts/`（先读 `_index.md`，再 `00-约定与状态机.md` 及 `10~70` 各域）；
实现级架构在 `docs/01-详细技术方案.md`；脚手架说明在 `docs/02-脚手架说明.md`。
Trace ID 排障和本地观测栈说明见 `docs/07-可观测性与Trace排障.md`。

---

## 安装

```bash
pnpm install
```

工作区 7 个 package：`packages/shared`、`apps/api`、`apps/web`、`db`、`infra`、`scripts`（`infra` 无 TS）。

---

## 本地开发

### 一次性全栈校验（无需 Docker）

```bash
pnpm install          # 装依赖
pnpm -r run build     # 按项目引用依赖序构建 shared → api / web
pnpm -r run typecheck # 全包 tsc -b
pnpm lint             # eslint .（含分层 import 规则）
pnpm -r run test      # shared 24 + db 14 + api 61 = 99（web 骨架无测试）
pnpm format:check     # prettier 全量校验
```

### 单独跑某个包

```bash
pnpm -F @cb/shared build        # 构建脊柱（apps 依赖其 dist + .d.ts，先构建它）
pnpm -F @cb/shared openapi:gen  # 生成 OpenAPI 3.1（写 dist/openapi.json）
pnpm -F @cb/api build           # 构建 api（依赖 shared dist）
pnpm -F @cb/web dev             # Vite 开发服务器（前端）
pnpm -F @cb/web build           # tsc -b && vite build
```

### 本地直跑 api（无 DB 也能起到健康检查可达）

`@cb/shared` 与 `@cb/api` 构建后：

```bash
node apps/api/dist/processes/api.js
# 默认监听 :3000（可用 PORT/HOST 覆盖）
```

无 DB / Redis / MinIO / Logto 时进程**不崩溃**，按设计降级：

- `GET /health` → `200 {"status":"ok"}`（liveness，不查依赖）
- `GET /ready` → `503`，结构化列出六依赖（db/redis_queue/redis_hot/minio/logto 标 `down`、llm 标 `degraded`），`ready:false`（依赖宕时快速失败、不裸挂）
- 受保护端点（如 `GET /api/v1/me`）→ `401` ErrorEnvelope（`UNAUTHENTICATED` / `escalate`，绝不裸露 code）
- 未实现端点 → `501` 占位信封；未知路由 → `404` 信封
- 每个响应带 `x-trace-id` 头 + 结构化 pino 日志

> 起全栈后 `/ready` 会随依赖就绪转 `ok`；编排 / LB 据 `/ready` 判定是否接流量。

---

## 四进程说明（一镜像四入口）

api / worker / consumer / sweeper 共用同一份代码、同一镜像，按 `PROCESS` 环境变量在 `infra/entrypoint.sh` 分叉：

| 进程       | 入口                                  | 职责                                                        | 伸缩约束                                          |
| ---------- | ------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------- |
| `api`      | `apps/api/dist/processes/api.js`      | Fastify HTTP，对外服务 + SSE                                | 可多实例                                          |
| `worker`   | `apps/api/dist/processes/worker.js`   | BullMQ 消费（import / extract / structure / publish_batch） | 可多实例                                          |
| `consumer` | `apps/api/dist/processes/consumer.js` | outbox 保序消费（事件投递 / 通知）                          | **不可多实例**（启动拿 advisory lock 防误 scale） |
| `sweeper`  | `apps/api/dist/processes/sweeper.js`  | 后台对账 / orphan 清理 / outbox 滞留补投                    | **固定单实例**（启动拿 redis_hot 锁单活）         |

本期四进程仅 `boot`（打印职责 banner），不消费队列 / 不写库；Phase 3 接 BullMQ Worker 时遵脊柱 §11.A 受保护写入 CTE（`WHERE id=:jobId AND fence_token=:fence AND status='running'`）。

本地直跑单个进程：

```bash
PROCESS=worker node apps/api/dist/processes/worker.js
# 或直接 node apps/api/dist/processes/{worker,consumer,sweeper}.js
```

---

## 数据库迁移

DDL 真源在 `db/migrations/`（10 个 SQL，字典序即执行序）：基表先建，跨域 FK 后置闭合（脊柱 §11.G）。
Runner 自带记账表 `schema_migrations`，**幂等可重入**：已应用文件跳过、逐文件单事务、失败即止。

```bash
# 需要一个可达的 PostgreSQL（默认连接串见下）
pnpm -F @cb/db migrate         # 应用全部未应用迁移
pnpm -F @cb/db migrate:status  # 列清单（无连接也能列）
```

默认 `DATABASE_URL=postgres://agora:agora@localhost:5432/agora`，可用环境变量覆盖。

- 唯一 `CREATE EXTENSION` 是 `pgcrypto`（stock PG 自带），故任意 PG 实例可跑。
- `vector(1536)`（pgvector）、`gin_trgm_ops`（pg_trgm）为 P1，已注释 / 改 btree，**stock PG 可跑**；P1 启用时新增 `ALTER ADD` 迁移（迁移只加不减，勿改既有文件）。
- 冻结表（`usage_events` / `daily_*` / `experience_*` / `runtime` / `artifacts`）本期只建 schema、不写、不挂端点。

---

## Compose 起全栈（需 Docker）

> **本期开发机无 Docker，以下命令未实跑、推迟到后续；compose / Dockerfile 已写好并通过静态一致性核对。**

编排在 `infra/docker-compose.yml`，18 服务 + 6 命名卷。固定启动顺序（硬性，由 `depends_on` + `condition` 落地）：

```
postgres → logto_db_seed → logto_alteration → logto → migrate(业务迁移) → 业务容器(api/worker/consumer/sweeper/web)
```

要点：

- Logto OSS 不自跑迁移：先 CLI `db seed` 建表（一次性容器），再 `db alteration deploy`（单实例一次性 job），跑完才起 logto 运行态。
- 业务库 `agora` 与身份库 `logto` 同 PG 实例、不同 database，各自独立迁移，互不干扰。
- Redis 物理拆两实例：`redis_queue`（AOF + noeviction，BullMQ 队列绝不被驱逐）/ `redis_hot`（maxmemory + allkeys-lru，事件 Streams / 锁 / 限流，可驱逐、无持久卷）。
- 健康检查：postgres / redis×2 / minio 用原生探针；logto 断言 OIDC discovery（`{issuer}/.well-known/openid-configuration` 的 `issuer` / `jwks_uri`）；api 用 `/health`（liveness）；observability 栈提供 Grafana + Loki + Tempo + OpenTelemetry Collector。

```bash
cp .env.compose.example .env    # 全栈起栈用：填全部密钥（不得留空/不得用弱默认）
pnpm -F @cb/infra compose:config  # docker compose config（静态校验编排）
bash scripts/start.sh           # 严格固定序起全栈（每步 --wait，失败即止；起栈前先跑弱密钥守卫）
bash scripts/smoke.sh           # 端到端冒烟（/health /ready 结构 / ErrorEnvelope / Logto discovery）
pnpm -F @cb/infra compose:down  # 拆栈
```

观测入口：Grafana `http://localhost:3003/d/agora-trace-debug/trace-debug`，输入 UI 反馈码（`traceId`）即可查关联日志。

#### 两套 env 示例（按运行语境二选一，issuer 各自自洽）

| 运行语境                   | 复制哪个               | Logto issuer（canonical）    | 密钥要求                                                                             |
| -------------------------- | ---------------------- | ---------------------------- | ------------------------------------------------------------------------------------ |
| **本机直跑**（无 Docker）  | `.env.local.example`   | `http://localhost:3001/oidc` | dev 占位可用（agora/minioadmin）；`LOGTO_AUDIENCE` 可空（不强校 aud）                |
| **全栈 compose**（生产栈） | `.env.compose.example` | `http://logto:3001/oidc`     | **密钥必填、禁弱默认**；`start.sh` 起栈前守卫拒绝空值与 agora/minioadmin/postgres 等 |

- **为何拆两套**：单一 `.env` 的 Logto URL 若用 `localhost`，在 compose 网络里会让 API 容器内 `/ready` 和 JWKS 打到自己（容器内 `localhost` ≠ `logto` 容器）。故 compose 用服务名 `logto:3001`，本机直跑用 `localhost:3001`，两套各自 `LOGTO_ENDPOINT == {LOGTO_ISSUER 去 /oidc}`、自洽不分裂。
- **为何示例密钥留空**：示例里若带可用密钥（agora/minioadmin），会满足 compose 的 `${VAR:?}` = 绕过「生产无默认密钥」。故 `.env.compose.example` 所有密钥项留空，且 `scripts/start.sh` 加弱默认守卫（空或已知弱默认值即拒绝起栈），与 `apps/api/src/config/env.ts` 生产守卫双保险。

环境变量真源是上述两个 `.env.*.example`，分两类消费者：`[app]`（Node 进程 `apps/api/src/config/env.ts` 校验）与 `[compose]`（compose 变量替换）。

---

## CI（持续集成）

CI workflow 位于仓库根 `.github/workflows/ci.yml`。本 monorepo **即仓库根**，故 GitHub Actions 直接识别并运行（无需再复制/软链或加 `working-directory` 前缀）。

三个 job：

- `gate` —— install / lint（含分层依赖规则）/ typecheck / build / test / OpenAPI 生成自查 / compose 配置自查（结构校验，不 up）。无外部依赖，必过才允许合并。
- `integration` —— 起 PG / Redis 双实例 / MinIO 临时 service 容器，跑 db 迁移集成 + redis 双实例分工断言（O-05 / O-07）。
- `image` —— 构建 api / web 两个镜像，校验 Dockerfile 与 build context（仓库根）自洽。

所有步骤直接以仓库根（= monorepo 根）为工作目录；`cache-dependency-path: pnpm-lock.yaml`、`docker build -f infra/Dockerfile.* .`（context `.` = 仓库根）等路径均相对仓库根。

---

## 目录结构

```
.                      # 仓库根 = 本 monorepo（@cb/root）
├── packages/shared/   # @cb/shared 脊柱：DTO / zod / ErrorEnvelope / SSE 协议 / 常量 / 端口 / OpenAPI 真源
├── apps/api/          # @cb/api  Fastify 多进程骨架（api/worker/consumer/sweeper），业务 501 占位
├── apps/web/          # @cb/web  React/Vite 前端骨架（API client / SSE / 统一状态组件 / 导航外壳）
├── db/                # @cb/db   PostgreSQL 迁移 + 幂等 runner
├── infra/             # @cb/infra docker-compose + 一镜像四入口 Dockerfile + nginx + Redis 双配置 + 建库/建桶脚本
├── scripts/           # @cb/scripts start / migrate / smoke / openapi-dump / 集成脚本
├── tools/             # agora-import：本机导入助手（Go 源，构建期交叉编译进 api 镜像）
├── docs/              # 契约真源（contracts/）+ 技术方案 + 脚手架说明（非 workspace）
└── .github/workflows/ # CI（ci.yml）。本 monorepo 即仓库根，GitHub Actions 直接识别并运行
```

更细的目录 / 各包职责 / 已验证 vs 待验证，见 `docs/02-脚手架说明.md`。

---

## 当前验证状态

集成重建自检（无 PG / 无 Docker 环境，2026-06-15）逐门复跑结果：

| 门                      | 状态     | 说明                                                                                                                                                       |
| ----------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install`          | 通过     | 7 workspace，lockfile up to date                                                                                                                           |
| `pnpm -r run build`     | 通过     | shared / api / web 全 Done（vite 124 模块）                                                                                                                |
| `pnpm -r run typecheck` | 通过     | 全包 tsc 干净（exit 0）                                                                                                                                    |
| `pnpm lint`             | 通过     | `eslint . --max-warnings 0` 0 error 0 warning                                                                                                              |
| `pnpm format:check`     | 通过     | 全量符合 Prettier（修了 9 个文件的换行格式）                                                                                                               |
| `pnpm -r run test`      | 通过     | 99 测全绿（shared 24 / db 14 / api 61；含 outbox 全 topic × payload 一致性自核验；web 骨架无测试）                                                         |
| api 启动冒烟            | 通过     | 无依赖下 `/health` 200、`/ready` 503 结构化降级不崩、`/me` 401 无 code、未知路由 404 无 code                                                               |
| SSE 协议冒烟            | 通过     | 真 `text/event-stream` 握手 + `state_snapshot` 首帧 + 业务帧（over-the-wire 验证）；Cookie-only 拒 Bearer/query token 返 401                               |
| `migrate`（真跑）       | **推迟** | 需可达 PG（本机无 PG/Docker）；runner 自查与 SQL 静态核对通过（36 表、复合 FK、`gen_uuid_v7` `::int`）                                                     |
| compose 起全栈          | **推迟** | 需 Docker（本机无）；YAML 解析有效 / migrate 依赖 logto healthy / healthcheck issuer 断言 / 0 生产默认密钥 + start.sh 弱密钥守卫 `bash -n` 通过 已静态核对 |

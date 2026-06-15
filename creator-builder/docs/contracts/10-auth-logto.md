# 10 · Auth / Logto 域契约（B-08）

> **本文是 Auth/Logto 域的对外契约。** 覆盖功能点 **B-08**（Logto 自托管 OIDC 接入 + JWT 鉴权中间件）：登录 / 回调 / 登出、`/me`、JWT 校验中间件契约（issuer / JWKS / audience）、受保护路由的鉴权约定、share_token 匿名身份、`users` 表 DDL。
>
> **依赖脊柱**：本文严格遵循 `creator-builder/docs/contracts/00-约定与状态机.md`（下称「脊柱」）。路由前缀 `/api/v1`、响应包络 `Envelope<T>` / `Paginated<T>`、错误信封 `ErrorEnvelope` + action 五枚举、幂等 `Idempotency-Key` + 行为矩阵、SSE 帧协议、共享 TS 类型（§9）、健康检查口径（§10）一律 **import 不重定义**。
>
> **真源**：技术架构以飞书《技术方案 · 创作者中心与消费链路》为权威，本地以 `creator-builder/docs/01-详细技术方案.md` B-08 / §6.1 / §6.2 / §6.3 为准；产品角色口径以 `docs/开工总纲-创作者中心主链路.md` §1.3 为准；验收口径以 `docs/测试验收-创作者中心主链路.md` 外壳首页-01/20/31/32、主页-13 为准。
>
> **六项已拍板决策落地点**：① **Auth = Logto 自托管唯一**（不二选一）。本域全部端点据此。share_token 匿名运行的限流 / 日成本上限 / 匿名身份键 **本期 usage 置空、不写计量**，但匿名身份键解析与签发链路本期定契约（②）。
>
> **三条硬规则在本域的落地**：
> 1. **永不裸转圈** —— Auth 端点都是短同步请求，无长任务、无 SSE 自有流；唯一关联 SSE 是「受保护 SSE 流鉴权」（§5，遵脊柱 §11.C 同源 Cookie、建流前 HTTP 失败），按脊柱帧协议、不另造帧。
> 2. **绝不裸露错误码** —— 鉴权失败（401/403）只出 `ErrorEnvelope`，唯一可展示字段是 `userMessage`（人话，如「登录态失效了，请重新登录」「你没有权限做这个操作」）+ `action`，**禁止**把内部 `error.code`、JWT 校验原始报错（`jwt expired` / `invalid signature` / `audience mismatch`）、Logto 上游 HTTP 状态、OIDC 错误码裸出。**登录失败重定向用 opaque `failureId`、不带内部 code**（脊柱 §11.B Codex#11）。落地于 §3.2 登录回调、§4 错误用例。
> 3. **已生成内容不丢** —— Auth 无产物。但登录态过期时前端跳登录、回跳后凭草稿 + 断点续传（脊柱 §8）回到原步骤，不打回从头；本域只负责「过期给可操作退路」，不破坏续传。

---

## 1. 域职责边界

**本域负责（B-08）**：

- Logto 自托管 OIDC 授权码流的「登录跳转 / 回调换会话 / 登出」三端点。
- 受保护路由的 **JWT 校验中间件契约**：从 `Authorization: Bearer <jwt>` 提取并验签（issuer / JWKS / audience / exp），解出 `AuthContext`（userId + 角色），失败统一落 `ErrorEnvelope`。
- `GET /me`：当前登录用户视图（账号、双角色、profile 摘要引用）。
- **首登即建档**：Logto `sub`（OIDC subject）⟷ 业务 `users.id` 的映射与首登 upsert 约定。
- **单账号双角色**：同一账号同时具备「创作者 / 消费者」两角色，角色经 JWT claim 携带、由中间件解析为 `roles`（详见 §6）。
- **share_token 匿名身份**：匿名访问的身份键签发与解析契约（`consumerKey`，本期仅解析、不写计量）。
- `users` 表 DDL（含 `logto_user_id` 唯一约束）。

**本域不负责（划清边界，避免与其他域契约重叠）**：

- `creator_profiles`（公开名片字段、头像 / 昵称 / 简介 / 关注粉丝获赞计数）的存储与读取 —— 属**主页域**（B-33）。本文 `users` 仅存账号映射与角色，`/me` 对 profile 只做引用（`hasProfile` + `creatorId`），不返回名片全字段。
- `follows` / `likes` 社交 —— 属**主页域**（B-34）。
- share_token 的**签发**（发布私享链接时生成 `publications.share_token`）—— 属**发布域**（B-30）；本文只定义 share_token **如何换匿名身份键、如何在请求里被解析**。
- Logto 容器编排 / `logto_db_seed` / `logto_alteration` 启动序 —— 属 **O-02 / O-03**（运维域）；本文只声明运行期所需 env 与 `/ready` 中 logto 依赖的断言口径（与脊柱 §10 一致）。
- usage 计量 / 限流真正落库 —— 本期置空（决策②），本文只冻结匿名身份键形态。

---

## 2. 认证模型总览

```
浏览器 ──(1) GET /api/v1/auth/login?returnTo=/creator──► api
   │                                                      └─► 302 到 Logto 授权端点（带 state/nonce/PKCE）
   ▼
 Logto 登录页（magic link / GitHub OAuth）── 用户完成登录
   │
   ▼ (2) 302 回 LOGTO_REDIRECT_URI = /api/v1/auth/callback?code=...&state=...
  api ──(3) 用 code 向 Logto token 端点换 token ──► 校验 id_token（issuer/aud/nonce）
   │   └─► 首登 upsert users（logto_user_id=sub）
   │   └─► 下发会话：HttpOnly Cookie（携带 access_token / 刷新引用）
   ▼ (4) 302 回 returnTo（默认 /creator 工作台）
浏览器后续请求 ──► api 中间件：从 Cookie 取 access_token → 验签(JWKS/issuer/aud/exp) → AuthContext
```

**会话承载方式（取舍）**：浏览器侧用 **HttpOnly + Secure + SameSite=Lax 的会话 Cookie** 承载 access_token（防 XSS 读取 token），而非把 token 交给前端 JS 存 localStorage。OpenAPI codegen client / 服务端调用方走 **`Authorization: Bearer <jwt>`** 头（标准 Logto JWT，进同一套 JWT 校验中间件）。**本机助手直传路径（B-21 connect/upload）不进 Logto JWT 中间件**——它走**独立 PairAuth（`pairId` + `pairingCode`）**：助手凭网页所铸一次性配对码上传，请求带表单字段 `pairId` + `Authorization: Bearer <pairingCode>`，服务端按 `pairId` 定位 `import_pairings` 行后校验 `pairing_code_hash`（**不**是 Logto JWT、**无** token exchange），失败计数绑定在 pairing 校验阶段（口径详见 20-step1-import §3.3 / §6.4）。配对码不与 Logto JWT 互换、互为独立鉴权（避免双套鉴权）。

> 验收对齐：外壳首页-01（登录后默认落工作台）= 回调成功 302 回 `/creator`；外壳首页-20/31（工作台 / 数据分析 / 收益页只对本人可见）= 受保护路由中间件 + 资源 owner 校验（§6.3）；主页-13（访客看公开名片）= 主页 profile 端点用 `optionalAuth`、不强制登录。

---

## 3. 端点契约

> 所有端点在脊柱前缀 `/api/v1` 下。成功响应裹 `Envelope<T>`；失败只出 `ErrorEnvelope`（脊柱 §3）。下方 schema 用 zod 风格片段（最终归 `src/shared/`，zod 即 OpenAPI 3.1 真源）。

### 3.1 `GET /api/v1/auth/login` — 发起登录（302 跳 Logto）

| 项 | 值 |
|---|---|
| method + path | `GET /api/v1/auth/login` |
| 鉴权 | **无**（未登录入口） |
| 幂等 | 天然幂等（GET，无副作用，不需 `Idempotency-Key`）；每次生成新 state/nonce/PKCE verifier 存短时会话 |
| 响应 | **302 Redirect** 到 Logto 授权端点；非 JSON 包络（重定向语义） |

**请求 query（zod 片段）**：

```typescript
const LoginQuery = z.object({
  // 登录成功后回跳的站内路径（白名单校验：必须以 "/" 开头、不得是外站 URL，防 open redirect）
  returnTo: z.string().startsWith('/').max(512).optional(), // 缺省 "/creator"（工作台）
  // 提示首选登录方式（透传给 Logto，可选）
  // 'magic_link' | 'github'
  prompt: z.enum(['magic_link', 'github']).optional(),
});
```

**行为**：

- 生成 `state`（CSRF）、`nonce`（绑定 id_token）、PKCE `code_verifier`，落短时服务端会话（Cookie `auth_tx`，HttpOnly，TTL ≤ 10min）。
- `returnTo` 经**白名单校验**（仅站内相对路径），存入 `auth_tx`；非法值降级为 `/creator`，不报错、不裸跳外站。
- 302 到 `{LOGTO_ISSUER}` 对应授权端点，`redirect_uri = LOGTO_REDIRECT_URI`。

**错误用例**：本端点几乎不返错（非法 query 降级而非报错）；Logto 不可达时不在此暴露（不预拉 Logto），失败发生在回调步。

---

### 3.2 `GET /api/v1/auth/callback` — OIDC 回调换会话（302 回站内）

| 项 | 值 |
|---|---|
| method + path | `GET /api/v1/auth/callback`（= `LOGTO_REDIRECT_URI`，本地 `http://localhost/api/v1/auth/callback`） |
| 鉴权 | **无**（持 `code` + `state` 即换会话；靠 state/PKCE 防伪） |
| 幂等 | code 一次性（Logto 侧），重复 callback 同 code 第二次失败 → 走 `change_input`（重新登录）；不引入 `Idempotency-Key`（OAuth 语义自带一次性） |
| 响应 | 成功 **302** 回 `auth_tx.returnTo`（默认 `/creator`），并 `Set-Cookie` 会话；失败 **302** 回 `/login?failureId=<opaque>`（脊柱 §11.B Codex#11：opaque `failureId`，**不带内部 code**；前端据 `failureId` 查预置文案表或调失败说明读接口渲染人话），不裸返 JSON 错误页、不把内部 code 进 URL |

**请求 query（zod 片段）**：

```typescript
const CallbackQuery = z.object({
  code: z.string().optional(),          // 授权码（成功路径）
  state: z.string().optional(),         // 必须与 auth_tx.state 匹配
  error: z.string().optional(),         // Logto 侧错误（如 access_denied）
  error_description: z.string().optional(),
});
```

**行为**：

1. 校验 `state` == `auth_tx.state`；不匹配 → `AUTH_STATE_MISMATCH`（见 §4）。
2. 用 `code` + PKCE `code_verifier` 向 Logto token 端点换 `id_token` / `access_token`。
3. 校验 `id_token`：`iss` == `LOGTO_ISSUER`、`aud` == `LOGTO_APP_ID`、`nonce` == `auth_tx.nonce`、`exp` 未过期、JWKS 验签。
4. **首登 upsert**：`INSERT users(logto_user_id=sub, ...) ON CONFLICT (logto_user_id) DO UPDATE last_login_at`（见 §7）。
5. 下发会话 Cookie（HttpOnly/Secure/SameSite=Lax），清理 `auth_tx`。
6. 302 回 `auth_tx.returnTo`。

**错误用例**（统一 302 回 `/login?failureId=<opaque>`；服务端把 `failureId` 映射到下表内部 code + `traceId` 落日志，前端据 `failureId` 渲染对应人话 `userMessage`，绝不裸露原始 OIDC 报错或内部 code）：

| 触发 | 内部 code（仅日志/映射，不进 URL/前端） | HTTP（内部判定） | retriable | action | 人话 `userMessage`（前端渲染） |
|---|---|---|---|---|---|
| `state` 不匹配 / `auth_tx` 缺失或过期 | `AUTH_STATE_MISMATCH` | 400 | false | `change_input` | 「登录会话过期了，请重新登录。」 |
| 用户在 Logto 取消授权（`error=access_denied`） | `AUTH_CONSENT_DENIED` | 400 | false | `change_input` | 「登录未完成，可以再试一次。」 |
| code 换 token 失败 / id_token 校验不过 | `AUTH_CALLBACK_FAILED` | 400 | false | `change_input` | 「登录没能完成，请重新登录。」 |
| Logto token 端点不可达 / 超时 | `AUTH_UPSTREAM_UNAVAILABLE` | 503 | true | `escalate` | 「登录服务正在恢复，请稍候再试。」 |

> 硬约束（脊柱 §11.B Codex#11）：内部 code、`error_description`、Logto 原始 `error`、JWT 库报错串**禁止**进 URL / `userMessage` / 前端展示；失败重定向**只带 opaque `failureId`**（随机短串，服务端映射到内部 code + `traceId`），内部 code 永不进 `/login?...`。上游不可达类用 `action:'escalate'`（§11.B 收敛可展示退路为 `retry|change_input|escalate`，前端给「稍后再试 / 反馈」入口，配 `traceId` 反馈代码）。

---

### 3.3 `POST /api/v1/auth/logout` — 登出

| 项 | 值 |
|---|---|
| method + path | `POST /api/v1/auth/logout` |
| 鉴权 | **可选**（已登录则清会话；未登录幂等返成功） |
| 幂等 | 幂等（重复登出同结果）；POST 但语义幂等，**可不带 `Idempotency-Key`**（清会话无「重复副作用」风险，与脊柱 §4「写命令带 key」的例外：登出是会话销毁、无产物、无连坐） |
| 响应 | `200 Envelope<{ loggedOut: true; logoutUrl?: string }>` |

**行为**：

- 清除会话 Cookie（`Set-Cookie` 过期）。
- 可选返回 Logto 的 RP-Initiated Logout URL（`logoutUrl`），前端可再跳 Logto 结束 IdP 会话；不返也可（仅清本地会话）。
- 未登录调用同样返 `200 { loggedOut: true }`（幂等，不报 401）。

**响应 schema（zod 片段）**：

```typescript
const LogoutResponse = z.object({
  loggedOut: z.literal(true),
  logoutUrl: z.string().url().optional(), // Logto RP-initiated logout，前端可选跳转
});
```

---

### 3.4 `GET /api/v1/me` — 当前登录用户

| 项 | 值 |
|---|---|
| method + path | `GET /api/v1/me` |
| 鉴权 | **必需**（`requireAuth`） |
| 幂等 | 天然幂等（GET） |
| 响应 | `200 Envelope<MeView>` |

**响应 schema（zod 片段，对应 §8 `MeView`）**：

```typescript
const MeView = z.object({
  id: z.string(),                         // users.id（UUID v7），对外字符串
  logtoUserId: z.string(),                // OIDC sub（前端一般不用，便于支持/反馈）
  account: z.string(),                    // 展示账号名（如 "@WAYNE"，发布署名取此，发布-05）
  email: z.string().email().nullable(),   // 可空（GitHub 无邮箱时）
  roles: z.array(z.enum(['creator', 'consumer'])), // 单账号双角色（§6）
  status: z.enum(['active', 'disabled']),
  hasProfile: z.boolean(),                // 是否已建公开名片（profile 详情在主页域）
  creatorId: z.string(),                  // = id，作为主页 /creators/{creatorId}/profile 寻址
  createdAt: z.string(),                  // IsoDateTime
  lastLoginAt: z.string().nullable(),
});
```

**说明**：

- `account` 是发布署名真源（验收 发布-05「市集卡署名自动取创作者账号 @WAYNE，不可手填」）—— 发布域取 `users.account`，本域负责其唯一性与首登初始化。
- `roles` 恒含 `creator`（本期创作者中心场景）；`consumer` 角色用于试用 / 消费链路（本期 schema 冻结、行为占位）。
- profile 全字段（头像 / 昵称 / 简介 / 关注粉丝获赞）**不在此返回**，前端要名片时走主页域 `GET /api/v1/creators/{creatorId}/profile`。

**token 来源（JWT 中间件接受两种）**：

1. **会话 Cookie**（浏览器路径，§2）：HttpOnly Cookie 中的 access_token。
2. **`Authorization: Bearer <jwt>`**（OpenAPI codegen client / 服务端调用方）：标准 Logto JWT Bearer 头。

两者解出的 token 走**同一套 JWT 校验**（§4.1）。Cookie 与 Bearer 同时存在时以 `Authorization` 头优先。

> **B-21 本机助手直传不在此列**：`POST /import/connect/upload` 走**独立 PairAuth（`pairId` + `pairingCode`）**，**不进 JWT 中间件、不做 token exchange**——`Authorization: Bearer` 头里携带的是**一次性配对码**（非 Logto JWT），服务端按 `pairId` 定位 `import_pairings` 行后比对 `pairing_code_hash`，失败计数与限流绑定在 pairing 校验阶段（口径以 20-step1-import §3.3 / §6.4 为唯一真源，本域不重定义）。配对码与 Logto JWT 互不互换，杜绝双套鉴权。

---

## 4. JWT 校验中间件契约

> 中间件落 `src/api/middleware/`（鉴权 / 限流 / 错误 envelope，见技术方案 §文件树）。它是所有受保护路由的入口闸；本节定义其**契约**（输入 / 校验项 / 输出 / 失败映射），不写实现。

### 4.1 校验项（issuer / JWKS / audience / exp）

中间件对从 token 来源（§3.4）取到的 JWT 依次校验：

| 校验项 | 断言 | env / 来源 |
|---|---|---|
| 签名 | 用 JWKS 公钥验签（RS256 等非对称） | JWKS = `{LOGTO_ISSUER}/jwks`（= `LOGTO_JWKS_URI`），缓存 + 按 `kid` 轮换拉取 |
| `iss` | == `LOGTO_ISSUER`（本地 `http://logto:3001/oidc`） | `LOGTO_ISSUER` |
| `aud` | 包含本服务 API resource indicator / `LOGTO_APP_ID`（按 Logto API resource 配置断言） | `LOGTO_APP_ID` / API resource |
| `exp` | 未过期（含时钟偏移容忍 ≤ 60s） | token claim |
| `nbf` | 若存在，已生效 | token claim |
| 角色 claim | 解析 `roles` / `scope`（Logto 角色 → `('creator'｜'consumer')[]`） | token claim（§6.1） |

**JWKS 处理**：本地缓存 JWKS，遇未知 `kid` 触发一次刷新拉取（防密钥轮换后误判）；JWKS 拉取本身不可达时，对受保护请求返 `AUTH_UPSTREAM_UNAVAILABLE`（503 / `escalate`，§11.B 收敛口径，前端给「稍后再试 / 反馈」入口），而非 401（区分「token 真无效」与「暂时验不了」），并不裸露上游报错。

### 4.2 输出 `AuthContext`

校验通过后注入请求上下文（对应 §8 `AuthContext`），下游 handler / owner 校验取用：

```typescript
interface AuthContext {
  userId: UserId;                          // 已映射的业务 users.id（非 sub）
  logtoUserId: string;                     // OIDC sub
  roles: Array<'creator' | 'consumer'>;
  account: string;
  authSource: 'cookie' | 'bearer';
  // 匿名身份：仅 optionalAuth 且无登录态、持 share_token 时填充（§6.4），登录态下为 undefined
  anonymous?: { consumerKey: string; shareToken: string };
}
```

### 4.3 三种中间件守卫（鉴权约定）

| 守卫 | 行为 | 用于 |
|---|---|---|
| `requireAuth` | 必须有有效 token，否则 `401 UNAUTHENTICATED`（`escalate`，前端跳登录） | 工作台 / 五步流程 / `/me` / 所有创作者私有写读 |
| `optionalAuth` | 有 token 则解 `AuthContext`；无 token 不报错，可降级匿名（持 share_token 填 `anonymous`） | 公开主页 `GET /creators/{id}/profile`、公开市集读、私享 share_token 访问 |
| `requireRole(role)` | 在 `requireAuth` 基础上断言 `roles` 含指定角色，否则 `403 FORBIDDEN`（`escalate`） | 需创作者角色的写命令（建能力 / 发布等，由各域按需挂载） |

> **资源 owner 校验**（外壳首页-20/31「只对本人可见」）不在通用中间件层做，而是各受保护资源 handler 内断言 `resource.owner_user_id == ctx.userId`，不匹配 → `403 FORBIDDEN`。本文给出统一约定（§6.3），各域沿用。

### 4.4 错误用例（映射脊柱错误分类与 action）

> 全部只出 `ErrorEnvelope`（脊柱 §3 / §11.B）。唯一可对 UI 展示的是 `userMessage`（人话）+ `action`；内部 `error.code` 仅供日志/告警/文案映射，**UI 永不渲染**；不含 JWT/OIDC 原始报错；HTTP 状态行不裸进 body。

| 触发 | HTTP | 内部 code（仅日志/映射，UI 不渲染） | retriable | action | 人话 `userMessage` |
|---|---|---|---|---|---|
| 无 token / token 缺失（`requireAuth`） | 401 | `UNAUTHENTICATED` | false | `escalate` | 「登录态失效了，请重新登录。」 |
| token 过期（`exp`） | 401 | `UNAUTHENTICATED` | false | `escalate` | 「登录态失效了，请重新登录。」 |
| token 签名 / `iss` / `aud` / `nonce` 不合法 | 401 | `UNAUTHENTICATED` | false | `escalate` | 「登录态失效了，请重新登录。」 |
| 已登录但缺所需角色（`requireRole`） | 403 | `FORBIDDEN` | false | `escalate` | 「你没有权限做这个操作。」 |
| 已登录但非资源 owner（本人可见） | 403 | `FORBIDDEN` | false | `escalate` | 「你没有权限查看这个内容。」 |
| 账号被禁用（`users.status='disabled'`） | 403 | `FORBIDDEN` | false | `escalate` | 「账号当前不可用，请联系支持。」（带 traceId） |
| JWKS / Logto 暂不可达（验不了，非「token 无效」） | 503 | `AUTH_UPSTREAM_UNAVAILABLE` | true | `escalate` | 「登录服务正在恢复，请稍候再试。」 |
| share_token 不存在 / 已失效（`optionalAuth` 匿名路径） | 404 | `NOT_FOUND` | false | `change_input` | 「没找到对应内容，可能已被删除或链接失效。」 |

> 细分内部 code（如 `AUTH_TOKEN_EXPIRED` / `AUTH_BAD_SIGNATURE`）**仅供内部日志 / 告警 / 文案映射**，对外统一收口到 `UNAUTHENTICATED`，前端只据 `action=escalate`（脊柱 §11.B：UI 永不渲染 `code`）跳登录，绝不分别向用户暴露「为什么无效」的技术原因。
>
> `action` 收敛口径（脊柱 §11.B Codex#11）：可对 UI 展示的核心退路为 `retry | change_input | escalate` 三类。鉴权失败一律 `escalate`（跳登录/反馈）；JWKS/Logto 暂不可达此前用 `wait`，本域统一改 `escalate`（前端给「稍后再试 / 反馈」入口 + `traceId` 反馈代码），与 §3.2 上游不可达口径一致，不再用 `wait`。

---

## 5. 受保护 SSE 流的鉴权约定（对齐脊柱 §5 / §11.C）

> **唯一权威见脊柱 §11.C（Codex#5 · SSE 鉴权统一）**：所有 SSE 流（job / structure / 未来 session）**统一同源 Cookie 会话鉴权，禁 query-string token、禁自定义 header 作主鉴权**；鉴权/权限失败必须在**建流之前**返 HTTP `ErrorEnvelope`，**绝不**用 SSE `error` 帧表达鉴权失败。本节是其在 Auth 域的落地，与 §11.C 完全一致；相邻 40-structure §4.D「Bearer / 查询参 / 头透传 token / 连接级失败走 error 帧」表述**作废**（须改齐本节）。

Auth 域不拥有自己的 SSE 流，但所有 job / structure SSE 端点（`GET /api/v1/jobs/{jobId}/events`、`GET /api/v1/versions/{versionId}/structure/events`）受本域中间件保护。约定（= §11.C）：

- **鉴权只用同源 Cookie**：EventSource / `fetch-event-source` 自动携带同源会话 Cookie，中间件按 §4 校验后才建流；SSE **不接受 query string 传 token**（避免 token 进日志 / referer / 浏览器历史泄漏），**不接受自定义 header token 作主鉴权**（EventSource 原生不支持自定义头，且与 Cookie 口径分叉）。SSE 鉴权口径**只有 Cookie 一种**。
- **鉴权/权限失败前置 HTTP**：未登录建流 → `401 UNAUTHENTICATED` + `action:'escalate'`；非 owner / 缺角色 → `403 FORBIDDEN` + `action:'escalate'`。一律在**建立流之前**以普通 HTTP 响应返 `ErrorEnvelope`，**不**进流再发 error 帧。
- **owner 校验**：流对应 job/version 必须属当前 `ctx.userId`，否则建流前 `403 FORBIDDEN`。
- **流中途 token 过期**：长连接期间不强制中断已建立的流（连接已鉴权）；下一次重连若 token 失效，重连握手即 HTTP `401`（非帧），前端据此跳登录。重连握手不破坏脊柱「先 `state_snapshot` 再续增量」的恢复（鉴权失败发生在握手前，不进帧流）。
- **不另造帧**：鉴权相关失败一律走 HTTP `ErrorEnvelope`（脊柱 §3 / §11.B），不新增 SSE 事件类型，沿用脊柱 12 类帧；SSE `error` 帧只表达「已建流、已鉴权后的业务失败终态」。

---

## 6. 单账号双角色 + owner 可见性 + 匿名身份

### 6.1 双角色 claim 解析

- Logto 侧给账号配「creator」「consumer」两角色（同一账号可同时持有），角色随 access_token 的 `roles`（或 `scope`）claim 下发。
- 中间件把 Logto 角色字符串映射为内部 `roles: ('creator'|'consumer')[]`，存入 `AuthContext`，并冗余落 `users.roles`（首登 / 角色变更时同步，便于无 token 的服务端逻辑读取）。
- 本期创作者中心主链路只实际门禁 `creator`（建能力/结构化/发布/批量发布走 `requireRole('creator')`）；**社交写（follow/like）是例外——按脊柱 §11.F 走 `requireAuth`、不限角色**（§6.2）。`consumer` 角色解析就绪但消费链路本期不交付（决策③，schema 冻结、行为占位）。

### 6.2 角色门禁挂载（供各域引用，本文不重复各域端点）

| 场景 | 守卫 |
|---|---|
| 工作台 / 数据分析 / 收益 / 五步流程 / `/me` | `requireAuth`（+ handler owner 校验） |
| 建能力 / 结构化 / 发布 / 批量发布 | `requireRole('creator')` |
| **社交写（follow / like 及其 DELETE 取消）** | **`requireAuth`**（任意已登录用户，**不**限 creator role；脊柱 §11.F Codex#17） |
| 公开主页读 / 公开市集读 / 私享访问 | `optionalAuth` |

> 社交写权限唯一权威见脊柱 §11.F：follow/like 是消费侧基础互动，限定 creator 会让普通登录用户无法关注创作者，违背产品意图，故对**任意已登录用户**开放。仍需 `Idempotency-Key`（写命令）；匿名 `optionalAuth` 不可写社交，未登录写 → `401 UNAUTHENTICATED` + `action:'escalate'`。「自己不能关注/点赞自己」等业务校验归 60-profile 域。本表与 60-profile 权限表、错误用例、前端权限态必须一致。

### 6.3 owner 可见性约定（「只对本人可见」统一口径）

外壳首页-20/31 要求工作台 / 数据分析 / 收益页**只对创作者本人可见**，钱 / 成本数据绝不外泄。统一约定：

- 凡「私有经营数据」资源（dashboard、收益、草稿、job、version 等）的 handler，在 `requireAuth` 之后断言 `owner_user_id == ctx.userId`，否则 `403 FORBIDDEN`（人话「你没有权限查看这个内容」）。
- 公开名片（主页域 B-33）走 `optionalAuth` + 公开字段口径，**不**经 owner 校验（任何人可看同一张只读名片，主页-13），且公开口径**不带钱 / 成本 / token**（由主页域字段裁剪保证，本域只保证「访客 token 缺失不报错」）。
- 这条约定是各域共用的「可见性脊柱补充」，各资源域按此挂载，不各自发明。

### 6.4 share_token 匿名身份键（consumerKey）

- 匿名访问（无登录态、持私享 `share_token`）走 `optionalAuth`，中间件按脊柱 §1.3 口径计算匿名身份键：

  ```
  consumerKey = hash(share_token + anon_cookie)
  ```

  其中 `anon_cookie` 是首次匿名访问下发的稳定匿名 Cookie（HttpOnly）。结果填入 `AuthContext.anonymous`。
- `consumerKey` **本期仅用于解析与（未来）限流 / 日成本上限 / 活跃消费者去重**；决策② usage 置空 —— **本期不写 `usage_events`、不计数、不限流落库**，活跃消费者卡显示「暂无数据 / 上线后填充」占位（验收 外壳首页-32 占位即过）。
- share_token 的**签发**属发布域（B-30 `publications.share_token`）；本域只定义「请求里 share_token 如何被解析成匿名身份」。

> 验收 外壳首页-32：活跃消费者口径含匿名（按 `consumerKey` 去重），与个人主页对外粉丝 / 获赞计数分属两套口径；本域只冻结匿名键形态，计数本期占位。

---

## 7. users 表 DDL（PostgreSQL）

> 体现 Phase 0 关键正确性决策：**去重键** `logto_user_id` UNIQUE（OIDC `sub` 一对一，首登 upsert 防重复建档）、`account` UNIQUE（发布署名唯一）。**血缘**：`users.id` 是 jobs / drafts / capabilities / creator_profiles 等表 `owner_user_id` 的被引方（脊柱 jobs/drafts DDL 已 `REFERENCES users(id)`）。本表是账号映射真源，公开名片字段在主页域 `creator_profiles`，不在此表。

```sql
-- users（B-08）：Logto subject ⟷ 业务账号映射 + 角色，账号真源
-- 归 src/infra/pg/migrations/，与 jobs/drafts（脊柱 §6/§8）同批核心表（B-02）
CREATE TABLE users (
  id             uuid        PRIMARY KEY DEFAULT gen_uuid_v7(),   -- 对外字符串 ID（UUID v7，时间有序）
  logto_user_id  text        NOT NULL,                            -- OIDC sub（去重键，首登 upsert 锚点）
  account        text        NOT NULL,                            -- 展示账号名（如 "WAYNE"，发布署名取此）
  email          text,                                            -- 可空（GitHub 登录可能无邮箱）
  roles          text[]      NOT NULL DEFAULT '{creator}',        -- 单账号双角色冗余：creator|consumer
  status         text        NOT NULL DEFAULT 'active',           -- active|disabled
  last_login_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT users_status_chk CHECK (status IN ('active','disabled')),
  CONSTRAINT users_roles_chk  CHECK (roles <@ ARRAY['creator','consumer']::text[])
);

-- 去重键：OIDC sub 一对一，首登 ON CONFLICT (logto_user_id) DO UPDATE 防并发重复建档
CREATE UNIQUE INDEX uq_users_logto_user_id ON users (logto_user_id);
-- 账号名唯一（发布署名 @account 不可重；大小写不敏感去重，避免 WAYNE/wayne 撞名）
CREATE UNIQUE INDEX uq_users_account_lower ON users (lower(account));
-- email 唯一但允许多条 NULL（GitHub 无邮箱时不冲突）
CREATE UNIQUE INDEX uq_users_email_lower ON users (lower(email)) WHERE email IS NOT NULL;
```

**首登 upsert 约定（说明语义，非实现代码）**：

```sql
INSERT INTO users (logto_user_id, account, email, roles, last_login_at)
VALUES ($sub, $account, $email, $roles, now())
ON CONFLICT (logto_user_id)
DO UPDATE SET last_login_at = now(),
             email = COALESCE(EXCLUDED.email, users.email),
             roles = EXCLUDED.roles,            -- 角色以 Logto 为权威，每次登录同步
             updated_at = now()
RETURNING id;
```

> `account` 首登从 Logto profile（username / GitHub login / email 前缀）派生，撞 `uq_users_account_lower` 时追加后缀消歧（如 `wayne-2`）；创建后稳定（发布署名一致性）。

---

## 8. 本域 TS 类型片段

> import 脊柱 §9 共享类型（`UserId` / `Id` / `Envelope` / `ErrorEnvelope` / `ErrorAction` / `IsoDateTime` 等），不重定义。下为本域新增类型，最终归 `src/shared/`（zod schema 即 OpenAPI 真源，本片段为人读镜像）。

```typescript
import type { UserId, IsoDateTime, Envelope } from '@/shared';

// ---------- 角色 ----------
export type Role = 'creator' | 'consumer';
export type UserStatus = 'active' | 'disabled';

// ---------- /me 视图 ----------
export interface MeView {
  id: UserId;
  logtoUserId: string;       // OIDC sub
  account: string;           // 展示账号（发布署名取此，发布-05）
  email: string | null;
  roles: Role[];             // 单账号双角色
  status: UserStatus;
  hasProfile: boolean;       // 公开名片是否已建（详情在主页域）
  creatorId: UserId;         // = id，主页 /creators/{creatorId}/profile 寻址
  createdAt: IsoDateTime;
  lastLoginAt: IsoDateTime | null;
}
export type MeResponse = Envelope<MeView>;

// ---------- 登出 ----------
export interface LogoutResult {
  loggedOut: true;
  logoutUrl?: string;        // Logto RP-initiated logout，前端可选跳转
}
export type LogoutResponse = Envelope<LogoutResult>;

// ---------- 鉴权上下文（中间件注入，非对外响应体）----------
export interface AuthContext {
  userId: UserId;            // 已映射业务 users.id（非 sub）
  logtoUserId: string;
  roles: Role[];
  account: string;
  authSource: 'cookie' | 'bearer';
  anonymous?: AnonymousIdentity; // 仅 optionalAuth 匿名 + 持 share_token 时填充
}

// ---------- 匿名身份（share_token 路径；本期仅解析、usage 置空）----------
export interface AnonymousIdentity {
  consumerKey: string;       // hash(share_token + anon_cookie)，限流/去重用，本期不落库
  shareToken: string;
}

// ---------- 中间件守卫标识（路由声明用）----------
export type AuthGuard =
  | { mode: 'requireAuth' }
  | { mode: 'requireRole'; role: Role }
  | { mode: 'optionalAuth' };
```

---

## 9. 环境变量（运行期所需，与 O-02/§6.1 对齐）

> 容器编排属运维域；本表列本域中间件 / 端点运行期读取的 env，口径与技术方案 B-08 一致。

| env | 含义 | 本地示例 |
|---|---|---|
| `LOGTO_ENDPOINT` | Logto 运行态端点 | `http://logto:3001` |
| `LOGTO_ISSUER` | OIDC issuer（验签 `iss` 锚点 + `/ready` 探针基址） | `http://logto:3001/oidc` |
| `LOGTO_JWKS_URI` | JWKS 地址（= `{LOGTO_ISSUER}/jwks`） | `http://logto:3001/oidc/jwks` |
| `LOGTO_APP_ID` | 本服务 application id（验 `aud`） | — |
| `LOGTO_APP_SECRET` | code 换 token 的客户端密钥 | —（机密） |
| `LOGTO_REDIRECT_URI` | 回调域名（= `/api/v1/auth/callback`） | `http://localhost/api/v1/auth/callback` |

> 健康检查（`/ready` 中 logto 依赖）口径见脊柱 §10.2：拉 `GET {LOGTO_ISSUER}/.well-known/openid-configuration`，断言返回 `issuer` 与 `jwks_uri` 存在且 `issuer` 匹配，通才 ready（**不用** `{LOGTO_ENDPOINT}/api/.well-known/...` 错误路径）。logto down 计入 required 依赖，`ready=false`；本域不重定义健康检查端点，仅声明此断言归属。

---

## 10. 功能点覆盖表

### 10.1 功能点 → 端点 / 表

| 功能点 | 内容 | 对应端点 | 对应表 |
|---|---|---|---|
| **B-08** | Logto 自托管接入 + JWT 鉴权中间件 | `GET /api/v1/auth/login`、`GET /api/v1/auth/callback`、`POST /api/v1/auth/logout`、`GET /api/v1/me` + JWT 校验中间件（`requireAuth`/`requireRole`/`optionalAuth`） | `users`（本域新建，含 `logto_user_id` UNIQ 去重键、`account` UNIQ 署名键、`roles[]` 双角色） |

> **B-21**（本机助手直传）**不依赖本域 JWT 链路**——它走独立 PairAuth（`pairId` + `pairingCode`，不进 JWT 中间件、无 token exchange），鉴权 / 失败计数口径以 20-step1-import §3.3 / §6.4 为唯一真源，本域仅在 §2 token 来源处声明「配对码不进 JWT 中间件」以杜绝双套鉴权。本域为 **B-32/B-33/B-34/F-04** 等所有依赖登录 / 鉴权 / owner 可见性 / 公开访问的功能点提供三种守卫 + owner 校验约定（§4.3/§6.3）；为 **B-30** 提供 share_token → 匿名身份键解析口径（§6.4）；为 **O-04** 提供 logto 依赖断言归属（§9）。这些为「被引用 / 提供契约」，端点 / 表归各自域。

### 10.2 涉及的验收用例模块

| 验收用例 | 本域承担的口径 |
|---|---|
| 外壳首页-01（登录后默认落工作台） | `auth/callback` 成功 302 回 `returnTo` 默认 `/creator` |
| 外壳首页-20（工作台只对本人可见、含经营数据） | `requireAuth` + handler owner 校验（§6.3）；非本人 `403 FORBIDDEN` 人话 |
| 外壳首页-31（数据分析 / 收益页只对本人可见） | 同上 owner 可见性约定 |
| 外壳首页-32（活跃消费者含匿名访客、与公开计数分清） | `consumerKey = hash(share_token+anon_cookie)` 匿名键形态冻结；本期 usage 置空、计数占位 |
| 主页-13（访客看公开名片、全程只读） | `optionalAuth`：访客无 token 不报错；公开口径不带钱 / 成本（字段裁剪在主页域） |
| 发布-05（市集卡署名自动取创作者账号 @WAYNE） | 署名取 `users.account`（本域唯一性 + 首登初始化保证） |
| 接口-（鉴权失败、异常不裸露错误码） | 所有鉴权失败只出 `ErrorEnvelope`，唯一可展示 `userMessage`+`action`、内部 `code` UI 永不渲染（§4.4 / 脊柱 §11.B）；登录失败重定向用 opaque `failureId`、不带内部 code（§3.2）；禁裸 JWT/OIDC 报错 |

---

## 附：合并校验摘要

**端点清单（method + path）**

- `GET /api/v1/auth/login` — 发起登录，302 跳 Logto（无鉴权）
- `GET /api/v1/auth/callback` — OIDC 回调换会话，302 回站内（无鉴权）
- `POST /api/v1/auth/logout` — 登出，清会话（可选鉴权，幂等）
- `GET /api/v1/me` — 当前登录用户（`requireAuth`）

**表清单**

- `users`（新建）：`id` PK(UUID v7)、`logto_user_id` UNIQ（去重键）、`account` UNIQ(lower)（署名键）、`email` UNIQ(lower) partial、`roles[]`、`status`、`last_login_at`。是 jobs/drafts/capabilities/creator_profiles 等 `owner_user_id` 外键被引方（血缘根）。

**SSE 事件清单**

- 本域无自有 SSE 流 / 无新增事件类型。仅定义「受保护 SSE 流（job/structure）的鉴权约定」：Cookie 握手鉴权 + owner 校验，失败走 HTTP `ErrorEnvelope`（不进帧流），完全沿用脊柱 12 类帧（§5）。

**引用到的脊柱共享类型（§9）**

- `Id` / `UserId`、`IsoDateTime`、`Envelope<T>`、`ErrorEnvelope` / `ErrorAction`、`Meta`（traceId）。
- 错误分类缺省沿用脊柱 §3.3，并按 §11.B 收敛可展示退路为 `retry|change_input|escalate`：`UNAUTHENTICATED`(401/escalate)、`FORBIDDEN`(403/escalate)、`NOT_FOUND`(404/change_input)、`DEPENDENCY_UNAVAILABLE`/`AUTH_UPSTREAM_UNAVAILABLE`(503/escalate，本域上游不可达统一 escalate、不用 wait)、`VALIDATION_FAILED`(400/change_input)。唯一可展示字段 = `userMessage`+`action`，内部 `code` UI 永不渲染。
- 健康检查口径沿用脊柱 §10（logto 为 required 依赖，断言 `issuer`/`jwks_uri`）。

**本域新增 TS 类型（归 src/shared/）**

- `Role`、`UserStatus`、`MeView` / `MeResponse`、`LogoutResult` / `LogoutResponse`、`AuthContext`、`AnonymousIdentity`、`AuthGuard`。

**关键正确性决策（Phase 0）**

- 去重键 `logto_user_id` UNIQUE + 首登 `ON CONFLICT DO UPDATE`（防并发重复建档）；`account` 唯一（发布署名一致）。
- token 双来源（Cookie 优先级低于 Bearer）走同一 JWT 校验；SSE 仅 Cookie、不走 query token（防泄漏）。
- 「JWKS/Logto 暂不可达」与「token 真无效」区分：前者 503/escalate（§11.B 收敛，不用 wait），后者 401/escalate，均不裸露原始报错；唯一可展示 `userMessage`+`action`，内部 `code` 不渲染。
- 登录失败重定向用 opaque `failureId`、不带内部 code（§3.2，遵脊柱 §11.B Codex#11）。
- 社交写权限 = `requireAuth`（任意已登录用户，不限 creator role；§6.2，遵脊柱 §11.F Codex#17，与 60-profile 一致）。
- SSE 鉴权统一同源 Cookie、建流前 HTTP 失败（§5，遵脊柱 §11.C Codex#5）。
- owner 可见性在 handler 层断言（非通用中间件），统一约定供各域沿用。

# 20 · STEP① 导入域契约（B-17 / B-18 / B-19 / B-20 / B-21）

> **本文是导入域的唯一契约真源。** 覆盖五个功能点：去敏规则引擎（B-17）、会话解析（B-18）、导入 Job（B-19）、导入接入 API（B-20）、本机助手直传（B-21）。
>
> **依赖脊柱**：本文严格 import `00-约定与状态机.md`，**不重定义**路由前缀 / 响应包络 / 错误信封 / 幂等 / SSE 帧 / jobs 状态机·fencing / progress 模型 / drafts 续传 / §9 共享 TS 类型 / 健康检查。下文出现的 `Envelope<T>` / `Paginated<T>` / `ErrorEnvelope` / `JobView` / `ProgressView` / `SSEFrame` / `StateSnapshotPayload` / `SnapshotId` / `JobId` / `DraftId` 等均来自脊柱 §9。
>
> **隐私口径（2026-06-15 拍板，硬约束）**：**全量上传原文 + 云端解析去敏**。原文（含本机助手扫到的全部 `~/.claude`、`~/.codex`）完整传到 S3，由云端 worker 解析、去敏、切段，原文处理完即弃、不落正式盘；正式存储只留去敏快照。**契约文案、错误 userMessage、字段说明里一律不得出现**「数据不出本机」「仅上传精简数据」「原始日志不出本机」「解析在你浏览器/本机本地完成」「只上传提取后的文本」这类承诺（导入-05 / 导入-29 / 导入文案口径负向 P0）。本机助手只是「在本机读取后把原文全量上传」的搬运工，不是「本机解析、只传精简」。
>
> **三条硬规则在本域的落地点**：
>
> 1. **永不裸转圈** —— 导入 Job 经 jobs + SSE 推「五项子任务清单 + 总进度量化文案 + 落库卡逐条浮现」；连接即 `state_snapshot(job)`；慢任务发 `slow_hint`；空结果/状态丢失数秒内切到有出口的态（导入-07/08/09/10/19/28）。
> 2. **绝不裸露错误码** —— 上传中断 / 解析失败 / 空结果一律出 `ErrorEnvelope`（人话 + action），绝不裸露 500/ECONNRESET/堆栈（导入-18/19）。
> 3. **已生成内容不丢** —— 重导生成**新快照**、旧快照及其段保留；取消保留已解析完成的段；刷新/重进走 `state_snapshot` 恢复、不打回从头（导入-21/26/35、贯穿-21）。

---

## 0. 导入两阶段时序（在场要求，导入-31）

```
阶段 A · 上传原文（前台、需在线、可断点续传）
  ┌─ 直传路径（B-20）：申请预签名 URL → 浏览器/FS Access 把原文分批直传 S3 → POST /import/jobs 引用对象
  └─ 本机助手路径（B-21）：网页铸配对码 → 终端跑助手脚本 → 助手凭码把原文 multipart 直传 → POST /import/connect/upload 自动建 job
       ↓ 秒回 jobId（此后可关页）
阶段 B · 云端解析去敏（后台、可关页、完成发通知）
  worker 从 S3 拉原文 → 解析(B-18) → 去敏(B-17) → 切段 → 建 raw_snapshots(新快照) → 写 session_segments(快照内去重)
       ↓ 进度走 jobs.progress + XADD events:job:{jobId}
  完成 → done 帧 + Outbox(notify) 站内 + 飞书/邮件（导入-32）
```

- **阶段 A 必须在线**：关页 / 断网会中断上传 → 给「可续传或重来」的 `ErrorEnvelope`（`UPLOAD_INTERRUPTED` / action `retry`），不卡死（导入-31）。
- **阶段 B 可关页**：`POST /import/jobs` 秒回 jobId 后即进入云端，关页云端继续跑，完成发通知；回来走 `state_snapshot` 看完成态（导入-06/11/25/31/32）。

---

## 1. 端点清单

| #   | method + path                                 | 鉴权                              | 用途                                                                   | 功能点      |
| --- | --------------------------------------------- | --------------------------------- | ---------------------------------------------------------------------- | ----------- |
| 1   | `POST /api/v1/import/uploads/presign`         | Bearer                            | 申请原文分批直传预签名 URL（直传路径起点）                             | B-20        |
| 2   | `POST /api/v1/import/jobs`                    | Bearer                            | 引用已上传对象触发导入 Job（阶段 A→B）                                 | B-19 / B-20 |
| 3   | `POST /api/v1/import/connect/pair`            | Bearer                            | 铸一次性配对码（本机助手路径起点）                                     | B-21        |
| 4   | `GET /api/v1/import/connect/script`           | 配对码（query）                   | 获取注入了 BASE+码的本机助手脚本                                       | B-21        |
| 5   | `POST /api/v1/import/connect/upload?pairId=…` | 配对码（Bearer）+ pairId（query） | 助手凭码把原文【分片】直传落桶 + 传齐后自动建 import Job               | B-21 / B-19 |
| 6   | `GET /api/v1/import/connect/pair/{pairId}`    | Bearer                            | 网页轮询配对/上传状态（拿到 jobId 后转 SSE）                           | B-21        |
| 7   | `GET /api/v1/jobs/{jobId}/events`             | 同源 Cookie                       | 订阅导入进度（SSE，job 流；脊柱 §5/§11.C 端点，禁 query/header token） | B-12 / B-19 |
| 8   | `POST /api/v1/jobs/{jobId}/cancel`            | Bearer                            | 取消导入（脊柱 §6.1 取消语义，保留已完成段）                           | B-11 / B-19 |
| 9   | `GET /api/v1/snapshots/{snapshotId}`          | Bearer                            | 快照统计四格 + 去敏报告对外口径                                        | B-19        |
| 10  | `GET /api/v1/snapshots/{snapshotId}/segments` | Bearer                            | 快照会话节选列表（只读，cursor 分页）                                  | B-19        |
| 11  | `GET /api/v1/snapshots`                       | Bearer                            | 当前用户快照列表（重导后旧快照仍可查）                                 | B-19        |

> 端点 7/8 直接复用脊柱 §5 / §6 既有定义，本域仅说明 job 流 snapshot/帧在导入语境的取值，不重定义路由。配对码鉴权见 §3.2。

---

## 2. 直传路径端点（B-20）

### 2.1 `POST /api/v1/import/uploads/presign` — 申请分批直传预签名 URL

- **鉴权**：Bearer（创作者登录态；只有已登录者能发起，对齐 MVP「铸码需解锁」边界）。
- **幂等**：**不写库、无副作用**（只签 URL，不创建任何持久化行），与 `POST /versions/{versionId}/market-card/preview` 同属「用 POST 仅因带请求体的只读操作」，按脊柱 §4.1「写命令」口径**非写命令故可不带** `Idempotency-Key`（可选 scope `import.presign`，带则重放回放同一组 URL）。区别于 §3.1 `connect/pair`（写 `import_pairings` 行 = 写命令、必带 key）。
- **请求**：

```typescript
// scope = import.presign
interface PresignRequest {
  // 客户端在阶段 A 把原文切成多个 part 分批直传；这里声明每个 part 的元信息
  parts: Array<{
    clientPartId: string; // 客户端生成的 part 标识（断点续传对账用）
    sizeBytes: number; // 单 part 字节数（服务端校验上限，超限 413→VALIDATION_FAILED）
    contentSha256?: string; // 可选，端到端完整性校验
  }>;
  source: ImportSource; // 'claude' | 'codex' | 'mixed'（仅用于 key 命名/统计，不改去敏逻辑）
  totalBytes: number; // 本次原文总字节（用于服务端配额/进度分母预估）
}
type ImportSource = 'claude' | 'codex' | 'mixed';
```

- **响应** `Envelope<PresignResult>`：

```typescript
interface PresignResult {
  uploadId: string; // 本次直传会话 id（贯穿断点续传、后续 POST /import/jobs 引用）
  bucket: 'agora-raw'; // 固定 raw 桶
  parts: Array<{
    clientPartId: string;
    url: string; // 预签名 PUT URL（短时有效）
    s3Key: string; // 该 part 在 S3 的 key
    expiresAt: IsoDateTime; // URL 过期时刻（过期需重新 presign，前端可续传未传完的 part）
  }>;
}
```

- **断点续传（导入-31）**：阶段 A 中断后，前端用同一 `uploadId` 对**未传完的 part** 重新 `presign`（带相同 `clientPartId`）继续传，已传完的 part 不重传。URL 过期同理重签。
- **错误用例**：

| 场景                      | HTTP | code                                             | retriable | action         | userMessage（人话）                         |
| ------------------------- | ---- | ------------------------------------------------ | --------- | -------------- | ------------------------------------------- |
| 单 part 超大 / parts 为空 | 400  | `VALIDATION_FAILED`                              | false     | `change_input` | 「上传内容有点问题，换个目录/文件再导入。」 |
| 总量超配额                | 400  | `IMPORT_NO_CONTENT`（量级）/ `VALIDATION_FAILED` | false     | `change_input` | 「这次内容超出单次上限，分批导入试试。」    |
| 未登录                    | 401  | `UNAUTHENTICATED`                                | false     | `escalate`     | 「登录态失效了，请重新登录。」              |
| S3 不可用                 | 503  | `DEPENDENCY_UNAVAILABLE`                         | true      | `wait`         | 「系统正在恢复，请稍候再试。」              |

### 2.2 `POST /api/v1/import/jobs` — 触发导入 Job（阶段 A→B）

- **鉴权**：Bearer。
- **幂等**：**必须**带 `Idempotency-Key`（scope `import.create`）。同一 `uploadId` + 同 key 重放回放同一 jobId；BullMQ `jobId` 去重为第二道闸。**重复点击「开始导入」/刷新只跑一次**（导入-23）。
- **请求**：

```typescript
// scope = import.create；Header: Idempotency-Key 必填
interface CreateImportJobRequest {
  uploadId: string; // 引用 2.1 的直传会话；服务端据此定位已上传的全部 part
  source: ImportSource;
  // 重导：不传 = 默认就是新快照（导入域永远生成新快照，旧保留，见 §6 血缘）
  // 续传草稿：可选挂到既有 draft（脊柱 §8）
  draftId?: DraftId;
}
```

- **响应** `Envelope<JobView>`（脊柱 §9）：`type:'import'`、`status:'queued'`、`progress` 初始为五项子任务全 `pending`。前端拿 `jobView.id` 立即转订阅 SSE（端点 7）。
- **行为**：api 校验 `uploadId` 下所有 part 已传齐 → 建 `jobs(type=import)` + BullMQ 入队 → 秒回。**此后可关页**（阶段 B 云端跑）。
- **错误用例**：

| 场景                               | HTTP | code                   | retriable | action         | userMessage                          |
| ---------------------------------- | ---- | ---------------------- | --------- | -------------- | ------------------------------------ |
| uploadId 不存在/已过期             | 404  | `NOT_FOUND`            | false     | `change_input` | 「上传会话已失效，重新发起导入。」   |
| part 未传齐（阶段 A 没传完就触发） | 409  | `STATE_CONFLICT`       | false     | `change_input` | 「还有内容没传完，传完再开始导入。」 |
| 上传阶段中断残留                   | 409  | `UPLOAD_INTERRUPTED`   | true      | `retry`        | 「上传中断了，续传或重新导入。」     |
| 同 key 首次仍在租约中              | 423  | `RESOURCE_LOCKED`      | true      | `wait`         | 「这条导入正在处理，请稍候。」       |
| 同 key 不同 body                   | 409  | `IDEMPOTENCY_CONFLICT` | false     | `none`         | （脊柱 §4，对前端透明）              |

---

## 3. 本机助手直传路径端点（B-21）

> 形态：网页铸一次性配对码 → 终端粘一行命令跑助手脚本 → 助手扫本机 `~/.claude` / `~/.codex` 全量原文、凭码直传 → 自动建 import Job → 网页轮询拿 jobId 后转 SSE 自动接上完成态（导入-25）。**助手上传的是原文全量**（隐私口径见文首，去敏在云端）。

### 3.1 `POST /api/v1/import/connect/pair` — 铸一次性配对码

- **鉴权**：Bearer（铸码需登录，对齐 MVP「铸码需解锁」；只有已解锁者能发起）。
- **幂等**：**必带** `Idempotency-Key`（scope=`import.connect.pair`）。铸码是写命令——成功即创建一行 `import_pairings`（铸 `pairing_code_hash` + `attempt_count`/`expires_at`，§6.4），按脊柱 §4.1「所有写命令 POST/PATCH/DELETE 必带 `Idempotency-Key`」必须带 key；重复点「生成命令」/刷新/双标签页按 §4 行为矩阵回放首次结果（同一 `pairId`+同一码，不重复铸行、不重复发码）。缺 key → `400 VALIDATION_FAILED`。
- **请求**：`{}`（无 body）或 `{ draftId?: DraftId }`（续传草稿挂接）。
- **响应** `Envelope<PairResult>`：

```typescript
interface PairResult {
  pairId: string; // 配对会话 id（网页轮询用，端点 6）
  pairingCode: string; // 6 位一次性配对码（助手凭它换上传权）。仅此响应返回一次：
  //   服务端只存 pairing_code_hash、不持久化明文（Codex#15，§6.4）
  command: string; // 整行可复制命令，形如：curl -fsSL <BASE>/api/v1/import/connect/script?code=XXXXXX | node -
  curlOneLiner: string; // 验收口径固定串：curl -fsSL agora.app/import | sh（导入-03/24，展示用）
  expiresAt: IsoDateTime; // 配对码有效期（默认 20 分钟，过期 GC 置 expired）
}
```

- **验收对齐**：`curlOneLiner` 恒为 `curl -fsSL agora.app/import | sh`（导入-03 命令框内容、导入-24 一键复制）；`command` 是注入 BASE+code 的实际可跑命令（导入-25 真实链路）。
- **错误用例**（`userMessage` 列即脊柱 §11.B 唯一可展示人话；内部 `code` 仅日志/映射、**对外信封不含 code**，D1）：

| 场景                                          | HTTP | code（仅内部）         | retriable | action         | userMessage（人话，可展示）    |
| --------------------------------------------- | ---- | ---------------------- | --------- | -------------- | ------------------------------ |
| 缺 `Idempotency-Key`（写命令必带，脊柱 §4.1） | 400  | `VALIDATION_FAILED`    | false     | `change_input` | 「请求缺少必要参数，请重试。」 |
| 同 key 首次仍在租约中                         | 423  | `RESOURCE_LOCKED`      | true      | `wait`         | 「正在生成命令，请稍候。」     |
| 同 key 不同 body                              | 409  | `IDEMPOTENCY_CONFLICT` | false     | `none`         | （脊柱 §4，对前端透明）        |
| 未登录铸码                                    | 401  | `UNAUTHENTICATED`      | false     | `escalate`     | 「请先登录再生成连接命令。」   |

### 3.2 `GET /api/v1/import/connect/script` — 获取本机助手脚本

- **鉴权**：**配对码 query**（`?code=XXXXXX`），**不需登录 cookie**（脚本公开、对齐 MVP「`/connect.mjs` 在访问码闸放行」；助手没有登录态）。码无效/过期则 404。
- **请求**：query `code`（必填，6 位配对码）。
- **响应**：`Content-Type: text/javascript`（**非** JSON 包络，这是可执行脚本）。服务端按请求 `Host` + `x-forwarded-proto` 注入 `__BASE__`（railway 给 https），脚本内固化 `pairId` + `pairingCode` 与上传端点（`pairId` 由 `?code` 反查注入，供上传时定位行，Codex#3-r2）。脚本职责：扫 `~/.claude/projects` + `~/.codex/sessions` → **原文全量打包** → 按 `PART_SIZE`（默认 8 MiB）**切多分片** → 用 `node:http/https` 直发（避开 undici 代理怪癖）`POST /api/v1/import/connect/upload?pairId=...&partIndex=N&totalParts=M&contentSha256=...`。**`pairId`/`partIndex`/`totalParts`/`contentSha256` 走 query string**（Codex P0-1：PairAuth preHandler 不解析 multipart body，只读 query），原文字节走 multipart 文件域，鉴权走 `Authorization: Bearer <pairingCode>`。**每分片独立 `Idempotency-Key = pair-{pairId}-{partIndex}-{contentSha256}`**（含 partIndex + 内容 hash，分片间互不 replay、重跑命令同片同 key 幂等续传，Codex P1-5）。
- **错误**：码无效/过期 → 404 `NOT_FOUND`（但因是脚本通道，返回的是一段「配对码已失效，请回网页重新生成」的可读 stderr 文案脚本片段，**不裸 JSON 错误码**，对齐硬规则②；网页侧仍以 `ErrorEnvelope` 呈现）。

### 3.3 `POST /api/v1/import/connect/upload?pairId=…&partIndex=…&totalParts=…&contentSha256=…` — 助手凭码分片直传落桶 + 传齐后建 Job

> **统一上传协议（manifest / part / complete，Codex P0-1/P0-2/P1-4/P1-5/P1-8）**。一句话：每次请求是「一个分片」——服务端**真实把分片字节写加密临时桶 `agora-raw`**，把 `{ partIndex → { key, contentSha256 } }` 登记进 `import_pairings.landed_parts` manifest（不置 `used_at`）；据 `totalParts` 判**全部分片到齐**才兑换 `used_at` + 建 job（subject_ref 带 `rawS3Keys`），未齐回 `uploading`。

- **鉴权（query pairId 定位行 + Bearer 码，Codex P0-1 + Codex#3-r2）**：请求**必须同时携带 `pairId` 与配对码**——`pairId`（明文配对会话 id，由脚本注入）走 **query string**（`?pairId=...`），配对码走 `Authorization: Bearer <pairingCode>`。**为何 `pairId` 改走 query（Codex P0-1）**：PairAuth 是 preHandler，此阶段 `@fastify/multipart` 的 body 尚未消费、读不到表单字段；把 `pairId` 放 query 让 preHandler 直接读到、无需解析 multipart。服务端**先按 query `pairId` 定位行**，再对该行 `pairing_code_hash` 校验入参码 hash。`pairId` 不存在/已终态 → `404`/`410`；定位到行但**码 hash 不匹配 = 一次失败尝试**，**同一条 UPDATE 内** `attempt_count += 1` 且 `attempt_count + 1 >= max_attempts` 时立即 `phase='expired'`（Codex P1-6：达上限即作废、不留试错窗口）；码无效/过期/已用 → 401/410。
  > **为何要带 `pairId`（Codex#3-r2）**：配对码哈希化后，仅凭「只提交 code」无法在 miss 时定位到任何 `import_pairings` 行，`attempt_count += 1` 无处可写、6 位码暴力枚举不可限流。绑定 `pairId` 后每次兑换都先定位到确定的行，码 hash 错即对该行累加失败计数并按 pairId 限流。`pairId` 是会话 id、非机密，明文携带安全。
- **`used_at` 时机（多分片协议，Codex P1-4）**：PairAuth 校验**只读不写 `used_at`**；`recordPartLanded` 登记分片也**不置 `used_at`**——否则首片就把码置「已用」，后续分片会被 PairAuth 当「已用」拒掉，多分片不可用。`used_at` **只在 complete 兑换完成（建 job、phase→job_created）时一次性置**。
- **幂等（每分片独立 key，Codex P1-5）**：写命令，**必带** `Idempotency-Key`（scope=`import.connect.upload`）。**每分片 key = `pair-{pairId}-{partIndex}-{contentSha256}`**（含 partIndex + 内容 hash），分片间绝不互相 replay/冲突；同片重传（重跑命令）同 key 幂等续传。请求 hash 含 query string（已天然纳入 partIndex/contentSha256），multipart 二进制流不入 hash。
- **请求**：`POST ...?pairId=&source=&partIndex=&totalParts=&contentSha256=`（协议元数据走 **query**）+ `multipart/form-data` 文件域 `file`（本分片原文字节）。

```typescript
// 上传协议元数据（走 query string，Codex P0-1/P1-5）；原文字节走 multipart 文件域 file
interface ConnectUploadForm {
  pairId: string; // query：定位 import_pairings 行（再校验码 hash），失败计数按 pairId 成立
  source: ImportSource; // query：'mixed' 常见（助手同时扫到 claude+codex）
  partIndex: number; // query：分片序号（0 起）
  totalParts?: number; // query：期望分片总数（齐全才建 job；单片无则视作 1 即齐）
  contentSha256?: string; // query：本片内容 hash（per-part 幂等键来源 + 完整性）
}
```

> 助手把每分片原文**真实写 `agora-raw` 桶**（经 api `objectStore.putObject` 转存，Codex P0-2），落桶 key 形如 `raw/{ownerUserId}/{pairId}/part-{partIndex}`；与直传路径殊途同归到「S3 有原文对象」，worker 据 `rawS3Keys` 拉回（不再 `IMPORT_NO_CONTENT`）。

- **响应** `Envelope<ConnectUploadResult>`（**判别联合**，Codex#14）：**未传齐** `status:'uploading'` **不含** `jobId`；**全部分片到齐、job 已建后** `status:'job_created'` 才**必含** `jobId` + `eventsUrl` + **`jobView`**（完整 JobView，前端初始态不裸转圈，Codex P1-7）：

```typescript
// 判别联合：用 status 判别，禁止「uploading 也带 jobId」的不一致形态（Codex#14）
type ConnectUploadResult =
  | {
      status: 'uploading'; // 分片未传齐：job 尚未创建
      pairId: string;
      uploadedParts: number; // 已落地分片数（= manifest 键数，进度短语，不裸转圈）
      totalParts?: number;
      // 注意：uploading 阶段无 jobId / eventsUrl（云端解析 job 还没建）
    }
  | {
      status: 'job_created'; // 全部分片到齐、import Job 已建
      pairId: string;
      jobId: JobId; // 必含：网页轮询据此转 SSE
      eventsUrl: string; // 必含：= /api/v1/jobs/{jobId}/events（脊柱 §5）
      jobView: JobView; // 必含：完整 JobView（queued + 五项子任务 pending + attemptNo/createdAt，Codex P1-7）
    };
```

- **行为**：每片请求 → ① 真实写桶；② 登记 manifest（不置 used_at）；③ 据 `totalParts` 判齐——**未齐**回 `status:'uploading'` + `uploadedParts`（**绝不建 job**，Codex P1-8）；**到齐**取 manifest 有序 `rawS3Keys` 自动建 `jobs(type=import)`（subject_ref 带 rawS3Keys，等价 `POST /import/jobs`）+ 兑换 `used_at` + phase→job_created + 回写 jobId，入队，回 `status:'job_created'` + `jobId` + `eventsUrl` + `jobView`。落桶失败（S3 不可用）→ `503 DEPENDENCY_UNAVAILABLE`（人话 `wait`，不建 job）。SSE 鉴权按脊柱 §11.C 走网页侧同源 Cookie（助手不订阅 SSE，只上传）。
- **错误用例**（`userMessage` 列即脊柱 §11.B 的唯一可展示人话；内部 `code` 仅日志/映射、**对外信封不含 code**，D1）：

| 场景                                        | HTTP                   | code（仅内部）                | retriable | action         | userMessage（人话，可展示）                                    |
| ------------------------------------------- | ---------------------- | ----------------------------- | --------- | -------------- | -------------------------------------------------------------- |
| 配对码无效/过期                             | 401                    | `UNAUTHENTICATED`（连接语境） | false     | `escalate`     | 「配对失效了，回网页重新生成配对码。」                         |
| 配对码已用过                                | 410/409                | `STATE_CONFLICT`              | false     | `change_input` | 「这个配对码已用过，回网页重新生成。」                         |
| 配对码尝试过多（达 max_attempts，Codex#15） | 429/401                | `RATE_LIMITED`                | false     | `change_input` | 「配对码试错次数过多已作废，回网页重新生成配对码。」           |
| 助手扫到空（本机无历史）                    | 200 + job 后续空 / 400 | `IMPORT_NO_CONTENT`           | false     | `change_input` | 「没扫到可导入的对话历史，去产生历史后再来，或换种导入方式。」 |
| 上传网络断                                  | —                      | `UPLOAD_INTERRUPTED`          | true      | `retry`        | 「上传中断了，重跑命令续传。」                                 |

### 3.4 `GET /api/v1/import/connect/pair/{pairId}` — 网页轮询配对/上传状态

- **鉴权**：Bearer（网页侧，需登录；对齐 MVP「轮询需解锁」）。
- **请求**：path `pairId`。
- **响应** `Envelope<PairStatusView>`：

```typescript
type PairPhase =
  | 'waiting' // 已铸码，等终端跑助手
  | 'uploading' // 助手正在传原文
  | 'job_created' // 已建 import Job，前端拿 jobId 转 SSE
  | 'expired'; // 配对码过期未使用
interface PairStatusView {
  pairId: string;
  phase: PairPhase;
  jobId?: JobId; // phase=job_created 时给出，前端转订阅 SSE（端点 7）自动接上
  eventsUrl?: string; // phase=job_created 时给出，= /api/v1/jobs/{jobId}/events（与 ConnectUploadResult 对齐）
  uploadedParts?: number;
  totalParts?: number;
}
```

> `phase` 与 `ConnectUploadResult.status` 同源同义（`waiting/uploading` 期无 jobId，`job_created` 必含 jobId+eventsUrl），与 §3.3 判别联合一致（Codex#14）。SSE 订阅按脊柱 §11.C 走同源 Cookie。

- **轮询节奏**：建议 2s 一次（对齐 MVP）；`phase=job_created` 后停轮询、转 SSE。`expired` 给「配对码已过期，重新生成」的引导（前端态，非错误）。
- **不裸转圈（导入-19）**：网页在 `waiting`/`uploading` 期间展示「等待终端连接 / 正在上传原文」的进度短语，不空转圈；超时（码过期）切到 `expired` 有出口态。

---

## 4. 导入 Job 进度 / SSE（B-19 / B-12）

### 4.1 订阅：`GET /api/v1/jobs/{jobId}/events`（脊柱 §5 端点，job 流）

- **鉴权（脊柱 §11.C，Codex#5）**：**同源 Cookie 会话鉴权**（`EventSource`/`fetch-event-source` 自动携带同源会话 Cookie），**禁 query-string token、禁自定义 header 作主鉴权**。中间件按脊柱 §11.C / 10-auth §4 先校验登录态 + job 属主（`jobs.owner_user_id = ctx.userId`），**鉴权/权限失败必须在建流之前**以普通 HTTP `ErrorEnvelope` 返回（未登录 `401 UNAUTHENTICATED` + `action:'escalate'`；非属主 `403 FORBIDDEN` + `action:'escalate'`），**绝不**用 SSE `error` 帧表达鉴权失败（`error` 帧只表达已建流后的业务失败终态）。流中途 Cookie 过期不强断已建立的流；下次重连握手失效即握手期 `401`（HTTP，非帧）。
- **连接首帧恒为 `state_snapshot`**（`kind:'job'`，载 `jobs.progress` 全量），刷新/重连超窗据此重置、不打回从头（导入-26、贯穿-22）。Last-Event-ID 续传见脊柱 §5.4。

### 4.2 导入子任务标准序（脊柱 §7，五项，导入-08）

```typescript
const IMPORT_SUBTASKS = [
  { key: 'credential', label: '连接凭证' },
  { key: 'fetch_index', label: '拉取会话索引' },
  { key: 'redact', label: '导入消息并抹掉隐私信息' }, // B-17 去敏在此项
  { key: 'segment', label: '切分成段落' }, // B-18 解析切段
  { key: 'snapshot', label: '生成原始数据' }, // 建 raw_snapshots
] as const;
```

依次点亮（pending→running→done/failed）。`redact` 项即去敏引擎落地，验收对外文案「导入消息并抹掉隐私信息」。

### 4.3 导入域用到的 SSE 事件（脊柱 §5.3 子集）

| event            | 导入语境 payload 要点                                                                                             | 验收             |
| ---------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------- |
| `state_snapshot` | `kind:'job'`，`progress` 全量（五项子任务 + 量化文案 + 已落库会话 items 摘要）                                    | 导入-26、贯穿-22 |
| `progress`       | `{ percent, phrase, done, total, unit:'段会话' }`，文案如「68% · 已抓取 146 / 215 段会话 · 5,210 / 8,420 条消息」 | 导入-07/10       |
| `subtask`        | 五项之一状态变化                                                                                                  | 导入-08          |
| `item-appended`  | 落库卡逐条：`{ item: ImportedSegmentBrief }`（每抓一段先显示一段）                                                | 导入-09          |
| `slow_hint`      | `{ phrase, elapsedMs }` 偏慢进度短语（超大量历史，导入-28）                                                       | 导入-28          |
| `error`          | `ErrorEnvelope`（上传中断/解析失败/空结果，人话+退路）                                                            | 导入-18/19       |
| `done`           | `{ status, result:{ snapshotId } }`（成功载新快照 id；取消/失败统一终止帧）                                       | 导入-06/12       |
| `heartbeat`      | 15s 保活                                                                                                          | 导入-28          |

```typescript
interface ImportedSegmentBrief {
  // item-appended 的 item / progress.items[] 元素
  segmentId: Id;
  dateLabel: string; // 如 '03-20'
  title: string; // 去敏后标题
  messageCount: number; // 该段消息条数
  status: 'importing' | 'imported'; // 「导入中…」/「已入」（导入-09）
}
```

### 4.4 取消（脊柱 §6.1，导入-12 / 导入-35）

- `POST /api/v1/jobs/{jobId}/cancel`（Bearer，写命令、**必带 `Idempotency-Key`**，固定 scope=`job.cancel`，脊柱 §4.1）→ 标 `cancelled` + 换 `fence_token`（旧 worker 写入因 fence 不匹配被拒）→ BullMQ remove → worker 安全点停；重复取消同 key 回放首次结果。
- **已解析完成的 `session_segments` 保留**（硬规则③，导入-35）：取消后重进这一步，已处理段仍在、可续；快照若已建则保留为可查快照。
- 取消后页面回到可重新发起导入的态，不卡加载态、不报错（导入-12）。

### 4.5 空结果 / 状态丢失不裸转圈（导入-19/20）

- worker 解析后**零段**（本机无历史）→ Job 终态 `failed` + `error` 帧 `IMPORT_NO_CONTENT` / action `change_input`，userMessage「没扫到可导入的对话历史，去产生历史后再来，或换种导入方式」；**不生成空的骗人完成态**（导入-20）。
- 状态丢失（后端态被清）→ SSE 数秒内 `error`（`JOB_TIMEOUT` / action `retry`）或重连推 `state_snapshot` 恢复，绝不无限转圈（导入-19）。

---

## 5. 快照查询端点（B-19）

### 5.1 `GET /api/v1/snapshots/{snapshotId}` — 快照统计 + 去敏报告

- **鉴权**：Bearer（属主校验；快照「仅你可见」，导入-17）。
- **响应** `Envelope<SnapshotView>`：

```typescript
interface SnapshotView {
  id: SnapshotId;
  ownerUserId: UserId;
  source: ImportSource; // 来源（用于「Codex + Claude」横幅口径，导入-27）
  sources: ImportSource[]; // 实际命中的来源集合（缺一时引导补导，导入-34）
  // 统计四格（导入-14；真实值，非 usage 占位）
  stats: {
    segmentCount: number; // 会话段数，如 215
    messageCount: number; // 消息条数，如 8420
    timeSpan: { from: string; to: string } | null; // 时间跨度，如 2026.03–06
    projectCount: number; // 涉及项目数，如 14
  };
  redaction: RedactionReportView; // 去敏报告对外口径（见 §5.4）
  createdAt: IsoDateTime;
  supersededBySnapshotId?: SnapshotId | null; // 重导后被哪个新快照接替（旧仍可查，导入-21/贯穿-21）
}
```

- **错误**：快照不存在/无权 → 404 `NOT_FOUND` / action `change_input`。

### 5.2 `GET /api/v1/snapshots/{snapshotId}/segments` — 会话节选列表（只读）

- **鉴权**：Bearer（属主）。
- **分页**：cursor（脊柱 §2.3），`order` 默认 `desc`（按 `happened_at`）。返回 `Paginated<SnapshotSegmentView>`，**不返 total**（统计 total 走 §5.1 stats / SSE done）。
- **响应元素**：

```typescript
interface SnapshotSegmentView {
  segmentId: Id;
  dateLabel: string; // 会话日期，如 '03-20'
  title: string; // 去敏后标题（导入-15）
  messageCount: number; // 条数，如 42
  project?: string;
  readOnly: true; // 恒 true：节选只读，原始快照不被这一步改写（导入-15/16）
  // 注意：节选正文是去敏后内容；隐私原文（手机号/密钥）已抹除，绝不明文出现（导入-30）
}
```

- **只读语义（导入-16）**：本端点不提供 PATCH/编辑；`readOnly:true` 是契约级保证。

### 5.3 `GET /api/v1/snapshots` — 当前用户快照列表（重导后旧快照仍可查）

- **鉴权**：Bearer。
- **分页**：cursor，`order` 默认 `desc`（最新快照在前）。`Paginated<SnapshotListItem>`。
- **响应元素**：

```typescript
interface SnapshotListItem {
  id: SnapshotId;
  source: ImportSource;
  segmentCount: number;
  createdAt: IsoDateTime;
  isLatest: boolean; // 是否当前最新快照（重导后旧快照 isLatest=false 但仍在列表，导入-21/贯穿-21）
  supersededBySnapshotId?: SnapshotId | null;
}
```

- **血缘保证（导入-21 / 提取-33 / 贯穿-21）**：重导生成新快照，旧快照不删、`isLatest=false`、`supersededBySnapshotId` 指向新快照；旧快照及其段、基于旧快照的提取结果均保留可查、互不串。

### 5.4 去敏报告对外口径（B-17）

> **对外只给「抹了多少、抹了哪几类」的聚合摘要，绝不回传被抹的隐私原文、绝不回传命中位置明文**（隐私安全关键路径，硬规则②③）。

```typescript
type RedactionCategory =
  | 'phone' // 手机号
  | 'api_key' // API key / 密钥 / token
  | 'email' // 邮箱
  | 'id_card' // 证件号
  | 'bank_card' // 银行卡号
  | 'ip' // IP 地址
  | 'secret_other'; // 其它命中的密钥型
interface RedactionReportView {
  applied: true; // 去敏已生效（导入-30 契约级保证：真生效、非文案声称）
  totalRedactions: number; // 总抹除次数（聚合计数）
  byCategory: Array<{
    category: RedactionCategory;
    count: number; // 该类抹除次数（只给计数，不给原文/位置明文）
    label: string; // 人话类别名，如「手机号」「密钥」
  }>;
  rulesetVersion: string; // 去敏规则集版本（B-17 规则可迭代，便于回溯哪版规则跑的）
  // 对外文案口径：恒为「完整上传 + 云端抹掉手机号、密钥这类隐私信息」，
  // 绝不出现「数据不出本机/仅上传精简」字样（导入-04/05/29、提取-31）
}
```

- **对外硬约束**：`RedactionReportView` 及任何 segment 正文里，被抹内容以打码/移除呈现，手机号/密钥**不以明文出现**（导入-30、提取-31）。`byCategory` 只暴露计数与类别，不暴露被抹明文片段。

---

## 6. 数据模型（PostgreSQL DDL）

> 体现 Phase 0 关键正确性决策：**快照内去重键** `(snapshot_id, content_hash)`、**段级血缘**挂 snapshot、**重导生成新快照旧保留不串**、**fencing** 受保护写入（jobs 表见脊柱 §6.3；本域写入遵脊柱 §11.A 受保护写入规范模式——fence 校验内联进单条事务 CTE 的数据源 `... FROM jobs WHERE id=:jobId AND fence_token=:fence AND status='running'`，禁两步「查 + 写」，落地见 §6.5）。`gen_uuid_v7()` 见脊柱（UUID v7 时间有序）。

### 6.1 `raw_snapshots` — 去敏快照（原文不落正式盘）

```sql
CREATE TABLE raw_snapshots (
  id                      uuid        PRIMARY KEY DEFAULT gen_uuid_v7(),
  owner_user_id           uuid        NOT NULL REFERENCES users(id),
  import_job_id           uuid        NOT NULL REFERENCES jobs(id), -- 产出本快照的导入 Job（血缘）
  source                  text        NOT NULL,           -- claude|codex|mixed
  sources                 text[]      NOT NULL DEFAULT '{}', -- 实际命中来源集合（缺一引导补导，导入-34）
  -- 原文 S3 引用：处理完即弃；保留 key 仅供短期对账/orphan 清理，正式存储只留去敏段
  raw_s3_key              text,                           -- agora-raw 桶 key（worker 处理后由 sweeper orphan 清理）
  raw_purged_at           timestamptz,                    -- 原文清弃时刻（导入-33 数据生命周期口径）
  -- 统计四格（导入-14；真实值）
  segment_count           int         NOT NULL DEFAULT 0,
  message_count           int         NOT NULL DEFAULT 0,
  project_count           int         NOT NULL DEFAULT 0,
  time_span_from          date,                           -- 时间跨度起（NULL=空快照不应到达完成态）
  time_span_to            date,
  -- 去敏报告（B-17，对外口径见 §5.4；DB 只存聚合，不存被抹明文）
  redaction_report        jsonb       NOT NULL DEFAULT '{}'::jsonb, -- RedactionReportView 的聚合形态
  redaction_ruleset_ver   text        NOT NULL,           -- 跑本快照的去敏规则集版本
  -- 重导血缘：新快照生成、旧保留不串（导入-21/26、贯穿-21、提取-33）
  superseded_by           uuid        REFERENCES raw_snapshots(id), -- 被哪个新快照接替；旧快照不删
  created_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_raw_snapshots_owner    ON raw_snapshots (owner_user_id, created_at DESC); -- 列表/最新
CREATE INDEX idx_raw_snapshots_job      ON raw_snapshots (import_job_id);
CREATE INDEX idx_raw_snapshots_orphan   ON raw_snapshots (raw_purged_at) WHERE raw_purged_at IS NULL; -- sweeper orphan 清理原文
```

> **重导=新快照**：导入 Job 永远 `INSERT` 一行新 `raw_snapshots`，绝不 `UPDATE` 旧快照；旧快照 `superseded_by` 指向新行后仍保留（硬规则③、导入-21）。`isLatest` = `superseded_by IS NULL AND` 该用户最新一行。

### 6.2 `session_segments` — 切段后会话段（段级真源，隶属某 snapshot）

```sql
CREATE TABLE session_segments (
  id            uuid        PRIMARY KEY DEFAULT gen_uuid_v7(),
  snapshot_id   uuid        NOT NULL REFERENCES raw_snapshots(id) ON DELETE CASCADE, -- 段级血缘挂 snapshot
  content_hash  text        NOT NULL,           -- hash(去敏后正文)，快照内去重键（按抹敏后内容判重，导入-22）
  source        text        NOT NULL,           -- claude|codex（合并计入两来源，导入-27）
  title         text,                           -- 去敏后标题
  date_label    text,                           -- 展示日期，如 '03-20'
  happened_at   timestamptz,                    -- 会话发生时刻（热力图聚合 / 节选 order，主页-）
  project       text,
  message_count int         NOT NULL DEFAULT 0,
  content       text        NOT NULL,           -- 去敏后段正文（隐私已抹，绝不明文，导入-30）
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- Phase 0 关键正确性：快照内去重（非跨用户全局去重）。
  -- 重导生成新快照 → 新快照拥有独立段集；同一用户重导相同内容不共用旧段、提取不串快照（提取-33）。
  UNIQUE (snapshot_id, content_hash),
  -- 血缘复合唯一键（脊柱 §11.E 注册表，约束名固定）：为 30 域 candidate_evidence 的复合 FK
  -- fk_evidence_segment_snapshot (segment_id, snapshot_id) → session_segments(id, snapshot_id) 提供被引用键。
  -- 注：id 已是单列 PK，但 PG 复合 FK 必须引用恰为 (id, snapshot_id) 的 UNIQUE/PK 约束，单列 PK 不满足，故显式补此键。
  CONSTRAINT uq_session_segments_id_snapshot UNIQUE (id, snapshot_id)
);
CREATE INDEX idx_segments_snapshot       ON session_segments (snapshot_id, happened_at DESC); -- 节选列表/分页
CREATE INDEX idx_segments_snapshot_proj  ON session_segments (snapshot_id, project);          -- 项目数统计
```

> **去重语义（导入-22）**：同一快照内、按**去敏后内容** `content_hash` 判重，重复只算一次（统计不算重、列表不堆重），重复内容导入照常完成不报错。`(snapshot_id, content_hash)` 唯一键即此保证 —— worker 写段用 `INSERT ... ON CONFLICT (snapshot_id, content_hash) DO NOTHING`（同快照重复段静默跳过）。**去重是快照内、不跨快照**：重导新快照的段独立、不与旧快照共用（提取候选不串快照）。
>
> **血缘复合唯一键（脊柱 §11.E，Codex#2）**：`uq_session_segments_id_snapshot UNIQUE (id, snapshot_id)` 是 30 域 `candidate_evidence.fk_evidence_segment_snapshot` 复合 FK 的被引用键（「证据的段与快照必须配套、不跨快照」）。本域**建表即焊死该唯一键**，约束名不得偏离；30 域据此建复合 FK。`id` 虽为单列 PK，但 PostgreSQL 复合 FK 只能引用列集**恰好相等**的唯一/主键约束，单列 PK 不能满足 `(id, snapshot_id)` 复合 FK，故必须显式声明本唯一键。

### 6.3 未采用的备选拆表方案（存储优化，本期不建，D2）

> **表数口径（D2）**：本期采 **6.2 `session_segments` 单表去重方案**（段表只有 `session_segments` 一张，计入全期 36 表）。下方拆表（`segment_contents` + `snapshot_segments`）是**未采用的备选**——仅在未来存储压力大时才考虑启用，**本期不建、不计入 36 表口径**。保留它只为记录「省空间时怎么拆且不破坏血缘」的设计。
>
> 若需按 content_hash 全局去重存正文省空间，可拆为「正文表（全局去重）+ 关联表（每快照独立可寻址）」。**关联表仍按 `(snapshot_id, segment_content_id)` UNIQ**，保证每条段在每个 snapshot 下独立可寻址、不串快照（与 6.2 语义等价）。

```sql
-- 正文按 content_hash 全局去重存一份
CREATE TABLE segment_contents (
  id            uuid        PRIMARY KEY DEFAULT gen_uuid_v7(),
  content_hash  text        NOT NULL UNIQUE,    -- 全局去重键
  title         text,
  content       text        NOT NULL,           -- 去敏后正文
  message_count int         NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now()
);
-- 快照 ↔ 正文关联：每条段在每个 snapshot 下独立可寻址
CREATE TABLE snapshot_segments (
  id                  uuid        PRIMARY KEY DEFAULT gen_uuid_v7(),
  snapshot_id         uuid        NOT NULL REFERENCES raw_snapshots(id) ON DELETE CASCADE,
  segment_content_id  uuid        NOT NULL REFERENCES segment_contents(id),
  source              text        NOT NULL,
  date_label          text,
  happened_at         timestamptz,
  project             text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (snapshot_id, segment_content_id),      -- 快照内去重、不串快照（等价 6.2）
  -- 拆表方案下，可寻址段表即 snapshot_segments；其 (id, snapshot_id) 复合唯一键承接 §11.E 注册表的
  -- uq_session_segments_id_snapshot 角色，供 30 域 fk_evidence_segment_snapshot 复合 FK 引用（约束名同名占位）。
  CONSTRAINT uq_session_segments_id_snapshot UNIQUE (id, snapshot_id)
);
CREATE INDEX idx_snapshot_segments_snap ON snapshot_segments (snapshot_id, happened_at DESC);
```

> **本期采 6.2 单表（D2，简单、血缘直观）；本拆表为未采用的备选**，仅在未来存储压力大时才启用、本期不建。无论哪种，`candidate_evidence.segment_id`（提取域）指向「某 snapshot 下具体段」的语义不变（6.2 指 `session_segments.id`，拆表指 `snapshot_segments.id`），保证证据可回溯具体 snapshot、不跨快照（提取域契约对齐）。两方案均提供 §11.E 注册表的 `uq_session_segments_id_snapshot UNIQUE (id, snapshot_id)`（单表落在 `session_segments`、拆表落在 `snapshot_segments` 作可寻址段表），故 30 域复合 FK 的被引用键无论选哪种方案都存在、约束名一致——本期落在 `session_segments`。

### 6.4 配对会话表 `import_pairings`（B-21）

> **配对码隐私硬约束（Codex#15）**：**只存 `pairing_code_hash`（HMAC/慢哈希），绝不存明文 6 位码**——明文落库一旦泄漏即可冒领上传权。明文码只在 `POST /connect/pair` 响应里返回一次（铸码者眼前），服务端不持久化明文。助手凭码上传时服务端按同算法 hash 后比对。配套：唯一约束**只限 active 配对**（避免历史已用码与新码 hash 撞键导致铸码失败）、过期清理、尝试次数限制（防 6 位码暴力枚举）。
>
> **失败计数可成立修法（Codex#3-r2）**：兑换鉴权**绑 `pairId + code`**——请求带明文 `pairId`（= 本表主键 `id`，非机密）定位行，再对该行 `pairing_code_hash` 校验入参码 hash。**这样「码 hash 不匹配」也有确定的行可写**，`attempt_count += 1` 与按 `pairId` 限流均成立；不再依赖「只凭 code hash 命中行」（哈希化后 miss 无行可更新、枚举不可限流）。`pairId` 走表单字段、`code` 走 `Authorization: Bearer`，二者缺一即拒。

```sql
CREATE TABLE import_pairings (
  id                uuid        PRIMARY KEY DEFAULT gen_uuid_v7(), -- = pairId
  owner_user_id     uuid        NOT NULL REFERENCES users(id),     -- 铸码者（铸码需登录）
  -- 只存 hash，绝不存明文 6 位码（Codex#15）。明文仅 pair 响应返回一次、服务端不留。
  pairing_code_hash text        NOT NULL,                          -- HMAC(server_secret, code) 或慢哈希
  phase             text        NOT NULL DEFAULT 'waiting',        -- waiting|uploading|job_created|expired
  upload_id         text,                                          -- 关联直传会话（助手转存）
  job_id            uuid        REFERENCES jobs(id),               -- 上传齐后建的 import Job（网页轮询接上）
  uploaded_parts    int         NOT NULL DEFAULT 0,                 -- = landed_parts 键数（冗余便于轮询读）
  total_parts       int,
  -- 上传 manifest（多分片协议，Codex P1-8）：已落地分片登记 { "<partIndex>": { "key": <s3Key>, "hash": <contentSha256> } }。
  --   complete 阶段据「键数 = total_parts 且 0..total_parts-1 全到齐」判传齐才建 job；rawS3Keys 取本表 key 集（按 partIndex 有序）。
  landed_parts      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  draft_id          uuid,                                          -- 续传草稿挂接 → drafts(id)（后置 FK fk_pairings_draft，Codex#18-r4：drafts 跨域 FK 破环，见 00 §11.G）
  -- 尝试次数限制（Codex#15）：防 6 位码被暴力枚举；超阈值即作废该配对、回引导重铸
  attempt_count     int         NOT NULL DEFAULT 0,                -- 凭码兑换上传权的失败尝试次数
  max_attempts      int         NOT NULL DEFAULT 5,                -- 阈值，超过 → phase=expired，强制重铸
  expires_at        timestamptz NOT NULL,                          -- 默认 20 分钟，过期 GC 置 expired
  used_at           timestamptz,                                   -- 码已用时刻（一次性、用完即作废）
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()             -- 失败计数/phase 推进/置 used 时更新
);
-- 唯一约束只限 active 配对：未用、未过期、仍 waiting/uploading 的配对其 hash 全局唯一；
-- 历史已用/已过期/已建 job 的配对不参与唯一性（避免与新铸码 hash 撞键导致铸码失败）。
CREATE UNIQUE INDEX uq_pairings_code_active ON import_pairings (pairing_code_hash)
  WHERE used_at IS NULL AND phase IN ('waiting', 'uploading');
-- 兑换定位走 pairId = 主键（Codex#3-r2：先按 pairId 定位行、再校验码 hash，失败计数有确定的行可写）；
-- 主键 O(1) 命中，无需额外 hash 索引。uq_pairings_code_active 仅用于防 active 期 hash 撞键。
-- 过期清理 / GC：sweeper 扫未达终态、已过 expires_at 的配对置 expired（不裸转圈，回引导重铸）
CREATE INDEX idx_pairings_expire ON import_pairings (expires_at)
  WHERE phase NOT IN ('job_created', 'expired');
-- draft_id → drafts(id) 的 FK 不内联（与 drafts 跨域落点 FK 形成建表顺序环）：
-- 后置 ALTER 约束名 fk_pairings_draft，在 drafts 基表建好后统一执行（00 §8.4 / §11.G 后置 FK 闭合清单，Codex#18-r4）。
```

- **兑换语义（`POST /connect/upload` 凭 `pairId + code` 验证，Codex#15 + Codex#3-r2）**：**第一步按 `pairId` 定位行**——`SELECT ... FROM import_pairings WHERE id=:pairId AND used_at IS NULL AND phase IN ('waiting','uploading') AND expires_at > now() FOR UPDATE`；`pairId` 查无 active 行 → `404`/`410`（已终态/过期）。**第二步对该行校验码 hash**——按同算法 hash 入参码，与该行 `pairing_code_hash` 比对：
  - **不匹配** → **同一条 UPDATE 内** `attempt_count += 1` 且 `attempt_count + 1 >= max_attempts` 时立即 `phase='expired'`（Codex P1-6：达上限即作废、回网页引导重铸，杜绝 6 位码暴力枚举），返 `429/401 RATE_LIMITED`/`UNAUTHENTICATED`。
  - **匹配** → 通过；**PairAuth 与分片登记均不置 `used_at`（Codex P1-4 多分片途中可续传）**；`used_at` **只在 complete 兑换完成（建 job、phase→job_created）时一次性置**。
    > 受保护更新（失败计数 + 即时作废，Codex P1-6）单语句示例：`UPDATE import_pairings SET attempt_count = attempt_count + 1, phase = CASE WHEN attempt_count + 1 >= max_attempts THEN 'expired' ELSE phase END, updated_at = now() WHERE id = :pairId AND used_at IS NULL AND phase IN ('waiting','uploading') AND attempt_count < max_attempts;`（行已由第一步 `FOR UPDATE` 锁定，无 TOCTOU）。
- **过期清理**：sweeper 周期把 `expires_at < now() AND phase NOT IN ('job_created','expired')` 的配对置 `phase='expired'`（网页轮询见 `expired` 切有出口态，导入-19/§3.4，不裸转圈）。

### 6.5 fencing 落地（脊柱 §6.2 铁律 + §11.A 受保护写入规范模式）

> **本节严格遵脊柱 §11.A（Codex#3 受保护写入闭环）**：worker import processor 对 `jobs`（进度/结果）与带 job 血缘的产物（`raw_snapshots` / `session_segments`）的写入**一律是单条事务 CTE，把 fence 校验内联进同一条 SQL 的数据源**（`... FROM jobs WHERE id=:jobId AND fence_token=:fence AND status='running'`），**禁止「先 SELECT 校验、再独立 INSERT/UPDATE」两步写法**（TOCTOU）。`rowCount=0` 是正常控制流（已被 fence out），干净退出当前 attempt、不报错、不重试、不落 ErrorEnvelope。
>
> **本域 job 血缘路径**：`raw_snapshots.import_job_id` 直接指向 job（受保护 INSERT 用模板 2）；`session_segments` 经 `snapshot_id → raw_snapshots.import_job_id` 联到 job（受保护 INSERT 用模板 3 的联表变体，下方给出）。

```sql
-- ① 进度回写（写 job 自身）= §11.A 模板 1（受保护 UPDATE）
WITH guard AS (
  SELECT id FROM jobs
  WHERE id = :jobId AND fence_token = :fence AND status = 'running'
  FOR UPDATE
)
UPDATE jobs j
SET progress = :progress, updated_at = now()
FROM guard
WHERE j.id = guard.id;            -- 0 行 = 已被 fence out，安全退出

-- ② 建快照（写 raw_snapshots，带 import_job_id 血缘）= §11.A 模板 2（受保护 INSERT）
INSERT INTO raw_snapshots (
  id, owner_user_id, import_job_id, source, sources, raw_s3_key,
  segment_count, message_count, project_count, time_span_from, time_span_to,
  redaction_report, redaction_ruleset_ver
)
SELECT
  gen_uuid_v7(), j.owner_user_id, j.id, :source, :sources, :rawS3Key,
  :segmentCount, :messageCount, :projectCount, :timeFrom, :timeTo,
  :redactionReport, :rulesetVer
FROM jobs j
WHERE j.id = :jobId AND j.fence_token = :fence AND j.status = 'running'
RETURNING id;                     -- 无返回行 = 已被 fence out，安全退出（不建快照）

-- ③ 段写入（写 session_segments，经 snapshot→job 联表守 fence）= §11.A 模板 2/3 联表变体
--    fence 内联进数据源 jobs；同一 attempt 内幂等靠快照内去重键（导入-22）
INSERT INTO session_segments (
  snapshot_id, content_hash, source, title, date_label, happened_at, project, message_count, content
)
SELECT
  s.id, :contentHash, :segSource, :title, :dateLabel, :happenedAt, :project, :msgCount, :content
FROM raw_snapshots s
JOIN jobs j ON j.id = s.import_job_id
WHERE s.id = :snapshotId
  AND j.fence_token = :fence
  AND j.status = 'running'        -- fence 经 snapshot→job 联表内联校验；非本 fence → 0 行
ON CONFLICT (snapshot_id, content_hash) DO NOTHING;  -- 快照内重复段静默跳过（导入-22）
```

> 三条写入都把 fence 校验内联进数据源、无任何「查 + 写」两步窗口；段写入的 fence 守门经 `snapshot_id → raw_snapshots.import_job_id → jobs.fence_token` 联表完成（无需在 `session_segments` 上冗余 job 列）。取消（§4.4）换 `fence_token` 后，旧 worker 上述三条写入全部 0 行、安全停，已落地的段与快照保留（硬规则③）。

### 6.6 收尾同事务 outbox（70 §2.1，Codex P0-3）

> **最终业务状态 + job 结果 + outbox 通知必须同一 PG 事务原子提交**，绝不「另起事务、吞失败」。import worker 写完段后，在**单条事务**里做两件事并一起 COMMIT：
>
> 1. **受保护落 `completed`**（§11.A 模板 1，fence 内联进 `WHERE id AND fence_token AND status='running'`）——写 `jobs.status='completed'` + `result.snapshotId` + 完整 progress（100% + 五项 done + 已生成段 items 不丢）。0 行 = 已被 fence out（取消/接管）→ **整事务回滚、不发通知**，runner 据 fence 兜终态（已生成段保留）。
> 2. **`emitInTx` outbox**（`notify.import_completed`，eventId 按 `(jobId, attemptNo)` 幂等）。
>
> 任一步抛错 → `withTransaction` ROLLBACK → 整体失败、由 runner 走 `failed`/重试——**杜绝「快照建成但状态没落、通知丢」的半提交**。提交成功后 handler 回 `{ finalized: true }`，runner **不再二次 `completeJob`**，仅发 `done(completed)` 帧。

---

## 7. 本域 TS 类型片段汇总

> 归集到 `src/shared/import/`（zod schema 即 OpenAPI 真源）。下为人读镜像。import 脊柱 §9 共享类型，不重定义。

```typescript
import type {
  Id,
  UserId,
  JobId,
  SnapshotId,
  DraftId,
  IsoDateTime,
  Envelope,
  Paginated,
  JobView,
} from '../shared';

// ---------- 来源 ----------
export type ImportSource = 'claude' | 'codex' | 'mixed';

// ---------- 直传路径（B-20）----------
export interface PresignRequest {
  parts: Array<{ clientPartId: string; sizeBytes: number; contentSha256?: string }>;
  source: ImportSource;
  totalBytes: number;
}
export interface PresignResult {
  uploadId: string;
  bucket: 'agora-raw';
  parts: Array<{ clientPartId: string; url: string; s3Key: string; expiresAt: IsoDateTime }>;
}
export interface CreateImportJobRequest {
  uploadId: string;
  source: ImportSource;
  draftId?: DraftId;
}

// ---------- 本机助手路径（B-21）----------
export interface PairResult {
  pairId: string;
  pairingCode: string;
  command: string;
  curlOneLiner: string; // 恒 'curl -fsSL agora.app/import | sh'（导入-03/24）
  expiresAt: IsoDateTime;
}
// 上传协议元数据走 query（Codex P0-1/P1-5）；原文字节走 multipart 文件域 file
export interface ConnectUploadForm {
  pairId: string; // query：定位 import_pairings 行（再校验码 hash），失败计数按 pairId 成立（Codex#3-r2 + P0-1）
  source: ImportSource;
  partIndex: number; // query：分片序号（0 起）
  totalParts?: number; // query：期望分片总数（齐全才建 job，Codex P1-8）
  contentSha256?: string; // query：本片内容 hash（per-part 幂等键 + 完整性，Codex P1-5）
}
// 判别联合（Codex#14）：uploading 不含 jobId，job_created 必含 jobId/eventsUrl/jobView（Codex P1-7）
export type ConnectUploadResult =
  | { status: 'uploading'; pairId: string; uploadedParts: number; totalParts?: number }
  | { status: 'job_created'; pairId: string; jobId: JobId; eventsUrl: string; jobView: JobView };
export type PairPhase = 'waiting' | 'uploading' | 'job_created' | 'expired';
export interface PairStatusView {
  pairId: string;
  phase: PairPhase;
  jobId?: JobId; // phase=job_created 时给出
  eventsUrl?: string; // phase=job_created 时给出，= /api/v1/jobs/{jobId}/events（Codex#14 对齐）
  uploadedParts?: number;
  totalParts?: number;
}

// ---------- 进度落库卡（SSE item-appended / progress.items[]）----------
export interface ImportedSegmentBrief {
  segmentId: Id;
  dateLabel: string;
  title: string;
  messageCount: number;
  status: 'importing' | 'imported';
}

// ---------- 去敏报告（B-17，对外口径）----------
export type RedactionCategory =
  | 'phone'
  | 'api_key'
  | 'email'
  | 'id_card'
  | 'bank_card'
  | 'ip'
  | 'secret_other';
export interface RedactionReportView {
  applied: true;
  totalRedactions: number;
  byCategory: Array<{ category: RedactionCategory; count: number; label: string }>;
  rulesetVersion: string;
}

// ---------- 快照视图（B-19）----------
export interface SnapshotView {
  id: SnapshotId;
  ownerUserId: UserId;
  source: ImportSource;
  sources: ImportSource[];
  stats: {
    segmentCount: number;
    messageCount: number;
    timeSpan: { from: string; to: string } | null;
    projectCount: number;
  };
  redaction: RedactionReportView;
  createdAt: IsoDateTime;
  supersededBySnapshotId?: SnapshotId | null;
}
export interface SnapshotSegmentView {
  segmentId: Id;
  dateLabel: string;
  title: string;
  messageCount: number;
  project?: string;
  readOnly: true;
}
export interface SnapshotListItem {
  id: SnapshotId;
  source: ImportSource;
  segmentCount: number;
  createdAt: IsoDateTime;
  isLatest: boolean;
  supersededBySnapshotId?: SnapshotId | null;
}

// ---------- 导入域错误 code（扩脊柱 §3.3，action/retriable 遵缺省表）----------
export type ImportErrorCode =
  | 'IMPORT_NO_CONTENT' // 空结果（本机无历史）→ change_input（导入-20）
  | 'UPLOAD_INTERRUPTED' // 阶段 A 上传中断 → retry（导入-31）
  | 'VALIDATION_FAILED' // 输入不合法 → change_input
  | 'STATE_CONFLICT' // part 未传齐 / 配对码已用 → change_input
  | 'NOT_FOUND' // uploadId/snapshot 失效 → change_input
  | 'RESOURCE_LOCKED' // 同 key 租约中 → wait
  | 'IDEMPOTENCY_CONFLICT' // 同 key 不同 body → none
  | 'DEPENDENCY_UNAVAILABLE' // S3 不可用 → wait
  | 'JOB_TIMEOUT'; // 解析超时 → retry
```

---

## 8. 文案口径硬约束（CI / 评审守门，导入-04/05/29）

> 本域所有对外文字（端点 `userMessage`、字段 label、`curlOneLiner`、子任务 label、横幅）必须过以下负向盯防：

- **必须出现的口径**：「导入会把你选择的对话历史**完整上传**到云端，由云端解析、**去敏**后再用于后续步骤」（导入-04）。
- **绝不出现的字眼**（导入-05/29 负向 P0）：「数据不出本机」「仅上传精简数据」「原始日志不出本机」「解析在你浏览器本地完成」「助手在你本机运行·只上传提取后」「只上传提取后的文本」。
- 本机助手 / CURL 命令的说明也必须是「在本机读取后**全量上传原文**、云端解析去敏」的口径（导入-29）。
- 成功横幅口径覆盖两来源：「已导入全部对话历史（Codex + Claude）」（导入-13/27）。
- 错误 `userMessage` 永远人话、不含 500/ECONNRESET/堆栈/英文报错（脊柱 §3，导入-18）。

---

## 9. 功能点覆盖表

| 功能点                | 说明                                                                        | 对应端点                                                                                                                                        | 对应表                                                                                                |
| --------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| **B-17** 去敏规则引擎 | 抹手机号/密钥等隐私，规则可迭代，对外只给聚合报告                           | 落于导入 Job `redact` 子任务；报告出口 `GET /snapshots/{id}`（§5.4）                                                                            | `raw_snapshots.redaction_report` / `redaction_ruleset_ver`；段正文去敏后存 `session_segments.content` |
| **B-18** 会话解析     | Claude/Codex 唯一真源解析、切段                                             | 落于导入 Job `segment` 子任务                                                                                                                   | `session_segments`（`source`/`title`/`message_count`/`content`）                                      |
| **B-19** 导入 Job     | S3 拉原文→解析→去敏→切段→快照，快照内去重，重导新快照旧保留，进度 jobs+XADD | `POST /import/jobs`、`GET /jobs/{id}/events`、`POST /jobs/{id}/cancel`、`GET /snapshots/{id}`、`GET /snapshots/{id}/segments`、`GET /snapshots` | `jobs`(脊柱)、`raw_snapshots`、`session_segments`（`(snapshot_id,content_hash)` UNIQ）                |
| **B-20** 导入接入 API | 预签名分批直传 + 触发 Job + 重导                                            | `POST /import/uploads/presign`、`POST /import/jobs`                                                                                             | `raw_snapshots`（`raw_s3_key`/`superseded_by`）、`idempotency_keys`(脊柱)                             |
| **B-21** 本机助手直传 | 配对码换短时权 → 助手全量直传 → 自动建 Job → 网页轮询接上                   | `POST /import/connect/pair`、`GET /import/connect/script`、`POST /import/connect/upload`、`GET /import/connect/pair/{id}`                       | `import_pairings`、`raw_snapshots`、`session_segments`                                                |

**涉及的验收用例模块**：

- **导入-** 全模块（导入-01~35）：空态两卡 / 文案口径负向（04/05/29）/ 三层加载态不转圈（07/08/09/10）/ 后台·取消（11/12/35）/ 完成态四格·节选只读（13/14/15/16/17）/ 失败不裸码·空结果有出口（18/19/20）/ 重导新快照旧保留·快照内去重（21/22）/ 重复点刷新只跑一次（23）/ CURL 复制·终端跑完网页接上（24/25）/ 完成刷新不丢（26）/ 两来源口径（27/34）/ 大量历史可感知（28）/ 去敏真生效（30）/ 两阶段时序（31）/ 完成通知（32）/ 原文用完即删（33）。
- **贯穿-**：贯穿-21（重导新快照旧保留）、贯穿-22（断线续传到真实状态，复用脊柱 §5.4）。
- **提取-**：提取-31（提取基于去敏快照、证据无隐私原文）、提取-33（新旧快照提取互不串）—— 本域 `(snapshot_id, content_hash)` 与段级血缘是其前置保证。
- **主页-**：主页-18（重新导入期间旧主页内容不丢）—— 由「重导新快照旧保留」机制支撑。

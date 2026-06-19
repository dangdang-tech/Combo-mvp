# Agora Creator Builder 主链路 QA Bug 清单

固定入口：`/Users/danielxing/repos/agora-mvp-creator-builder/creator-builder/docs/测试/创作者中心主链路验收/BUGS.md`

截图目录：`/Users/danielxing/repos/agora-mvp-creator-builder/creator-builder/docs/测试/创作者中心主链路验收/screenshots/`

修复 Agent Prompt：`/Users/danielxing/repos/agora-mvp-creator-builder/creator-builder/docs/测试/创作者中心主链路验收/FIX_AGENT_PROMPT.md`

测试时间：2026-06-19 01:45-02:05 Asia/Shanghai

测试对象：生产 Docker 栈 `http://localhost/`，API `http://localhost/api/v1/...`

## 验收真源

- PRD：飞书 `https://enbmphajlu.feishu.cn/docx/VlkCdpDiIoJmPGxUWwtclMbRnir`
- 本地 PRD 快照：`docs/测试/创作者中心主链路验收/source/prd-feishu.md`，`revision_id=252`
- Figma：`https://www.figma.com/design/XwOk3OdwHGSt6gviqS2Doy/Agora？-！?node-id=233-65`
- Figma MCP 已核对节点：Page `233:65`；外壳 `1153:65` / `1155:65`；工作台 `1157:65`；个人主页 `1152:65`；STEP1 `1168:65`；STEP2 `1168:238`；STEP3 修订态 `1777:24`；STEP4 `1776:24`；STEP5 修订态 `1778:24`
- contracts：`docs/contracts/_index.md`、`docs/contracts/00-约定与状态机.md`、`docs/contracts/10-auth-logto.md`、`docs/contracts/20-step1-import.md`、`docs/contracts/30-step2-extract.md`、`docs/contracts/40-step3-4-structure.md`、`docs/contracts/50-step5-publish.md`、`docs/contracts/60-dashboard-profile.md`

注意：PRD 文中提到的 Figma `1818-24` 实测只是“STEP③④⑤ 修订”说明文字，不是页面主体。页面设计应使用上面的实际 frame 节点。

## 本轮测试状态

生产栈健康检查通过：

```text
GET /health -> 200 {"status":"ok"}
GET /ready  -> ready=true，db/redis_queue/redis_hot/minio/logto/llm 均 ready 或 ok
```

鉴权限制：

- `GET /api/v1/me` 未登录返回 401，符合 API 保护预期。
- `GET /api/v1/auth/login?returnTo=/creator` 返回 302 到 Logto。
- `POST /api/v1/auth/dev-login` 在生产栈返回 404，符合生产禁用 dev-login 的环境设定。
- 本轮没有可用 Logto 用户凭据，因此未能完成“登录后”五步成功流、发布成功流、个人主页真实数据流的黑盒闭环。以下问题来自未登录边界、公开路由、直接跳步、错误态和当前运行 UI 的真实浏览器复测。

本轮截图和 DOM/network 摘要见：`docs/测试/创作者中心主链路验收/screenshots/qa-run-summary.json`

## 覆盖路由

| 路由 | 结果摘要 | 截图 |
| --- | --- | --- |
| `/` | 自动到 `/creator`，未登录仍展示后台外壳和 Wayne/CGO | `home.png` |
| `/creator` | Dashboard API 401，页面保留骨架/后台外壳 | `creator-unauth.png` |
| `/capabilities` | 未登录可见“我的能力”后台页，API 401 | `capabilities-unauth.png` |
| `/analytics` | 未登录可见“数据分析”后台页，API 401 | `analytics-unauth.png` |
| `/earnings` | 未登录可见“收益”后台页，API 401 | `earnings-unauth.png` |
| `/profile` | 私有个人主页入口 401 后只有错误文字，无登录动作 | `profile-unauth.png` |
| `/create/import` | 未登录自动 POST `/api/v1/drafts`，401 后仍留在上传向导 | `create-import-unauth.png` |
| `/create/extract` | 无登录/无 draft 可直接打开 Step2，并伪造前序完成态 | `create-extract-direct.png` |
| `/create/select` | 无登录/无 draft 可直接打开 Step3，显示 0 能力选择 | `create-select-direct.png` |
| `/create/structure` | 无登录/无 draft 可直接打开 Step4，并伪造前序完成态 | `create-structure-direct.png` |
| `/create/publish` | 无登录/无 draft 可直接打开 Step5，并伪造前序完成态 | `create-publish-direct.png` |
| `/a/nonexistent-e2e-test-slug` | 假 slug 被渲染成公开能力页，还套创作者后台 shell | `public-capability-fake-slug.png` |
| `/c/nonexistent-creator-e2e` | 公开创作者路径进入内部 NotFound/Phase 文案，且套后台 shell | `public-creator-fake-slug.png` |
| `/creators/me/profile` | 401 错误页仍套后台 shell，无登录动作 | `creators-me-profile-unauth.png` |
| `/login?failureId=fake-check` | 登录失败页进入内部 NotFound/Phase 文案，且套后台 shell | `login-page.png` |

## 当前结论

已确认问题数：P0 2 个，P1 4 个，P2 2 个。

三条全局原则观察：

- 永不裸转圈：不成立。Dashboard 401 后仍保留骨架/加载占位，缺少明确失败退路。
- 绝不裸露错误码：后端 envelope 未暴露内部 `code`，但 UI 多处缺少 action 对应的登录/重试按钮，并在公开/登录路径泄露内部 Phase 占位文案。
- 已生成内容不丢：未能验证。缺少登录态，真实导入、提取、结构化、发布链路无法闭环。

初步代码线索：

- `apps/web/src/App.tsx:30` 直接把所有路由挂在 `<Shell />` 下，未接入 `RequireAuth`。
- `apps/web/src/shell/auth.tsx:84` 已有 `RequireAuth` 守卫实现，但当前路由树没有使用。
- `apps/web/src/shell/account.tsx:18` 仍保留 `DEFAULT_ACCOUNT = Wayne / CGO`，未登录时也会被 shell 消费。
- `apps/web/src/shell/Shell.tsx:24` 对公开页、登录失败页、404 也统一渲染创作者后台侧栏和账号区。

## 本轮修复与验证（2026-06-19 02:18 Asia/Shanghai）

修复落点说明：上一轮已在工作树里实现「分组路由 + 登录守卫 + 真实账号 + 公开裸壳 + 诚实错误/空态」的整体改造，但当时既没提交、也没重建运行栈，所以 01:57 的 QA 仍然在测 01:15 的旧镜像，问题原样复现。本轮在这个基础上补齐 BUG-007 缺失的 `/login` 路由，并把全部修复重新构建进 `infra-web` 镜像、重启 web 容器，让 `http://localhost/` 真正反映修复后的代码。

本轮代码改动：

- 新增公开登录页 `apps/web/src/pages/index.tsx` 的 `LoginPage`，并在 `apps/web/src/App.tsx` 公开组挂 `/login` 路由。它承接 OIDC 回调失败的回跳 `/login?failureId=<opaque>`，按 opaque failureId 渲染人话登录失败态加「去登录」，只把 failureId 当作反馈代码展示，绝不透传内部 code、OIDC 原始报错或堆栈。
- `apps/web/src/styles.css` 增补 `.cb-public__feedback` 反馈代码样式。
- 另有并行会话把 `/creators/:creatorId/profile` 从受保护组移到公开组（对齐契约 60 的 optionalAuth 公开名片：访客同视图、不挂登录闸门），本轮重建的镜像已包含该改动。

验证手段与本会话限制（诚实声明）：

- 本会话没有可用的浏览器 / computer-use MCP，无法做点击级 DOM 回归（QA 原本用的真实浏览器操控本轮不可用）。已用可得的最强证据替代：构建加类型检查通过、542 个前端单测与组件测试全绿、HTTP 路由与鉴权探针、对线上 JS bundle 的字符串核验。点击级回归仍需 QA 用真实浏览器复跑一遍，这也正是「已修待回归」的含义。
- 部署核验：线上 `index.html` 现在引用新 bundle `index-ZPmp3TCq.js`（替换旧的 `index-CtCZ_wNu.js`）；web 容器健康检查通过。
- 鉴权核验：`/api/v1/me`、`/api/v1/dashboard/summary?range=30d`、`/api/v1/creators/me/profile` 未登录均返回 401。
- bundle 字符串核验（在线上 JS 内 grep）：修复文案全部命中（「请先登录后进入创作者中心」「正在确认登录状态…」「公开能力页即将上线」「公开创作者主页即将上线」「页面不存在或已失效」「登录没能完成」「反馈代码」）；旧开发脚手架泄漏文案全部为 0（「页面骨架」「Phase 4」「后端契约前缀」）。

命令（节选）：

```text
pnpm -F @cb/web build           # tsc -b + vite build 通过
pnpm -F @cb/web test            # 77 文件 / 542 测试通过
docker compose --env-file .env -f infra/docker-compose.yml build web
docker compose --env-file .env -f infra/docker-compose.yml up -d web
curl -s http://localhost/ | grep -oE 'index-[A-Za-z0-9_]+\.(js|css)'
curl -s http://localhost/assets/index-ZPmp3TCq.js | grep -c <文案>
```

三条全局原则复测口径更新（替代上文「当前结论」里基于旧镜像的三条观察）：

- 永不裸转圈：未登录访问受保护页此时先经登录守卫（加载态显「正在确认登录状态…」这种有限态，匿名态显裸登录闸门），不再停在工作台骨架。仪表盘中途过期由各区 ErrorState 给「去登录」退路。
- 绝不裸露错误码：公开页、404、登录失败页都已是诚实人话，线上 bundle 里已无内部脚手架文案；登录失败只带 opaque failureId 作反馈代码。
- 已生成内容不丢：登录链路本会话仍无 Logto 凭据，导入/提取/结构化/发布的续传闭环未能黑盒验证，维持「待登录态回归」。

## BUG-001：未登录访问首页直接进入创作者后台，并显示 Wayne/CGO

严重度：P0 阻断

状态：已修待回归

修复摘要：

- `App.tsx` 把工作台、我的能力、数据分析、收益、个人主页、上传五步整组包进 `RequireAuth` 守卫。未登录渲染裸登录闸门（`auth.tsx` 的 `AuthLoginGate`：「请先登录后进入创作者中心」加「去登录」跳 `/api/v1/auth/login`），不再进 `/creator`、不再出创作者侧栏与导航。
- `ProtectedLayout` 用 `accountFromMe(me)` 喂账号区，登录后才显真实账号；硬编码 persona Wayne · CGO 不再出现在未登录路径。
- 满足契约 10-auth §4.3 `requireAuth` 与 §6.3 owner 可见性，以及 PRD「工作台是登录后私有后台」。

剩余风险：

- 点击级回归（真实浏览器看侧栏、账号区、network）待 QA 复跑，本会话无浏览器 MCP。自测证据见「本轮修复与验证」一节。

所在页面/路由：`/`，实际落到 `/creator`

复现步骤：

1. 清空或不提供有效 Logto 会话。
2. 打开 `http://localhost/`。
3. 观察路由、左侧导航、账号区和 network。

预期：

未登录用户不能进入创作者经营后台。应展示登录闸门，或跳后端 `GET /api/v1/auth/login`，且不出现后台侧栏、创作者导航、Wayne/CGO。

实际：

页面进入 `/creator`，展示 Agora 创作者中心侧栏、工作台/我的能力/上传能力/数据分析/收益导航、底部 `Wayne / CGO` 和右上 `W` 头像。Dashboard 请求全部 401。

证据：

- 截图：`screenshots/home.png`，`screenshots/creator-unauth.png`
- Network：

```text
GET /api/v1/dashboard/metrics?range=30d -> 401
GET /api/v1/dashboard/token-trend?range=30d&metric=tokens -> 401
GET /api/v1/dashboard/summary?range=30d -> 401
GET /api/v1/dashboard/drafts -> 401
GET /api/v1/dashboard/capabilities?range=30d -> 401
```

对照：

- PRD：工作台是私有创作者后台，不是匿名可见页。
- contracts `10-auth-logto.md`：受保护路由应由登录态放行；401 需给可操作退路。
- contracts `60-dashboard-profile.md`：`dashboard/*` 鉴权为创作者本人。
- Figma：工作台 shell 是登录后创作者中心状态，不应作为匿名落地页。

初步根因：

`App.tsx` 未使用现有 `RequireAuth`，所有页面直接挂到 `<Shell />`，`AccountProvider` 默认给 Wayne persona。

## BUG-002：Dashboard 401 后停在骨架/占位态，没有错误说明和登录动作

严重度：P0 阻断

状态：已修待回归

修复摘要：

- 未登录不再挂载 DashboardPage（守卫先行），从源头消除「401 后停在骨架」。会话中途过期时 DashboardPage 各区用 `ErrorState` 给人话加「去登录」(action=escalate)；`useMe` 设 `retry:false`，不对 401 反复重试。
- 满足脊柱 §3 错误信封 action=escalate，以及契约 60 各工作台区块允许局部失败但要给重试/退路。

剩余风险：

- 中途过期时 escalate 文案与「去登录」按钮的视觉，待真实浏览器回归确认。

所在页面/路由：`/creator`

复现步骤：

1. 未登录打开 `http://localhost/creator`。
2. 等待 dashboard 请求完成。
3. 查看指标卡、趋势图、能力列表、草稿区域。

预期：

401 后应渲染明确的人话错误和下一步动作，例如“登录态失效了，请重新登录”加“去登录”按钮。不能长期保留骨架态或空白占位。

实际：

页面保留 dashboard 骨架/趋势图占位和“我的能力体”区块，没有错误说明、没有登录动作、没有重试动作。

证据：

- 截图：`screenshots/creator-unauth.png`
- Console：多条 `Failed to load resource: the server responded with a status of 401 (Unauthorized)`
- Network：同 BUG-001 的 5 个 dashboard API，且出现重复请求。

对照：

- contracts `00-约定与状态机.md`：永不裸转圈，失败必须给人话 `userMessage` 和 action。
- contracts `60-dashboard-profile.md`：各工作台区块允许局部失败，但需局部错误和重试，不应整页假装加载中。

初步根因：

Dashboard 数据层没有把 401/rejected 状态收敛到错误 UI，仍按 loading/empty 骨架渲染。

## BUG-003：未登录可进入我的能力、数据分析、收益等私有经营页面

严重度：P1 严重

状态：已修待回归

修复摘要：

- `/capabilities`、`/analytics`、`/earnings` 与其它经营页同在 `RequireAuth` 组内，未登录统一落裸登录闸门，不再暴露后台信息结构。
- 满足契约 60 dashboard 聚合端点为创作者本人，PRD 这些页面属登录后 shell。

剩余风险：

- 同 BUG-001，待真实浏览器点击级回归。

所在页面/路由：`/capabilities`、`/analytics`、`/earnings`

复现步骤：

1. 未登录分别访问三个路由。
2. 观察页面是否展示后台 shell、经营页面标题、表格/图表占位。
3. 查看 network。

预期：

这些页面均属于创作者本人后台，应被登录守卫拦截，或展示裸登录闸门。

实际：

三个路由均渲染创作者后台 shell 和 Wayne/CGO。API 返回 401，但页面仍显示“我的能力”“数据分析”“收益”等后台信息结构。

证据：

- 截图：`screenshots/capabilities-unauth.png`
- 截图：`screenshots/analytics-unauth.png`
- 截图：`screenshots/earnings-unauth.png`
- Network：

```text
GET /api/v1/dashboard/capabilities?status=all&range=30d&limit=20 -> 401
GET /api/v1/dashboard/metrics?range=30d -> 401
GET /api/v1/dashboard/token-trend?range=30d&metric=tokens -> 401
GET /api/v1/dashboard/capabilities?status=published&range=30d&limit=20 -> 401
```

对照：

- PRD：工作台、能力管理、数据分析、收益均是创作者后台。
- contracts `60-dashboard-profile.md`：dashboard 聚合端点为创作者本人。
- Figma：这些页面属于 Creator Builder 登录后 shell。

初步根因：

私有页面缺少统一 auth gate；API 层拒绝了请求，但 UI 层仍暴露后台结构。

## BUG-004：未登录打开上传页会自动创建草稿，401 后仍停在向导中

严重度：P1 严重

状态：已修待回归

修复摘要：

- `/create/*` 五步子树挂在 `RequireAuth` 内，未登录该子树根本不挂载，`useBootstrapDraft` 的 `POST /api/v1/drafts` 不会触发。登录后进入第一步才 bootstrap 真实草稿，且带稳定幂等键（StrictMode 双渲染与重试都回放同一草稿，不重复建行）。
- 满足脊柱 §4 写命令受鉴权与幂等约束，PRD 五步是登录后主链路。

剩余风险：

- 登录态下的 bootstrap 与续传闭环需 Logto 凭据做黑盒回归，本会话无凭据。

所在页面/路由：`/create/import`

复现步骤：

1. 未登录打开 `http://localhost/create/import`。
2. 等待页面完成初始化。
3. 查看 network 和底部按钮。

预期：

未登录用户不应触发写接口。进入五步上传前应先通过登录守卫。若会话过期，应展示登录动作，不应继续展示可操作上传向导。

实际：

页面渲染 STEP1 上传向导，自动 `POST /api/v1/drafts`，返回 401。页面显示“登录态失效了，请重新登录。反馈代码...”，但没有“去登录”按钮，仍显示“下一步：提取能力项”。

证据：

- 截图：`screenshots/create-import-unauth.png`
- Network：

```text
POST /api/v1/drafts -> 401
```

对照：

- contracts `00-约定与状态机.md`：写命令必须受鉴权和幂等约束，错误 action 要可执行。
- PRD：五步流程是登录后创作者上传能力主链路。
- Figma：STEP1 是登录后 shell 内的向导态，不是匿名入口。

初步根因：

向导入口没有被 auth gate 包住，Import step mount 后立即创建草稿。

## BUG-005：直接访问 Step2-5 会伪造前序完成态，缺少 draft/auth 状态恢复

严重度：P1 严重

状态：已修待回归（主缺陷已修；登录态残留另立 BUG-009 跟踪）

修复摘要：

- 未登录直达 Step2-5 已被 `RequireAuth` 拦截（本条文档记录的主缺陷）。续传仍以 `?draftId=` 深链经 `useResumeDraft` 恢复 draftId 与 selection；新建流程仅在无任何锚点时 bootstrap，避免空建。

剩余风险：

- 登录态下对中后段步骤的「无锚点深链」（例如直接打开 `/create/structure` 且 URL 无 draftId/snapshot/version 等参数），步骤条仍按 URL 把前序步标成 done。`WizardShell` 用 `stepForPath` 派生当前步、`buildStepNodes` 把其前各步标 done，未与真实 `draft.currentStep` 对账。已另立 BUG-009 跟踪，留待带浏览器与测试的专项修复，避免破坏正常前进流。
- 登录后真实 draft 与 state_snapshot 续传闭环需 Logto 凭据回归。

所在页面/路由：`/create/extract`、`/create/select`、`/create/structure`、`/create/publish`

复现步骤：

1. 未登录且无 draft 状态时，直接打开以上任一路由。
2. 观察步骤条和页面提示。

预期：

直接跳步应先经过登录守卫。登录后也应根据真实 draft/currentStep/state_snapshot 恢复，不能凭 URL 伪造前序完成态。缺少状态时应回到可恢复入口，并给明确动作。

实际：

这些路由可直接打开，步骤条显示前序步骤已完成。Step2 提示“没找到要提取的原始数据”，Step3 显示 0 个能力候选，Step4/Step5 显示缺少选择/发布对象。

证据：

- 截图：`screenshots/create-extract-direct.png`
- 截图：`screenshots/create-select-direct.png`
- 截图：`screenshots/create-structure-direct.png`
- 截图：`screenshots/create-publish-direct.png`

对照：

- PRD：五步主链路依赖导入、提取、选择、结构化、发布的真实状态递进。
- contracts `00-约定与状态机.md`：`drafts.currentStep` 和 `state_snapshot` 是断点续传真源，已生成内容不丢。
- Figma：STEP2-5 是有上下文的向导状态，不是可匿名直达的空壳。

初步根因：

路由以 path 推导步骤态，没有先校验 auth/draft/currentStep；状态恢复逻辑和直接访问兜底不完整。

## BUG-006：公开能力假 slug 被渲染成真实能力页，且套用后台 shell

严重度：P1 严重

状态：已修待回归

修复摘要：

- `/a/:slug` 改由公开裸壳 `PublicLayout` 承载（无侧栏、账号、Wayne），`PublicCapabilityPage` 诚实显「公开能力页即将上线」，不拉数据、不伪造卡片、不裸 404、不渗漏内部文案。
- 范围说明：公开能力详情后端端点本期范围外（契约 §2.9 仅冻结），故暂不按真实 slug 返公开 404；待消费侧接通后再在此渲染真实只读卡。

剩余风险：

- 与本条「应请求真实公开读端点并对不存在 slug 返公开 404」的字面预期有差。本期以「诚实占位、不伪造、不套后台外壳」满足三条全局原则，真实 404 留待公开读端点上线再补。

所在页面/路由：`/a/nonexistent-e2e-test-slug`

复现步骤：

1. 打开不存在的公开能力 slug。
2. 观察页面 shell、标题和是否发起公开 API。

预期：

不存在的公开能力应请求真实公开读端点，返回公开 404/失效链接态。公开页不应显示创作者后台侧栏、Wayne/CGO、经营导航。

实际：

页面直接渲染“源自一次真实会话 nonexistent-e2e-test-slug”等公开能力占位文案，没有 API 请求，并套用创作者后台 shell 和 Wayne/CGO。

证据：

- 截图：`screenshots/public-capability-fake-slug.png`
- Network：未观察到对应 `/api/v1/...` 公开读请求。

对照：

- PRD：发布后才进入 marketplace/public 展示，公开页应是消费/访客视图。
- Figma：公开/试用视图不应混入创作者后台经营 shell。
- contracts：公开读可以匿名，但必须来自真实 listing/profile 数据，不应纯前端伪造。

初步根因：

`PublicCapabilityPage` 仍是静态占位页；公开路由被包在全局 `<Shell />` 内。

## BUG-007：公开创作者路径和登录失败页泄露内部 Phase/契约占位文案

严重度：P2 一般

状态：已修待回归

修复摘要：

- 新增 `/login` 路由加 `LoginPage`（公开裸壳内）：承接 `/login?failureId=<opaque>`，渲染人话登录失败态加「去登录」，failureId 仅作反馈代码，不透传内部 code 或 OIDC 报错。此前 `/login` 无路由、落 404 兜底显「页面不存在」，文案对登录失败场景是错的，现已修。
- `PublicCreatorPage`（`/c/:slug`）与 `NotFoundPage`（404 兜底）都改成诚实人话，移除 `Placeholder` 开发脚手架。线上 bundle 已无「页面骨架 / Phase 4 / 后端契约前缀」。
- 满足契约 10-auth §3.2（failureId 驱动人话）与脊柱 §11.B（不裸露 code）。

剩余风险：

- failureId 到文案目前是通用兜底（未接「失败说明读接口」或预置文案表，本期无此端点），多种语义失败暂共用一句人话。

所在页面/路由：`/c/nonexistent-creator-e2e`、`/login?failureId=fake-check`

复现步骤：

1. 打开不存在的公开创作者路径。
2. 打开登录失败回跳 URL。
3. 观察 404/登录失败页面。

预期：

公开 404 和登录失败页应是面向用户的生产文案，不应显示内部开发阶段、契约路径或后端前缀。登录失败页应根据 opaque `failureId` 显示登录失败人话和重新登录动作。

实际：

两个路由进入内部 NotFound/Placeholder，文案包含“页面骨架，Phase 4 实现...”和“后端契约前缀：/api/v1”，并套创作者后台 shell。

证据：

- 截图：`screenshots/public-creator-fake-slug.png`
- 截图：`screenshots/login-page.png`

对照：

- contracts `10-auth-logto.md`：登录失败重定向到 `/login?failureId=<opaque>` 后，前端应渲染人话，不透传内部 code/OIDC 错误。
- contracts `00-约定与状态机.md`：UI 不展示内部路径、堆栈、英文原始报错、内部实现细节。

初步根因：

缺少生产级 `/login` route 和公开 404 route；catch-all placeholder 仍暴露开发文案，且被全局 shell 包裹。

## BUG-008：`/profile` 和 `/creators/me/profile` 未登录错误缺少可操作登录 CTA

严重度：P2 一般

状态：已修待回归

修复摘要：

- `/profile`（self 视图）在 `RequireAuth` 组内，未登录落裸登录闸门加「去登录」。
- `/creators/:creatorId/profile` 移入公开组（契约 60 optionalAuth 公开名片，访客同视图、不挂创作者外壳）。当 `:creatorId='me'` 且未登录时后端返 401 escalate，`ProfilePage` 整页 `ErrorState` 给「去登录」CTA（`window.location.assign('/api/v1/auth/login')`），不再是无动作死页、不再套 Wayne 外壳。
- 满足契约 10-auth §6.3 owner 可见性与 optionalAuth 公开名片、脊柱 §3 错误 action 可执行。

剩余风险：

- 公开名片在真实存在 creatorId 下的访客只读渲染，需真实浏览器回归；self 'me' 的 401 文案与 CTA 视觉待点击级确认。

所在页面/路由：`/profile`、`/creators/me/profile`

复现步骤：

1. 未登录访问 `/profile`。
2. 未登录访问 `/creators/me/profile`。
3. 观察错误态和可操作按钮。

预期：

私有“我的个人主页”入口未登录时应显示登录 CTA。公开创作者主页应使用真实 creator id/slug，并在不存在时展示公开 404。错误态要对齐 ErrorEnvelope action。

实际：

页面显示“登录后才能查看‘我的个人主页’，请先登录。反馈代码：...”，但没有“去登录”按钮，且仍显示后台 shell 和 Wayne/CGO。

证据：

- 截图：`screenshots/profile-unauth.png`
- 截图：`screenshots/creators-me-profile-unauth.png`
- Network：

```text
GET /api/v1/creators/me/profile -> 401
```

对照：

- contracts `10-auth-logto.md`：登录态过期时前端跳登录、回跳后恢复原步骤/页面。
- contracts `00-约定与状态机.md`：错误 action 要能转成用户可执行动作。

初步根因：

Profile page 自身有错误文案，但未把 401/escalate 连接到 `goToLogin()` 或统一 auth gate；公开/私有 profile 路由边界不清。

## BUG-009：登录态下中后段步骤的无锚点深链仍按 URL 伪造步骤条前序完成态

严重度：P1 严重（修复 BUG-005 过程中定位）

状态：已修待回归（步骤条改按 draft 实际进度，无锚点深链不伪造前序完成；wizard 12 测试文件全绿）

所在页面/路由：`/create/extract`、`/create/select`、`/create/structure`、`/create/publish`（登录态、且 URL 无 draftId / snapshot / version 等续传锚点参数）

现象：

已登录用户直接打开中后段步骤路由、且不带任何续传锚点时，步骤条把当前步之前的所有步标成已完成（done 对勾），与真实草稿进度不符。这是「凭 URL 伪造前序完成态」的登录态残留；未登录那一面已由 BUG-005 的路由守卫修掉。各步内容区本身已优雅降级（显空态或缺对象提示，不崩、不伪造数据），问题只在步骤条。

初步根因：

`apps/web/src/pages/wizard/WizardShell.tsx` 用 `stepForPath(location.pathname)` 从 URL 派生当前步，`apps/web/src/pages/wizard/wizardMachine.ts` 的 `buildStepNodes(routeStep)` 把序号小于当前步的各步一律标 done，没有与真实 `draft.currentStep` / `state_snapshot` 对账。

建议修复（留待专项，带浏览器与测试验证，避免破坏正常前进流和 `?draftId` 续传）：

当 `WizardContext` 无 draftId、URL 也无 draftId / snapshot / version / job / capability / batch 锚点、且当前步不是 import 时，重定向回 `/create/import` 这个规范入口；或据真实 draft 对账步骤条的 done 态。正常前进流在 import 挂载即 bootstrap 出 `ctx.draftId`，故该守卫不会误伤正常推进。

对照：

- 脊柱 §8 drafts 断点续传：`currentStep` 与 `state_snapshot` 是步骤态真源。
- PRD：五步主链路依赖真实状态递进，不应凭 URL 伪造。

## BUG-014：登录用户自己的 /profile 在无 profile 数据时整页「没找到创作者」错误态

严重度：P1

状态：已修待回归（self 主页无数据时返回最小 Hero 而非 404；登录态截图 impl-20260619-v2/12；1055 测试）

发现与背景：本轮用测试账号真实登录，访问自己的 /profile，后端在该账号无 creator_profiles 行时返回 404「没找到这个创作者」整页错误态。但「自己的个人主页」Hero 应恒在（主页-01）。

修复摘要：后端 profile-handlers.ts —— self（rawId=me 或 creatorId===viewerId）且无数据且已登录 → 基于账号身份构造最小 Hero（空分区 + usage 占位）返回 200。不回归 BUG-008（匿名 self 仍 401）、BUG-011（非 UUID 仍 404）；+3 回归单测。

自测证据：截图 impl-20260619-v2/12-profile.png —— Hero 恒在（头像 + 名 + 0关注/粉丝/赞 + 各分区友好空态），不再整页错误。

## 持续验收记录（2026-06-19 修复 agent，收尾：STEP4/5 CSS 补齐 + sse 测试修复）

本轮收尾两项：
- STEP4/5（结构化/发布）整套缺失 CSS（~90 个 cb- 类）已按 Figma 节点 1776:24/1778:24 补齐，全用暖米 token，build + web 591 测试通过。登录态截图 impl-20260619-v3/15-create-structure、16-create-publish 确认：换肤、顶栏居中字标、步骤条圆点连线、空态/错误态样式均生效。**主体布局（软硬字段面板 / market-card / cover-picker）因测试账号无能力数据走不到该两步，未能登录态逐像素截图，待有真实数据回归**（CSS 已按 Figma 几何补齐 + StructureStepPage/PublishStepPage 组件单测覆盖）。
- sse-auth.test.ts「JWKS 不可达→503」用例改用死端口（127.0.0.1:1）确定性触发，不再依赖 dev stack 是否在线；只改测试不动生产逻辑。api 全套件 1056/1056 全绿。

最终核验：web build 通过、web 591/591、api 1056/1056；线上 bundle index-BIZ4gkdM.js。工作树干净。

## 持续验收记录（2026-06-19 修复 agent，真实登录态全面还原 + 多 bug 修复回归）

修复 agent 照 Figma MCP 实读设计为真源、用测试账号真实登录（Chrome via playwright-core）逐页截图自证。线上 bundle index-BWn5cNrP.js，commit 3f80f40。

| Bug | 状态 | 关键证据（screenshots/impl-20260619-v2/） |
| --- | --- | --- |
| BUG-012 换肤+结构 | 已修待回归 | 全页暖米+砖红+衬线；顶栏居中字标、步骤条圆点连线、草稿条单 bar、图表砖红 —— 10-creator/12-profile/13-create-import 均登录态确认 |
| BUG-009 | 已修待回归 | 步骤条按 draft 实际进度，无锚点深链不伪造前序 done |
| BUG-010 | 已修待回归 | 公开/登录/404 页不再请求 /api/v1/me |
| BUG-013 | 已修待回归 | STEP1「从浏览器导入」主入口（选文件/文件夹/拖拽），接 B-20；13-create-import |
| BUG-014 | 已修待回归 | self 主页 Hero 恒在；12-profile |

剩余风险：
- STEP4/5 整套 CSS（cb-structure/cb-app-identity/cb-market-card 等）仍缺规则；测试账号无数据走不到该两步，无法登录态逐像素验证，待有真实数据后补齐。
- 字体走 Google Fonts @import，中国大陆网络可能加载慢，已配中文衬线（Songti/STSong）+ 系统等宽 fallback 优雅降级；建议后续自托管 woff2。
- BUG-010 的 console 无 401 噪声为代码层 + 单测验证，建议测试员真实浏览器 network/console 复核。

## 持续验收记录（2026-06-19 02:23 Asia/Shanghai，computer use / Chrome CDP）

本轮读取来源：

- PRD 本地快照：`docs/测试/创作者中心主链路验收/source/prd-feishu.md`，`revision_id=252`
- contracts：`docs/contracts/_index.md`、`docs/contracts/00-约定与状态机.md`
- 既有 Bug 清单与修复说明：本文件、`FIX_AGENT_PROMPT.md`

真实浏览器证据：

- 截图目录：`docs/测试/创作者中心主链路验收/screenshots/heartbeat-20260619-0223/`
- DOM / network / console 摘要：`docs/测试/创作者中心主链路验收/screenshots/heartbeat-20260619-0223/summary.json`

生产栈状态：

```text
GET /health -> 200 {"status":"ok"}
GET /ready  -> ready=true，db/redis_queue/redis_hot/minio/logto/llm 均 ready 或 ok
```

本轮 computer use 实测路由：

| 路由 | 回归结果 | 截图 |
| --- | --- | --- |
| `/` | 未登录展示裸登录闸门，无 shell/Wayne/Phase 文案；只请求 `/api/v1/me` 401 | `heartbeat-20260619-0223/home.png` |
| `/creator` | 同上；点击「去登录」成功跳到 Logto 登录页 | `heartbeat-20260619-0223/creator.png` |
| `/capabilities` | 未登录被登录闸门拦截，不再展示经营后台 | `heartbeat-20260619-0223/capabilities.png` |
| `/analytics` | 未登录被登录闸门拦截，不再展示经营后台 | `heartbeat-20260619-0223/analytics.png` |
| `/earnings` | 未登录被登录闸门拦截，不再展示经营后台 | `heartbeat-20260619-0223/earnings.png` |
| `/profile` | 未登录被登录闸门拦截，无 shell/Wayne | `heartbeat-20260619-0223/profile.png` |
| `/create/import` | 未登录被登录闸门拦截，未再触发 `POST /api/v1/drafts` | `heartbeat-20260619-0223/create-import.png` |
| `/create/extract` | 未登录被登录闸门拦截，不再伪造 Step2 前序完成态 | `heartbeat-20260619-0223/create-extract.png` |
| `/create/select` | 未登录被登录闸门拦截，不再伪造 Step3 前序完成态 | `heartbeat-20260619-0223/create-select.png` |
| `/create/structure` | 未登录被登录闸门拦截，不再伪造 Step4 前序完成态 | `heartbeat-20260619-0223/create-structure.png` |
| `/create/publish` | 未登录被登录闸门拦截，不再伪造 Step5 前序完成态 | `heartbeat-20260619-0223/create-publish.png` |
| `/a/nonexistent-e2e-test-slug` | 公开裸壳，无 shell/Wayne/Phase 文案；展示“公开能力页即将上线” | `heartbeat-20260619-0223/public-capability-fake.png` |
| `/c/nonexistent-creator-e2e` | 公开裸壳，无 shell/Wayne/Phase 文案；展示“公开创作者主页即将上线” | `heartbeat-20260619-0223/public-creator-fake.png` |
| `/creators/me/profile` | 无后台 shell，有「去登录」CTA；后端 `/creators/me/profile` 401 人话错误 | `heartbeat-20260619-0223/creators-me-profile.png` |
| `/login?failureId=fake-check` | 公开裸壳，登录失败人话 + 去登录/回首页 + opaque 反馈代码 | `heartbeat-20260619-0223/login-failure.png` |
| `/definitely-not-a-real-route` | 公开裸壳，生产 404 人话，无 Phase/契约文案 | `heartbeat-20260619-0223/not-found.png` |

本轮通过项：

- BUG-001 / BUG-002 / BUG-003 / BUG-004 / BUG-005 的未登录侧回归通过：私有页统一先走登录闸门，不再挂载后台 shell，不再发 dashboard/drafts 写请求。
- BUG-006 / BUG-007 / BUG-008 的公开/登录/404 外壳泄漏回归通过：没有 Wayne/CGO、侧栏、`Phase 4`、`页面骨架`、`后端契约前缀`。
- 登录按钮功能通过：`/creator` 登录闸门点击「去登录」后跳到 Logto `https://andkzt.logto.app/sign-in?...`。

仍待验证：

- BUG-009 需要真实登录态才能复测。当前生产栈 `dev-login` 关闭，没有 Logto 凭据，因此无法验证登录态中后段深链步骤条是否仍凭 URL 伪造前序完成态。
- 登录后的五步成功流、发布成功流、真实个人主页数据流仍待人工登录态或测试账号支持。

新增问题：

- BUG-010：公开/登录/404 页面仍会全局请求 `/api/v1/me`，产生 401 console 噪声。

## BUG-010：公开页、登录失败页和 404 页仍全局请求 `/api/v1/me`，产生 401 console 噪声

严重度：P3 细节

状态：已修待回归（AuthProvider 下移到受保护子树，公开/登录/404 页不再请求 /api/v1/me；+7 测试）

所在页面/路由：

- `/a/nonexistent-e2e-test-slug`
- `/c/nonexistent-creator-e2e`
- `/login?failureId=fake-check`
- `/definitely-not-a-real-route`

复现步骤：

1. 清空登录态。
2. 用真实浏览器打开任一公开路由、登录失败页或 404 页。
3. 查看 console 和 network。

预期：

公开页、登录失败页和 404 页应匿名可访问，不应为了渲染公开裸壳而主动打受保护的 `/api/v1/me` 并在 DevTools console 留下 401 错误。若后续需要 optional auth，应避免把匿名态当作失败资源噪声。

实际：

这些页面 UI 已正确渲染公开裸壳，但每页都会请求 `/api/v1/me`，浏览器 console 记录：

```text
Failed to load resource: the server responded with a status of 401 (Unauthorized)
```

Network 示例：

```text
GET /api/v1/me -> 401
```

证据：

- `screenshots/heartbeat-20260619-0223/summary.json`
- `screenshots/heartbeat-20260619-0223/public-capability-fake.png`
- `screenshots/heartbeat-20260619-0223/login-failure.png`
- `screenshots/heartbeat-20260619-0223/not-found.png`

初步根因：

`apps/web/src/App.tsx` 在最外层包了 `AuthProvider`，而 `apps/web/src/shell/auth.tsx` 的 `useMe()` 在 provider mount 时无条件请求 `/api/v1/me`。因此即使当前 route 在 `PublicLayout` 下，仍会触发受保护身份探针。

建议修复：

把 `/me` 探针限制在受保护路由树内，例如把 `AuthProvider` 下沉到 `<Route element={<RequireAuth />}>` / `ProtectedLayout` 这一组，或给 `useMe()` 加 route-aware `enabled` 条件。公开页如需 optional auth，再用不会污染 console 的独立 optional-auth 策略处理。

## 部署同步（第二次 loop · 2026-06-19，自动循环）

把当时最新工作树源码重建进 `infra-web` 并重启，让运行栈反映并行会话的鉴权改进（`auth.tsx` 四态收敛、`Envelope<MeView>` 解包、`returnTo`，已闭合 r1/r2 复审三项 P1/P2）。

- 线上 bundle 现为 `index-D8pltqU2.js`（接续上一轮 `index-ZPmp3TCq.js`）。注意 02:23 的 Chrome CDP 验收测的是上一轮 bundle，鉴权四态与 returnTo 的点击级回归建议在这个新 bundle 上补一次。
- 验证（本会话无浏览器 MCP）：`pnpm -F @cb/web test` 78 文件 / 559 测试全绿；web 容器健康；`/api/v1/me` 未登录 401；线上 JS 含「暂时无法确认登录状态」「请先登录后进入创作者中心」「登录没能完成」「returnTo」。
- 命令：`docker compose --env-file .env -f infra/docker-compose.yml build web && docker compose --env-file .env -f infra/docker-compose.yml up -d web`。

本轮未触碰的两项（留给主修复会话，避免与其热改文件相撞）：BUG-009 与既有「步骤条按路由派生」的设计和测试（`WizardShell.test.tsx`「select 步：前两步 done」用例）冲突，且需真实登录态复测，不宜盲加重定向；BUG-010 修复落点在 `App.tsx` / `auth.tsx`，是并行会话正在改的文件。

## 持续验收记录（2026-06-19 02:43 Asia/Shanghai，computer use / Chrome CDP）

本轮读取来源：

- 在线飞书 PRD：`https://enbmphajlu.feishu.cn/docx/VlkCdpDiIoJmPGxUWwtclMbRnir`，`revision_id=252`，与本地快照一致
- PRD 本地快照：`docs/测试/创作者中心主链路验收/source/prd-feishu.md`
- contracts：`docs/contracts/_index.md`、`docs/contracts/00-约定与状态机.md`
- 既有 Bug 清单与修复说明：本文件、`FIX_AGENT_PROMPT.md`

生产栈状态：

```text
GET /health -> 200 {"status":"ok"}
GET /ready  -> ready=true，db/redis_queue/redis_hot/minio/logto/llm 均 ready 或 ok
线上 bundle -> index-D8pltqU2.js
```

真实浏览器证据：

- 截图目录：`docs/测试/创作者中心主链路验收/screenshots/heartbeat-20260619-0243/`
- DOM / network / console 摘要：`docs/测试/创作者中心主链路验收/screenshots/heartbeat-20260619-0243/summary.json`

本轮 computer use 实测路由：

| 路由 | 回归结果 | 截图 |
| --- | --- | --- |
| `/` | 未登录展示裸登录闸门，无 shell/Wayne/Phase 文案；仍请求 `/api/v1/me` 401 | `heartbeat-20260619-0243/home.png` |
| `/creator` | 未登录被登录闸门拦截；无经营后台泄漏 | `heartbeat-20260619-0243/creator.png` |
| `/create/import` | 未登录被登录闸门拦截；未触发 `POST /api/v1/drafts` | `heartbeat-20260619-0243/create-import.png` |
| `/a/nonexistent-e2e-test-slug` | 公开裸壳，无 shell/Wayne/Phase 文案；BUG-010 仍复现，打 `/api/v1/me` 401 | `heartbeat-20260619-0243/public-capability.png` |
| `/c/nonexistent-creator-e2e` | 公开裸壳，无 shell/Wayne/Phase 文案；BUG-010 仍复现 | `heartbeat-20260619-0243/public-creator.png` |
| `/login?failureId=fake-check` | 登录失败人话页正常；BUG-010 仍复现 | `heartbeat-20260619-0243/login-failure.png` |
| `/definitely-not-a-real-route` | 生产 404 人话页正常；BUG-010 仍复现 | `heartbeat-20260619-0243/not-found.png` |
| `/creators/me/profile` | 公开裸壳 + 401 人话错误 + 去登录 CTA；仍额外打 `/api/v1/me` 401 | `heartbeat-20260619-0243/creators-me-profile.png` |

本轮通过项：

- 新 bundle 上 BUG-001 ~ BUG-008 的未登录/公开壳回归继续通过：没有后台 shell、Wayne/CGO、`Phase 4`、`页面骨架`、`后端契约前缀`。
- `/create/import` 点击「去登录」会请求 `/api/v1/auth/login?returnTo=%2Fcreate%2Fimport`，确认新 bundle 的 `returnTo` 回跳参数生效。

本轮仍失败：

- BUG-010 仍未修：公开页、登录失败页、404 页依旧由最外层 `AuthProvider` 无条件触发 `/api/v1/me`，console 留 401 噪声。现有代码线索仍是 `apps/web/src/App.tsx:35` 外层 `<AuthProvider>` + `apps/web/src/shell/auth.tsx:86` 的无条件 `useMe()`。

仍待验证：

- BUG-009 仍需真实登录态才能复测。
- 登录后的五步成功流、发布成功流、真实个人主页数据流仍待人工登录态或测试账号支持。

## 持续验收记录（2026-06-19 03:03 Asia/Shanghai，computer use / Chrome CDP）

本轮读取来源：

- 在线飞书 PRD：`https://enbmphajlu.feishu.cn/docx/VlkCdpDiIoJmPGxUWwtclMbRnir`，`revision_id=252`，与本地快照一致
- PRD 本地快照：`docs/测试/创作者中心主链路验收/source/prd-feishu.md`
- contracts：`docs/contracts/_index.md`、`docs/contracts/00-约定与状态机.md`
- 既有 Bug 清单与修复说明：本文件、`FIX_AGENT_PROMPT.md`

生产栈状态：

```text
GET /health -> 200 {"status":"ok"}
GET /ready  -> ready=true，db/redis_queue/redis_hot/minio/logto/llm 均 ready 或 ok
线上 bundle -> index-D8pltqU2.js
```

真实浏览器证据：

- 截图目录：`docs/测试/创作者中心主链路验收/screenshots/heartbeat-20260619-0303/`
- DOM / network / console 摘要：`docs/测试/创作者中心主链路验收/screenshots/heartbeat-20260619-0303/summary.json`

本轮 computer use 实测路由：

| 路由 | 回归结果 | 截图 |
| --- | --- | --- |
| `/` | 未登录登录闸门正常；无 shell/Wayne/Phase 文案；仍请求 `/api/v1/me` 401 | `heartbeat-20260619-0303/home.png` |
| `/creator` | 未登录被登录闸门拦截；无经营后台泄漏 | `heartbeat-20260619-0303/creator.png` |
| `/create/import` | 未登录被登录闸门拦截；未触发 `POST /api/v1/drafts` | `heartbeat-20260619-0303/create-import.png` |
| `/a/nonexistent-e2e-test-slug` | 公开裸壳正常；无 shell/Wayne/Phase 文案；BUG-010 仍复现 | `heartbeat-20260619-0303/public-capability.png` |
| `/login?failureId=fake-check` | 登录失败人话页正常；BUG-010 仍复现 | `heartbeat-20260619-0303/login-failure.png` |
| `/definitely-not-a-real-route` | 生产 404 人话页正常；BUG-010 仍复现 | `heartbeat-20260619-0303/not-found.png` |

本轮结论：

- 无新增 Bug。
- BUG-001 ~ BUG-008 覆盖到的未登录/公开壳问题在当前 bundle 上继续通过。
- BUG-010 仍待修：公开页、登录失败页、404 页继续由外层 `AuthProvider` 触发 `/api/v1/me` 401，console 有噪声。
- BUG-009、登录后的五步成功流、发布成功流、真实个人主页数据流仍需要真实登录态或测试账号支持。

## 持续验收记录（2026-06-19 03:13 Asia/Shanghai，computer use / in-app browser + Chrome CDP）

本轮读取来源：

- 在线飞书 PRD：`https://enbmphajlu.feishu.cn/docx/VlkCdpDiIoJmPGxUWwtclMbRnir`，`revision_id=252`，与本地快照一致。
- PRD 本地快照：`docs/测试/创作者中心主链路验收/source/prd-feishu.md`
- Figma MCP：读取 Page `233:65`，并截图 `1153:65`、`1168:65`、`1778:24`。再次确认 `1818:24` 是修订说明文字，不是页面主体。
- contracts：`docs/contracts/_index.md`、`docs/contracts/00-约定与状态机.md`，并抽查 `10-auth-logto.md`、`20-step1-import.md`、`60-dashboard-profile.md` 的鉴权/公开页口径。
- 既有 Bug 清单与修复说明：本文件、`FIX_AGENT_PROMPT.md`

生产栈状态：

```text
GET /health -> 200 {"status":"ok"}
GET /ready  -> ready=true，db/redis_queue/redis_hot/minio/logto/llm 均 ready 或 ok
线上 bundle -> index-D8pltqU2.js
```

真实浏览器证据：

- in-app browser 截图与 DOM 摘要：`docs/测试/创作者中心主链路验收/screenshots/heartbeat-20260619-0313/summary.json`
- Chrome CDP network/console 摘要：`docs/测试/创作者中心主链路验收/screenshots/heartbeat-20260619-0313-cdp/summary.json`
- 本轮 Figma 参考截图：`heartbeat-20260619-0313/figma-shell-1153.png`、`figma-step1-1168-65.png`、`figma-step5-1778-24.png`

本轮 computer use 实测路由：

| 路由 | 回归结果 | 截图 |
| --- | --- | --- |
| `/` | 未登录登录闸门正常；无 shell/Wayne/Phase 文案；CDP 仍抓到 `/api/v1/me` 401 | `heartbeat-20260619-0313-cdp/home.png` |
| `/creator` | 未登录被登录闸门拦截；无经营后台泄漏；CDP 抓到 `/api/v1/me` 401 | `heartbeat-20260619-0313-cdp/creator.png` |
| `/create/import` | 未登录被登录闸门拦截；未触发 `POST /api/v1/drafts`；点击「去登录」跳到 Logto | `heartbeat-20260619-0313-cdp/create-import.png` |
| `/a/nonexistent-e2e-test-slug` | 公开裸壳正常；无 shell/Wayne/Phase 文案；BUG-010 仍复现 | `heartbeat-20260619-0313-cdp/public-capability.png` |
| `/c/nonexistent-creator-e2e` | 公开裸壳正常；无 shell/Wayne/Phase 文案；BUG-010 仍复现 | `heartbeat-20260619-0313-cdp/public-creator.png` |
| `/login?failureId=fake-check` | 登录失败人话页正常；无内部错误码；BUG-010 仍复现 | `heartbeat-20260619-0313-cdp/login-failure.png` |
| `/definitely-not-a-real-route` | 生产 404 人话页正常；无内部脚手架文案；BUG-010 仍复现 | `heartbeat-20260619-0313-cdp/not-found.png` |
| `/creators/me/profile` | 公开裸壳 + 401 人话错误 + 去登录 CTA；同时请求 `/api/v1/creators/me/profile` 与 `/api/v1/me` | `heartbeat-20260619-0313-cdp/creators-me-profile.png` |

本轮通过项：

- BUG-001 ~ BUG-008 覆盖到的未登录/公开壳回归继续通过：没有后台 shell、Wayne/CGO、`Phase 4`、`页面骨架`、`后端契约前缀`。
- `/create/import` 登录闸门点击「去登录」成功跳转 Logto：`https://andkzt.logto.app/sign-in?app_id=vbu4vp7h0nczrddmzcpq1`。
- 未登录打开 `/create/import` 没有自动 `POST /api/v1/drafts`，符合“未登录不生成草稿/不丢已生成内容”的边界。
- 可见 UI 未出现裸转圈，公开页/登录失败/404 文案仍是人话。

本轮仍失败：

- BUG-010 仍待修。Chrome CDP 在公开页、登录失败页、404 页均抓到 `GET http://localhost/api/v1/me -> 401`，console 留 `Failed to load resource: the server responded with a status of 401 (Unauthorized)`。
- 轻量定位继续指向：`apps/web/src/App.tsx:35` 把 `<AuthProvider>` 包在公开/受保护两组外层；`apps/web/src/shell/auth.tsx:111` 的 `AuthProvider` mount 后无条件执行 `useMe()`，`auth.tsx:86` 的 `useMe()` 固定请求 `/api/v1/me`。

仍待验证：

- BUG-009 仍需真实登录态才能复测。当前生产栈没有可用测试账号，`dev-login` 在生产禁用，因此登录态中后段深链步骤条、五步成功流、发布成功流、真实个人主页数据流仍需人工登录或测试账号支持。
- UI 还原度方面，本轮只能验证匿名/公开路径没有外壳泄漏和内部文案；工作台、五步上传、试用运行态的 Figma 级细节仍需要登录态进入真实页面后逐页对照。

备注：

- `lark-cli` 返回更新提示：当前 `1.0.52`，最新 `1.0.56`。本轮未执行更新，避免影响正在进行的验收环境。

## 持续验收记录（2026-06-19 03:23 Asia/Shanghai，Figma MCP + computer use / Chrome CDP）

本轮读取来源：

- 在线飞书 PRD：`https://enbmphajlu.feishu.cn/docx/VlkCdpDiIoJmPGxUWwtclMbRnir`，`revision_id=252`，与本地快照一致。
- PRD 本地快照：`docs/测试/创作者中心主链路验收/source/prd-feishu.md`
- Figma MCP：读取 Page `233:65`，并截图工作台节点 `1157:65`；继续使用 PRD 指定文件 `XwOk3OdwHGSt6gviqS2Doy`。
- contracts：`docs/contracts/_index.md`、`docs/contracts/00-约定与状态机.md`，并抽查 `10-auth-logto.md`、`60-dashboard-profile.md` 的鉴权/公开页口径。
- 既有 Bug 清单与修复说明：本文件、`FIX_AGENT_PROMPT.md`

生产栈状态：

```text
GET /health -> 200 {"status":"ok"}
GET /ready  -> ready=true
线上 bundle -> index-zjwzbwW2.js
```

真实浏览器证据：

- Figma 参考截图：`docs/测试/创作者中心主链路验收/screenshots/heartbeat-20260619-0323/figma-dashboard-1157-65.png`
- Chrome CDP 截图与 network/console 摘要：`docs/测试/创作者中心主链路验收/screenshots/heartbeat-20260619-0323-cdp/summary.json`

本轮 computer use 实测路由：

| 路由 | 回归结果 | 截图 |
| --- | --- | --- |
| `/` | 未登录登录闸门正常；无 shell/Wayne/Phase 文案；仍请求 `/api/v1/me` 401 | `heartbeat-20260619-0323-cdp/home.png` |
| `/creator` | 未登录被登录闸门拦截；无经营后台泄漏；仍请求 `/api/v1/me` 401 | `heartbeat-20260619-0323-cdp/creator.png` |
| `/capabilities` | 未登录被登录闸门拦截；无经营后台泄漏；仍请求 `/api/v1/me` 401 | `heartbeat-20260619-0323-cdp/capabilities.png` |
| `/analytics` | 未登录被登录闸门拦截；无经营后台泄漏；仍请求 `/api/v1/me` 401 | `heartbeat-20260619-0323-cdp/analytics.png` |
| `/create/import` | 未登录被登录闸门拦截；未触发 `POST /api/v1/drafts`；点击「去登录」跳到 Logto | `heartbeat-20260619-0323-cdp/create-import.png` |
| `/create/extract` | 未登录被登录闸门拦截；无步骤页内容泄漏；仍请求 `/api/v1/me` 401 | `heartbeat-20260619-0323-cdp/create-extract.png` |
| `/a/nonexistent-e2e-test-slug` | 公开裸壳正常；无 shell/Wayne/Phase 文案；BUG-010 仍复现 | `heartbeat-20260619-0323-cdp/public-capability.png` |
| `/c/nonexistent-creator-e2e` | 公开裸壳正常；无 shell/Wayne/Phase 文案；BUG-010 仍复现 | `heartbeat-20260619-0323-cdp/public-creator.png` |
| `/login?failureId=fake-check` | 登录失败人话页正常；无内部错误码；BUG-010 仍复现 | `heartbeat-20260619-0323-cdp/login-failure.png` |
| `/definitely-not-a-real-route` | 生产 404 人话页正常；无内部脚手架文案；BUG-010 仍复现 | `heartbeat-20260619-0323-cdp/not-found.png` |
| `/creators/me/profile` | 401 人话错误 + 去登录 CTA；同时请求 `/api/v1/creators/me/profile` 与 `/api/v1/me` | `heartbeat-20260619-0323-cdp/creators-me-profile.png` |

本轮通过项：

- BUG-001 ~ BUG-008 覆盖到的未登录/公开壳回归在新 bundle `index-zjwzbwW2.js` 上继续通过：没有后台 shell、Wayne/CGO、`Phase 4`、`页面骨架`、`后端契约前缀`。
- `/create/import` 登录闸门点击「去登录」成功跳转 Logto：`https://andkzt.logto.app/sign-in?app_id=vbu4vp7h0nczrddmzcpq1`。
- 未登录打开 `/create/import` 和 `/create/extract` 没有自动 `POST /api/v1/drafts`，符合“未登录不生成草稿/不丢已生成内容”的边界。
- 可见 UI 未出现裸转圈，公开页/登录失败/404 文案仍是人话。

本轮仍失败：

- BUG-010 仍待修。Chrome CDP 在公开页、登录失败页、404 页以及未登录保护页均抓到 `GET http://localhost/api/v1/me -> 401`，console 留 `Failed to load resource: the server responded with a status of 401 (Unauthorized)`。
- 轻量定位继续指向：`apps/web/src/App.tsx:35` 把 `<AuthProvider>` 包在公开/受保护两组外层；`apps/web/src/shell/auth.tsx:111` 的 `AuthProvider` mount 后无条件执行 `useMe()`，`auth.tsx:86` 的 `useMe()` 固定请求 `/api/v1/me`。

UI 还原度备注：

- 本轮已用 Figma MCP 保存工作台节点 `1157:65` 作为对照基准，但当前无登录态，无法进入真实工作台逐项比较布局、信息层级、间距、组件状态。
- 匿名/公开路由层面，本轮只验证了“不泄漏内部工作台外壳/脚手架文案/裸错误码/裸转圈”；登录后的工作台、五步导入、试用运行态还需要真实登录态逐页按 Figma 节点对照。

仍待验证：

- BUG-009 仍需真实登录态才能复测。当前生产栈没有可用测试账号，`dev-login` 在生产禁用，因此登录态中后段深链步骤条、五步成功流、发布成功流、真实个人主页数据流仍需人工登录或测试账号支持。
- `lark-cli` 继续提示当前 `1.0.52`、最新 `1.0.56`。本轮未执行更新，避免影响验收环境。

## 持续验收记录（2026-06-19 04:23 Asia/Shanghai，Figma MCP + in-app browser + Chrome CDP）

本轮读取来源：

- 在线飞书 PRD：`https://enbmphajlu.feishu.cn/docx/VlkCdpDiIoJmPGxUWwtclMbRnir`，`revision_id=252`，与本地快照一致。
- PRD 本地快照：`docs/测试/创作者中心主链路验收/source/prd-feishu.md`
- Figma MCP：读取并截图 STEP5 修订态节点 `1778:24`；继续使用 PRD 指定文件 `XwOk3OdwHGSt6gviqS2Doy`。
- contracts：`docs/contracts/_index.md`、`docs/contracts/00-约定与状态机.md`，并抽查 `20-step1-import.md`、`50-step5-publish.md`、`60-dashboard-profile.md`。
- 既有 Bug 清单与修复说明：本文件、`FIX_AGENT_PROMPT.md`

生产栈状态：

```text
GET /health -> 200 {"status":"ok"}
GET /ready  -> ready=true，db/redis_queue/redis_hot/minio/logto/llm 均 ready 或 ok
线上 bundle -> index-zjwzbwW2.js
```

真实浏览器证据：

- Figma 参考截图：`docs/测试/创作者中心主链路验收/screenshots/heartbeat-20260619-0423-figma-step5-1778-24.png`
- in-app browser 截图与 DOM 摘要：`docs/测试/创作者中心主链路验收/screenshots/heartbeat-20260619-0423-iab/summary.json`
- in-app browser 登录点击证据：`docs/测试/创作者中心主链路验收/screenshots/heartbeat-20260619-0423-iab/login-click.json`
- Chrome CDP 截图与 network/console 摘要：`docs/测试/创作者中心主链路验收/screenshots/heartbeat-20260619-0423-cdp/summary.json`

本轮 computer use 实测路由：

| 路由 | 回归结果 | 截图 |
| --- | --- | --- |
| `/` | 未登录登录闸门正常；无 shell/Wayne/Phase 文案；CDP 抓到 `/api/v1/me` 401 | `heartbeat-20260619-0423-cdp/home.png` |
| `/creator` | 未登录被登录闸门拦截；无经营后台泄漏；CDP 抓到 `/api/v1/me` 401 | `heartbeat-20260619-0423-cdp/creator.png` |
| `/capabilities` | 未登录被登录闸门拦截；无我的能力数据泄漏；CDP 抓到 `/api/v1/me` 401 | `heartbeat-20260619-0423-cdp/capabilities.png` |
| `/create/import` | 未登录被登录闸门拦截；未触发 `POST /api/v1/drafts`；in-app browser 点击「去登录」跳到 Logto | `heartbeat-20260619-0423-cdp/create-import.png` |
| `/create/publish` | 未登录被登录闸门拦截；无 STEP5 发布卡/市集卡内容泄漏；CDP 抓到 `/api/v1/me` 401 | `heartbeat-20260619-0423-cdp/create-publish.png` |
| `/a/nonexistent-e2e-test-slug` | 公开裸壳正常；无 shell/Wayne/Phase 文案；BUG-010 仍复现 | `heartbeat-20260619-0423-cdp/public-capability.png` |
| `/c/nonexistent-creator-e2e` | 公开裸壳正常；无 shell/Wayne/Phase 文案；BUG-010 仍复现 | `heartbeat-20260619-0423-cdp/public-creator.png` |
| `/creators/me/profile` | 401 人话错误 + 去登录 CTA；同时请求 `/api/v1/creators/me/profile` 与 `/api/v1/me` | `heartbeat-20260619-0423-cdp/creators-me-profile.png` |
| `/creators/not-a-uuid/profile` | 新增 BUG-011：无效公开个人主页路径显示 500 重试态，而非链接失效/参数错误 | `heartbeat-20260619-0423-iab/creators-invalid-profile.png` |
| `/login?failureId=fake-check` | 登录失败人话页正常；无内部错误码；BUG-010 仍复现 | `heartbeat-20260619-0423-cdp/login-failure.png` |
| `/definitely-not-a-real-route` | 生产 404 人话页正常；无内部脚手架文案；BUG-010 仍复现 | `heartbeat-20260619-0423-cdp/not-found.png` |

本轮通过项：

- BUG-001 ~ BUG-008 覆盖到的未登录/公开壳回归在当前 bundle `index-zjwzbwW2.js` 上继续通过：没有后台 shell、Wayne/CGO、`Phase 4`、`页面骨架`、`后端契约前缀`。
- 新增覆盖 `/create/publish`：未登录只显示登录闸门，没有 STEP5 发布页、市集卡、字段映射或 Alpha 评审文案泄漏。
- in-app browser 实际点击 `/create/import` 的「去登录」按钮，成功跳转 Logto：`https://andkzt.logto.app/sign-in?app_id=vbu4vp7h0nczrddmzcpq1`。
- 未登录打开 `/create/import` 和 `/create/publish` 没有自动 `POST /api/v1/drafts`，符合“未登录不生成草稿/不丢已生成内容”的边界。
- 可见 UI 未出现裸转圈，公开页/登录失败/404 文案仍是人话；本轮 DOM 检测未发现可见 `401/500/INTERNAL/UNAUTHENTICATED/Error:` 等裸错误码文本。

本轮仍失败/新增：

- BUG-010 仍待修。Chrome CDP 在公开页、登录失败页、404 页以及未登录保护页均抓到 `GET http://localhost/api/v1/me -> 401`，console 留 `Failed to load resource: the server responded with a status of 401 (Unauthorized)`。
- BUG-011 新增待修。`/creators/not-a-uuid/profile` 触发 profile 聚合 500 重试态；合法 UUID 不存在能正确 404，说明问题集中在 path 参数格式校验/仓储前置校验。
- BUG-010 轻量定位仍指向：`apps/web/src/App.tsx:35` 把 `<AuthProvider>` 包在公开/受保护两组外层；`apps/web/src/shell/auth.tsx:111` 的 `AuthProvider` mount 后无条件执行 `useMe()`，`auth.tsx:86` 的 `useMe()` 固定请求 `/api/v1/me`。

UI 还原度备注：

- 本轮新增 STEP5 Figma 基准图 `1778:24`，后续登录态需对照：恒定侧栏/顶栏、步骤条第 5 步 active、左侧能力切换、右侧市集卡预览、字段映射面板、封面来源 3 选 1、底栏「发布后进入 Alpha 人工评审」和「发布到市集」按钮位置。
- 当前仍无登录态，无法进入真实 STEP5 页面逐项检查封面切换、价格/可见性、market-card preview、发布事务、Alpha 审核中态、试用按钮本期未开放文案。
- 匿名/公开路由层面，本轮只验证了“不泄漏内部工作台外壳/脚手架文案/裸错误码/裸转圈”；登录后的工作台、五步导入、试用运行态还需要真实登录态逐页按 Figma 节点对照。

仍待验证：

- BUG-009 仍需真实登录态才能复测。当前生产栈没有可用测试账号，`dev-login` 在生产禁用，因此登录态中后段深链步骤条、五步成功流、发布成功流、真实个人主页数据流仍需人工登录或测试账号支持。
- `lark-cli` 继续提示当前 `1.0.52`、最新 `1.0.56`。本轮未执行更新，避免影响验收环境。

## 持续验收记录（2026-06-19 04:03 Asia/Shanghai，Figma MCP + in-app browser + Chrome CDP）

本轮读取来源：

- 在线飞书 PRD：`https://enbmphajlu.feishu.cn/docx/VlkCdpDiIoJmPGxUWwtclMbRnir`，`revision_id=252`，与本地快照一致。
- PRD 本地快照：`docs/测试/创作者中心主链路验收/source/prd-feishu.md`
- Figma MCP：读取并截图 STEP4 节点 `1776:24`；继续使用 PRD 指定文件 `XwOk3OdwHGSt6gviqS2Doy`。
- contracts：`docs/contracts/_index.md`、`docs/contracts/00-约定与状态机.md`，并抽查 `10-auth-logto.md`、`50-step5-publish.md`、`60-dashboard-profile.md`。
- 既有 Bug 清单与修复说明：本文件、`FIX_AGENT_PROMPT.md`

生产栈状态：

```text
GET /health -> 200 {"status":"ok"}
GET /ready  -> ready=true，db/redis_queue/redis_hot/minio/logto/llm 均 ready 或 ok
线上 bundle -> index-zjwzbwW2.js
```

真实浏览器证据：

- Figma 参考截图：`docs/测试/创作者中心主链路验收/screenshots/heartbeat-20260619-0403/figma-step4-1776-24.png`
- in-app browser 截图与 DOM 摘要：`docs/测试/创作者中心主链路验收/screenshots/heartbeat-20260619-0403-iab/summary.json`
- in-app browser 登录点击证据：`docs/测试/创作者中心主链路验收/screenshots/heartbeat-20260619-0403-iab/login-click.json`
- Chrome CDP 截图与 network/console 摘要：`docs/测试/创作者中心主链路验收/screenshots/heartbeat-20260619-0403-cdp/summary.json`

本轮 computer use 实测路由：

| 路由 | 回归结果 | 截图 |
| --- | --- | --- |
| `/` | 未登录登录闸门正常；无 shell/Wayne/Phase 文案；CDP 抓到 `/api/v1/me` 401 | `heartbeat-20260619-0403-cdp/home.png` |
| `/creator` | 未登录被登录闸门拦截；无经营后台泄漏；CDP 抓到 `/api/v1/me` 401 | `heartbeat-20260619-0403-cdp/creator.png` |
| `/earnings` | 未登录被登录闸门拦截；无收益页经营数据泄漏；CDP 抓到 `/api/v1/me` 401 | `heartbeat-20260619-0403-cdp/earnings.png` |
| `/create/import` | 未登录被登录闸门拦截；未触发 `POST /api/v1/drafts`；in-app browser 点击「去登录」跳到 Logto | `heartbeat-20260619-0403-cdp/create-import.png` |
| `/create/structure` | 未登录被登录闸门拦截；无 STEP4 页面内容泄漏；CDP 抓到 `/api/v1/me` 401 | `heartbeat-20260619-0403-cdp/create-structure.png` |
| `/a/nonexistent-e2e-test-slug` | 公开裸壳正常；无 shell/Wayne/Phase 文案；BUG-010 仍复现 | `heartbeat-20260619-0403-cdp/public-capability.png` |
| `/c/nonexistent-creator-e2e` | 公开裸壳正常；无 shell/Wayne/Phase 文案；BUG-010 仍复现 | `heartbeat-20260619-0403-cdp/public-creator.png` |
| `/creators/me/profile` | 401 人话错误 + 去登录 CTA；同时请求 `/api/v1/creators/me/profile` 与 `/api/v1/me` | `heartbeat-20260619-0403-cdp/creators-me-profile.png` |
| `/login?failureId=fake-check` | 登录失败人话页正常；无内部错误码；BUG-010 仍复现 | `heartbeat-20260619-0403-cdp/login-failure.png` |
| `/definitely-not-a-real-route` | 生产 404 人话页正常；无内部脚手架文案；BUG-010 仍复现 | `heartbeat-20260619-0403-cdp/not-found.png` |

本轮通过项：

- BUG-001 ~ BUG-008 覆盖到的未登录/公开壳回归在当前 bundle `index-zjwzbwW2.js` 上继续通过：没有后台 shell、Wayne/CGO、`Phase 4`、`页面骨架`、`后端契约前缀`。
- 新增覆盖 `/earnings` 与 `/create/structure`：未登录只显示登录闸门，没有收益经营数据或 STEP4 软硬字段内容泄漏。
- in-app browser 实际点击 `/create/import` 的「去登录」按钮，成功跳转 Logto：`https://andkzt.logto.app/sign-in?app_id=vbu4vp7h0nczrddmzcpq1`。
- 未登录打开 `/create/import` 和 `/create/structure` 没有自动 `POST /api/v1/drafts`，符合“未登录不生成草稿/不丢已生成内容”的边界。
- 可见 UI 未出现裸转圈，公开页/登录失败/404 文案仍是人话；本轮 DOM 检测未发现可见 `401/500/INTERNAL/UNAUTHENTICATED/Error:` 等裸错误码文本。

本轮仍失败：

- BUG-010 仍待修。Chrome CDP 在公开页、登录失败页、404 页以及未登录保护页均抓到 `GET http://localhost/api/v1/me -> 401`，console 留 `Failed to load resource: the server responded with a status of 401 (Unauthorized)`。
- 轻量定位仍指向：`apps/web/src/App.tsx:35` 把 `<AuthProvider>` 包在公开/受保护两组外层；`apps/web/src/shell/auth.tsx:111` 的 `AuthProvider` mount 后无条件执行 `useMe()`，`auth.tsx:86` 的 `useMe()` 固定请求 `/api/v1/me`。

UI 还原度备注：

- 本轮新增 STEP4 Figma 基准图 `1776:24`，后续登录态需对照：恒定侧栏/顶栏、步骤条第 4 步 active、左侧能力切换、右侧 `App Identity` 软 7 项/硬 6 项分组、底栏「软 7 项可改 · 硬 6 项锁定」和「下一步:发布」。
- 当前仍无登录态，无法进入真实 STEP4 页面逐项检查软字段生成态、硬字段锁定态、保存草稿、字段重生成和底栏按钮位置。
- 匿名/公开路由层面，本轮只验证了“不泄漏内部工作台外壳/脚手架文案/裸错误码/裸转圈”；登录后的工作台、五步导入、试用运行态还需要真实登录态逐页按 Figma 节点对照。

仍待验证：

- BUG-009 仍需真实登录态才能复测。当前生产栈没有可用测试账号，`dev-login` 在生产禁用，因此登录态中后段深链步骤条、五步成功流、发布成功流、真实个人主页数据流仍需人工登录或测试账号支持。
- `lark-cli` 继续提示当前 `1.0.52`、最新 `1.0.56`。本轮未执行更新，避免影响验收环境。

## 持续验收记录（2026-06-19 03:43 Asia/Shanghai，Figma MCP + in-app browser + Chrome CDP）

本轮读取来源：

- 在线飞书 PRD：`https://enbmphajlu.feishu.cn/docx/VlkCdpDiIoJmPGxUWwtclMbRnir`，`revision_id=252`，与本地快照一致。
- PRD 本地快照：`docs/测试/创作者中心主链路验收/source/prd-feishu.md`
- Figma MCP：读取 Page `233:65`，并截图 STEP2 节点 `1168:238`；继续使用 PRD 指定文件 `XwOk3OdwHGSt6gviqS2Doy`。
- contracts：`docs/contracts/_index.md`、`docs/contracts/00-约定与状态机.md`，并抽查 `20-step1-import.md`、`30-step2-extract.md`、`40-step3-4-structure.md`、`60-dashboard-profile.md`。
- 既有 Bug 清单与修复说明：本文件、`FIX_AGENT_PROMPT.md`

生产栈状态：

```text
GET /health -> 200 {"status":"ok"}
GET /ready  -> ready=true，db/redis_queue/redis_hot/minio/logto/llm 均 ready 或 ok
线上 bundle -> index-zjwzbwW2.js
```

真实浏览器证据：

- Figma 参考截图：`docs/测试/创作者中心主链路验收/screenshots/heartbeat-20260619-0343/figma-step2-1168-238.png`
- in-app browser 截图与 DOM 摘要：`docs/测试/创作者中心主链路验收/screenshots/heartbeat-20260619-0343-iab/summary.json`
- in-app browser 登录点击证据：`docs/测试/创作者中心主链路验收/screenshots/heartbeat-20260619-0343-iab/login-click.json`
- Chrome CDP 截图与 network/console 摘要：`docs/测试/创作者中心主链路验收/screenshots/heartbeat-20260619-0343-cdp/summary.json`

本轮 computer use 实测路由：

| 路由 | 回归结果 | 截图 |
| --- | --- | --- |
| `/` | 未登录登录闸门正常；无 shell/Wayne/Phase 文案；CDP 仍抓到 `/api/v1/me` 401 | `heartbeat-20260619-0343-cdp/home.png` |
| `/creator` | 未登录被登录闸门拦截；无经营后台泄漏；CDP 抓到 `/api/v1/me` 401 | `heartbeat-20260619-0343-cdp/creator.png` |
| `/create/import` | 未登录被登录闸门拦截；未触发 `POST /api/v1/drafts`；in-app browser 点击「去登录」跳到 Logto | `heartbeat-20260619-0343-cdp/create-import.png` |
| `/create/extract` | 未登录被登录闸门拦截；无步骤页内容泄漏；CDP 抓到 `/api/v1/me` 401 | `heartbeat-20260619-0343-cdp/create-extract.png` |
| `/a/nonexistent-e2e-test-slug` | 公开裸壳正常；无 shell/Wayne/Phase 文案；BUG-010 仍复现 | `heartbeat-20260619-0343-cdp/public-capability.png` |
| `/c/nonexistent-creator-e2e` | 公开裸壳正常；无 shell/Wayne/Phase 文案；BUG-010 仍复现 | `heartbeat-20260619-0343-cdp/public-creator.png` |
| `/login?failureId=fake-check` | 登录失败人话页正常；无内部错误码；BUG-010 仍复现 | `heartbeat-20260619-0343-cdp/login-failure.png` |
| `/definitely-not-a-real-route` | 生产 404 人话页正常；无内部脚手架文案；BUG-010 仍复现 | `heartbeat-20260619-0343-cdp/not-found.png` |

本轮通过项：

- BUG-001 ~ BUG-008 覆盖到的未登录/公开壳回归在当前 bundle `index-zjwzbwW2.js` 上继续通过：没有后台 shell、Wayne/CGO、`Phase 4`、`页面骨架`、`后端契约前缀`。
- in-app browser 实际点击 `/create/import` 的「去登录」按钮，成功跳转 Logto：`https://andkzt.logto.app/sign-in?app_id=vbu4vp7h0nczrddmzcpq1`。
- 未登录打开 `/create/import` 和 `/create/extract` 没有自动 `POST /api/v1/drafts`，符合“未登录不生成草稿/不丢已生成内容”的边界。
- 可见 UI 未出现裸转圈，公开页/登录失败/404 文案仍是人话。

本轮仍失败：

- BUG-010 仍待修。Chrome CDP 在公开页、登录失败页、404 页以及未登录保护页均抓到 `GET http://localhost/api/v1/me -> 401`，console 留 `Failed to load resource: the server responded with a status of 401 (Unauthorized)`。
- 轻量定位仍指向：`apps/web/src/App.tsx:35` 把 `<AuthProvider>` 包在公开/受保护两组外层；`apps/web/src/shell/auth.tsx:111` 的 `AuthProvider` mount 后无条件执行 `useMe()`，`auth.tsx:86` 的 `useMe()` 固定请求 `/api/v1/me`。

UI 还原度备注：

- 本轮新增 STEP2 Figma 基准图 `1168:238`，可用于后续登录态对照：顶部步骤条、个人上下文卡、能力关系网络、能力节点标签和底部图例都需要按该节点核验。
- 当前仍无登录态，无法进入真实 STEP2 页面逐项检查布局、间距、候选浮现/骨架、失败行重试、底栏按钮文案。
- 匿名/公开路由层面，本轮只验证了“不泄漏内部工作台外壳/脚手架文案/裸错误码/裸转圈”；登录后的工作台、五步导入、试用运行态还需要真实登录态逐页按 Figma 节点对照。

仍待验证：

- BUG-009 仍需真实登录态才能复测。当前生产栈没有可用测试账号，`dev-login` 在生产禁用，因此登录态中后段深链步骤条、五步成功流、发布成功流、真实个人主页数据流仍需人工登录或测试账号支持。
- `lark-cli` 继续提示当前 `1.0.52`、最新 `1.0.56`。本轮未执行更新，避免影响验收环境。

## BUG-011：公开个人主页 creatorId 非 UUID 时返回 500 重试态，而不是链接失效/参数错误

严重度：P2

状态：已修（2026-06-19 05:03 回归通过）

修复摘要：

- `apps/api/src/routes/profile-handlers.ts`：五个个人主页 handler（主聚合 + 密度/热力图/网络/作品墙子端点）的 catch 增加 `isInvalidIdError(err)` 判定——PG `22P02`（invalid_text_representation，非法 UUID 文本绑定 uuid 列时抛）映射成 `reply404`「没找到这个创作者，可能链接失效了。」（action=change_input），不再落 500 可重试聚合/分区失败态。
- 不在 handler 层加 UUID 格式预校验：共享 `IdSchema` 故意只校验非空字符串以兼容测试夹具，且 `me` 别名本身也非 UUID。改为捕获真实 PG 错误码，既修真库 500、又不破坏 fake DB 单测与 `me` 别名解析。
- 满足契约 60 §2.7（creatorId 不存在/不下钻 → 404 NOT_FOUND + change_input、不暴露存在性）与脊柱「绝不裸露错误码 / 错误 action 要可执行」（非法链接不是可重试服务故障）。

自测证据：

- 单测：`apps/api/src/__tests__/profile-routes.test.ts` 新增两条（主聚合 + 作品墙子端点：注入 `throwCodeNext='22P02'` → 断言 404 + change_input + 无 code）；fake DB 扩 `throwCodeNext` 注入位。`vitest run profile-routes` 21 通过；`tsc -b` 通过。
- 全 api 套件 1052 通过、1 失败，失败项 `sse-auth.test.ts`「JWKS 不可达→503」与本修复无关：该用例假设 Logto/JWKS 不可达，但本机全栈 Logto 实际在跑、JWKS 可达 → 假签名验签失败 → 401。已 stash 本次改动后在干净 HEAD 上复跑、同样失败，确认是测试环境假设与运行栈冲突，非本次回归、非产品缺陷。
- 重建并重启 `infra-api`，容器健康。
- 线上 curl 核验：`GET /api/v1/creators/not-a-uuid/{profile,works,heatmap,network,capabilities}` 全部 404（原 500）；合法但不存在 UUID `00000000-0000-4000-8000-000000000000/profile` 仍 404；`/creators/me/profile` 未登录仍 401。
- 404 body：`{"error":{"userMessage":"没找到这个创作者，可能链接失效了。","retriable":false,"action":"change_input","traceId":"..."}}`（人话、无 code、不可重试）。
- 命令：`docker compose --env-file .env -f infra/docker-compose.yml build api && ... up -d api`；`curl -s -o /dev/null -w '%{http_code}' http://localhost/api/v1/creators/not-a-uuid/profile`。

剩余风险：

- UI 侧此前显示「内容没能加载 + 重试」；后端改 404 后前端 ProfilePage 应走整页 ErrorState 的 change_input 文案（链接失效 / 没找到）。需真实浏览器复核前端文案与退路（本会话无浏览器 MCP，建议并行浏览器会话下一轮 CDP 复跑确认）。
- 这些只读端点的 22P02 目前只可能来自 path creatorId（cursor 已由 InvalidCursorError 单独处理），按 404 收敛安全；若未来这些 handler 新增其它 uuid/数值 path 参数，需重新审视 22P02 的归类。

回归证据（2026-06-19 05:03 Asia/Shanghai）：

- in-app browser + Chrome CDP 打开 `http://localhost/creators/not-a-uuid/profile`，页面可见文案为「没找到这个创作者，可能链接失效了。」+「去修改」+ 反馈代码，未出现「内容没能加载」/「重试」/裸 500。
- CDP network：`GET http://localhost/api/v1/creators/not-a-uuid/profile -> 404`，`invalidProfile500=false`，`invalidProfile400or404=true`。
- curl：`GET /api/v1/creators/not-a-uuid/profile -> 404`，body 为 `{"error":{"userMessage":"没找到这个创作者，可能链接失效了。","retriable":false,"action":"change_input","traceId":"..."}}`。
- 对照组：合法但不存在的 `GET /api/v1/creators/00000000-0000-4000-8000-000000000000/profile -> 404`，同样是链接失效人话。

所在页面/路由：

- UI：`/creators/not-a-uuid/profile`
- API：`GET /api/v1/creators/not-a-uuid/profile`

复现步骤：

1. 清空或不提供有效 Logto 会话。
2. 打开 `http://localhost/creators/not-a-uuid/profile`。
3. 或直接请求 `GET http://localhost/api/v1/creators/not-a-uuid/profile`。

预期：

- contracts `60-dashboard-profile.md` §2：`creatorId` 不存在/已注销应返回 `404 NOT_FOUND` + `action=change_input`；如果路径参数格式不合法，也应是人话参数/链接失效态，不应进入整页 500 重试。
- UI 应提示「没找到这个创作者 / 链接失效」一类可理解文案，并给回首页/登录等退路。

实际：

- API 返回 `500 Internal Server Error`，body 为 `{"error":{"userMessage":"内容没能加载，请重试。","retriable":true,"action":"retry",...}}`。
- UI 显示「内容没能加载，请重试。」和「重试」，把无效链接误判成可重试的服务故障。
- 对比：合法 UUID 但不存在的 `GET /api/v1/creators/00000000-0000-4000-8000-000000000000/profile` 能正确返回 404。

证据：

- 截图：`screenshots/heartbeat-20260619-0423-iab/creators-invalid-profile.png`
- DOM 摘要：`screenshots/heartbeat-20260619-0423-iab/creators-invalid-profile.json`
- API 探针：`curl -i http://localhost/api/v1/creators/not-a-uuid/profile -> 500`

初步定位：

- `apps/api/src/routes/profile-handlers.ts:114` 的 `getCreatorProfileHandler` 直接把 path `creatorId` 传给 `readCreatorProfile`。
- `apps/api/src/profile/profile-repo.ts` 查询 `creator_profiles.user_id` 时按 UUID 列比较，非 UUID 字符串会触发数据库参数类型错误；handler 的 broad `catch` 统一落 `reply500Aggregate`。
- 修复方向：在 handler 或路由 schema 先用共享 `IdSchema`/UUID 校验 path 参数；非法值返回 400/404 的 `ErrorEnvelope` 人话，不进入仓储查询和 500 聚合失败分支。

## 持续验收记录（2026-06-19 04:43 Asia/Shanghai，试用 Figma 基准 + in-app browser + Chrome CDP）

本轮读取来源：

- 在线飞书 PRD：`https://enbmphajlu.feishu.cn/docx/VlkCdpDiIoJmPGxUWwtclMbRnir`，`revision_id=252`，与本地快照一致。
- PRD 本地快照：`docs/测试/创作者中心主链路验收/source/prd-feishu.md`。重点复核 §6「试用与发布上线（进行中）」：试用设计是后续 runtime 方向稿。
- Figma MCP：读取 Page `233:65`，并补截图试用 Intake 节点 `1281:65`、试用运行中节点 `1339:65`；继续使用 PRD 指定文件 `XwOk3OdwHGSt6gviqS2Doy`。
- contracts：`docs/contracts/_index.md`、`docs/contracts/00-约定与状态机.md`，并重点复核 `50-step5-publish.md` 与 `60-dashboard-profile.md`。当前 release 的 contract 明确：试用按钮固定展示，点击落「本期未开放」，不进 runtime session。
- 既有 Bug 清单与修复说明：本文件、`FIX_AGENT_PROMPT.md`。

生产栈状态：

```text
GET /health -> 200 {"status":"ok"}
GET /ready  -> ready=true，db/redis_queue/redis_hot/minio/logto 均 ok，llm 为 optional ok
线上 bundle -> index-zjwzbwW2.js / index-CMiPoXZv.css
```

真实浏览器证据：

- Figma 试用 Intake 参考截图：`docs/测试/创作者中心主链路验收/screenshots/heartbeat-20260619-0443/figma-trial-intake-1281-65.png`
- Figma 试用运行中参考截图：`docs/测试/创作者中心主链路验收/screenshots/heartbeat-20260619-0443/figma-trial-running-1339-65.png`
- in-app browser 截图与 DOM 摘要：`docs/测试/创作者中心主链路验收/screenshots/heartbeat-20260619-0443-iab/summary.json`
- in-app browser 登录点击证据：`docs/测试/创作者中心主链路验收/screenshots/heartbeat-20260619-0443-iab/login-click.json`
- Chrome CDP 截图与 network/console 摘要：`docs/测试/创作者中心主链路验收/screenshots/heartbeat-20260619-0443-cdp/summary.json`

本轮 computer use 实测路由：

| 路由 | 回归结果 | 证据 |
| --- | --- | --- |
| `/` | 未登录登录闸门正常；无 shell/Wayne/Phase 文案；CDP 仍抓到 `/api/v1/me` 401 | `heartbeat-20260619-0443-cdp/home.png` |
| `/creator` | 未登录被登录闸门拦截；无经营后台泄漏；CDP 抓到 `/api/v1/me` 401 | `heartbeat-20260619-0443-cdp/creator.png` |
| `/capabilities` | 未登录被登录闸门拦截；无法验证行内试用按钮；CDP 抓到 `/api/v1/me` 401 | `heartbeat-20260619-0443-cdp/capabilities.png` |
| `/create/import` | 未登录被登录闸门拦截；未触发 `POST /api/v1/drafts`；in-app browser 点击「去登录」成功跳转 Logto | `heartbeat-20260619-0443-iab/login-click.json` |
| `/create/publish` | 未登录被登录闸门拦截；无 STEP⑤ 发布页内容泄漏；未触发发布/建草稿写请求 | `heartbeat-20260619-0443-cdp/create-publish.png` |
| `/a/nonexistent-e2e-test-slug` | 公开裸壳正常；无 shell/Wayne/Phase 文案；BUG-010 仍复现 | `heartbeat-20260619-0443-cdp/public-capability.png` |
| `/c/nonexistent-creator-e2e` | 公开裸壳正常；无 shell/Wayne/Phase 文案；BUG-010 仍复现 | `heartbeat-20260619-0443-cdp/public-creator.png` |
| `/creators/me/profile` | 401 人话错误 + 去登录 CTA；同时请求 `/api/v1/creators/me/profile` 与 `/api/v1/me` | `heartbeat-20260619-0443-cdp/creators-me-profile.png` |
| `/creators/not-a-uuid/profile` | BUG-011 仍复现：页面是人话重试态，但 API 返回 500；反馈代码 UUID 里含 `404` 片段，不是裸 HTTP 404 文案 | `heartbeat-20260619-0443-cdp/creators-invalid-profile.png` |
| `/creators/00000000-0000-4000-8000-000000000000/profile` | 合法 UUID 缺失 profile 返回 404，对照组正常；页面仍为人话失败态 | `heartbeat-20260619-0443-cdp/creators-valid-missing-profile.png` |
| `/login?failureId=fake-check` | 登录失败人话页正常；无内部错误码；BUG-010 仍复现 | `heartbeat-20260619-0443-cdp/login-failure.png` |
| `/definitely-not-a-real-route` | 生产 404 人话页正常；无内部脚手架文案；BUG-010 仍复现 | `heartbeat-20260619-0443-cdp/not-found.png` |

本轮通过项：

- BUG-001 ~ BUG-008 覆盖到的未登录/公开壳回归在当前 bundle `index-zjwzbwW2.js` 上继续通过：没有后台 shell、Wayne/CGO、`Phase 4`、`页面骨架`、`后端契约前缀`。
- in-app browser 实际点击 `/create/import` 的「去登录」按钮，成功跳转 Logto：`https://andkzt.logto.app/sign-in?app_id=vbu4vp7h0nczrddmzcpq1`。
- 未登录打开 `/create/import`、`/create/publish` 没有自动 `POST /api/v1/drafts`，也没有触发发布写请求，符合“未登录不生成草稿/不丢已生成内容”的边界。
- 可见 UI 未出现裸转圈；公开页、登录失败页、404 页、公开主页错误态均是人话。CDP 的 `noVisibleErrorCodes=false` 是因为 BUG-011 页面反馈 UUID 中包含 `404` 字符串，不是页面裸露 HTTP 状态码。
- 试用当前实现与 release contract 一致：`DashboardCapabilityRow.actions.trial.enabled` 在 schema 中固定为 `false`，`CapabilityTable`/`CapabilitiesPage` 点击试用只落 `TrialNotice` 的「本期未开放」，不进入 runtime。由于未登录态无法看到真实行按钮，本轮用 contract + 代码轻量定位确认，不记新 bug。

本轮仍失败：

- BUG-010 仍待修。Chrome CDP 在公开页、登录失败页、404 页以及未登录保护页均抓到 `GET http://localhost/api/v1/me -> 401`，console 留 `Failed to load resource: the server responded with a status of 401 (Unauthorized)`。
- BUG-011 仍待修。`GET /api/v1/creators/not-a-uuid/profile -> 500`；合法但不存在的 UUID 对照为 `404`。轻量定位仍指向 `apps/api/src/routes/profile-handlers.ts` 未先校验 path `creatorId` UUID，导致 `apps/api/src/profile/profile-repo.ts` 的 UUID 列比较异常被 broad catch 归成 500。

UI 还原度备注：

- 本轮新增试用 Figma 基准图。试用 Intake 设计为完整 runtime shell：左侧 session 列表、顶部 Artifact toolbar、居中 Intake 表单、底部 timeline；运行中态节点 `1339:65` 后续也要用于对照运行进度/非裸转圈/产出浮现。
- 当前 release contract 明确试用不做，所以“未进入 runtime”按本期 contract 不算 bug；但 Trial 上线时必须按 Figma 节点 `1281:65`、`1339:65`、`1246:65`、`1246:314` 重新逐页验 UI 还原度与功能。
- 匿名/公开路由层面，本轮只验证了“不泄漏内部工作台外壳/脚手架文案/裸错误码/裸转圈”；登录后的工作台、五步导入、行内试用占位弹层、发布成功后的工作台表格仍需要真实登录态逐页按 Figma 对照。

仍待验证：

- BUG-009 仍需真实登录态才能复测。当前生产栈没有可用测试账号，`dev-login` 在生产禁用，因此登录态中后段深链步骤条、五步成功流、发布成功流、真实个人主页数据流、行内试用按钮点击占位弹层仍需人工登录或测试账号支持。
- `lark-cli` 继续提示当前 `1.0.52`、最新 `1.0.56`。本轮未执行更新，避免影响验收环境。

## 持续验收记录（2026-06-19 05:03 Asia/Shanghai，个人主页 Figma 基准 + in-app browser + Chrome CDP）

本轮读取来源：

- 在线飞书 PRD：`https://enbmphajlu.feishu.cn/docx/VlkCdpDiIoJmPGxUWwtclMbRnir`，`revision_id=252`，与本地快照一致。
- PRD 本地快照：`docs/测试/创作者中心主链路验收/source/prd-feishu.md`。
- Figma MCP：读取 Page `233:65`，并补截图个人主页节点 `1152:65`；继续使用 PRD 指定文件 `XwOk3OdwHGSt6gviqS2Doy`。
- contracts：`docs/contracts/_index.md`、`docs/contracts/00-约定与状态机.md`，并重点复核 `50-step5-publish.md`、`60-dashboard-profile.md`。
- 既有 Bug 清单与修复说明：本文件、`FIX_AGENT_PROMPT.md`。

生产栈状态：

```text
GET /health -> 200 {"status":"ok"}
GET /ready  -> ready=true，db/redis_queue/redis_hot/minio/logto 均 ok，llm 为 optional ok
线上 bundle -> index-zjwzbwW2.js / index-CMiPoXZv.css
```

真实浏览器证据：

- Figma 个人主页参考截图：`docs/测试/创作者中心主链路验收/screenshots/heartbeat-20260619-0503/figma-profile-1152-65.png`
- in-app browser 截图与 DOM 摘要：`docs/测试/创作者中心主链路验收/screenshots/heartbeat-20260619-0503-iab/summary.json`
- in-app browser 登录点击证据：`docs/测试/创作者中心主链路验收/screenshots/heartbeat-20260619-0503-iab/login-click.json`
- Chrome CDP 截图与 network/console 摘要：`docs/测试/创作者中心主链路验收/screenshots/heartbeat-20260619-0503-cdp/summary.json`

本轮 computer use 实测路由：

| 路由 | 回归结果 | 证据 |
| --- | --- | --- |
| `/` | 未登录登录闸门正常；无 shell/Wayne/Phase 文案；CDP 仍抓到 `/api/v1/me` 401 | `heartbeat-20260619-0503-cdp/home.png` |
| `/creator` | 未登录被登录闸门拦截；无经营后台泄漏；CDP 抓到 `/api/v1/me` 401 | `heartbeat-20260619-0503-cdp/creator.png` |
| `/profile` | 未登录被登录闸门拦截；无个人主页 Figma 内容泄漏；CDP 抓到 `/api/v1/me` 401 | `heartbeat-20260619-0503-cdp/profile.png` |
| `/capabilities` | 未登录被登录闸门拦截；无能力表/试用按钮泄漏；CDP 抓到 `/api/v1/me` 401 | `heartbeat-20260619-0503-cdp/capabilities.png` |
| `/create/import` | 未登录被登录闸门拦截；未触发 `POST /api/v1/drafts`；in-app browser 点击「去登录」成功跳转 Logto | `heartbeat-20260619-0503-iab/login-click.json` |
| `/create/extract` | 未登录被登录闸门拦截；无 STEP2 内容泄漏；未触发写请求 | `heartbeat-20260619-0503-cdp/create-extract.png` |
| `/create/structure` | 未登录被登录闸门拦截；无 STEP4 内容泄漏；未触发写请求 | `heartbeat-20260619-0503-cdp/create-structure.png` |
| `/create/publish` | 未登录被登录闸门拦截；无 STEP5 内容泄漏；未触发发布/建草稿写请求 | `heartbeat-20260619-0503-cdp/create-publish.png` |
| `/a/nonexistent-e2e-test-slug` | 公开裸壳正常；无 shell/Wayne/Phase 文案；BUG-010 仍复现 | `heartbeat-20260619-0503-cdp/public-capability.png` |
| `/c/nonexistent-creator-e2e` | 公开裸壳正常；无 shell/Wayne/Phase 文案；BUG-010 仍复现 | `heartbeat-20260619-0503-cdp/public-creator.png` |
| `/creators/me/profile` | 401 人话错误 + 去登录 CTA；同时请求 `/api/v1/creators/me/profile` 与 `/api/v1/me` | `heartbeat-20260619-0503-cdp/creators-me-profile.png` |
| `/creators/not-a-uuid/profile` | BUG-011 回归通过：API 404，人话「没找到这个创作者，可能链接失效了。」+ 去修改，不再 500 重试态 | `heartbeat-20260619-0503-cdp/creators-invalid-profile.png` |
| `/creators/00000000-0000-4000-8000-000000000000/profile` | 合法 UUID 缺失 profile 仍 404，人话链接失效态 | `heartbeat-20260619-0503-cdp/creators-valid-missing-profile.png` |
| `/login?failureId=fake-check` | 登录失败人话页正常；无内部错误码；BUG-010 仍复现 | `heartbeat-20260619-0503-cdp/login-failure.png` |
| `/definitely-not-a-real-route` | 生产 404 人话页正常；无内部脚手架文案；BUG-010 仍复现 | `heartbeat-20260619-0503-cdp/not-found.png` |

本轮通过项：

- BUG-001 ~ BUG-008 覆盖到的未登录/公开壳回归在当前 bundle `index-zjwzbwW2.js` 上继续通过：没有后台 shell、Wayne/CGO、`Phase 4`、`页面骨架`、`后端契约前缀`。
- BUG-011 回归通过。非法 creatorId 不再返回 500，不再显示「内容没能加载 + 重试」，而是 404 + `action=change_input` + 人话链接失效文案。
- in-app browser 实际点击 `/create/import` 的「去登录」按钮，成功跳转 Logto：`https://andkzt.logto.app/sign-in?app_id=vbu4vp7h0nczrddmzcpq1`。
- 未登录打开 `/create/import`、`/create/extract`、`/create/structure`、`/create/publish` 没有自动 `POST /api/v1/drafts`，也没有触发发布写请求，符合“未登录不生成草稿/不丢已生成内容”的边界。
- 可见 UI 未出现裸转圈；CDP `noVisibleErrorCodes=true`、`noSpinnerOnly=true`、`noShellLeakOnTestedRoutes=true`。

本轮仍失败：

- BUG-010 仍待修。Chrome CDP 在公开页、登录失败页、404 页以及未登录保护页均抓到 `GET http://localhost/api/v1/me -> 401`，console 仍会留下 401 资源加载噪声。
- BUG-009 仍无法复测。当前无真实登录态/测试账号，生产 `dev-login` 关闭，无法验证登录态中后段深链步骤条是否还按 URL 伪造前序完成态。

UI 还原度备注：

- 本轮新增个人主页 Figma 基准图 `1152:65`。设计结构为 288px 左侧常驻导航 + 右侧 Hero 身份区、指标带、能力密度榜、会话热力图、能力网络、作品墙。
- 未登录 `/profile` 被登录闸门拦截，未泄漏个人主页设计内容；这符合鉴权边界，但无法对真实个人主页的布局、间距、指标、热力图、作品墙和空态做像素级对照。
- 登录后的工作台、个人主页、五步导入、行内试用占位弹层、发布成功后的能力表仍需要真实登录态逐页按 Figma 对照。

仍待验证：

- BUG-009、登录后的五步成功流、发布成功流、真实个人主页数据流、行内试用按钮点击占位弹层仍需人工登录或测试账号支持。

## 持续验收记录（2026-06-19 11:58 Asia/Shanghai，修复后 Chrome Computer Use 回归）

本轮读取来源：

- PRD 本地快照：`docs/测试/创作者中心主链路验收/source/prd-feishu.md`（目录快照时间 2026-06-19 10:50）；本轮未重新拉取飞书在线正文，因此不声称已验证在线 PRD 是否更新。
- Figma MCP：重新截图 `1157:65` 工作台、`1152:65` 个人主页、`1168:65` STEP1、`1168:238` STEP2、`1777:24` STEP3、`1776:24` STEP4、`1778:24` STEP5，并保存到 `screenshots/post-fix-20260619-115819/figma/`。
- contracts：复读 `_index.md`、`00-约定与状态机.md`、`20-step1-import.md`；重点对照 B-20 浏览器直传路径 `presign -> PUT parts -> import/jobs -> jobs/{jobId}/events`。
- 修复提示源：`FIX_AGENT_PROMPT.md`。

本轮 Chrome Computer Use 实测：

| 路由 / 页面 | 操作与结果 | 截图 |
| --- | --- | --- |
| `/creator` | 登录态可进入；5 秒内从骨架转为真实空态/占位态，无 console error。侧栏 288px 对齐 Figma；工作台整体换肤明显改善，但空数据下仍不像 Figma 的经营样例，图表和表格信息密度偏弱。 | `01-dashboard.png`、`01-dashboard-after-5s.png` |
| `/create/import?draftId=...` | STEP1 现在有主路径「从浏览器导入」，DOM 中有文件 input、多文件 input、目录 input（`webkitdirectory`）和拖拽区；命令行/CURL 降为「其它导入方式」。 | `02-step1-initial.png` |
| STEP1 文件选择 | 点击可见「选择文件」能触发 Chrome file chooser，但本轮 `chooser.setFiles(...)` 被 Chrome 扩展返回 `Not allowed`，因此未能把本地 JSONL 测试文件实际注入页面。后端日志未出现 `import/uploads/presign` 或 `import/jobs`。这轮只能确认入口和代码接入存在，不能判定 B-20 E2E 已通过。 | `03-step1-filechooser-not-allowed.png` |
| `/create/extract?draftId=...` | 对无原始数据草稿，页面人话提示「没找到要提取的原始数据，回上一步重新导入」，下一步按钮禁用；但步骤条仍把 STEP1 标成「已完成」。 | `04-step2-direct.png` |
| `/create/select?draftId=...` | 无候选时提示「没有可选的能力」，下一步禁用；但步骤条仍把 STEP1/STEP2 标成「已完成」。 | `04-step3-direct.png` |
| `/create/structure?draftId=...` | 无选择时提示「还没选好要结构化的能力」，下一步禁用；但步骤条仍把 STEP1/STEP2/STEP3 标成「已完成」。 | `04-step4-direct.png` |
| `/create/publish?draftId=...` | 无选择时提示「还没选好要发布的能力」，给「去修改 / 回工作台」；但步骤条仍把 STEP1-STEP4 标成「已完成」。 | `04-step5-direct.png` |
| `/profile` | BUG-014 通过：登录用户自己的个人主页不再整页「没找到创作者」，有 Hero、指标、能力密度、网络、作品墙空态。 | `05-profile.png` |
| `/capabilities` `/analytics` `/earnings` | 均可进入，无 console error，无裸转圈；空态文案可操作。 | `06-capabilities.png`、`06-analytics.png`、`06-earnings.png` |
| `/a/some-slug` `/c/some-creator` | 公开页仍是裸壳占位，无后台侧栏，无 console error。 | `07-public-capability.png`、`07-public-creator.png` |
| `/creators/not-a-uuid/profile` `/this-route-should-not-exist` | 均为人话失败/404；无后台 shell。无效公开 profile 展示 opaque「反馈代码」，本轮先不记为裸错误码，但建议后续产品确认是否符合「绝不裸露错误码」口径。 | `07-public-profile-invalid.png`、`07-notfound.png` |

BUG 回归结论：

| Bug | 本轮结论 | 说明 |
| --- | --- | --- |
| BUG-012 UI 未高保真还原 | 部分改善，但未通过 | 配色、侧栏宽度、步骤条和按钮风格明显改善；但个人主页主体仍只有 880px 宽，在 2268px 视口下右侧大面积空白，和 Figma `1152:65` 的 1056px 宽六分区编排差异明显。工作台空数据态也仍缺 Figma 的图表/表格密度与卡片层级。 |
| BUG-013 STEP1 浏览器导入 | 入口与代码已修，E2E 待复测 | 前端已有文件/目录/拖拽入口；`apps/web/src/pages/upload/step1-import/importApi.ts` 已接 `presign` 和 `import/jobs`；但 Chrome 扩展文件权限阻塞导致本轮无法真实上传文件，network/log 未出现 B-20 请求，不能宣布端到端通过。 |
| BUG-014 `/profile` 无数据错误态 | 通过 | 自己的 `/profile` 不再整页错误，显示可用空态。 |
| BUG-009 中后段深链伪造前序完成 | 仍失败 | 直接带 `draftId` 深链到 STEP2-5，即使草稿没有 snapshot/candidate/selection/version，步骤条仍按当前 URL 把前序标 `done`。 |

轻量定位：

- BUG-013：`BrowserImportCard.tsx` 已提供 `input[type=file]`、`webkitdirectory`、拖拽区和按钮，`importApi.ts` 已提供 `presignPath()` 与 `createJobPath()`，问题不再是前端完全缺主入口。本轮 E2E 阻塞来自 Chrome 扩展 file chooser `setFiles` 的本地权限。
- BUG-009：可疑点在 `apps/web/src/pages/wizard/WizardShell.tsx:62-73`。当前 `hasUrlAnchor` 把 `draftIdParam` 本身当作合法进度锚点，只要 URL 带 `draftId`，`progressStep = routeStep`，导致无 snapshot/候选/选择/版本的草稿也把前序步骤标成 done。应改为以草稿真实产物锚点为准：STEP2 至少需要 `snapshotId`，STEP3 至少需要 `extractJobId` 或 ready candidates，STEP4 至少需要 selection/capability/version，STEP5 至少需要 version/publishable。
- BUG-012：侧栏宽度已接近 Figma；个人主页内容宽度/分区高度、Hero cover、指标带、热力图、能力网络、作品墙卡片网格仍未按 Figma `1152:65` 的层级还原。空数据可以有空态，但布局骨架应保持同等分区密度。

本轮未完成 / 环境阻塞：

- 未能完成真正的浏览器文件上传和 B-20 network 验收。Chrome file chooser 已触发，但 Codex Chrome 扩展 `setFiles` 返回 `Not allowed`。要完成这项测试，需要在 Chrome 的 Codex 扩展详情里开启本地文件访问权限；启用后复测应看到 `POST /api/v1/import/uploads/presign`、对象 PUT、`POST /api/v1/import/jobs`、`GET /api/v1/jobs/{jobId}/events`。
- 因 STEP1 上传未实际完成，本轮无法自然推进到 Step2 提取、Step3 真实候选选择、Step4 真实结构化流、Step5 真实发布成功闭环；本轮 Step2-5 覆盖的是无数据草稿的状态门禁和 UI。

## BUG-012：登录后前端 UI 未按 Figma 高保真还原

严重度：P0 阻断

状态：换肤维度已修待回归（色板/字体/图表/选中态，已真实登录态截图自证，见末尾「修复进展（换肤维度）」）；结构精修（顶栏居中字标、步骤条圆点连线、草稿条单 bar、STEP4/5 缺失 CSS）待续

所在页面/路由：

- 登录后创作者中心整体外壳：`/creator`、`/capabilities`、`/profile`、`/create/*`
- 五步上传向导：`/create/import`、`/create/extract`、`/create/select`、`/create/structure`、`/create/publish`
- 个人主页与公开/私有 profile：`/profile`、`/creators/{creatorId}/profile`

复现与背景：

1. 用户在真实注册/登录后进入产品，确认“前端展示和 Figma 里的样子不一样，没有完全还原”。
2. 既有自动验收多轮只证明未登录闸门、公开裸壳和错误态不再泄漏后台外壳；登录态工作台、个人主页、五步流程主体一直记录为“仍待真实登录态逐页按 Figma 对照”，但没有作为独立阻断 Bug 进入修复队列。
3. 本轮重新用 Figma MCP 读取 STEP1 节点 `1168:65`，设计明确是 288px 侧栏 + 1120px 主体 + 64px 顶栏 + 840px 向导主体，步骤条/标题/进度条/子任务/落库会话列表都有固定信息层级；当前前端实现仍是按本地组件和 CSS 手写拼装，未形成逐页像素级还原闭环。

预期：

- 修复 agent 必须以 PRD 内 Figma 文件为设计真源，逐页对照节点 `1153:65`、`1155:65`、`1157:65`、`1152:65`、`1168:65`、`1168:238`、`1777:24`、`1776:24`、`1778:24`、`1281:65`、`1339:65`、`1246:65`、`1246:314`。
- 登录后 UI 的外壳宽度、导航分组、顶部栏、主体留白、步骤条、卡片密度、表格/图表/进度条、按钮位置、状态文案、错误态和空态都要和 Figma 对齐。
- “功能可用但视觉不像 Figma”应判失败；UI 还原度和功能正确性同等重要。

实际：

- 当前验收资料缺少一轮“登录态逐页 Figma 对照”的通过记录。
- 用户真实登录后确认前端视觉未还原。
- 现有自动记录多次把登录态 UI 归为“仍待验证”，导致修复 agent 容易只修鉴权/接口边界，而未把视觉还原作为阻断项处理。

证据：

- Figma STEP1 基准截图：`docs/测试/创作者中心主链路验收/screenshots/user-reported-20260619-0844/figma-step1-1168-65.png`
- 历史 Figma 基准截图：
  - 外壳：`screenshots/heartbeat-20260619-0703/figma-sidebar-expanded-1153-65.png`、`screenshots/heartbeat-20260619-0703/figma-sidebar-collapsed-1155-65.png`
  - 工作台：`screenshots/heartbeat-20260619-0723/figma-dashboard-1157-65.png`
  - 个人主页：`screenshots/heartbeat-20260619-0744/figma-profile-1152-65.png`
  - STEP1/2：`screenshots/heartbeat-20260619-0804/figma-step1-1168-65.png`、`screenshots/heartbeat-20260619-0804/figma-step2-1168-238.png`
  - STEP3/4：`screenshots/heartbeat-20260619-0824/figma-step3-1777-24.png`、`screenshots/heartbeat-20260619-0824/figma-step4-1776-24.png`
- 用户注册验证码页截图（验证码实际在垃圾邮件中，不单独作为发送失败 Bug）：`docs/测试/创作者中心主链路验收/screenshots/user-reported-20260619-0844/logto-email-verification-spam.png`

轻量定位：

- UI 层主要落点在 `apps/web/src/styles.css`、`apps/web/src/shell/*`、`apps/web/src/pages/dashboard/*`、`apps/web/src/pages/profile/*`、`apps/web/src/pages/upload/*`、`apps/web/src/pages/wizard/*`。
- 修复应按 Figma 页面对组件结构做系统性对齐，而不是只微调单个文案或颜色。

修复进展（2026-06-19，修复 agent，换肤维度）：

修复摘要：
- 以 Figma MCP 实读设计为真源（whoami=D Steve），测绘全部 10 个关键节点产出统一 design token，重做 `apps/web/src/styles.css` 的 `:root`：色板由冷灰+蓝 `#3370ff` 换成暖米三层（bone `#f7f3ec` / rail `#f4f0e7` / paper `#fbf9f4`）+ 砖红 `#a73718`，新增 `--cb-accent-soft/--cb-badge-ok/--cb-ok-olive/--cb-warn/--cb-radius-*/--cb-shadow-card` 等；侧栏 220→288px。
- 引入三族字体并逐类绑定：衬线标题/大数字（Noto Serif SC）、无衬线正文（Noto Sans SC）、等宽大写 label（Geist Mono）。
- 外壳：侧栏/卡片/顶栏硬编码 `#fff` → 暖米层级变量；导航选中去蓝底改暖白底+砖红字；账号头像砖红实底白字 32px；分组小标 mono 大写。
- 残留蓝色 10 处全部收敛到砖红/暖色；绿/橙语义色收敛到 `--cb-badge-ok/--cb-ok-olive/--cb-warn`；图表色板 `charts/theme.ts`（折线/面积/热力图五阶/密度条/趋势）全部改砖红系。

自测证据：
- 本地 `pnpm --filter @cb/web build` 通过；重建并 `up -d` 部署 web 镜像，线上 bundle = `index-B4K4Axih.js`。
- 用 playwright-core 驱动系统 Chrome 真实登录测试账号，逐页登录态截图自证，存 `docs/测试/创作者中心主链路验收/screenshots/impl-20260619/`：
  - 登录闸门/登录页（01/02）：暖米底 + 砖红衬线 Agora + 砖红按钮。
  - 工作台 `10-creator`：对照 Figma 1157:65 高度还原（暖米侧栏 288px / 砖红选中态 / serif 标题与大数字 / 段控 / 草稿胶囊 / 砖红账号头像 / mono 分组标）。
  - STEP1/STEP2 `13`/`14`：暖米+砖红+衬线全部生效。

剩余风险：
- 结构精修未完成（P1）：顶栏仍是「Creator Builder」左对齐而非 Figma 居中字标 `AGORA · CREATOR · xx`；步骤条是分段框而非圆点+连线；草稿条是多卡而非单 bar；STEP4/5 整套类名（cb-structure/cb-app-identity/cb-market-card 等）在 CSS 仍缺规则，需走到该步有真实数据再逐页对照。
- 字体走 Google Fonts @import，中国大陆网络可能加载慢/被墙，已配中文衬线（Songti/STSong）+ 系统等宽 fallback 优雅降级；建议后续自托管 woff2。
- 真实登录另测出两点：自己的 `/profile` 无数据时整页「没找到创作者」错误态（见 BUG-014）；STEP1 仍只有命令行/CURL 导入无浏览器内直传（BUG-013 坐实，登录态截图 `13-create-import` 为证）。

## BUG-013：STEP1 只能通过命令行/助手脚本导入，缺少浏览器内直接导入路径

严重度：P0 阻断

状态：已修待回归（STEP1 新增「从浏览器导入」主入口，接 B-20 presign/分片/jobs/SSE；登录态截图 impl-20260619-v2/13；50/50 测试）

所在页面/路由：`/create/import`

复现步骤：

1. 用户注册并完成登录。
2. 进入 `http://localhost/create/import`。
3. 点击开始导入或查看导入入口。

预期：

- 用户可以直接在浏览器内导入对话历史，例如选择文件/目录、拖拽文件/目录，或通过 File System Access / `<input type="file" webkitdirectory>` 完成浏览器侧导入。
- 浏览器内导入应走 contracts `20-step1-import.md` 的 B-20 直传路径：`POST /api/v1/import/uploads/presign` → 浏览器分批上传原文 part → `POST /api/v1/import/jobs` → 订阅 `/api/v1/jobs/{jobId}/events`。
- 命令行/本机助手脚本可以作为高级/兜底路径，但不能是唯一主路径。

实际：

- Step1 当前 UI 主路径是“生成命令 / 终端运行助手脚本”。用户必须使用脚本或命令行工具才能导入，不符合预期。
- 生产日志显示用户真实登录后进入 `/create/import`，只触发：
  - `POST /api/v1/drafts -> 201`
  - `POST /api/v1/import/connect/pair -> 201`
  - `GET /api/v1/import/connect/pair/{pairId} -> 200`
- 同一时段未看到浏览器直传路径应有的 `POST /api/v1/import/uploads/presign` 或 `POST /api/v1/import/jobs`。

证据：

- 用户反馈：“在 Step 1 的时候，必须得使用脚本或者命令行工具才能完成导入。这也不符合预期，理论上来说，我应该可以直接从浏览器里把这些东西都导进去。”
- 代码定位：
  - `apps/web/src/pages/upload/step1-import/ImportStepPage.tsx:3` 注释写明链路“主推本机助手路径”，点击开始导入只 `createPair`。
  - `apps/web/src/pages/upload/step1-import/ImportEmptyState.tsx:31` UI 主卡是“一键导入（本机直读）”，文案说明“全自动，无需选文件夹”，但实际动作仍进入命令/配对流程。
  - `apps/web/src/pages/upload/step1-import/importApi.ts:4` 明确说前端“不在 UI 起整套分批 PUT”，只暴露铸码/轮询/取消/快照查询。
  - 后端 B-20 已实现直传端点：`apps/api/src/routes/import.ts:29` `/import/uploads/presign`，`apps/api/src/routes/import.ts:38` `/import/jobs`；handler 见 `apps/api/src/routes/import-handlers.ts:57`、`:112`。
- 契约对照：
  - `docs/contracts/20-step1-import.md:20` 明确阶段 A 有“直传路径（B-20）：申请预签名 URL → 浏览器/FS Access 把原文分批直传 S3 → POST /import/jobs”。
  - `docs/contracts/20-step1-import.md:57` 定义 `/import/uploads/presign`。
  - `docs/contracts/20-step1-import.md:103` 定义 `/import/jobs`。

初步根因：

- 前端只接入了 B-21 本机助手路径，未接入已经存在的 B-20 浏览器直传接口。
- Step1 文案把“无需选文件夹”当作卖点，但用户预期和外层旧实现行为是浏览器内即可导入；这里形成产品行为偏差。

修复要求：

- Step1 必须新增浏览器内导入入口，并作为普通用户主路径；可支持文件、目录、拖拽，至少应满足无需终端即可完成一次导入。
- 新增前端 API：presign、分片上传、create import job、上传中断/续传/重签、进度展示、错误态与重试。
- 命令行助手保留为高级入口，但不得替代浏览器导入。
- 修复后必须用真实浏览器登录态完成一次浏览器内导入验证，network 应看到 `import/uploads/presign`、对象上传、`import/jobs`、job SSE；同时截图保存 Step1 空态、上传中、导入中、完成态。

## 持续验收记录（2026-06-19 08:44 Asia/Shanghai，用户真实登录反馈 + STEP1/Figma/代码轻量定位）

本轮新增事实：

## 持续验收记录（2026-06-19 10:05 Asia/Shanghai，Chrome Computer Use 登录态 Step1-5 完整覆盖）

本轮读取来源：

- PRD：飞书 PRD 链接 `https://enbmphajlu.feishu.cn/docx/VlkCdpDiIoJmPGxUWwtclMbRnir`；本地快照 `docs/测试/创作者中心主链路验收/source/prd-feishu.md`（`revision_id=252`）。
- Figma MCP：重新读取并下载工作台 `1157:65`、个人主页 `1152:65`、STEP1 `1168:65`、STEP2 `1168:238`、STEP3 `1777:24`、STEP4 `1776:24`、STEP5 `1778:24`。
- contracts：读取 `docs/contracts/_index.md`、`docs/contracts/00-约定与状态机.md`、`docs/contracts/20-step1-import.md`、`30-step2-extract.md`、`40-step3-4-structure.md`、`50-step5-publish.md`。
- 既有缺陷：复核 BUG-009、BUG-012、BUG-013。

Computer Use / 登录态：

- 用户修复 Chrome 插件后，Chrome Computer Use 连接成功。
- 使用用户授权的测试账号完成 Logto 登录；密码未写入文档、截图或日志。
- 登录后成功进入 `http://localhost/create/import?draftId=019edd9b-f2e6-78b1-89fd-edc242dd1dcf`。

本轮证据目录：

- 实测截图：`docs/测试/创作者中心主链路验收/screenshots/login-e2e-20260619-0958/`
- Figma 源图：`docs/测试/创作者中心主链路验收/screenshots/login-e2e-20260619-0958/figma/`
- Step2-5 DOM/console 摘要：`screenshots/login-e2e-20260619-0958/step2-5-browser-results.json`
- 工作台/个人主页摘要：`screenshots/login-e2e-20260619-0958/dashboard-profile-results.json`

### Step1-5 覆盖结论

| Step | Chrome 实测 | 结论 | 证据 |
| --- | --- | --- | --- |
| Step 1 导入 | 打开 `/create/import?draftId=...`；页面无 `input[type=file]`、无 `webkitdirectory`、无拖拽上传入口；点击「开始导入」后进入“在终端里运行这行命令”，只显示 `curl -fsSL agora.app/import \| sh` 与「等待你在终端运行」 | BUG-013 回归失败；普通用户仍不能浏览器内直接导入 | `chrome-after-auth-check.png`、`step1-after-start-import.png`；API 日志仅有 `POST /api/v1/import/connect/pair` 和 pair 轮询 |
| Step 2 提取 | 直达 `/create/extract?draftId=...`；内容区提示“没找到要提取的原始数据，回上一步重新导入”，但步骤条把 STEP1 标为已完成 | BUG-009 登录态复现；错误态存在但步骤条误导 | `step2-extract.png` |
| Step 3 选择 | 直达 `/create/select?draftId=...`；显示“全部发布（不逐个选）/ 0 个能力 / 没有可选的能力”，步骤条把 STEP1/STEP2 标为已完成 | BUG-009 登录态复现；缺上游数据时不应伪造完成态 | `step3-select.png` |
| Step 4 结构化 | 直达 `/create/structure?draftId=...`；提示“还没选好要结构化的能力”，但步骤条把 STEP1/STEP2/STEP3 标为已完成 | BUG-009 登录态复现 | `step4-structure.png` |
| Step 5 发布 | 直达 `/create/publish?draftId=...`；提示“还没选好要发布的能力”，但步骤条把 STEP1-STEP4 全部标为已完成 | BUG-009 登录态复现 | `step5-publish.png` |

### BUG-012 回归结论：仍待修 / 未通过

登录态页面与 Figma 源图存在系统性差异，不是单点文案问题：

- 外壳：实测为约 200px 左侧栏、浅灰工作区、蓝色高亮和灰白卡片；Figma 源图是 288px 侧栏、米色/红棕视觉系统、明确的顶栏与主内容边界。
- Step1：实测空态是两张卡片 + 蓝色按钮，点击后变成命令行等待页；Figma `1168:65` 是导入进行中结构，包含红棕进度条、子任务清单、导入会话列表和取消导入；实际没有对齐信息层级、进度表达和视觉密度。
- Step2-5：实测直达错误/空态仍显示“前序已完成”的步骤条；Figma 设计均是有真实上下文的五步状态，Step2 有候选卡与失败重试行，Step3 有全部发布卡和候选列表，Step4 有左侧能力切换器与 App Identity 面板，Step5 有市集卡预览与字段来源映射。
- 工作台：实测 `/creator` 为零数据表格/占位文案和草稿条；Figma `1157:65` 是完整经营后台视觉，包括指标带、趋势图、能力体表格和草稿恢复条，当前密度、色彩、布局均未高保真还原。
- 个人主页：实测 `/profile` 对新测试账号直接显示“没找到这个创作者，可能链接失效了”，无创建/补全个人主页引导；Figma `1152:65` 是完整创作者名片六分区。若新登录创作者还未建 profile，应有面向创作者的补全/创建入口，而不是像访问失效公开链接。

初步定位：

- UI 仍主要集中在 `apps/web/src/styles.css`、`apps/web/src/shell/*`、`apps/web/src/pages/dashboard/*`、`apps/web/src/pages/profile/*`、`apps/web/src/pages/upload/*`、`apps/web/src/pages/wizard/*`。
- 修复不能只让路由和接口“不报错”，必须按 Figma 源节点重建视觉骨架、步骤条状态、空态/错误态、底栏与按钮位置。

### BUG-013 回归结论：仍待修 / 未通过

登录态 Step1 主路径仍是 B-21 本机助手/命令行路径：

```text
POST /api/v1/drafts
GET  /api/v1/drafts/{draftId}
POST /api/v1/import/connect/pair
GET  /api/v1/import/connect/pair/{pairId}
```

本轮未观察到 B-20 浏览器直传路径：

```text
POST /api/v1/import/uploads/presign
POST /api/v1/import/jobs
GET  /api/v1/jobs/{jobId}/events
```

静态 DOM 也确认 Step1 当前没有文件选择/目录选择入口：

```json
{ "inputs": [] }
```

对照 contracts `20-step1-import.md`：普通浏览器直传应从 `/import/uploads/presign` 开始，浏览器分批上传原文 part 后再 `/import/jobs` 创建导入 Job；本机助手 B-21 只能是高级/兜底路径，不能是唯一主路径。

### BUG-009 回归结论：仍待修 / 登录态已复现

此前 BUG-009 记录的是“登录态下仍需复测”。本轮用真实测试账号登录后已复现：Step2-5 即使没有上游产物，也会按 URL 把前序步骤标成 done。内容区虽然有错误/空态，但步骤条状态仍会误导用户，说明 `WizardShell` / `wizardMachine` 仍以 URL step 推导前序完成态，没有与真实 `draft.currentStep`、snapshot/candidate/version/job 锚点或 `state_snapshot` 对账。

### 仍未覆盖 / 阻塞

- 因 BUG-013 阻断，无法从浏览器内完成 Step1 导入，因此无法自然推进到 Step2 提取候选、Step3 真实候选选择、Step4 结构化字段流、Step5 发布事务的成功闭环。
- 未执行命令行/本机助手导入，因为本轮目标是验证普通用户浏览器内导入路径；用命令行绕过会掩盖 BUG-013。
- 试用页、发布成功后的能力详情/公开页、真实个人主页数据流仍需在 BUG-013 修复后继续用登录态完整回归。

- 用户确认注册验证码实际在垃圾邮件中，因此暂不把验证码发送链路记为独立缺陷；保留截图作为过程证据。
- 用户真实登录后反馈两个阻断问题：前端整体没有完全还原 Figma；Step1 只能通过命令行/脚本导入，不能直接在浏览器里导入。

本轮读取来源：

- Figma MCP：重新读取 STEP1 节点 `1168:65`，并保存基准截图。
- contracts：重点复核 `docs/contracts/20-step1-import.md` B-20 直传路径与 B-21 助手路径。
- 代码：重点读取 `apps/web/src/pages/upload/step1-import/*` 和 `apps/api/src/routes/import*`。
- 生产日志：复核用户登录后 Step1 的真实请求序列。

本轮结论：

- 新增 BUG-012：登录态前端 UI 未按 Figma 高保真还原，必须作为 P0 阻断项修复和回归。
- 新增 BUG-013：Step1 缺少浏览器内直接导入路径，只接了命令行/助手路径，必须作为 P0 阻断项修复。
- BUG-009/010 仍保留原状态；BUG-012/013 修完后，下一轮验收必须以真实登录态逐页跑 UI 和主链路，不再只停留在未登录边界。

## 持续验收记录（2026-06-19 09:04 Asia/Shanghai，BUG-012/013 优先回归 + Figma MCP + in-app browser）

本轮读取来源：

- 飞书 PRD 在线读取成功：`revision_id=252`，与本地 `source/` 快照标注一致；本轮未发现在线 PRD 更新漂移。`lark-cli` 提示当前版本 `1.0.52`、可更新到 `1.0.56`，但未执行更新。
- Figma MCP：重新读取并截图 `STEP1 1168:65` 与工作台 `1157:65`；`1168:65` metadata 再次确认设计结构为 288px 左侧栏、1120px 主体、64px 顶栏、840px 五步向导内容区，包含步骤条、标题、进度条、子任务、落库会话列表与取消导入。
- contracts：复核 `docs/contracts/_index.md`、`docs/contracts/00-约定与状态机.md`、`docs/contracts/20-step1-import.md`；STEP1 重点确认 B-20 直传路径和 B-21 本机助手路径差异。
- 生产 Docker 栈：`/health` 与 `/ready` 均正常，api/web/worker/consumer/logto/minio/postgres/redis 等容器运行中。

本轮 computer use / 真实浏览器结果：

- in-app browser 访问 `http://localhost/create/import`，当前浏览器无登录态，只看到登录闸门：`Agora / 请先登录后进入创作者中心。 / 去登录`。
- 截图：`screenshots/heartbeat-20260619-0904/iab-create-import.png`。
- DOM 记录：`screenshots/heartbeat-20260619-0904/iab-create-import-dom.json`；可见 `fileInputCount=0`，但因页面停在未登录闸门，不能据此证明登录后 Step1 主体没有 file input。
- console 记录：`screenshots/heartbeat-20260619-0904/iab-create-import-console.json`，本轮该页无 console 输出。
- 可用浏览器后端列表只有 Codex in-app browser；未发现可复用用户 Chrome / extension 登录态，因此本轮无法完成登录后 UI 像素验收，也无法在浏览器里实测登录后 Step1 导入闭环。

BUG-012 回归结论：仍待修 / 未通过。

- 本轮新增 Figma 基准截图：`screenshots/heartbeat-20260619-0904/figma-step1-1168-65.png`、`screenshots/heartbeat-20260619-0904/figma-dashboard-1157-65.png`。
- 当前没有任何修复后的登录态逐页截图与 Figma 对照证据；用户真实登录反馈“前端展示和 Figma 不一样”仍是有效阻断。
- 本轮真实浏览器只到登录闸门，不能把未登录页面视为登录后 UI 通过。下一轮若拿到登录态，必须优先按 Figma 节点逐页核外壳、工作台、个人主页、STEP1-5、试用页的布局密度、组件状态、步骤条、按钮位置、错误态和空态。

BUG-013 回归结论：仍待修 / 未通过。

- 代码复核显示 Web Step1 仍以 B-21 本机助手路径为主：
  - `apps/web/src/pages/upload/step1-import/ImportStepPage.tsx` 顶部注释仍写“主推本机助手路径”，`handleStart` 仍只调用 `createPair()`。
  - `apps/web/src/pages/upload/step1-import/ImportEmptyState.tsx` 仍展示“一键导入（本机直读）”和 “CURL 命令导入”，文案强调“无需选文件夹”，没有浏览器文件/目录选择或拖拽入口。
  - `apps/web/src/pages/upload/step1-import/importApi.ts` 仍明确说本模块“不在 UI 起整套分批 PUT”，只暴露铸码 / 轮询 / 取消 / 快照查询。
- 后端 B-20 端点仍存在：`apps/api/src/routes/import.ts` 暴露 `/import/uploads/presign` 与 `/import/jobs`，handler 位于 `apps/api/src/routes/import-handlers.ts`。
- 本轮生产日志里仅看到未登录探针访问 `POST /api/v1/import/uploads/presign` 与 `POST /api/v1/import/jobs` 均返回 401，说明端点存在且受鉴权保护；这不是浏览器 UI 主路径接入成功的证据。
- 未在登录态 UI 中观察到 `import/uploads/presign` → 对象上传 → `import/jobs` → job SSE 的 B-20 完整链路；BUG-013 仍失败。

全局硬规则检查：

- 未登录闸门本轮没有裸转圈，也没有在 UI 上裸露错误码。
- 本轮未进入生成/导入内容态，无法验证“已生成内容不丢”。

初步定位：

- BUG-012：主要落点仍在 `apps/web/src/styles.css`、`apps/web/src/shell/*`、`apps/web/src/pages/dashboard/*`、`apps/web/src/pages/profile/*`、`apps/web/src/pages/upload/*`、`apps/web/src/pages/wizard/*`，需要按 Figma 系统性还原，而不是只改单点文案。
- BUG-013：前端 Step1 缺 B-20 浏览器直传 UI 和 API 封装；应新增文件/目录/拖拽入口、presign、分片上传、`POST /import/jobs`、job SSE、上传中断/重试/续传/完成态，B-21 命令行助手只保留为高级/兜底入口。

仍待验证：

- 需要真实登录态或测试账号支持，才能完成登录后 UI 逐页 Figma 对照、Step1 浏览器直传闭环、五步主链路、发布、试用、公开页与恢复态回归。

## 持续验收记录（2026-06-19 09:24 Asia/Shanghai，BUG-012/013 优先回归 + Figma MCP + in-app browser）

本轮读取来源：

- 飞书 PRD 在线读取成功：`revision_id=252`，与本地 `source/` 快照一致；本轮未发现 PRD 更新漂移。`lark-cli` 仍提示当前 `1.0.52`、最新 `1.0.56`，本轮未升级。
- Figma MCP：补充读取并截图个人主页 `1152:65`、STEP2 `1168:238`；`1168:238` metadata 确认 STEP2 设计仍为 288px 左侧栏、1120px 主体、840px 内容区，含五步步骤条、保存草稿、候选能力列表、频率条、失败可重试行、底部主按钮和置信分布。
- contracts：复核 `20-step1-import.md` 的 B-20 / B-21 分流；B-20 仍是浏览器/FS Access 分批直传，B-21 是本机助手配对码/命令行路径。
- 代码：复核 `apps/web/src/pages/upload/step1-import/*` 与 `apps/api/src/routes/import*`。
- 生产 Docker 栈：`/health` 与 `/ready` 正常，容器均运行中。

本轮 computer use / 真实浏览器结果：

- in-app browser 访问 `http://localhost/create/import`，当前浏览器仍无登录态；页面只显示 `Agora / 请先登录后进入创作者中心。 / 去登录`。
- 截图与 DOM：`screenshots/heartbeat-20260619-0924/iab-create-import-before.jpg`、`screenshots/heartbeat-20260619-0924/iab-create-import-before.json`。
- 页面 DOM 显示 `fileInputCount=0`，但本轮仍停在未登录闸门，因此不能据此证明登录后 Step1 主体缺 file input；只能作为“未拿到登录态”的证据。
- 实际点击“去登录”后，服务端日志显示 `GET /api/v1/auth/login?returnTo=%2Fcreate%2Fimport -> 302`；浏览器脚本等待登录跳转时超时，未成功保存登录页截图。本轮不输入账号、不处理验证码。
- 可用浏览器后端列表仍只有 Codex in-app browser，没有可复用用户 Chrome / extension 登录态。

BUG-012 回归结论：仍待修 / 未通过。

- 本轮新增 Figma 基准截图：`screenshots/heartbeat-20260619-0924/figma-profile-1152-65.png`、`screenshots/heartbeat-20260619-0924/figma-step2-1168-238.png`。
- 仍没有修复后的登录态逐页截图与 Figma 对照证据；无法验证外壳、工作台、个人主页、STEP1-5、试用页的布局密度、组件层级、按钮位置、错误态/空态是否已按 Figma 还原。
- 因为真实浏览器没有登录态，本轮只能补 Figma 基准和未登录闸门证据，不能把未登录页面视为登录后 UI 通过。

BUG-013 回归结论：仍待修 / 未通过。

- Web Step1 代码仍只接 B-21 本机助手路径：
  - `ImportStepPage.tsx` 顶部链路仍写“主推本机助手路径”，`handleStart` 仍调用 `createPair()`。
  - `ImportEmptyState.tsx` 仍是“一键导入（本机直读）”与 “CURL 命令导入”，无浏览器文件/目录选择或拖拽主入口。
  - `importApi.ts` 仍说明“不在 UI 起整套分批 PUT”，没有 presign / part upload / create import job 封装。
- 后端 B-20 端点仍存在，但本轮日志未观察到登录态 UI 主动触发 `POST /api/v1/import/uploads/presign`、对象上传、`POST /api/v1/import/jobs` 或 job SSE。
- 生产日志本轮只记录未登录 `/api/v1/me -> 401` 与点击登录后的 `/api/v1/auth/login -> 302`；没有新的登录态 `POST /api/v1/drafts`、`POST /api/v1/import/connect/pair` 或 B-20 直传闭环。

全局硬规则检查：

- 未登录闸门没有裸转圈，也没有在 UI 上裸露错误码。
- 未进入导入/生成内容态，无法验证“已生成内容不丢”。

初步定位：

- BUG-012 仍需修复 agent 按 Figma 源节点逐页做高保真还原，重点是 shell、dashboard、profile、STEP1/2 已补充基准，后续还要继续核 STEP3/4/5 和试用页。
- BUG-013 仍需在前端新增 B-20 浏览器直传主路径；后端端点已有，缺的是 Web UI 和 API 封装，以及真实浏览器登录态的 network 验收。

仍待验证：

- 需要真实登录态或测试账号支持，才能完成登录后 UI 逐页 Figma 对照、Step1 浏览器直传闭环、五步主链路、发布、试用、公开页与恢复态回归。

## 持续验收记录（2026-06-19 08:24 Asia/Shanghai，STEP3/STEP4 Figma 基准 + 选择/结构化未登录边界）

本轮读取来源：

- 在线飞书 PRD：`https://enbmphajlu.feishu.cn/docx/VlkCdpDiIoJmPGxUWwtclMbRnir`，`revision_id=252`，与本地快照一致；`lark-cli` 仍提示当前 `1.0.52`、最新 `1.0.56`，本轮未升级。
- PRD 本地快照：`docs/测试/创作者中心主链路验收/source/prd-feishu.md`。
- Figma MCP：读取并补截图 STEP3 修订态 `1777:24`、STEP4 `1776:24`。
- contracts：`docs/contracts/_index.md`、`docs/contracts/00-约定与状态机.md`，并重点复核 `40-step3-4-structure.md`。
- 既有 Bug 清单与修复说明：本文件、`FIX_AGENT_PROMPT.md`、既有 `screenshots/` 和 `source/`。

生产栈状态：

```text
GET /health -> 200 {"status":"ok"}
GET /ready  -> ready=true，db/redis_queue/redis_hot/minio/logto 均 ok，llm 为 optional ok
线上 bundle -> index-zjwzbwW2.js / index-CMiPoXZv.css
```

真实浏览器证据：

- Figma STEP3 修订态基准：`docs/测试/创作者中心主链路验收/screenshots/heartbeat-20260619-0824/figma-step3-1777-24.png`
- Figma STEP4 基准：`docs/测试/创作者中心主链路验收/screenshots/heartbeat-20260619-0824/figma-step4-1776-24.png`
- in-app browser DOM 摘要：`docs/测试/创作者中心主链路验收/screenshots/heartbeat-20260619-0824-iab/summary.json`
- Chrome network/console 截图与摘要：`docs/测试/创作者中心主链路验收/screenshots/heartbeat-20260619-0824-cdp/summary.json`
- Chrome STEP3/STEP4 API 未登录检查：`docs/测试/创作者中心主链路验收/screenshots/heartbeat-20260619-0824-cdp/api-checks.json`
- Chrome 登录点击截图：`docs/测试/创作者中心主链路验收/screenshots/heartbeat-20260619-0824-cdp/login-click-after.png`

本轮 computer use 实测路由与 API：

| 路由 / API | 回归结果 | 证据 |
| --- | --- | --- |
| `/create/select` | 未登录被登录闸门拦截；无 STEP3「全部发布 / 逐个选定 / 下一步结构化」内容泄漏；未触发 selection 写请求 | `heartbeat-20260619-0824-cdp/01-create-select.png` |
| `/create/structure` | 未登录被登录闸门拦截；无 STEP4 App Identity、软硬字段、切换能力内容泄漏；未触发结构化写请求 | `heartbeat-20260619-0824-cdp/02-create-structure.png` |
| `/create/publish` / `/capabilities` | 未登录被登录闸门拦截；无 STEP5/能力表/试用按钮泄漏；未触发发布或 runtime 写请求 | `heartbeat-20260619-0824-cdp/03-create-publish.png`、`04-capabilities.png` |
| `/creator` / `/profile` | 未登录被登录闸门拦截；无工作台/个人主页主体泄漏；仍触发 `/api/v1/me` 401 | `heartbeat-20260619-0824-cdp/05-creator.png`、`06-profile.png` |
| `/login?failureId=fake-check` | 登录失败人话页正常；无内部错误码；BUG-010 仍复现 | `heartbeat-20260619-0824-cdp/07-login-failureId-fake-check.png` |
| `/definitely-not-a-real-route` | 生产 404 人话页正常；无内部脚手架文案；BUG-010 仍复现 | `heartbeat-20260619-0824-cdp/08-definitely-not-a-real-route.png` |
| `/a/nonexistent-e2e-test-slug` / `/c/nonexistent-creator-e2e` | 公开占位页正常；无 shell/Wayne/Phase 文案；BUG-010 仍复现 | `heartbeat-20260619-0824-cdp/09-a-nonexistent-e2e-test-slug.png`、`10-c-nonexistent-creator-e2e.png` |
| Chrome 点击 `/create/structure` 的「去登录」 | 成功跳转 `https://andkzt.logto.app/sign-in?app_id=vbu4vp7h0nczrddmzcpq1` | `heartbeat-20260619-0824-cdp/login-click-after.png` |
| `PATCH /api/v1/drafts/{draftId}/selection` | 未登录 401，人话 `userMessage=登录态失效了，请重新登录。`，无 `error.code`；写探针被挡住 | `heartbeat-20260619-0824-cdp/api-checks.json` |
| `POST /api/v1/capabilities` | 未登录 401，人话包络；无 `error.code`；写探针被挡住 | `heartbeat-20260619-0824-cdp/api-checks.json` |
| `GET /api/v1/versions/{versionId}/manifest` | 未登录 401，人话包络；无 manifest 数据泄漏 | `heartbeat-20260619-0824-cdp/api-checks.json` |
| `POST /api/v1/versions/{versionId}/structure` | 未登录 401，人话包络；结构化写探针被挡住 | `heartbeat-20260619-0824-cdp/api-checks.json` |
| `GET /api/v1/versions/{versionId}/structure/events` | 未登录建流前 401，人话包络；符合结构化 SSE 鉴权失败走 HTTP ErrorEnvelope | `heartbeat-20260619-0824-cdp/api-checks.json` |
| `PATCH /api/v1/versions/{versionId}/manifest` / `POST /api/v1/versions/{versionId}/manifest/fields/tagline/regenerate` | 未登录 401，人话包络；软字段编辑/重生成写探针被挡住 | `heartbeat-20260619-0824-cdp/api-checks.json` |

本轮通过项：

- BUG-001 ~ BUG-008 覆盖到的未登录/公开壳回归在当前 bundle `index-zjwzbwW2.js` 上继续通过：没有后台 shell、Wayne/CGO、`Phase 4`、`页面骨架`、`后端契约前缀`。
- STEP3/STEP4 路由未登录态只显示「Agora / 请先登录后进入创作者中心 / 去登录」，没有泄漏选择列表、全部发布卡、保存草稿、App Identity、软硬字段或字段流状态。
- Chrome 真实 network 摘要：`noVisibleErrorCodes=true`、`noSpinnerOnly=true`、`privateRoutesGateUnauth=true`、`noRouteApiWrites=true`、`directWriteProbesAllBlocked=true`、`step34Api401Human=true`、`structureSse401Human=true`。
- STEP3/STEP4 相关直接 API 检查均只返回 `userMessage/action/retriable/traceId`，未对外暴露 `error.code`；结构化 SSE 未登录握手也在建流前返回 HTTP 401 ErrorEnvelope。
- Chrome 真实点击 `/create/structure` 的「去登录」成功跳 Logto；in-app browser DOM 检查也确认按钮唯一可见，但其点击外部导航时发生工具侧 CDP timeout，本轮仍以 Chrome 点击证据为准。
- 本轮未观察到任何路由自动触发的 `PATCH /api/v1/drafts/{draftId}/selection`、`POST /api/v1/capabilities`、`POST /api/v1/versions/{versionId}/structure`、`PATCH /api/v1/versions/{versionId}/manifest`、`POST /api/v1/versions/{versionId}/manifest/fields/{field}/regenerate` 或发布/试用写请求。

本轮仍失败：

- BUG-010 仍待修。Chrome network 在公开页、登录失败页、404 页以及未登录保护页均抓到 `GET http://localhost/api/v1/me -> 401`；本轮 `me401Count=10`，其中公开/登录失败/404 路由 `publicMe401Count=4`，console error 共 10 条。
- BUG-009 仍无法复测。当前无真实登录态/测试账号，生产 `dev-login` 关闭，无法验证登录态中后段深链步骤条是否还按 URL 伪造前序完成态。

轻量定位：

- BUG-010 代码线索仍指向 `apps/web/src/App.tsx:35` 外层 `<AuthProvider>` 包住公开/受保护路由，以及 `apps/web/src/shell/auth.tsx:111` 的 `AuthProvider` mount 后无条件执行 `useMe()`；`auth.tsx:86` 的 `useMe()` 固定请求 `/api/v1/me`。
- STEP3/STEP4 未登录直接写探针全部被鉴权挡在 401，未发现副作用；如果后续登录态出现选择保存/结构化重复执行，应继续沿 `40-step3-4-structure.md` 的 `draft.selection.patch`、`capability.create`、`structure.start`、`manifest.patch`、`manifest.regenerate_field` scope 定位。

UI 还原度备注：

- 本轮新增 STEP3 修订态 Figma 基准。节点 `1777:24` 为 1408x858：展开侧栏 288px，主区 840px；步骤条中导入/提取完成、选择为第 3 步；主体包含「选一个能力发布」、全部发布 card、逐个选定列表 4 行、底部已选状态和「下一步:结构化『面向大厂PM的资格打分器』→」CTA。
- 本轮新增 STEP4 Figma 基准。节点 `1776:24` 为 1408x1130：左侧能力切换器 190px，右侧 App Identity 面板 630px；软字段 7 项可改/可重生成，硬字段 6 项锁定；底部显示「软 7 项可改 · 硬 6 项锁定(第 4 步,共 5 步)」和「下一步:发布 →」。
- 未登录 `/create/select`、`/create/structure` 被登录闸门拦截，当前只能验证不会泄漏登录态业务 UI；真实登录态 STEP3 的选变不写库、保存草稿、全部发布，和 STEP4 的字段流、卡住三退路、软字段编辑/重生成、硬字段锁定仍无法逐像素和功能端到端对照。

仍待验证：

- BUG-009、登录后的 STEP3 选变/保存草稿/全部发布、STEP4 结构化字段流与卡住三退路、STEP5 发布成功流、真实个人主页数据流、行内试用按钮点击占位弹层仍需人工登录或测试账号支持。

## 持续验收记录（2026-06-19 08:04 Asia/Shanghai，STEP1/STEP2 Figma 基准 + 导入/提取未登录边界）

本轮读取来源：

- 在线飞书 PRD：`https://enbmphajlu.feishu.cn/docx/VlkCdpDiIoJmPGxUWwtclMbRnir`，`revision_id=252`，与本地快照一致；`lark-cli` 仍提示当前 `1.0.52`、最新 `1.0.56`，本轮未升级。
- PRD 本地快照：`docs/测试/创作者中心主链路验收/source/prd-feishu.md`。
- Figma MCP：读取并补截图 STEP1 `1168:65`、STEP2 `1168:238`。
- contracts：`docs/contracts/_index.md`、`docs/contracts/00-约定与状态机.md`，并重点复核 `20-step1-import.md`、`30-step2-extract.md`。
- 既有 Bug 清单与修复说明：本文件、`FIX_AGENT_PROMPT.md`、既有 `screenshots/` 和 `source/`。

生产栈状态：

```text
GET /health -> 200 {"status":"ok"}
GET /ready  -> ready=true，db/redis_queue/redis_hot/minio/logto 均 ok，llm 为 optional ok
线上 bundle -> index-zjwzbwW2.js / index-CMiPoXZv.css
```

真实浏览器证据：

- Figma STEP1 基准：`docs/测试/创作者中心主链路验收/screenshots/heartbeat-20260619-0804/figma-step1-1168-65.png`
- Figma STEP2 基准：`docs/测试/创作者中心主链路验收/screenshots/heartbeat-20260619-0804/figma-step2-1168-238.png`
- in-app browser DOM 摘要：`docs/测试/创作者中心主链路验收/screenshots/heartbeat-20260619-0804-iab/summary.json`
- Chrome network/console 截图与摘要：`docs/测试/创作者中心主链路验收/screenshots/heartbeat-20260619-0804-cdp/summary.json`
- Chrome 导入/提取 API 未登录检查：`docs/测试/创作者中心主链路验收/screenshots/heartbeat-20260619-0804-cdp/api-checks.json`
- Chrome 登录点击截图：`docs/测试/创作者中心主链路验收/screenshots/heartbeat-20260619-0804-cdp/login-click-after.png`

本轮 computer use 实测路由与 API：

| 路由 / API | 回归结果 | 证据 |
| --- | --- | --- |
| `/create/import` | 未登录被登录闸门拦截；无 STEP1 进度/子任务/上传内容泄漏；未触发导入写请求 | `heartbeat-20260619-0804-cdp/01-create-import.png` |
| `/create/extract` | 未登录被登录闸门拦截；无 STEP2 候选列表/失败行/保存草稿泄漏；未触发提取写请求 | `heartbeat-20260619-0804-cdp/02-create-extract.png` |
| `/create/select` | 未登录被登录闸门拦截；无 STEP3 内容泄漏；未触发 selection 写请求 | `heartbeat-20260619-0804-cdp/03-create-select.png` |
| `/create/structure` | 未登录被登录闸门拦截；无 STEP4 内容泄漏；未触发结构化写请求 | `heartbeat-20260619-0804-cdp/04-create-structure.png` |
| `/create/publish` | 未登录被登录闸门拦截；无 STEP5 内容泄漏；未触发发布/批量发布写请求 | `heartbeat-20260619-0804-cdp/05-create-publish.png` |
| `/creator` / `/profile` | 未登录被登录闸门拦截；无工作台/个人主页主体泄漏；仍触发 `/api/v1/me` 401 | `heartbeat-20260619-0804-cdp/06-creator.png`、`07-profile.png` |
| `/login?failureId=fake-check` | 登录失败人话页正常；无内部错误码；仍触发 `/api/v1/me` 401 | `heartbeat-20260619-0804-cdp/08-login-failureId-fake-check.png` |
| `/definitely-not-a-real-route` | 生产 404 人话页正常；无内部脚手架文案；BUG-010 仍复现 | `heartbeat-20260619-0804-cdp/09-definitely-not-a-real-route.png` |
| `/a/nonexistent-e2e-test-slug` / `/c/nonexistent-creator-e2e` | 公开占位页正常；无 shell/Wayne/Phase 文案；BUG-010 仍复现 | `heartbeat-20260619-0804-cdp/10-a-nonexistent-e2e-test-slug.png`、`11-c-nonexistent-creator-e2e.png` |
| Chrome 点击 `/create/import` 的「去登录」 | 成功跳转 `https://andkzt.logto.app/sign-in?app_id=vbu4vp7h0nczrddmzcpq1` | `heartbeat-20260619-0804-cdp/login-click-after.png` |
| `POST /api/v1/import/jobs` | 未登录 401，人话 `userMessage=登录态失效了，请重新登录。`，无 `error.code`；写探针被挡住 | `heartbeat-20260619-0804-cdp/api-checks.json` |
| `POST /api/v1/import/connect/pair` | 未登录 401，人话包络；无 `error.code`；写探针被挡住 | `heartbeat-20260619-0804-cdp/api-checks.json` |
| `GET /api/v1/jobs/{id}/events` | 未登录建流前 401，人话包络；符合 SSE 鉴权失败走 HTTP ErrorEnvelope | `heartbeat-20260619-0804-cdp/api-checks.json` |
| `GET /api/v1/snapshots/{id}` / `POST /api/v1/snapshots/{id}/extract` | 未登录 401，人话包络；提取写探针被挡住 | `heartbeat-20260619-0804-cdp/api-checks.json` |
| `GET /api/v1/extract-jobs/{id}/candidates` / `POST /api/v1/candidates/{id}/retry` | 未登录 401，人话包络；候选重试写探针被挡住 | `heartbeat-20260619-0804-cdp/api-checks.json` |

本轮通过项：

- BUG-001 ~ BUG-008 覆盖到的未登录/公开壳回归在当前 bundle `index-zjwzbwW2.js` 上继续通过：没有后台 shell、Wayne/CGO、`Phase 4`、`页面骨架`、`后端契约前缀`。
- 五步路由未登录态均只显示「Agora / 请先登录后进入创作者中心 / 去登录」，没有泄漏 STEP1/STEP2/STEP3/STEP4/STEP5 登录态 UI。
- Chrome 真实 network 摘要：`noVisibleErrorCodes=true`、`noSpinnerOnly=true`、`privateRoutesGateUnauth=true`、`noRouteApiWrites=true`、`directWriteProbesAllBlocked=true`、`importExtractApi401Human=true`。
- 导入/提取相关直接 API 检查均只返回 `userMessage/action/retriable/traceId`，未对外暴露 `error.code`；SSE 未登录握手也在建流前返回 HTTP 401 ErrorEnvelope。
- Chrome 真实点击 `/create/import` 的「去登录」成功跳 Logto；in-app browser DOM 检查也确认按钮唯一可见，但其点击外部导航时发生工具侧 CDP timeout，本轮以 Chrome 点击证据为准。
- 本轮未观察到任何路由自动触发的 `POST /api/v1/import/jobs`、`POST /api/v1/import/connect/pair`、`POST /api/v1/snapshots/{id}/extract`、`PATCH /api/v1/drafts/{draftId}/selection`、`POST /api/v1/capabilities`、`POST /api/v1/versions/{versionId}/publish` 等写请求。

本轮仍失败：

- BUG-010 仍待修。Chrome network 在公开页、登录失败页、404 页以及未登录保护页均抓到 `GET http://localhost/api/v1/me -> 401`；本轮 `me401Count=11`，其中公开/登录失败/404 路由 `publicMe401Count=4`，console error 共 11 条。
- BUG-009 仍无法复测。当前无真实登录态/测试账号，生产 `dev-login` 关闭，无法验证登录态中后段深链步骤条是否还按 URL 伪造前序完成态。

轻量定位：

- BUG-010 代码线索仍指向 `apps/web/src/App.tsx:35` 外层 `<AuthProvider>` 包住公开/受保护路由，以及 `apps/web/src/shell/auth.tsx:111` 的 `AuthProvider` mount 后无条件执行 `useMe()`；`auth.tsx:86` 的 `useMe()` 固定请求 `/api/v1/me`。
- 导入/提取未登录直接写探针全部被鉴权挡在 401，未发现副作用；如果后续登录态出现草稿/任务错乱，应继续沿 `20-step1-import.md` 的 `import.create/import.connect.pair` 幂等 scope 与 `30-step2-extract.md` 的 `extract.create/candidate.retry` scope 做定位。

UI 还原度备注：

- 本轮新增 STEP1 Figma 基准。节点 `1168:65` 为导入 loading 态：展开侧栏 288px、顶部 `上传能力 / Creator Builder`、五步步骤条，主体 840px 宽；核心文案「正在导入你的对话历史…」、68% 进度条、五项子任务、正在落入的会话列表和「取消导入」入口。
- 本轮新增 STEP2 Figma 基准。节点 `1168:238` 包含完成态与 loading 态：完成态有「保存草稿」、五步步骤条、绿色 raw data summary、6 行候选卡、失败可重试行、底部识别计数/置信分布/「下一步：批量处理已选 3 项」；loading 态有子任务清单、已浮现候选和骨架行。
- 未登录 `/create/import`、`/create/extract` 被登录闸门拦截，当前只能验证不会泄漏登录态业务 UI；真实登录态 STEP1 的进度/SSE/取消/落库列表，以及 STEP2 的候选逐个浮现、失败重试、保存草稿、底部 CTA、置信分布仍无法逐像素对照。

仍待验证：

- BUG-009、登录后的 STEP1 导入成功流、STEP2 提取候选流、STEP3/4/5、发布成功流、真实个人主页数据流、行内试用按钮点击占位弹层仍需人工登录或测试账号支持。

## 持续验收记录（2026-06-19 05:23 Asia/Shanghai，STEP3 修订态 Figma 基准 + in-app browser + Chrome network）

本轮读取来源：

- 在线飞书 PRD：`https://enbmphajlu.feishu.cn/docx/VlkCdpDiIoJmPGxUWwtclMbRnir`，`revision_id=252`，与本地快照一致；`lark-cli` 仍提示当前 `1.0.52`、最新 `1.0.56`，本轮未升级。
- PRD 本地快照：`docs/测试/创作者中心主链路验收/source/prd-feishu.md`。
- Figma MCP：读取 Page `233:65`，并补截图 STEP3 修订态节点 `1777:24`；PRD 内 `1818:24` 仍只作为修订说明文字，不当作页面设计节点。
- contracts：`docs/contracts/_index.md`、`docs/contracts/00-约定与状态机.md`，并重点复核 `40-step3-4-structure.md`。
- 既有 Bug 清单与修复说明：本文件、`FIX_AGENT_PROMPT.md`。

生产栈状态：

```text
GET /health -> 200 {"status":"ok"}
GET /ready  -> ready=true，db/redis_queue/redis_hot/minio/logto 均 ok，llm 为 optional ok
线上 bundle -> index-zjwzbwW2.js / index-CMiPoXZv.css
```

真实浏览器证据：

- Figma STEP3 修订态参考截图：`docs/测试/创作者中心主链路验收/screenshots/heartbeat-20260619-0523/figma-step3-1777-24.png`
- in-app browser 截图与 DOM 摘要：`docs/测试/创作者中心主链路验收/screenshots/heartbeat-20260619-0523-iab/summary.json`
- in-app browser 登录点击证据：`docs/测试/创作者中心主链路验收/screenshots/heartbeat-20260619-0523-iab/login-click.json`
- Chrome network/console 截图与摘要：`docs/测试/创作者中心主链路验收/screenshots/heartbeat-20260619-0523-cdp/summary.json`

本轮 computer use 实测路由：

| 路由 | 回归结果 | 证据 |
| --- | --- | --- |
| `/` | 未登录登录闸门正常；无 shell/Wayne/Phase 文案；仍触发 `/api/v1/me` 401 | `heartbeat-20260619-0523-cdp/home.png` |
| `/creator` | 未登录被登录闸门拦截；无经营后台泄漏；仍触发 `/api/v1/me` 401 | `heartbeat-20260619-0523-cdp/creator.png` |
| `/profile` | 未登录被登录闸门拦截；无个人主页内容泄漏；仍触发 `/api/v1/me` 401 | `heartbeat-20260619-0523-cdp/profile.png` |
| `/capabilities` | 未登录被登录闸门拦截；无能力表/试用按钮泄漏；仍触发 `/api/v1/me` 401 | `heartbeat-20260619-0523-cdp/capabilities.png` |
| `/create/import` | 未登录被登录闸门拦截；未触发 `POST /api/v1/drafts`；in-app browser 点击「去登录」可跳转 Logto | `heartbeat-20260619-0523-iab/login-click.json` |
| `/create/select` | 未登录被登录闸门拦截；没有泄漏 STEP3 选择页内容；未触发草稿写请求 | `heartbeat-20260619-0523-cdp/create-select.png` |
| `/create/extract` | 未登录被登录闸门拦截；无 STEP2 内容泄漏；未触发写请求 | `heartbeat-20260619-0523-cdp/create-extract.png` |
| `/create/structure` | 未登录被登录闸门拦截；无 STEP4 内容泄漏；未触发写请求 | `heartbeat-20260619-0523-cdp/create-structure.png` |
| `/create/publish` | 未登录被登录闸门拦截；无 STEP5 内容泄漏；未触发发布/建草稿写请求 | `heartbeat-20260619-0523-cdp/create-publish.png` |
| `/a/nonexistent-e2e-test-slug` | 公开裸壳正常；无 shell/Wayne/Phase 文案；BUG-010 仍复现 | `heartbeat-20260619-0523-cdp/public-capability.png` |
| `/c/nonexistent-creator-e2e` | 公开裸壳正常；无 shell/Wayne/Phase 文案；BUG-010 仍复现 | `heartbeat-20260619-0523-cdp/public-creator.png` |
| `/creators/not-a-uuid/profile` | BUG-011 继续通过：profile API 404，人话链接失效 + 去修改，不再 500 重试态 | `heartbeat-20260619-0523-cdp/creators-invalid-profile.png` |
| `/creators/00000000-0000-4000-8000-000000000000/profile` | 合法 UUID 缺失 profile 仍 404，人话链接失效态 | `heartbeat-20260619-0523-cdp/creators-valid-missing-profile.png` |
| `/login?failureId=fake-check` | 登录失败人话页正常；无内部错误码；BUG-010 仍复现 | `heartbeat-20260619-0523-cdp/login-failure.png` |
| `/definitely-not-a-real-route` | 生产 404 人话页正常；无内部脚手架文案；BUG-010 仍复现 | `heartbeat-20260619-0523-cdp/not-found.png` |

本轮通过项：

- BUG-001 ~ BUG-008 覆盖到的未登录/公开壳回归在当前 bundle `index-zjwzbwW2.js` 上继续通过：没有后台 shell、Wayne/CGO、`Phase 4`、`页面骨架`、`后端契约前缀`。
- BUG-011 继续通过。非法 creatorId 的页面与 API 均为 404 人话链接失效态，不再出现 500 或「内容没能加载 + 重试」。
- 未登录打开 `/create/import`、`/create/select`、`/create/extract`、`/create/structure`、`/create/publish` 均没有自动 `POST /api/v1/drafts`，也没有触发发布写请求，符合“未登录不生成草稿/不丢已生成内容”的边界。
- 可见 UI 未出现裸转圈；Chrome network 摘要 `noVisibleErrorCodes=true`、`noSpinnerOnly=true`、`noShellLeakOnTestedRoutes=true`、`privateRoutesGateUnauth=true`。

本轮仍失败：

- BUG-010 仍待修。Chrome network 在公开页、登录失败页、404 页以及未登录保护页均抓到 `GET http://localhost/api/v1/me -> 401`，console 共记录 17 条 `Failed to load resource: the server responded with a status of 401 (Unauthorized)`。
- BUG-009 仍无法复测。当前无真实登录态/测试账号，生产 `dev-login` 关闭，无法验证登录态中后段深链步骤条是否还按 URL 伪造前序完成态。

轻量定位：

- BUG-010 代码线索仍指向 `apps/web/src/App.tsx:35` 外层 `<AuthProvider>` 包住公开/受保护路由，以及 `apps/web/src/shell/auth.tsx:111` 的 `AuthProvider` mount 后无条件执行 `useMe()`；`auth.tsx:86` 的 `useMe()` 固定请求 `/api/v1/me`。

UI 还原度备注：

- 本轮新增 STEP3 修订态 Figma 基准图 `1777:24`。设计结构为 288px 左侧常驻导航、顶部保存草稿/头像、5 步步骤条、主标题「选一个能力发布」、顶部「全部发布」卡片、4 条能力候选列表、底部已选提示与「下一步:结构化...」主按钮。
- 未登录 `/create/select` 被登录闸门拦截，未泄漏 STEP3 设计内容；这符合鉴权边界，但无法对真实登录态 STEP3 的布局、间距、步骤条状态、候选项展开、全部发布卡片和按钮状态做像素级对照。
- 登录后的工作台、个人主页、五步导入、STEP3 选择、STEP4 结构化、STEP5 发布、行内试用占位弹层、发布成功后的能力表仍需要真实登录态逐页按 Figma 对照。

仍待验证：

- BUG-009、登录后的五步成功流、发布成功流、真实个人主页数据流、行内试用按钮点击占位弹层仍需人工登录或测试账号支持。

## 持续验收记录（2026-06-19 05:43 Asia/Shanghai，STEP4/STEP5 Figma 基准 + in-app browser DOM/click + Chrome network）

本轮读取来源：

- 在线飞书 PRD：`https://enbmphajlu.feishu.cn/docx/VlkCdpDiIoJmPGxUWwtclMbRnir`，`revision_id=252`，与本地快照一致；`lark-cli` 仍提示当前 `1.0.52`、最新 `1.0.56`，本轮未升级。
- PRD 本地快照：`docs/测试/创作者中心主链路验收/source/prd-feishu.md`。
- Figma MCP：读取 Page `233:65`，并补截图 STEP4 `1776:24`、STEP5 修订态 `1778:24`。
- contracts：`docs/contracts/_index.md`、`docs/contracts/00-约定与状态机.md`，并重点复核 `40-step3-4-structure.md`、`50-step5-publish.md`。
- 既有 Bug 清单与修复说明：本文件、`FIX_AGENT_PROMPT.md`。

生产栈状态：

```text
GET /health -> 200 {"status":"ok"}
GET /ready  -> ready=true，db/redis_queue/redis_hot/minio/logto 均 ok，llm 为 optional ok
线上 bundle -> index-zjwzbwW2.js / index-CMiPoXZv.css
```

真实浏览器证据：

- Figma STEP4 参考截图：`docs/测试/创作者中心主链路验收/screenshots/heartbeat-20260619-0543/figma-step4-1776-24.png`
- Figma STEP5 参考截图：`docs/测试/创作者中心主链路验收/screenshots/heartbeat-20260619-0543/figma-step5-1778-24.png`
- in-app browser DOM/点击摘要：`docs/测试/创作者中心主链路验收/screenshots/heartbeat-20260619-0543-iab/summary.json`
- in-app browser 登录点击证据：`docs/测试/创作者中心主链路验收/screenshots/heartbeat-20260619-0543-iab/login-click.json`
- Chrome network/console 截图与摘要：`docs/测试/创作者中心主链路验收/screenshots/heartbeat-20260619-0543-cdp/summary.json`

本轮工具限制：

- in-app browser 的 DOM 读取和点击可用；截图接口本轮在 `Page.captureScreenshot` 超时。因此 in-app browser 只作为真实 DOM/点击证据，页面截图由 Chrome network sweep 保存。

本轮 computer use 实测路由：

| 路由 | 回归结果 | 证据 |
| --- | --- | --- |
| `/` | 未登录登录闸门正常；无 shell/Wayne/Phase 文案；仍触发 `/api/v1/me` 401 | `heartbeat-20260619-0543-cdp/home.png` |
| `/creator` | 未登录被登录闸门拦截；无经营后台泄漏；仍触发 `/api/v1/me` 401 | `heartbeat-20260619-0543-cdp/creator.png` |
| `/profile` | 未登录被登录闸门拦截；无个人主页内容泄漏；仍触发 `/api/v1/me` 401 | `heartbeat-20260619-0543-cdp/profile.png` |
| `/capabilities` | 未登录被登录闸门拦截；无能力表/试用按钮泄漏；仍触发 `/api/v1/me` 401 | `heartbeat-20260619-0543-cdp/capabilities.png` |
| `/create/import` | 未登录被登录闸门拦截；in-app browser 点击「去登录」可跳转 Logto；未触发建草稿写请求 | `heartbeat-20260619-0543-iab/login-click.json` |
| `/create/select` | 未登录被登录闸门拦截；没有泄漏 STEP3 内容；未触发 `PATCH /drafts/{draftId}/selection` | `heartbeat-20260619-0543-cdp/create-select.png` |
| `/create/extract` | 未登录被登录闸门拦截；无 STEP2 内容泄漏；未触发写请求 | `heartbeat-20260619-0543-cdp/create-extract.png` |
| `/create/structure` | 未登录被登录闸门拦截；无 STEP4 内容泄漏；未触发结构化/selection 写请求 | `heartbeat-20260619-0543-cdp/create-structure.png` |
| `/create/publish` | 未登录被登录闸门拦截；无 STEP5 内容泄漏；未触发发布/批量发布写请求 | `heartbeat-20260619-0543-cdp/create-publish.png` |
| `/a/nonexistent-e2e-test-slug` | 公开裸壳正常；无 shell/Wayne/Phase 文案；BUG-010 仍复现 | `heartbeat-20260619-0543-cdp/public-capability.png` |
| `/c/nonexistent-creator-e2e` | 公开裸壳正常；无 shell/Wayne/Phase 文案；BUG-010 仍复现 | `heartbeat-20260619-0543-cdp/public-creator.png` |
| `/creators/me/profile` | 401 人话错误 + 去登录 CTA；同时请求 `/api/v1/creators/me/profile` 与 `/api/v1/me` | `heartbeat-20260619-0543-cdp/creators-me-profile.png` |
| `/creators/not-a-uuid/profile` | BUG-011 继续通过：profile API 404，人话链接失效 + 去修改，不再 500 重试态 | `heartbeat-20260619-0543-cdp/creators-invalid-profile.png` |
| `/creators/00000000-0000-4000-8000-000000000000/profile` | 合法 UUID 缺失 profile 仍 404，人话链接失效态 | `heartbeat-20260619-0543-cdp/creators-valid-missing-profile.png` |
| `/login?failureId=fake-check` | 登录失败人话页正常；无内部错误码；BUG-010 仍复现 | `heartbeat-20260619-0543-cdp/login-failure.png` |
| `/definitely-not-a-real-route` | 生产 404 人话页正常；无内部脚手架文案；BUG-010 仍复现 | `heartbeat-20260619-0543-cdp/not-found.png` |

本轮通过项：

- BUG-001 ~ BUG-008 覆盖到的未登录/公开壳回归在当前 bundle `index-zjwzbwW2.js` 上继续通过：没有后台 shell、Wayne/CGO、`Phase 4`、`页面骨架`、`后端契约前缀`。
- BUG-011 继续通过。非法 creatorId 的页面与 API 均为 404 人话链接失效态，不再出现 500 或「内容没能加载 + 重试」。
- 未登录打开五步路由没有触发 `POST /api/v1/drafts`、`PATCH /api/v1/drafts/{draftId}/selection`、`POST /api/v1/versions/{versionId}/publish` 或 `POST /api/v1/publish-batches`，符合鉴权边界与“已生成内容不丢/未登录不误写”的边界。
- 可见 UI 未出现裸转圈；Chrome network 摘要 `noVisibleErrorCodes=true`、`noSpinnerOnly=true`、`noShellLeakOnTestedRoutes=true`、`privateRoutesGateUnauth=true`。

本轮仍失败：

- BUG-010 仍待修。Chrome network 在公开页、登录失败页、404 页以及未登录保护页均抓到 `GET http://localhost/api/v1/me -> 401`，console 共记录 19 条 error/warning，其中 17 条是 `/api/v1/me` 401 噪声，另有 `/api/v1/creators/me/profile` 401 属该路由预期错误态。
- BUG-009 仍无法复测。当前无真实登录态/测试账号，生产 `dev-login` 关闭，无法验证登录态中后段深链步骤条是否还按 URL 伪造前序完成态。

轻量定位：

- BUG-010 代码线索仍指向 `apps/web/src/App.tsx:35` 外层 `<AuthProvider>` 包住公开/受保护路由，以及 `apps/web/src/shell/auth.tsx:111` 的 `AuthProvider` mount 后无条件执行 `useMe()`；`auth.tsx:86` 的 `useMe()` 固定请求 `/api/v1/me`。

UI 还原度备注：

- 本轮新增 STEP4 Figma 基准图 `1776:24`。设计结构为 288px 左侧常驻导航、STEP4 激活步骤条、左侧能力切换器、右侧 App Identity 面板；软字段 7 项（name/tagline/role/goal/instructions/skill_set/starter_prompts）均标「可改」，硬字段 6 项（id/version/status/inputs.schema/output.type/boundaries）均标「锁定」。
- 本轮新增 STEP5 Figma 基准图 `1778:24`。设计结构为左侧能力切换器、中间市集卡预览、右侧字段来源映射面板、底部「发布后进入 Alpha 人工评审」提示与「发布到市集」主按钮；市集卡含封面来源、状态 flag、类型标签、名称、tagline、summary、作者、真实会话来源、免费价格与试用按钮。
- 未登录 `/create/structure`、`/create/publish` 被登录闸门拦截，未泄漏 STEP4/STEP5 设计内容；这符合鉴权边界，但无法对真实登录态 STEP4/STEP5 的软硬字段布局、字段状态、发布卡预览、字段映射和按钮位置做像素级对照。
- 登录后的工作台、个人主页、五步导入、STEP3 选择、STEP4 结构化、STEP5 发布、行内试用占位弹层、发布成功后的能力表仍需要真实登录态逐页按 Figma 对照。

仍待验证：

- BUG-009、登录后的五步成功流、发布成功流、真实个人主页数据流、行内试用按钮点击占位弹层仍需人工登录或测试账号支持。

## 持续验收记录（2026-06-19 06:43 Asia/Shanghai，试用产出态 Figma 基准 + in-app browser 点击 + Chrome network）

本轮读取来源：

- 在线飞书 PRD：`https://enbmphajlu.feishu.cn/docx/VlkCdpDiIoJmPGxUWwtclMbRnir`，`revision_id=252`，与本地快照一致；`lark-cli` 仍提示当前 `1.0.52`、最新 `1.0.56`，本轮未升级。
- PRD 本地快照：`docs/测试/创作者中心主链路验收/source/prd-feishu.md`。
- Figma MCP：沿用 Page `233:65` 的既有试用 Intake/运行中截图，并补截图试用产出态：创作者视角 `1246:65`、消费者视角 `1246:314`。
- contracts：`docs/contracts/_index.md`、`docs/contracts/00-约定与状态机.md`，并重点复核 `50-step5-publish.md`、`60-dashboard-profile.md`、`70-events-infra.md`。
- 既有 Bug 清单与修复说明：本文件、`FIX_AGENT_PROMPT.md`。

生产栈状态：

```text
GET /health -> 200 {"status":"ok"}
GET /ready  -> ready=true，db/redis_queue/redis_hot/minio/logto 均 ok，llm 为 optional ok
线上 bundle -> index-zjwzbwW2.js / index-CMiPoXZv.css
```

真实浏览器证据：

- Figma 试用产出态（创作者视角）：`docs/测试/创作者中心主链路验收/screenshots/heartbeat-20260619-0643/figma-trial-output-creator-1246-65.png`
- Figma 试用产出态（消费者视角）：`docs/测试/创作者中心主链路验收/screenshots/heartbeat-20260619-0643/figma-trial-output-consumer-1246-314.png`
- in-app browser DOM/点击摘要：`docs/测试/创作者中心主链路验收/screenshots/heartbeat-20260619-0643-iab/summary.json`
- in-app browser 登录点击证据：`docs/测试/创作者中心主链路验收/screenshots/heartbeat-20260619-0643-iab/login-click.json`
- Chrome network/console 截图与摘要：`docs/测试/创作者中心主链路验收/screenshots/heartbeat-20260619-0643-cdp/summary.json`

本轮 computer use 实测路由：

| 路由 | 回归结果 | 证据 |
| --- | --- | --- |
| `/` | 未登录登录闸门正常；无 shell/Wayne/Phase 文案；仍触发 `/api/v1/me` 401 | `heartbeat-20260619-0643-cdp/home.png` |
| `/creator` | 未登录被登录闸门拦截；无经营后台泄漏；仍触发 `/api/v1/me` 401 | `heartbeat-20260619-0643-cdp/creator.png` |
| `/profile` | 未登录被登录闸门拦截；无个人主页内容泄漏；仍触发 `/api/v1/me` 401 | `heartbeat-20260619-0643-cdp/profile.png` |
| `/capabilities` | 未登录被登录闸门拦截；无能力表/试用按钮泄漏；仍触发 `/api/v1/me` 401 | `heartbeat-20260619-0643-cdp/capabilities.png` |
| `/create/import` | 未登录被登录闸门拦截；in-app browser 点击「去登录」跳转 Logto；未触发建草稿写请求 | `heartbeat-20260619-0643-iab/login-click.json` |
| `/create/select` | 未登录被登录闸门拦截；没有泄漏 STEP3 内容；未触发 selection 写请求 | `heartbeat-20260619-0643-cdp/create-select.png` |
| `/create/extract` | 未登录被登录闸门拦截；无 STEP2 内容泄漏；未触发写请求 | `heartbeat-20260619-0643-cdp/create-extract.png` |
| `/create/structure` | 未登录被登录闸门拦截；无 STEP4 内容泄漏；未触发结构化/selection 写请求 | `heartbeat-20260619-0643-cdp/create-structure.png` |
| `/create/publish` | 未登录被登录闸门拦截；无 STEP5 内容泄漏；未触发发布/批量发布写请求 | `heartbeat-20260619-0643-cdp/create-publish.png` |
| `/a/nonexistent-e2e-test-slug` | 公开裸壳正常；无 shell/Wayne/Phase 文案；BUG-010 仍复现 | `heartbeat-20260619-0643-cdp/public-capability.png` |
| `/c/nonexistent-creator-e2e` | 公开裸壳正常；无 shell/Wayne/Phase 文案；BUG-010 仍复现 | `heartbeat-20260619-0643-cdp/public-creator.png` |
| `/creators/me/profile` | 401 人话错误 + 去登录 CTA；同时请求 `/api/v1/creators/me/profile` 与 `/api/v1/me` | `heartbeat-20260619-0643-cdp/creators-me-profile.png` |
| `/creators/not-a-uuid/profile` | BUG-011 继续通过：profile API 404，人话链接失效 + 去修改，不再 500 重试态 | `heartbeat-20260619-0643-cdp/creators-invalid-profile.png` |
| `/creators/00000000-0000-4000-8000-000000000000/profile` | 合法 UUID 缺失 profile 仍 404，人话链接失效态 | `heartbeat-20260619-0643-cdp/creators-valid-missing-profile.png` |
| `/login?failureId=fake-check` | 登录失败人话页正常；无内部错误码；BUG-010 仍复现 | `heartbeat-20260619-0643-cdp/login-failure.png` |
| `/definitely-not-a-real-route` | 生产 404 人话页正常；无内部脚手架文案；BUG-010 仍复现 | `heartbeat-20260619-0643-cdp/not-found.png` |

本轮通过项：

- BUG-001 ~ BUG-008 覆盖到的未登录/公开壳回归在当前 bundle `index-zjwzbwW2.js` 上继续通过：没有后台 shell、Wayne/CGO、`Phase 4`、`页面骨架`、`后端契约前缀`。
- BUG-011 继续通过。非法 creatorId 的页面与 API 均为 404 人话链接失效态，不再出现 500 或「内容没能加载 + 重试」。
- 未登录打开五步路由没有触发 `POST /api/v1/drafts`、`PATCH /api/v1/drafts/{draftId}/selection`、`POST /api/v1/versions/{versionId}/publish` 或 `POST /api/v1/publish-batches`。
- 本轮未观察到任何 `runtime` / `trial` / `session` 写请求；这与 contracts 当前“试用按钮在、点击落本期未开放、不进 runtime session”的范围一致。
- 可见 UI 未出现裸转圈；Chrome network 摘要 `noVisibleErrorCodes=true`、`noSpinnerOnly=true`、`noShellLeakOnTestedRoutes=true`、`privateRoutesGateUnauth=true`。

本轮仍失败：

- BUG-010 仍待修。Chrome network 在公开页、登录失败页、404 页以及未登录保护页均抓到 `GET http://localhost/api/v1/me -> 401`；本轮 `me401Count=16`，其中公开/登录失败/404 路由 `publicMe401Count=5`，console error 共 19 条。
- BUG-009 仍无法复测。当前无真实登录态/测试账号，生产 `dev-login` 关闭，无法验证登录态中后段深链步骤条是否还按 URL 伪造前序完成态。

轻量定位：

- BUG-010 代码线索仍指向 `apps/web/src/App.tsx:35` 外层 `<AuthProvider>` 包住公开/受保护路由，以及 `apps/web/src/shell/auth.tsx:111` 的 `AuthProvider` mount 后无条件执行 `useMe()`；`auth.tsx:86` 的 `useMe()` 固定请求 `/api/v1/me`。
- 试用范围对齐 contracts：`50-step5-publish.md` 明示 `trialEnabled:false`；`60-dashboard-profile.md` 明示按钮存在、点击落「本期未开放」、不进 runtime session；`70-events-infra.md` 明示 `runtime_sessions` / `artifacts` / `runtime.session_event` 本期 schema-only、不挂端点、不注册 processor。因此本轮不把“未进入真实 runtime”记录为新缺陷。

UI 还原度备注：

- 本轮新增试用产出态 Figma 基准图。创作者视角 `1246:65` 为 244px 左侧运行会话栏 + 中央产物画布 + 底部 Timeline rail + 悬浮 CompanionCard，包含 Persona 卡片、分数条、locked objection、生成中骨架和 follow-up chips。
- 消费者视角 `1246:314` 与创作者产出态同构，但顶部新增「@WAYNE 的判断 · 守则 9 ›」只读署名条，中央画布高度相应压缩；这会是 Trial 真上线后必须逐像素对齐的关键差异。
- 由于当前 contracts 将 Trial runtime 挂起，本轮只能把这些 Figma 节点作为未来验收基准；当前生产可验 UI 仍停留在未登录闸门和试用占位范围。
- 登录后的工作台、个人主页、五步导入、STEP3 选择、STEP4 结构化、STEP5 发布、行内试用占位浮层、发布成功后的能力表仍需要真实登录态逐页按 Figma 对照。

仍待验证：

- BUG-009、登录后的五步成功流、发布成功流、真实个人主页数据流、行内试用按钮点击占位弹层仍需人工登录或测试账号支持。

## 持续验收记录（2026-06-19 07:03 Asia/Shanghai，外壳 Figma 基准 + in-app browser 点击 + Chrome network）

本轮读取来源：

- 在线飞书 PRD：`https://enbmphajlu.feishu.cn/docx/VlkCdpDiIoJmPGxUWwtclMbRnir`，`revision_id=252`，与本地快照一致；`lark-cli` 仍提示当前 `1.0.52`、最新 `1.0.56`，本轮未升级。
- PRD 本地快照：`docs/测试/创作者中心主链路验收/source/prd-feishu.md`。
- Figma MCP：读取并补截图外壳展开态 `1153:65`、收起态 `1155:65`。
- contracts：`docs/contracts/_index.md`、`docs/contracts/00-约定与状态机.md`，并重点复核 `40-step3-4-structure.md`、`50-step5-publish.md`、`60-dashboard-profile.md`、`70-events-infra.md`。
- 既有 Bug 清单与修复说明：本文件、`FIX_AGENT_PROMPT.md`。

生产栈状态：

```text
GET /health -> 200 {"status":"ok"}
GET /ready  -> ready=true，db/redis_queue/redis_hot/minio/logto 均 ok，llm 为 optional ok
线上 bundle -> index-zjwzbwW2.js / index-CMiPoXZv.css
```

真实浏览器证据：

- Figma 外壳展开态：`docs/测试/创作者中心主链路验收/screenshots/heartbeat-20260619-0703/figma-sidebar-expanded-1153-65.png`
- Figma 外壳收起态：`docs/测试/创作者中心主链路验收/screenshots/heartbeat-20260619-0703/figma-sidebar-collapsed-1155-65.png`
- in-app browser DOM/点击摘要：`docs/测试/创作者中心主链路验收/screenshots/heartbeat-20260619-0703-iab/summary.json`
- in-app browser 登录点击证据：`docs/测试/创作者中心主链路验收/screenshots/heartbeat-20260619-0703-iab/login-click.json`
- Chrome network/console 截图与摘要：`docs/测试/创作者中心主链路验收/screenshots/heartbeat-20260619-0703-cdp/summary.json`

本轮 computer use 实测路由：

| 路由 | 回归结果 | 证据 |
| --- | --- | --- |
| `/` | 未登录登录闸门正常；无 shell/Wayne/Phase 文案；仍触发 `/api/v1/me` 401 | `heartbeat-20260619-0703-cdp/home.png` |
| `/creator` | 未登录被登录闸门拦截；无经营后台泄漏；仍触发 `/api/v1/me` 401 | `heartbeat-20260619-0703-cdp/creator.png` |
| `/profile` | 未登录被登录闸门拦截；无个人主页内容泄漏；仍触发 `/api/v1/me` 401 | `heartbeat-20260619-0703-cdp/profile.png` |
| `/capabilities` | 未登录被登录闸门拦截；无能力表/试用按钮泄漏；仍触发 `/api/v1/me` 401 | `heartbeat-20260619-0703-cdp/capabilities.png` |
| `/create/import` | 未登录被登录闸门拦截；in-app browser 点击「去登录」跳转 Logto；未触发建草稿写请求 | `heartbeat-20260619-0703-iab/login-click.json` |
| `/create/select` | 未登录被登录闸门拦截；没有泄漏 STEP3 内容；未触发 selection 写请求 | `heartbeat-20260619-0703-cdp/create-select.png` |
| `/create/extract` | 未登录被登录闸门拦截；无 STEP2 内容泄漏；未触发写请求 | `heartbeat-20260619-0703-cdp/create-extract.png` |
| `/create/structure` | 未登录被登录闸门拦截；无 STEP4 内容泄漏；未触发结构化/selection 写请求 | `heartbeat-20260619-0703-cdp/create-structure.png` |
| `/create/publish` | 未登录被登录闸门拦截；无 STEP5 内容泄漏；未触发发布/批量发布写请求 | `heartbeat-20260619-0703-cdp/create-publish.png` |
| `/a/nonexistent-e2e-test-slug` | 公开裸壳正常；无 shell/Wayne/Phase 文案；BUG-010 仍复现 | `heartbeat-20260619-0703-cdp/public-capability.png` |
| `/c/nonexistent-creator-e2e` | 公开裸壳正常；无 shell/Wayne/Phase 文案；BUG-010 仍复现 | `heartbeat-20260619-0703-cdp/public-creator.png` |
| `/creators/me/profile` | 401 人话错误 + 去登录 CTA；同时请求 `/api/v1/creators/me/profile` 与 `/api/v1/me` | `heartbeat-20260619-0703-cdp/creators-me-profile.png` |
| `/creators/not-a-uuid/profile` | BUG-011 继续通过：profile API 404，人话链接失效 + 去修改，不再 500 重试态 | `heartbeat-20260619-0703-cdp/creators-invalid-profile.png` |
| `/creators/00000000-0000-4000-8000-000000000000/profile` | 合法 UUID 缺失 profile 仍 404，人话链接失效态 | `heartbeat-20260619-0703-cdp/creators-valid-missing-profile.png` |
| `/login?failureId=fake-check` | 登录失败人话页正常；无内部错误码；BUG-010 仍复现 | `heartbeat-20260619-0703-cdp/login-failure.png` |
| `/definitely-not-a-real-route` | 生产 404 人话页正常；无内部脚手架文案；BUG-010 仍复现 | `heartbeat-20260619-0703-cdp/not-found.png` |

本轮通过项：

- BUG-001 ~ BUG-008 覆盖到的未登录/公开壳回归在当前 bundle `index-zjwzbwW2.js` 上继续通过：没有后台 shell、Wayne/CGO、`Phase 4`、`页面骨架`、`后端契约前缀`。
- BUG-011 继续通过。非法 creatorId 的页面与 API 均为 404 人话链接失效态，不再出现 500 或「内容没能加载 + 重试」。
- 未登录打开五步路由没有触发 `POST /api/v1/drafts`、`PATCH /api/v1/drafts/{draftId}/selection`、`POST /api/v1/versions/{versionId}/publish` 或 `POST /api/v1/publish-batches`。
- 本轮未观察到任何 `runtime` / `trial` / `session` 写请求；contracts 仍明确 Trial 本期只做「按钮在 + 本期未开放」占位，不进 runtime session。
- 可见 UI 未出现裸转圈；Chrome network 摘要 `noVisibleErrorCodes=true`、`noSpinnerOnly=true`、`noShellLeakOnTestedRoutes=true`、`privateRoutesGateUnauth=true`。

本轮仍失败：

- BUG-010 仍待修。Chrome network 在公开页、登录失败页、404 页以及未登录保护页均抓到 `GET http://localhost/api/v1/me -> 401`；本轮 `me401Count=16`，其中公开/登录失败/404 路由 `publicMe401Count=5`，console error 共 19 条。
- BUG-009 仍无法复测。当前无真实登录态/测试账号，生产 `dev-login` 关闭，无法验证登录态中后段深链步骤条是否还按 URL 伪造前序完成态。

轻量定位：

- BUG-010 代码线索仍指向 `apps/web/src/App.tsx:35` 外层 `<AuthProvider>` 包住公开/受保护路由，以及 `apps/web/src/shell/auth.tsx:111` 的 `AuthProvider` mount 后无条件执行 `useMe()`；`auth.tsx:86` 的 `useMe()` 固定请求 `/api/v1/me`。
- 未登录写请求为 `apiWrites=[]`，所以当前没有出现“未登录误建草稿 / 误保存 selection / 误发布 / 误进入 runtime”的功能回归。

UI 还原度备注：

- 本轮新增外壳展开/收起 Figma 基准。展开态宽 288px，包含 brand-row、创作分组、工作台/我的能力/上传能力/数据分析/收益、我的分组、个人主页、底部 Wayne/CGO 用户行；收起态宽 64px，仅保留 A 标识、导航图标、分隔线与底部 W 头像。
- 未登录 `/creator`、`/profile`、`/capabilities` 和五步路由被登录闸门拦截，未泄漏外壳真实登录态；这符合鉴权边界，但无法对登录态外壳展开/收起、导航激活态、底部用户行和页面主体留白做像素级对照。
- 登录后的工作台、个人主页、五步导入、STEP3 选择、STEP4 结构化、STEP5 发布、行内试用占位浮层、发布成功后的能力表仍需要真实登录态逐页按 Figma 对照。

仍待验证：

- BUG-009、登录后的五步成功流、发布成功流、真实个人主页数据流、行内试用按钮点击占位弹层仍需人工登录或测试账号支持。

## 持续验收记录（2026-06-19 07:23 Asia/Shanghai，工作台 Figma 基准 + in-app browser DOM + Chrome network/点击）

本轮读取来源：

- 在线飞书 PRD：`https://enbmphajlu.feishu.cn/docx/VlkCdpDiIoJmPGxUWwtclMbRnir`，`revision_id=252`，与本地快照一致；`lark-cli` 仍提示当前 `1.0.52`、最新 `1.0.56`，本轮未升级。
- PRD 本地快照：`docs/测试/创作者中心主链路验收/source/prd-feishu.md`。
- Figma MCP：读取并补截图工作台节点 `1157:65`。
- contracts：`docs/contracts/_index.md`、`docs/contracts/00-约定与状态机.md`，并重点复核 `10-auth-logto.md`、`50-step5-publish.md`、`60-dashboard-profile.md`。
- 既有 Bug 清单与修复说明：本文件、`FIX_AGENT_PROMPT.md`。

生产栈状态：

```text
GET /health -> 200 {"status":"ok"}
GET /ready  -> ready=true，db/redis_queue/redis_hot/minio/logto 均 ok，llm 为 optional ok
线上 bundle -> index-zjwzbwW2.js / index-CMiPoXZv.css
```

真实浏览器证据：

- Figma 工作台基准：`docs/测试/创作者中心主链路验收/screenshots/heartbeat-20260619-0723/figma-dashboard-1157-65.png`
- in-app browser DOM 摘要：`docs/测试/创作者中心主链路验收/screenshots/heartbeat-20260619-0723-iab/summary.json`
- in-app browser 登录点击尝试：`docs/测试/创作者中心主链路验收/screenshots/heartbeat-20260619-0723-iab/login-click.json`（本轮 IAB click/CDP screenshot 通道超时，未作为产品缺陷；以 Chrome 点击和截图为准）
- Chrome network/console 截图与摘要：`docs/测试/创作者中心主链路验收/screenshots/heartbeat-20260619-0723-cdp/summary.json`
- Chrome 登录点击截图：`docs/测试/创作者中心主链路验收/screenshots/heartbeat-20260619-0723-cdp/login-click-after.png`

本轮 computer use 实测路由：

| 路由 | 回归结果 | 证据 |
| --- | --- | --- |
| `/` | 未登录登录闸门正常；无 shell/Wayne/Phase 文案；仍触发 `/api/v1/me` 401 | `heartbeat-20260619-0723-cdp/01-root.png` |
| `/creator` | 未登录被登录闸门拦截；无工作台主体泄漏；仍触发 `/api/v1/me` 401 | `heartbeat-20260619-0723-cdp/02-creator.png` |
| `/profile` | 未登录被登录闸门拦截；无个人主页内容泄漏；仍触发 `/api/v1/me` 401 | `heartbeat-20260619-0723-cdp/03-profile.png` |
| `/capabilities` | 未登录被登录闸门拦截；无能力表/试用按钮泄漏；仍触发 `/api/v1/me` 401 | `heartbeat-20260619-0723-cdp/04-capabilities.png` |
| `/create/import` | 未登录被登录闸门拦截；Chrome 点击「去登录」跳转 Logto；未触发建草稿写请求 | `heartbeat-20260619-0723-cdp/05-create-import.png`、`login-click-after.png` |
| `/create/select` | 未登录被登录闸门拦截；没有泄漏 STEP3 内容；未触发 selection 写请求 | `heartbeat-20260619-0723-cdp/06-create-select.png` |
| `/create/extract` | 未登录被登录闸门拦截；无 STEP2 内容泄漏；未触发写请求 | `heartbeat-20260619-0723-cdp/07-create-extract.png` |
| `/create/structure` | 未登录被登录闸门拦截；无 STEP4 内容泄漏；未触发结构化/selection 写请求 | `heartbeat-20260619-0723-cdp/08-create-structure.png` |
| `/create/publish` | 未登录被登录闸门拦截；无 STEP5 内容泄漏；未触发发布/批量发布写请求 | `heartbeat-20260619-0723-cdp/09-create-publish.png` |
| `/a/nonexistent-e2e-test-slug` | 公开能力占位页正常；无 shell/Wayne/Phase 文案；BUG-010 仍复现 | `heartbeat-20260619-0723-cdp/10-a-nonexistent-e2e-test-slug.png` |
| `/c/nonexistent-creator-e2e` | 公开创作者占位页正常；无 shell/Wayne/Phase 文案；BUG-010 仍复现 | `heartbeat-20260619-0723-cdp/11-c-nonexistent-creator-e2e.png` |
| `/creators/me/profile` | 401 人话错误 + 去登录 CTA；同时请求 `/api/v1/creators/me/profile` 与 `/api/v1/me` | `heartbeat-20260619-0723-cdp/12-creators-me-profile.png` |
| `/creators/not-a-uuid/profile` | BUG-011 继续通过：profile API 404，人话链接失效 + 去修改，不再 500 重试态 | `heartbeat-20260619-0723-cdp/13-creators-not-a-uuid-profile.png` |
| `/creators/00000000-0000-4000-8000-000000000000/profile` | 合法 UUID 缺失 profile 仍 404，人话链接失效态 | `heartbeat-20260619-0723-cdp/14-creators-00000000-0000-4000-8000-000000000000-profile.png` |
| `/login?failureId=fake-check` | 登录失败人话页正常；无内部错误码；BUG-010 仍复现 | `heartbeat-20260619-0723-cdp/15-login-failureId-fake-check.png` |
| `/definitely-not-a-real-route` | 生产 404 人话页正常；无内部脚手架文案；BUG-010 仍复现 | `heartbeat-20260619-0723-cdp/16-definitely-not-a-real-route.png` |

本轮通过项：

- BUG-001 ~ BUG-008 覆盖到的未登录/公开壳回归在当前 bundle `index-zjwzbwW2.js` 上继续通过：没有后台 shell、Wayne/CGO、`Phase 4`、`页面骨架`、`后端契约前缀`。
- BUG-011 继续通过。非法 creatorId 的页面与 API 均为 404 人话链接失效态，不再出现 500 或「内容没能加载 + 重试」。
- Chrome 真实点击 `/create/import` 的「去登录」成功跳到 `https://andkzt.logto.app/sign-in?app_id=vbu4vp7h0nczrddmzcpq1`。
- 未登录打开五步路由没有触发 `POST /api/v1/drafts`、`PATCH /api/v1/drafts/{draftId}/selection`、`POST /api/v1/versions/{versionId}/publish` 或 `POST /api/v1/publish-batches`。
- 本轮未观察到任何 `runtime` / `trial` / `session` 写请求；contracts 仍明确 Trial 本期只做「按钮在 + 本期未开放」占位，不进 runtime session。
- 可见 UI 未出现裸转圈；Chrome 摘要 `noVisibleErrorCodes=true`、`noSpinnerOnly=true`、`noShellLeakOnTestedRoutes=true`、`privateRoutesGateUnauth=true`、`apiWrites=[]`。

本轮仍失败：

- BUG-010 仍待修。Chrome network 在公开页、登录失败页、404 页以及未登录保护页均抓到 `GET http://localhost/api/v1/me -> 401`；本轮 `me401Count=16`，其中公开/登录失败/404/公开 profile 路由 `publicMe401Count=6`，console error 共 19 条。
- BUG-009 仍无法复测。当前无真实登录态/测试账号，生产 `dev-login` 关闭，无法验证登录态中后段深链步骤条是否还按 URL 伪造前序完成态。

轻量定位：

- BUG-010 代码线索仍指向 `apps/web/src/App.tsx:35` 外层 `<AuthProvider>` 包住公开/受保护路由，以及 `apps/web/src/shell/auth.tsx:111` 的 `AuthProvider` mount 后无条件执行 `useMe()`；`auth.tsx:86` 的 `useMe()` 固定请求 `/api/v1/me`。
- 未登录写请求仍为 `apiWrites=[]`，所以当前没有出现“未登录误建草稿 / 误保存 selection / 误发布 / 误进入 runtime”的功能回归。

UI 还原度备注：

- 本轮新增工作台 Figma 基准。节点 `1157:65` 为 1440x1209 画布，展开侧栏宽 288px，主体包含标题栏、日期分段控件「近7天 / 近30天 / 全部」、四张指标卡、Daily token 图表、能力表和底部草稿进度条。
- 未登录 `/creator` 被登录闸门拦截，当前只能验证不会泄漏工作台主体；登录态工作台的四卡数据、token 图表、能力表、草稿条、侧栏激活态和间距仍无法逐像素对照。
- 登录后的工作台、个人主页、五步导入、STEP3 选择、STEP4 结构化、STEP5 发布、行内试用占位浮层、发布成功后的能力表仍需要真实登录态逐页按 Figma 对照。

仍待验证：

- BUG-009、登录后的五步成功流、发布成功流、真实个人主页数据流、行内试用按钮点击占位弹层仍需人工登录或测试账号支持。

## 持续验收记录（2026-06-19 07:44 Asia/Shanghai，个人主页 Figma 基准 + profile/API 回归）

本轮读取来源：

- 在线飞书 PRD：`https://enbmphajlu.feishu.cn/docx/VlkCdpDiIoJmPGxUWwtclMbRnir`，`revision_id=252`，与本地快照一致；`lark-cli` 仍提示当前 `1.0.52`、最新 `1.0.56`，本轮未升级。
- PRD 本地快照：`docs/测试/创作者中心主链路验收/source/prd-feishu.md`。
- Figma MCP：读取并补截图个人主页节点 `1152:65`。
- contracts：`docs/contracts/_index.md`、`docs/contracts/00-约定与状态机.md`，并重点复核 `10-auth-logto.md`、`60-dashboard-profile.md`。
- 既有 Bug 清单与修复说明：本文件、`FIX_AGENT_PROMPT.md`。

生产栈状态：

```text
GET /health -> 200 {"status":"ok"}
GET /ready  -> ready=true，db/redis_queue/redis_hot/minio/logto 均 ok，llm 为 optional ok
线上 bundle -> index-zjwzbwW2.js / index-CMiPoXZv.css
```

真实浏览器证据：

- Figma 个人主页基准：`docs/测试/创作者中心主链路验收/screenshots/heartbeat-20260619-0744/figma-profile-1152-65.png`
- in-app browser DOM 摘要：`docs/测试/创作者中心主链路验收/screenshots/heartbeat-20260619-0744-iab/summary.json`
- Chrome network/console 截图与摘要：`docs/测试/创作者中心主链路验收/screenshots/heartbeat-20260619-0744-cdp/summary.json`
- Chrome 只读 API 检查：`docs/测试/创作者中心主链路验收/screenshots/heartbeat-20260619-0744-cdp/api-checks.json`
- Chrome 登录点击截图：`docs/测试/创作者中心主链路验收/screenshots/heartbeat-20260619-0744-cdp/login-click-after.png`

本轮 computer use 实测路由与 API：

| 路由 / API | 回归结果 | 证据 |
| --- | --- | --- |
| `/profile` | 未登录被登录闸门拦截；Chrome 点击「去登录」跳转 Logto；仍触发 `/api/v1/me` 401 | `heartbeat-20260619-0744-cdp/01-profile.png`、`login-click-after.png` |
| `/creator` | 未登录被登录闸门拦截；无工作台主体泄漏；仍触发 `/api/v1/me` 401 | `heartbeat-20260619-0744-cdp/02-creator.png` |
| `/capabilities` | 未登录被登录闸门拦截；无能力表/试用按钮泄漏；仍触发 `/api/v1/me` 401 | `heartbeat-20260619-0744-cdp/03-capabilities.png` |
| `/creators/me/profile` | 401 人话错误 + 去登录 CTA；同时请求 `/api/v1/creators/me/profile` 与 `/api/v1/me` | `heartbeat-20260619-0744-cdp/04-creators-me-profile.png` |
| `/creators/not-a-uuid/profile` | BUG-011 继续通过：profile API 404，人话链接失效 + 去修改，不再 500 重试态 | `heartbeat-20260619-0744-cdp/05-creators-not-a-uuid-profile.png` |
| `/creators/00000000-0000-4000-8000-000000000000/profile` | 合法 UUID 缺失 profile 仍 404，人话链接失效态 | `heartbeat-20260619-0744-cdp/06-creators-00000000-0000-4000-8000-000000000000-profile.png` |
| `/c/nonexistent-creator-e2e` | 公开创作者占位页正常；无 shell/Wayne/Phase 文案；BUG-010 仍复现 | `heartbeat-20260619-0744-cdp/07-c-nonexistent-creator-e2e.png` |
| `/a/nonexistent-e2e-test-slug` | 公开能力占位页正常；无 shell/Wayne/Phase 文案；BUG-010 仍复现 | `heartbeat-20260619-0744-cdp/08-a-nonexistent-e2e-test-slug.png` |
| `/login?failureId=fake-check` | 登录失败人话页正常；无内部错误码；BUG-010 仍复现 | `heartbeat-20260619-0744-cdp/09-login-failureId-fake-check.png` |
| `/definitely-not-a-real-route` | 生产 404 人话页正常；无内部脚手架文案；BUG-010 仍复现 | `heartbeat-20260619-0744-cdp/10-definitely-not-a-real-route.png` |
| `GET /api/v1/me` | 401 `userMessage=登录态失效了，请重新登录。`，对外 envelope 无 `code` | `heartbeat-20260619-0744-cdp/api-checks.json` |
| `GET /api/v1/dashboard/summary` / `metrics` | 未登录 401 人话错误；无 dashboard 数据泄漏 | `heartbeat-20260619-0744-cdp/api-checks.json` |
| `GET /api/v1/creators/me/profile` | 未登录 401 人话错误；无内部 code | `heartbeat-20260619-0744-cdp/api-checks.json` |
| `GET /api/v1/creators/not-a-uuid/profile` | 404 `userMessage=没找到这个创作者，可能链接失效了。`；无 500 | `heartbeat-20260619-0744-cdp/api-checks.json` |
| `GET /api/v1/creators/00000000-0000-4000-8000-000000000000/profile` | 404 人话链接失效；无 500 | `heartbeat-20260619-0744-cdp/api-checks.json` |

本轮通过项：

- BUG-001 ~ BUG-008 覆盖到的未登录/公开壳回归在当前 bundle `index-zjwzbwW2.js` 上继续通过：没有后台 shell、Wayne/CGO、`Phase 4`、`页面骨架`、`后端契约前缀`。
- BUG-011 继续通过。非法 creatorId 与合法但缺失的 creatorId 均为 404 人话链接失效态，不再出现 500 或「内容没能加载 + 重试」。
- `/api/v1/me`、`/api/v1/dashboard/summary`、`/api/v1/dashboard/metrics`、`/api/v1/creators/me/profile`、`/api/v1/creators/{id}/profile` 的直接浏览器 API 检查均只返回 `userMessage/action/retriable/traceId`，未对外暴露 `error.code`。
- Chrome 真实点击 `/profile` 的「去登录」成功跳到 `https://andkzt.logto.app/sign-in?app_id=vbu4vp7h0nczrddmzcpq1`。
- 本轮未观察到任何写请求，`apiWrites=[]`；未登录访问个人主页/工作台相关路由没有误建草稿、误保存或误发布。
- 可见 UI 未出现裸转圈；Chrome 摘要 `noVisibleErrorCodes=true`、`noSpinnerOnly=true`、`privateRoutesGateUnauth=true`、`profileNotFoundHuman=true`。

本轮仍失败：

- BUG-010 仍待修。Chrome network 在公开页、登录失败页、404 页以及未登录保护页均抓到 `GET http://localhost/api/v1/me -> 401`；本轮聚焦 profile 路由，`me401Count=10`，其中公开/登录失败/404/公开 profile 路由 `publicMe401Count=6`，console error 共 13 条。
- BUG-009 仍无法复测。当前无真实登录态/测试账号，生产 `dev-login` 关闭，无法验证登录态中后段深链步骤条是否还按 URL 伪造前序完成态。

轻量定位：

- BUG-010 代码线索仍指向 `apps/web/src/App.tsx:35` 外层 `<AuthProvider>` 包住公开/受保护路由，以及 `apps/web/src/shell/auth.tsx:111` 的 `AuthProvider` mount 后无条件执行 `useMe()`；`auth.tsx:86` 的 `useMe()` 固定请求 `/api/v1/me`。
- Profile 404 已稳定落 `CreatorProfileErrorBoundary` / profile route 的人话错误态；API 层也只出 `ErrorEnvelope.userMessage`，因此本轮不新增 profile API 缺陷。

UI 还原度备注：

- 本轮新增个人主页 Figma 基准。节点 `1152:65` 为 1440x1470 页面，展开侧栏宽 288px，主体六分区固定顺序：Hero 身份区、指标带、能力按会话密度榜、近半年会话足迹热力图、能力网络缩略、作品墙。
- Figma 个人主页关键视觉：Hero 有 1056x120 cover band、64px 头像、身份 tag pill、关注/粉丝/获赞三计数；指标带四列；密度榜含三条进度条；热力图是 8px 格子矩阵；能力网络为中心 Wayne + 多节点边；作品墙为 4 列卡片网格。
- 未登录 `/profile` 被登录闸门拦截，`/creators/*/profile` 当前只能验证错误态/占位态；真实登录态个人主页的六分区数据、热力图开关、密度榜展开、网络缩略和作品墙分页仍无法逐像素对照。

仍待验证：

- BUG-009、登录后的五步成功流、发布成功流、真实个人主页数据流、行内试用按钮点击占位弹层仍需人工登录或测试账号支持。


## 持续验收记录（2026-06-19 12:4x Asia/Shanghai，修复 Agent 回归——针对 11:58 测试员复测三项）

针对 11:58 测试员复测标记的三项（BUG-009 仍失败 / BUG-012 部分未通过 / BUG-013 E2E 待复测）逐一修复并真实登录态复验。
本轮用 playwright-core 驱动系统 Chrome（channel:chrome，不受 Codex 扩展 setFiles 权限限制），测试账号真实登录态操作 + DOM/network/DB 三向取证。

### BUG-009：中后段深链伪造前序完成 —— 已修，复测通过

- 根因（确认测试员定位）：`WizardShell.tsx` 把 `draftId` 存在当进度锚点（`hasUrlAnchor` 含 `draftIdParam`），任一 `?draftId=` 即令 `progressStep=routeStep`，前序被 URL 标 done。
- 修复：新增纯函数 `wizardMachine.progressFrontier(锚点)`，进度前沿只认真实产物（snapshot/extract/selection/version/capability/batch），**draftId 不在内**。深链恢复中（hydrate 未回填）前沿暂退首步、前序 todo + 顶「正在恢复你的草稿…」，hydrate 落库后据真实产物前移。select 是纯前端步、后端 current_step 跳过它，故取产物锚点而非后端 currentStep。
- 自测证据（真实登录态，浏览器 DOM 实读步骤条 data-status）：
  - 空草稿（仅 bootstrap、无任何产物）深链 `/create/publish?draftId=…` → 步骤条 import/extract/select/structure 全 `todo`、publish `current`，无伪造 done、前序无「点击回看」按钮；页面落人话闸门「还没选好要发布的能力 · 去修改」（永不裸错）。截图 `verify-20260619/bug009-publish-deeplink.png`。
  - 真实导入完成的草稿（已有 snapshot）深链 `/create/publish?draftId=…` → 步骤条**仅 import=done**、extract/select/structure `todo`、publish `current`——精确反映真实产物进度，绝不过度标记。
  - 单测：`wizardMachine.test.ts` 21（progressFrontier 7 + 越界前沿 2）；`WizardShell.test.tsx` 含「仅 draftId 深链不伪造 done」用例。web 全套 601/601。
- 剩余风险：低。续传恢复中前序短暂 todo→done 是诚实的「未知→已知」，非闪烁缺陷。
- 状态：已修待回归 → **本轮复测通过**。

### BUG-012：个人主页未按 Figma 满宽六分区还原 —— 已修，视觉复验通过（主体）

- 修复：`.cb-profile` 去 `max-width:880px`，铺满外壳主区（与工作台同口径，消除右侧空白）；Hero 加封面横幅（暖米渐变 + 砖红底线，头像跨线）+ 左身份/右社交三计数同行编排（对齐 Figma 1152:65）；指标带四列竖细线分隔 + 大号衬线值（34px / topic 26px）；分区卡 padding 24/28、标题 17px；作品墙 minmax 210 约四列。
- 自测证据：真实登录态截图 `verify-20260619/12-profile.png`——满宽六分区、Hero 封面+头像跨线+右侧三计数、指标带竖分隔大号衬线值，均与 Figma 1152:65 编排一致；工作台 `10-creator.png` 无回归。profile 单测 61/61；web tsc 0 err。
- 剩余风险：本测试账号无能力数据，密度榜进度条、热力图格阵、能力网络、作品墙卡片的**有数据态**逐像素仍待真实数据回归（空态文案已正确）。
- 状态：部分未通过 → **本轮主体（满宽 + Hero + 指标带）复测通过**；有数据态分区待数据。

### BUG-013：浏览器内导入 E2E —— 实测抓到真阻断并修复，full E2E 通过

- 测试员因扩展 setFiles 权限被挡无法真跑。我用 playwright 真跑，**抓到真阻断**：presign 返回的 PUT URL host 是 Docker 内网名 `minio:9000`，宿主浏览器不可解析 → `ERR_NAME_NOT_RESOLVED`，上传必败，B-20 断在 presign(200) 后的 PUT。详见新立 **BUG-015**。
- 修复（见 BUG-015）：拆出公网可达预签名端点 `S3_PUBLIC_ENDPOINT`，presign 用它签、内网操作仍走 `S3_ENDPOINT`。
- 自测证据（valid Claude-format jsonl 真上传）：网络链 `POST /import/uploads/presign 200` → `PUT http://localhost:9000/agora-raw/… 200` → `POST /import/jobs 202` → `GET /jobs/{id}/events (SSE) 200`，无 console error；worker 解析 1 段 → 建快照 → 回填草稿 `current_step=extract` + `snapshot_id`；DB 实查 `jobs.status=completed`、`session_segments=1`。截图 `verify-20260619/bug013-import-result.png`。
- 注：测试员/早期样例 jsonl 为扁平 `{role,content}`，非真实 Claude(`message:{role,content}`)/Codex(`type+payload`) 导出格式，故 worker 正确报 `IMPORT_NO_CONTENT: parsed zero segments`（非产品缺陷，是样例格式问题）；换正确 Claude 格式样例后 E2E 通过。
- 剩余风险：低。目录导入 / 大文件分片 / 断点续传重试本轮未逐一跑（单测已覆盖）。
- 状态：入口与代码已修、E2E 待复测 → **本轮 full E2E 复测通过**（修掉 presign 内网 host 后）。

## BUG-015：预签名直传 URL 使用 Docker 内网 host（minio:9000），宿主浏览器不可达

严重度：P0 阻断（浏览器直传 B-20 在容器化部署下整链不可用；BUG-013 E2E 的真根因）

状态：已修待回归（presign 改用 `S3_PUBLIC_ENDPOINT` 公网端点签名；E2E 实测 PUT 200、job completed、快照 1 段）

发现：BUG-013 浏览器导入 E2E 中，`POST /import/uploads/presign` 返回 200，但其中 PUT URL 为 `http://minio:9000/agora-raw/…`；宿主浏览器无法解析 `minio`（仅 Docker 网内可达）→ `net::ERR_NAME_NOT_RESOLVED`，上传失败。

根因：`apps/api/src/infra/object-store.ts` 用同一 `S3_ENDPOINT`（compose 内为 `http://minio:9000`）既做 API↔MinIO 内网操作、又做 presign 签名，故浏览器拿到内网 host。API/worker 又必须用 `minio:9000` 读回对象，不能简单改端点；且 V4 签名含 host，签后改 host 会 `SignatureDoesNotMatch`。

修复摘要：
- `env.ts` 新增可选 `S3_PUBLIC_ENDPOINT`（缺省回退 `S3_ENDPOINT`，生产端点本就公网可达时零副作用）。
- `object-store.ts` 拆「预签名专用客户端」（endpoint=公网端点，仅算 URL 不发请求）；`presignPut/presignGet` 用它，其余操作仍用内网客户端。
- `infra/docker-compose.yml` 仅 API 服务加 `S3_PUBLIC_ENDPOINT`（dev 默认 `http://localhost:9000`，minio 已 publish 9000；生产设对外 S3/CDN 端点）。

自测证据：见 BUG-013 record（presign 200 → PUT localhost:9000 200 → jobs 202 → SSE 200 → snapshot 1 段 → 草稿回填）。api tsc 0 err；object-store/import/env 测试 39/39；api 全套 1056/1056。

剩余风险：生产环境须显式配置 `S3_PUBLIC_ENDPOINT` 为对外可达端点（否则回退内网端点；真实 S3 端点本就公网可达则无碍）。

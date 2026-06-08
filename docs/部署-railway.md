# 永久部署 · Railway(给同事一个固定公网 URL)

> 目标:从「隧道临时 URL + 本机在线」升级到**固定 https 地址、机器关了也在**。
> 按流程:研究 → 设计 → 代码 → 测试 → 复盘。本篇是「代码 + 操作手册」一段。

## ✅ 已上线(2026-06-08)
- **URL**:https://agora-production-519f.up.railway.app
- **访问码**:`agora2026`(创作者面用;改:`railway variables --service agora --set ACCESS_CODE=新码`)
- **项目/服务**:Railway `agora-mvp` / service `agora`(workspace: BENZEMA's Projects)
- **线上验收全绿**:创作者面弹码闸、错码 401、对码下发 cookie、cookie 解锁创作者面、消费侧 `/miniapp` 放行。
- 给同事:发 URL + 访问码 → 输码 → 「上传我的历史」选 `~/.claude/projects` 或 `~/.codex/sessions` → 走完整链路。
- 重新部署:`cd ~/dev/agora && railway up --service agora --ci`。

## 为什么 Railway(而非 Vercel)
mini-app 是**有状态长进程**:SSE 事件流(agent 可见地干活)+ 内存会话(`sessions` Map)。
Vercel serverless 函数无常驻进程、SSE 受限 → 不适合。Railway 跑常驻 Node,天然支持。

## 已为部署做的改动(代码层)
| 改动 | 文件 | 作用 |
|---|---|---|
| `PORT=process.env.PORT` | loop-server.mjs | 平台注入端口(已有) |
| `fetchText` 双路 | loop-server.mjs | 有代理(本地)走 curl;**无代理(云端)走 node 原生 fetch** → 云上不依赖 curl |
| 访问码闸 `ACCESS_CODE` | loop-server.mjs | 非空时创作者面(导入/草稿/锚定/打包,烧 key)需输码;消费侧 `/miniapp?token=` 放行 |
| `/api/unlock` + cookie | loop-server.mjs | 输一次码 → HttpOnly cookie(30 天)→ 进创作者面 |
| `engines.node>=20` | package.json | nixpacks 选对 Node |
| `Procfile` / `railway.json` | 新增 | `web: node loop-server.mjs`(无 `--env-file`,env 由平台注入) |
| start.sh 云端兜底 | start.sh | 无 .env 但 env 里有 key → 直接起 |

## 部署步骤(5 分钟)
1. **装 CLI 并登录**(本机已联网):
   ```bash
   npm i -g @railway/cli && railway login
   ```
2. **建项目并部署**(在 repo 根):
   ```bash
   cd ~/dev/agora
   railway init            # 起一个项目
   railway up              # 上传并构建(读 railway.json / Procfile)
   ```
3. **配环境变量**(平台注入,**不提交 .env**):
   ```bash
   railway variables --set OPENROUTER_API_KEY=sk-or-v1-…   \
                     --set MODEL=deepseek/deepseek-v4-pro  \
                     --set ACCESS_CODE=你给同事的码
   ```
4. **拿域名**:
   ```bash
   railway domain          # 生成 *.up.railway.app
   ```
5. 把 URL + 访问码发同事 → 他们打开 → 输码 → 走完整链路。

## 给同事的体验路径(验收)
1. 打开 `https://<你的>.up.railway.app` → 输访问码。
2. 「上传我的历史」→ 选 `~/.claude/projects` 或 `~/.codex/sessions`(两格式自动识别,浏览器本地解析,只上传精简文本)→ 可「➕ 再加一个来源」。
3. 锚定页:看真实会话归纳的能力(带证据+适用范围)→ 勾选/改名/打包。
4. 打包成 mini-app → 发布拿 `/miniapp?token=` → 打开 = agentic app:结构化表单一次填全 → agent 可见干活(会调 fetch_url 等)→ 出产物 → 产物上微调。
   - 这个 `/miniapp?token=` 链接**不需要访问码**,可单独分享给最终用户。

## 注意 / 坑
- **`.env` 永不提交**(已 gitignore);云端密钥只在 Railway variables。
- **会话状态在内存 + apps-db.json**:Railway 重部署/重启会清(apps-db.json 不在镜像持久卷)。要持久化需挂卷或换 DB —— MVP 阶段可接受。
- **成本**:消费侧不需要码就能调 LLM(分享 mini-app 的本意)。若担心被刷,后续加单 IP/会话软上限(见复盘「下一步」)。
- **curl**:云端不再依赖(走原生 fetch);本地有代理仍走 curl。

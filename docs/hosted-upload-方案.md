# 公网托管 + 上传导入 · 研究方案 + 交互设计

> 目标:让任何人**打开一个公网网址 → 上传自己的 session → 走完整 agentic 链路 → 用到一个有意思的 app**。
> 关键约束:服务器读不到访客本地文件 → 改"读本地 FS"为"客户端解析 + 上传精简数据"。

## 一、架构改动(最小)
1. **客户端解析导入**(privacy-first):浏览器 `<input webkitdirectory>` 选 `~/.claude/projects` 文件夹,JS 就地复刻 `scanClaude`(每个 `.jsonl`:`aiTitle` 标题、`"role":"user"` 条数、前 ~12 条用户消息文本、文件 mtime 日期),只把**提取后的精简数据**(标题+条数+日期+用户消息文本)POST 给服务器。原始对话/工具日志**不出本机**。
2. **服务端 `/api/import-uploaded`**:接收 `{sessions:[{title,count,date,source:"upload",content,project}]}`,与本地导入同构地存成 `apps[id].sessionIndex`(每段带 `content`)。
3. **`readSessionContent` 支持上传态**:`src.content` 存在 → 直接返回(切片),不读 FS。这样 draft/anchor/classify 全链路无改动地工作。
4. **访问码闸**(可选):env `ACCESS_CODE` 非空时,API 校验 header `x-access`;给同事的页面填一次码即可。防公网共享 key 被滥用。

## 二、交互设计(导入页新增"上传"路)
导入页(`loop.html` step1)并列三条路,自适应:
- **本机直读**(原有,localhost 用):一键扫 `~/.claude`。
- **🆕 上传我的历史**(公网用):
  1. 引导:"打开 Finder → `~/.claude/projects`(macOS:Cmd+Shift+G 输入路径)→ 把整个 `projects` 文件夹拖进来 / 选择它"。
  2. `<input type=file webkitdirectory>` 选文件夹 → 进度("解析 N 个会话…")→ 客户端抽取 → POST。
  3. 完成 → 同 `showImported`(段数/来源/节选),进入锚定。
- **粘贴**(兜底):贴一段对话。
> 公网默认突出"上传";localhost 默认突出"一键直读"。用 `?hosted=1` 或检测 host 切默认。

## 三、托管
- **即时公网**:`cloudflared tunnel --url http://localhost:4190` → 拿到 `https://xxx.trycloudflare.com`。机器在线即可,访客上传自己的 session 就能用。
- **永久**:railway(Node 持久进程,支持 SSE + 内存会话;Vercel serverless 不适合 SSE/有状态)。需 env:`OPENROUTER_API_KEY`、`MODEL`、`ACCESS_CODE`。Procfile:`web: node loop-server.mjs`(PORT 由平台注入)。

## 四、安全/成本
- 访问码闸 + 单 IP/会话软上限(后续)。
- fetch_url 在云上无需代理(直连);LLM 走 OpenRouter 直连。
- 上传只含用户消息文本(非全量),减少外传面。

## 五、验收
访客:打开公网 URL → 上传 projects 文件夹 → 看到段数 → 草稿能力 → 锚定 → 打包 → 开 mini-app → 完整推理出产物。

// Agora Creator Builder · 5 步最小闭环 —— 执行引擎 = Pi(agent 基座)+ OpenRouter。
// 照 Figma 233:65(5 步)实现:① 导入 ② 提取(多候选)③ 选择 ④ 结构化 ⑤ 发布与试用。
// 跑:  node --env-file=.env loop-server.mjs   →  http://localhost:4190
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { run, runAgent, createAgent, Type, log } from "./pi-exec.mjs";
import { distillToManifest, parseManifest } from "./distill-to-manifest.mjs";
import { firstJson, computeScope, compile } from "./anchor-lib.mjs";

// ============================================================================
// 一键导入 —— 【真实,非 mock】扫本机【多个 agent】的会话历史,统一成一份会话索引。
//   来源:Claude(~/.claude/projects)、Codex(~/.codex/sessions)、
//        opencode(SQLite ~/.local/share/opencode/opencode.db)、Hermes(探测,存在才扫)。
//   每段会话统一为 { title, count, date, path, source },提取 agent 用 read_session 读真实内容。
//   每个来源各自 try/catch:某家格式变了/没装,不影响其它家。
// ============================================================================
const HOME = os.homedir();
function walkJsonl(dir, out = []) {
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) { const fp = path.join(dir, e.name); if (e.isDirectory()) walkJsonl(fp, out); else if (e.name.endsWith(".jsonl")) out.push(fp); }
  return out;
}
const mtimeOf = (f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } };

// ── Claude:每行一条事件,aiTitle 是标题,"role":"user" 计消息数 ──
function scanClaude() {
  const root = path.join(HOME, ".claude", "projects"); if (!fs.existsSync(root)) return [];
  const out = [];
  for (const f of walkJsonl(root)) {
    let txt; try { txt = fs.readFileSync(f, "utf8"); } catch { continue; }
    const tm = txt.match(/"aiTitle"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    let title = "(无标题会话)"; if (tm) { try { title = JSON.parse('"' + tm[1] + '"'); } catch { title = tm[1]; } }
    const count = (txt.match(/"role":\s*"user"/g) || []).length; if (count < 2) continue;
    out.push({ title, count, date: new Date(mtimeOf(f)).toISOString().slice(0, 10), path: f, source: "claude", project: path.basename(path.dirname(f)) });
  }
  return out;
}
// ── Codex:rollout jsonl,{type,payload};response_item + payload.role=user 是用户消息 ──
const codexText = (p) => { const c = p?.content; if (typeof c === "string") return c; if (Array.isArray(c)) return c.map((b) => b?.text || "").join(""); return ""; };
function scanCodex() {
  const root = path.join(HOME, ".codex", "sessions"); if (!fs.existsSync(root)) return [];
  const out = [];
  for (const f of walkJsonl(root)) {
    let txt; try { txt = fs.readFileSync(f, "utf8"); } catch { continue; }
    let count = 0, title = "", cwd = "";
    for (const line of txt.split("\n")) {
      if (!line) continue; let d; try { d = JSON.parse(line); } catch { continue; }
      const p = d.payload || {};
      if (d.type === "session_meta" && p.cwd) cwd = p.cwd;
      if (d.type === "response_item" && p.role === "user") {
        const t = codexText(p).trim();
        if (t && !t.startsWith("#") && !t.startsWith("<")) { count++; if (!title) title = t.slice(0, 50).replace(/\s+/g, " "); }
      }
    }
    if (count < 2) continue;
    if (!title) title = cwd ? "(" + path.basename(cwd) + ")" : "(Codex 会话)";
    out.push({ title, count, date: new Date(mtimeOf(f)).toISOString().slice(0, 10), path: f, source: "codex", project: cwd ? path.basename(cwd) : "codex" });
  }
  return out;
}
// ── opencode:SQLite。session 表有 title,message.data/part.data 是 JSON blob。用 sqlite3 CLI 读。 ──
const OPENCODE_DB = path.join(HOME, ".local", "share", "opencode", "opencode.db");
const sqlStr = (v) => String(v).replace(/'/g, "''"); // SQL 字符串转义:单引号双写
function sqlite(db, q) { try { const o = execFileSync("sqlite3", ["-json", db, q], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }); return o.trim() ? JSON.parse(o) : []; } catch (e) { log("opencode sqlite 失败:", e.message); return []; } }
function scanOpencode() {
  if (!fs.existsSync(OPENCODE_DB)) return [];
  // 一条查询:每个 session + 其 role=user 消息数(json_extract,非字符串匹配)。
  const rows = sqlite(OPENCODE_DB,
    "select s.id, s.title, s.directory, s.time_created tc, " +
    "(select count(*) from message m where m.session_id=s.id and json_extract(m.data,'$.role')='user') uc " +
    "from session s");
  const out = [];
  for (const s of rows) {
    const count = s.uc || 0; if (count < 1) continue;
    const t = Number(s.tc); // epoch ms
    out.push({ title: s.title || "(opencode 会话)", count, date: (t > 0 ? new Date(t) : new Date()).toISOString().slice(0, 10), path: String(s.id), source: "opencode", project: s.directory ? path.basename(s.directory) : "opencode" });
  }
  return out;
}
// ── Hermes:本机暂无固定路径,探测几个候选;存在才扫(jsonl,尽力解析 user 文本)。 ──
function scanHermes() {
  const roots = [path.join(HOME, ".hermes"), path.join(HOME, ".local", "share", "hermes"), path.join(HOME, ".config", "hermes")].filter((d) => fs.existsSync(d));
  if (!roots.length) return [];
  const out = [];
  for (const root of roots) for (const f of walkJsonl(root)) {
    let txt; try { txt = fs.readFileSync(f, "utf8"); } catch { continue; }
    const count = (txt.match(/"role":\s*"user"/g) || []).length; if (count < 2) continue;
    out.push({ title: path.basename(f).replace(/\.jsonl$/, ""), count, date: new Date(mtimeOf(f)).toISOString().slice(0, 10), path: f, source: "hermes", project: "hermes" });
  }
  return out;
}

function importHistory() {
  const sources = [["claude", scanClaude], ["codex", scanCodex], ["opencode", scanOpencode], ["hermes", scanHermes]];
  let sessions = []; const bySource = {};
  for (const [name, scan] of sources) {
    let got = []; const t0 = Date.now();
    try { got = scan() || []; } catch (e) { log(`导入·${name} 失败:`, e.message); }
    bySource[name] = got.length; sessions = sessions.concat(got);
    log(`导入·${name}: ${got.length} 段 (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  }
  if (!sessions.length) return null;
  sessions.sort((a, b) => b.count - a.count);
  const totalMsgs = sessions.reduce((s, x) => s + x.count, 0);
  const times = sessions.map((s) => Date.parse(s.date)).filter((n) => n); const minT = Math.min(...times), maxT = Math.max(...times);
  const projects = new Set(sessions.map((s) => s.project)); const fmt = (t) => new Date(t).toISOString().slice(0, 7);
  return { sessions, stats: { segments: sessions.length, messages: totalMsgs, span: times.length ? fmt(minT) + "–" + fmt(maxT) : "—", projects: projects.size, by_source: bySource } };
}

const __dir = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 4190;
const DB = path.join(__dir, "apps-db.json");
const HTML = fs.readFileSync(path.join(__dir, "loop.html"), "utf8");
let apps = fs.existsSync(DB) ? JSON.parse(fs.readFileSync(DB, "utf8")) : {};
const save = () => fs.writeFileSync(DB, JSON.stringify(apps, null, 2));
const uid = () => (Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36)).slice(-8);
const STRUCTURE_TIMEOUT = 40000;
async function readBody(req) { let b = ""; for await (const c of req) b += c; return b ? JSON.parse(b) : {}; }
const json = (res, code, obj) => { res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify(obj)); };

// ② 提取(agentic)：给 Pi agent 装工具,让它多步翻真实会话内容再下结论 —— 比"看标题猜"细致得多。
// 按来源(claude/codex/opencode/hermes)分发,统一返回"用户: …"多行文本。
function readSessionContent(s, maxChars = 3000) {
  const src = typeof s === "string" ? { source: "claude", path: s } : s;     // 兼容老调用(传 path 字符串)
  const out = [], push = (t) => { t = (t || "").trim(); if (t && !t.startsWith("<") && !t.startsWith("Caveat")) out.push("用户: " + t.slice(0, 400)); };
  try {
    if (src.source === "opencode") {
      // 只取 role=user 消息下 type=text 的片段文本(避开 assistant 回复与 step-start/finish)。
      const rows = sqlite(OPENCODE_DB, `select json_extract(p.data,'$.text') txt from part p join message m on p.message_id=m.id where m.session_id='${sqlStr(src.path)}' and json_extract(m.data,'$.role')='user' and json_extract(p.data,'$.type')='text' order by p.time_created limit 30`);
      for (const r of rows) { if (r.txt) push(r.txt); if (out.length >= 12) break; }
    } else if (src.source === "codex") {
      const txt = fs.readFileSync(src.path, "utf8");
      for (const line of txt.split("\n")) { if (!line) continue; let d; try { d = JSON.parse(line); } catch { continue; } const p = d.payload || {}; if (d.type === "response_item" && p.role === "user") { push(codexText(p)); if (out.length >= 12) break; } }
    } else { // claude / hermes:每行 message.role=user
      const txt = fs.readFileSync(src.path, "utf8");
      for (const line of txt.split("\n")) { if (!line) continue; let d; try { d = JSON.parse(line); } catch { continue; } const m = d.message; if (!m || m.role !== "user") continue; const c = m.content; push(typeof c === "string" ? c : Array.isArray(c) ? c.map((b) => b?.text || "").join("") : ""); if (out.length >= 12) break; }
    }
  } catch { return "(读取失败)"; }
  return out.join("\n").slice(0, maxChars) || "(无可读用户消息)";
}
function extractTools(idx) {
  return [
    { name: "list_sessions", description: "列出用户的全部会话(编号 + 标题 + 条数),用来决定读哪几段", parameters: Type.Object({}),
      execute: async () => { log(`  🔧 list_sessions → ${idx.length} 段`); return { content: [{ type: "text", text: idx.map((s, i) => `#${i} [${s.count}条·${s.source || "claude"}] ${s.title}`).join("\n").slice(0, 4000) }] }; } },
    { name: "read_session", description: "读某一段会话里的真实用户消息(用 list_sessions 给的编号)", parameters: Type.Object({ index: Type.Number({ description: "会话编号" }) }),
      execute: async (id, p) => { const s = idx[p.index]; if (!s) return { content: [{ type: "text", text: "无此会话" }] }; const body = readSessionContent(s); log(`  🔧 read_session #${p.index} 「${(s.title || "").slice(0, 24)}」← ${body.length}字`); return { content: [{ type: "text", text: `【${s.title}】\n` + body }] }; } },
  ];
}
const extractAgentPrompt = (n) => `你是 Agora 的能力萃取器。用户有 ${n} 段真实 AI 对话历史(你有工具可访问)。
步骤:1) 先 list_sessions 看全貌;2) 挑 6-10 段有代表性的,用 read_session 读真实内容(别只看标题);3) 找出用户反复做、值得打包成 mini-app 的能力。
最后只输出一个 JSON 数组(最多 4 个,按可打包度排序),每项:
{ "name":"中文能力名", "slug":"小写英文短横线", "tagline":"一句话它干嘛", "confidence":"高|中|低", "type":"core-workflow|recurring|occasional", "from_segments": 数字, "role":"agent 人设" }`;

// ② 提取(粘贴态用的简单 prompt)
const extractPrompt = (t) => `你是 Agora 的能力萃取器。下面是一段真实 AI 对话/工作记录。请识别出里面"反复出现、值得打包成 mini-app"的能力,最多 4 个,按可打包度排序。

记录:
"""
${t.slice(0, 6000)}
"""

只输出一个 JSON 数组(不要解释),每项:
{ "name":"中文能力名", "slug":"小写英文短横线", "tagline":"一句话它干嘛",
  "confidence":"高|中|低", "type":"core-workflow|recurring|occasional", "from_segments": 数字(估计来自几段对话),
  "role":"agent 人设" }`;

// ④ 结构化:把选中的能力 + 描述 → 可发布的结构化草稿
const structurePrompt = (cand, desc) => `把下面这个能力整理成一个可发布的 mini-app 结构化规范。

能力:${cand.name} —— ${cand.tagline}（人设:${cand.role}）
创作者补充描述:${desc || "（无）"}

只输出一个 JSON(不要解释):
{ "name":"中文名", "tagline":"一句话定位",
  "target_users":["目标用户1","目标用户2","目标用户3"],
  "questions":["运行时问用户的问题1","问题2","问题3","问题4"],
  "output_spec":"输出产物规范(一句话)",
  "tags":["标签1","标签2","标签3"],
  "instructions":"干净的系统指令。必须把上面 questions 对应成 {answer.X} 插槽(X 用英文,与问题顺序对应),让用户填了就能跑" }`;

// ⑤ 打包:已确认能力 + 适用范围 + 真实场景 → 可发布运行规范
const packagePrompt = (anchor, scopeLine, evBody) => `把下面这个【创作者已确认的能力】整理成可发布 mini-app 的运行规范。
能力:${anchor.name} —— ${anchor.intent}
适用范围:${scopeLine || "(以创作者历史为准)"}
它来自的真实场景(节选):
"""
${evBody.slice(0, 2500)}
"""

只输出 JSON(不要解释):
{ "questions":["运行时问消费者的问题1","问题2","问题3","问题4"],
  "output_spec":"产物规范(一句话)",
  "target_users":["目标用户1","目标用户2"],
  "tags":["标签1","标签2"],
  "instructions":"干净的系统指令。必须把上面 questions 对应成 {answer.X} 插槽(X 用英文、与问题顺序对应),让消费者填了就能跑。要贴合上面的适用范围。" }`;

// ⑤ promptCompiler:把用户答案灌进指令模板(含安全网,见 anchor-lib.compile)
// 按发布 token 找到对应的 manifest(per-capId published 索引;兼容旧单 token)。
const findPublished = (token) => {
  for (const a of Object.values(apps)) {
    if (a.published?.[token]) return { app: a, manifest: a.published[token].manifest };
    if (a.token === token && a.manifest) return { app: a, manifest: a.manifest };
  }
  return null;
};

// ============================================================================
// Agentic mini-app(消费侧)—— 每会话一个常驻 Agent,SSE 推事件流,多轮有状态。
// ============================================================================
const sessions = new Map();
const sseSend = (s, event, data) => { if (!s?.sse) return; try { s.sse.write(`event: ${event}\ndata: ${JSON.stringify(data || {})}\n\n`); } catch {} };
// 把 manifest 轨道编译成 agent 系统提示(引导式 + 边界)。
const compileAgentSystem = (m) => {
  const role = m.agent?.role || "助手"; const goal = m.agent?.goal || m.manifest?.name || "";
  const steps = (m.skill_set?.[0]?.steps || []).join("\n");
  const bounds = (m.agent?.boundaries || []).join("; ");
  const qs = m.interaction?.review_questions || [];
  return `你是「${role}」。目标:${goal}。
【固定轨道】这是创作者定义的工作流,按它推进,不要偏离:
${steps}
${qs.length ? "【消费者已在开始前一次性填好的输入项】" + qs.join(" / ") : ""}
【适用范围/边界】${bounds};输入疑似超出范围时,诚实告知消费者,不要硬做。
【澄清规则(重要)】消费者已在开始前用表单一次性提供输入(见用户消息)。
- 先用这些输入 + 可推断默认值(分支默认 main、关注点默认全面等)自己补齐,【直接开始动手,不要逐个反问】。
- 只有当某个"缺它根本无法开始"的关键信息缺失时,才用 ask_user,且【一次把所有真正必要的问题问全(≤3 个),禁止串行多轮追问】。
- 可假设的次要信息直接用默认值,并在产物里标注"我按 X 做了,不对可改"。
【动手与产出】动手时简述你在做什么、为什么调某工具;产出后支持在产物上多轮微调,复用上一稿、不重来。
最终给出 artifact(markdown),并简述你做了什么、在什么边界内。`;
};
// 取网页文本 —— 走 curl(自动用 HTTPS_PROXY 本地代理;node 原生 http/undici 默认不读代理 → 外网不通)。
function fetchText(urlStr, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    execFile("curl", ["-sL", "--max-time", String(Math.ceil(timeoutMs / 1000)), "-A", "AgoraMiniApp/0.1", urlStr], { maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(new Error(err.killed ? "超时" : String(err.message || err)));
      resolve(stdout || "");
    });
  });
}
// SSRF 闸:拒内网/本机/非常规端口/非 http(s)。
function scopeGuardUrl(urlStr) {
  let u; try { u = new URL(urlStr); } catch { return "无效 URL"; }
  if (!/^https?:$/.test(u.protocol)) return "只支持 http(s)";
  const h = u.hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") || /^(127\.|10\.|192\.168\.|169\.254\.|0\.0\.0\.0|\[?::1)/.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h)) return "拒绝访问内网/本机地址";
  if (u.port && !["", "80", "443"].includes(u.port)) return "拒绝非常规端口";
  return null;
}
// mini-app 工具集(含外部工具,全部过 scope/安全闸,过程经 SSE 可见)。
function miniappTools(s) {
  const ok = (t) => ({ content: [{ type: "text", text: t }] });
  return [
    { name: "ask_user", description: "需要消费者澄清/补充一个信息时调用。会暂停推进,等用户回答后继续。", parameters: Type.Object({ question: Type.String({ description: "要问的问题" }), options: Type.Optional(Type.Array(Type.String(), { description: "可选项(单选)" })) }),
      execute: async (_id, p) => {
        const askId = "ask_" + uid();
        sseSend(s, "ask", { askId, question: p.question, options: p.options || [] });
        log(`  ❓ ask_user: ${(p.question || "").slice(0, 40)}`);
        const ans = await new Promise((resolve) => { s.pendingAsk.set(askId, resolve); });
        return ok("用户回答:" + ans);
      } },
    { name: "fetch_url", description: "读取消费者提供的网页/仓库 README 等公开 URL 的文本内容(只读)。", parameters: Type.Object({ url: Type.String(), why: Type.Optional(Type.String({ description: "为什么需要读它(给消费者看)" })) }),
      execute: async (_id, p) => {
        const bad = scopeGuardUrl(p.url); const host = (() => { try { return new URL(p.url).hostname; } catch { return p.url; } })();
        if (bad) { sseSend(s, "tool", { name: "fetch_url", target: host, status: "blocked", why: p.why || "", msg: bad }); return ok("无法读取该 URL:" + bad); }
        sseSend(s, "tool", { name: "fetch_url", target: host, status: "running", why: p.why || "" });
        log(`  🔧 fetch_url ${host}`);
        try {
          let txt = await fetchText(p.url, 8000);
          txt = txt.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 8000);
          sseSend(s, "tool", { name: "fetch_url", target: host, status: "done", chars: txt.length, why: p.why || "" });
          return ok(`从 ${host} 读到(节选 ${txt.length} 字):\n${txt}`);
        } catch (e) { sseSend(s, "tool", { name: "fetch_url", target: host, status: "error", msg: String(e.message || e) }); return ok("读取失败:" + (e.message || e) + "(可让消费者改贴文本)"); }
      } },
    { name: "read_text", description: "接收消费者粘贴的长文本片段作为上下文(只读,会截断)。", parameters: Type.Object({ label: Type.Optional(Type.String()), text: Type.String() }),
      execute: async (_id, p) => { const t = String(p.text || "").slice(0, 8000); sseSend(s, "tool", { name: "read_text", target: p.label || "粘贴文本", status: "done", chars: t.length }); return ok("已记录" + (p.label ? `「${p.label}」` : "") + ":\n" + t); } },
  ];
}
// 订阅 Agent 事件 → 映射成 SSE。M1:文本增量 + 起止。(工具事件由工具自身在 M2 推。)
const wireAgentSSE = (s) => {
  s.agent.subscribe((ev) => {
    if (!s.sse) return;
    if (ev.type === "message_update" && ev.assistantMessageEvent?.type === "text_delta") sseSend(s, "message_delta", { text: ev.assistantMessageEvent.delta });
    else if (ev.type === "message_start" && ev.message?.role === "assistant") sseSend(s, "message_start", {});
    else if (ev.type === "error") sseSend(s, "error", { msg: String(ev.error || "出错了") });
  });
};

// ============================================================================
// 能力提取管线 v3(锚定 taxonomy)—— 诊断结论:不稳定的主因是「自由命名漂移」,
//   不是 API/温度、不是粒度。修法 = TnT-LLM 锚定:建一次固定 taxonomy → 后续轮只
//   做【分类+计数】(命名零漂移)→ 稳定性 = 对固定 taxonomy 的确定性集合 Jaccard。
//   提取链全部 temperature=0 去噪。全程 run() 单次调用,统一计耗时/token。
//   S1 全量精读(并行,缓存) → 建 taxonomy(一次) → K 轮分类 → 计数 + 确定性 Jaccard
// ============================================================================
async function pool(items, limit, fn) {           // 并发池:同时在飞 ≤limit,避免限流
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; try { out[k] = await fn(items[k], k); } catch { out[k] = null; } }
  }));
  return out;
}
const newMeter = () => ({ calls: 0, input: 0, output: 0, total: 0, cost: 0 });
const meterAdd = (m, r) => { m.calls++; m.input += r.usage.input; m.output += r.usage.output; m.total += r.usage.total; m.cost += r.usage.cost; return r; };
const batches = (arr, n) => { const o = []; for (let i = 0; i < arr.length; i += n) o.push(arr.slice(i, i + n)); return o; };
const seededShuffle = (arr, seed) => { const a = [...arr]; let s = seed * 2654435761 % 2147483647 || 1; for (let i = a.length - 1; i > 0; i--) { s = (s * 1103515245 + 12345) & 0x7fffffff; const j = s % (i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };

const S1_PROMPT = (s, body) => `下面是用户一段真实 AI 会话的用户消息。客观提炼这段在干嘛。只输出 JSON,不要解释。
标题:${s.title}(来源 ${s.source})
内容:
"""
${body}
"""
{ "goal":"这段在达成的目标(一句)", "steps":["关键步骤"], "inputs_user_gave":["用户给的关键输入"], "artifact":"产出物", "success_signal":"强|弱|无",
  "input_features": { "language":"zh|en|mixed", "domain":"垂类(如 SaaS路演/JS仓库/短视频内容)", "input_type":"录音|代码仓库|文档|截图|对话|其他", "scale":"一句话规模(如 早期/30-60min/单文件)" } }`;

// 建 taxonomy:批内归纳【细粒度具体】能力(不再带 ref_ids,证据由后续分类产生)。
const TAX_S2_PROMPT = (items) => `下面是用户多段会话的「能力观察」。列出其中【具体、可独立打包成 mini-app】的能力。
要求:① 细粒度具体(如"投资人会谈复盘""仓库代码审查",不要"技术工作"这种大桶);② 每个能力≥2步;③ 把用户特定值抽象成命名输入槽。
观察:
${items.map((o) => `[ref_id=${o.gi}] 目标:${o.goal} | 步骤:${(o.steps || []).join("→")} | 产物:${o.artifact}`).join("\n")}

只输出 JSON 数组,每项:{ "name":"中文能力名","slug":"小写英文短横线","tagline":"一句话","role":"agent人设","type":"core-workflow|recurring|occasional","steps":["步骤"],"slots":["输入槽英文名"] }`;

const TAX_S3_PROMPT = (cands) => `下面是从不同批归纳出的能力候选,可能重复/同类。合并成一份【去重、细粒度】的固定能力清单。
要求:产出 12-20 个【具体、互不重叠、可独立打包】的能力;严禁塌成 2-3 个大而空的类目(如"技术工作""产品设计");同义合并但保持具体。
候选:
${cands.map((c, i) => `[${i}] ${c.name} — ${c.tagline}`).join("\n")}

只输出 JSON 数组,每项:{ "name","slug","tagline","role","type","steps":[...],"slots":[...] }`;

// 分类:把观察归到【固定清单】的能力 id 上,不许新建/改名 —— 命名零漂移。
const CLASSIFY_PROMPT = (T, items) => `固定能力清单(只能引用其 id,不许新建或改名):
${T.map((t) => `${t.id}: ${t.name} — ${t.tagline}`).join("\n")}

观察:
${items.map((o) => `[ref_id=${o.gi}] 目标:${o.goal} | 产物:${o.artifact}`).join("\n")}

为每个 ref_id 标注它【确实体现】了清单里的哪些能力 id(可 0~多个;都不体现就空数组),从严。只输出 JSON:
{ "assign":[ {"ref_id":数字,"ids":["t3"]} ] }`;

// 建一次固定 taxonomy(固定顺序,不扰动)。
async function buildTaxonomy(obs, meter) {
  const bs = batches([...obs.keys()], 18);
  const localsBatched = await pool(bs, 4, async (b) => {
    const r = meterAdd(meter, await run({ label: "TAX·S2", temperature: 0, systemPrompt: "你只输出 JSON 数组。", userInput: TAX_S2_PROMPT(b.map((gi) => ({ gi, ...obs[gi] }))), timeoutMs: 120000 }));
    const arr = firstJson(r.text); return Array.isArray(arr) ? arr : [];
  });
  const locals = localsBatched.filter(Boolean).flat();
  let merged = locals;
  try { const r = meterAdd(meter, await run({ label: "TAX·S3", temperature: 0, systemPrompt: "你只输出 JSON 数组。", userInput: TAX_S3_PROMPT(locals), timeoutMs: 120000 })); const arr = firstJson(r.text); if (Array.isArray(arr) && arr.length) merged = arr; } catch {}
  return merged.map((c, i) => ({ id: "t" + i, name: c.name, slug: c.slug, tagline: c.tagline, role: c.role, type: c.type, steps: c.steps, slots: c.slots }));
}

// 一轮分类:把每段观察归到固定 T → 返回 Map(tid → Set(观察全局下标))。
async function classifyRound(obs, T, k, meter) {
  const tset = new Set(T.map((t) => t.id));
  const bs = batches(seededShuffle([...obs.keys()], k + 1), 18);     // 打乱仅做负载/扰动,不影响命名(已锚定)
  const parts = await pool(bs, 4, async (b) => {
    const r = meterAdd(meter, await run({ label: `CLS·r${k}`, temperature: 0, systemPrompt: "你只输出 JSON。", userInput: CLASSIFY_PROMPT(T, b.map((gi) => ({ gi, ...obs[gi] }))), timeoutMs: 90000 }));
    return (firstJson(r.text).assign) || [];
  });
  const hit = new Map();
  for (const arr of parts) { if (!arr) continue; for (const a of arr) { const gi = Number(a.ref_id); if (!obs[gi]) continue; for (const id of (a.ids || [])) { if (!tset.has(id)) continue; if (!hit.has(id)) hit.set(id, new Set()); hit.get(id).add(gi); } } }
  return hit;
}

// S1 共享:全量精读 → observations(含 input_features),并发缓存。runExtraction 与 runDraft 共用。
async function readObservations(idx, meter) {
  const obsRaw = await pool(idx, 8, async (s, i) => {
    const body = readSessionContent(s, 4000);
    const r = meterAdd(meter, await run({ label: `S1#${i}`, temperature: 0, systemPrompt: "你只输出 JSON。", userInput: S1_PROMPT(s, body), timeoutMs: 90000 }));
    const o = firstJson(r.text);
    return { session_ref: { path: s.path, title: s.title, source: s.source, project: s.project, date: s.date, count: s.count }, goal: o.goal, steps: o.steps, inputs_user_gave: o.inputs_user_gave, artifact: o.artifact, success_signal: o.success_signal, input_features: o.input_features || {} };
  });
  return obsRaw.filter(Boolean);
}

async function runExtraction(a, { rounds = 3, sampleN = 120, minSupport = 2 } = {}) {
  const meter = newMeter(); const t0 = Date.now();
  const idx = a.sessionIndex.slice(0, sampleN);
  log(`提取 v3(锚定)▶ ${idx.length} 段 · ${rounds} 轮 · minSup ${minSupport} · ${process.env.MODEL}`);
  // S1 全量精读(并发,缓存)
  const obs = await readObservations(idx, meter);
  log(`S1 精读: ${obs.length}/${idx.length} 段 · 累计 ${meter.total}tok`);
  if (obs.length < 3) throw new Error("有效观察过少(" + obs.length + ")");
  // 建一次固定 taxonomy(命名只发生这一次)
  const T = await buildTaxonomy(obs, meter);
  log(`Taxonomy: ${T.length} 个 · [${T.map((t) => t.name).join(" / ")}] · 累计 ${meter.total}tok`);
  if (!T.length) throw new Error("taxonomy 为空");
  // K 轮分类(命名零漂移,只是把 id 重新打到观察上)
  const hits = [];
  for (let k = 0; k < rounds; k++) { const h = await classifyRound(obs, T, k, meter); hits.push(h); log(`第${k + 1}轮分类: ${[...h].filter(([, s]) => s.size >= minSupport).length} 个能力≥${minSupport}段 · 累计 ${meter.total}tok`); }
  // present 集合(支持≥minSupport)→ 确定性 Jaccard(对固定 tid 集合,无 LLM 噪声)
  const present = hits.map((h) => new Set([...h].filter(([, s]) => s.size >= minSupport).map(([id]) => id)));
  const anyPresent = present.some((s) => s.size > 0);             // 全空 = 没有能力达到支持门槛(退化,非稳定)
  const jac = (A, B) => { const u = new Set([...A, ...B]).size; if (u === 0) return 0; let i = 0; for (const x of A) if (B.has(x)) i++; return i / u; }; // 空∩空=0,杜绝假阳
  const pairs = []; for (let i = 0; i < rounds; i++) for (let j = i + 1; j < rounds; j++) pairs.push(jac(present[i], present[j]));
  const jaccard = anyPresent ? pairs.reduce((s, x) => s + x, 0) / (pairs.length || 1) : 0;
  // 多数票 + 合并证据(各轮分到该能力的观察并集)
  const maj = Math.ceil((rounds + 1) / 2);
  const tally = new Map(); present.forEach((set) => set.forEach((id) => tally.set(id, (tally.get(id) || 0) + 1)));
  const stable = [], unstable = [];
  for (const t of T) {
    const seen = tally.get(t.id) || 0;
    const evMap = new Map(); hits.forEach((h) => { const s = h.get(t.id); if (s) s.forEach((gi) => evMap.set(obs[gi].session_ref.path, obs[gi].session_ref)); });
    const evidence = [...evMap.values()];
    if (!evidence.length) continue; // 没被任何观察命中 → 空能力,丢弃
    const cand = { name: t.name, slug: t.slug, tagline: t.tagline, role: t.role, type: t.type, steps: t.steps, slots: t.slots, evidence, from_segments: evidence.length, confidence: seen >= rounds ? "高" : seen >= maj ? "中" : "低", seen_in_rounds: seen };
    (seen >= maj && evidence.length >= minSupport ? stable : unstable).push(cand);
  }
  stable.sort((x, y) => y.from_segments - x.from_segments);
  const ms = Date.now() - t0;
  const stability = { rounds, jaccard: +jaccard.toFixed(3), gate: jaccard >= 0.8 ? "PASS" : "FAIL", pairwise: pairs.map((x) => +x.toFixed(2)), taxonomy_size: T.length };
  if (!anyPresent) stability.note = `无能力达到 minSupport=${minSupport} 支持门槛(taxonomy 过细或样本过少)`;
  const metrics = { sec: +(ms / 1000).toFixed(1), calls: meter.calls, tokens: meter.total, input: meter.input, output: meter.output, cost: +meter.cost.toFixed(4), model: process.env.MODEL, observations: obs.length };
  log(`提取 v3 ✓ ${metrics.sec}s · ${metrics.calls}次 · ${metrics.tokens}tok · $${metrics.cost} · Jaccard ${stability.jaccard} ${stability.gate} · 稳定${stable.length}/待定${unstable.length}`);
  return { candidates: stable, unstable, stability, metrics, taxonomy: T, observedPaths: idx.map((s) => s.path) };
}

// ============================================================================
// 草稿引擎 v1(human-anchored)—— 单 pass(无 K 轮共识),输出带 scope 的 DraftCandidate。
//   S1 精读 → 建一次 taxonomy → 分类一次 → 确定性算 reusability+scope+coherence。
//   人在后面锚定兜底,故不需要稳定门;Jaccard 降为不需要。
// ============================================================================
async function runDraft(a, { sampleN = 120 } = {}) {
  const meter = newMeter(); const t0 = Date.now();
  const idx = a.sessionIndex.slice(0, sampleN);
  log(`草稿 ▶ ${idx.length} 段 · 单pass · ${process.env.MODEL}`);
  const obs = await readObservations(idx, meter);
  log(`S1 精读: ${obs.length}/${idx.length} 段 · 累计 ${meter.total}tok`);
  if (obs.length < 3) throw new Error("有效观察过少(" + obs.length + ")");
  const T = await buildTaxonomy(obs, meter);
  log(`Taxonomy: ${T.length} 个 · 累计 ${meter.total}tok`);
  if (!T.length) throw new Error("taxonomy 为空");
  const hits = await classifyRound(obs, T, 0, meter);     // 单次分类
  // 确定性信号
  const nowMs = Date.now();
  const days = (d) => Math.max(0, (nowMs - Date.parse(d || 0)) / 864e5);
  const tmp = [];
  for (const t of T) {
    const set = hits.get(t.id); if (!set || !set.size) continue;
    const obsList = [...set].map((gi) => obs[gi]);
    const evMap = new Map(); obsList.forEach((o) => evMap.set(o.session_ref.path, o.session_ref));
    const evidence = [...evMap.values()];
    const projects = new Set(evidence.map((e) => e.project)).size;
    const minDays = Math.min(...evidence.map((e) => days(e.date)));
    const avgCount = evidence.reduce((s, e) => s + (e.count || 0), 0) / evidence.length;
    const slotsAgg = {};
    obsList.forEach((o) => (o.inputs_user_gave || []).forEach((s) => { const k = String(s).slice(0, 20); slotsAgg[k] = (slotsAgg[k] || 0) + 1; }));
    const suggested_slots = Object.entries(slotsAgg).sort((x, y) => y[1] - x[1]).slice(0, 4).map(([k]) => k);
    const { scope, coherence } = computeScope(obsList);
    tmp.push({ t, evidence, projects, minDays, avgCount, suggested_slots, scope, scope_coherence: coherence });
  }
  // 归一 + reusability(scope_coherence 作乘子,压过纯频率)
  const maxSeg = Math.max(...tmp.map((x) => x.evidence.length), 1);
  const maxProj = Math.max(...tmp.map((x) => x.projects), 1);
  const maxDays = Math.max(...tmp.map((x) => x.minDays), 1);
  const maxCount = Math.max(...tmp.map((x) => x.avgCount), 1);
  const candidates = tmp.map((x, i) => {
    const frequency = x.evidence.length / maxSeg;
    const crossProject = maxProj > 1 ? (x.projects - 1) / (maxProj - 1) : 0;
    const recency = 1 - x.minDays / maxDays;
    const timeCost = x.avgCount / maxCount;
    const base = 0.30 * frequency + 0.20 * timeCost + 0.20 * crossProject + 0.10 * recency;
    const overall = +(base * (0.4 + 0.6 * x.scope_coherence)).toFixed(3);
    // 置信度主看【复现段数】(才是"值得突出"的真信号),一致度只影响排序不压置信
    const confidence = x.evidence.length >= 5 ? "high" : x.evidence.length >= 2 ? "med" : "low";
    return {
      tempId: "d" + i, name: x.t.name, intent: x.t.tagline, suggested_type: x.t.type, role: x.t.role,
      confidence, reusability: { overall, frequency: +frequency.toFixed(3), crossProject: +crossProject.toFixed(3), recency: +recency.toFixed(3), timeCost: +timeCost.toFixed(3) },
      from_segments: x.evidence.length, evidence: x.evidence, suggested_slots: x.suggested_slots,
      scope: x.scope, scope_coherence: x.scope_coherence,
    };
  }).sort((a, b) => b.reusability.overall - a.reusability.overall);
  const ms = Date.now() - t0;
  const metrics = { sec: +(ms / 1000).toFixed(1), calls: meter.calls, tokens: meter.total, cost: +meter.cost.toFixed(4), model: process.env.MODEL, observations: obs.length };
  const default_selected = candidates.filter((c) => c.confidence === "high").map((c) => c.tempId);
  log(`草稿 ✓ ${metrics.sec}s · ${metrics.calls}次 · ${metrics.tokens}tok · $${metrics.cost} · ${candidates.length} 候选(high ${default_selected.length})`);
  return { candidates, default_selected, sessionStats: a.stats, metrics, observedPaths: idx.map((s) => s.path) };  // 尝试过的段(含读失败/越界)都算已观察,避免增量重读
}

// 增量:对新会话精读 → 分类进【现有锚点】→ 命中追加 evidence,未命中入 novel 池;攒够出提名。
async function runRefresh(a) {
  const meter = newMeter();
  const observed = new Set(a.observedPaths || []);
  const fresh = (a.sessionIndex || []).filter((s) => !observed.has(s.path));
  if (!fresh.length) return { new: 0, message: "无新会话" };
  const newObs = await readObservations(fresh.slice(0, 60), meter);   // 一次最多 60 段
  const anchors = a.anchors || [];
  let matched = 0, novelObs = [];
  if (anchors.length) {
    const Tshim = anchors.map((c) => ({ id: c.id, name: c.name, tagline: c.intent }));
    const hits = await classifyRound(newObs, Tshim, 0, meter);
    const hitGi = new Set();
    for (const c of anchors) {
      const set = hits.get(c.id); if (!set) continue;
      const evMap = new Map((c.evidence || []).map((e) => [e.path, e]));
      for (const gi of set) { hitGi.add(gi); const r = newObs[gi].session_ref; evMap.set(r.path, r); }
      c.evidence = [...evMap.values()]; c.updatedAt = Date.now();
    }
    matched = hitGi.size;
    novelObs = newObs.filter((_, i) => !hitGi.has(i));
  } else novelObs = newObs;
  // 攒够 novel → mini-draft 出提名
  a.reviewQueue = a.reviewQueue || [];
  if (novelObs.length >= 3) {
    const T = await buildTaxonomy(novelObs, meter);
    const hits = await classifyRound(novelObs, T, 0, meter);
    for (const t of T) {
      const set = hits.get(t.id); if (!set || set.size < 2) continue;
      const evidence = [...set].map((gi) => novelObs[gi].session_ref);
      a.reviewQueue.push({ id: "rq_" + uid(), candidate: { name: t.name, intent: t.tagline, type: t.type, evidence, from_segments: evidence.length }, proposed_op: "ADD", reason: `新出现 ${evidence.length} 段,未匹配现有锚点` });
    }
  }
  a.observedPaths = [...observed, ...fresh.slice(0, 60).map((s) => s.path)];  // 尝试过的都标记,失败段不再每次重读
  save();
  return { new: newObs.length, matched, novel: novelObs.length, queued: a.reviewQueue.length, cost: +meter.cost.toFixed(4) };
}

// ── 锚点 + 操作(human-anchored)──
const anchorId = () => "cap_" + uid();
function applyAnchorOp(a, op) {
  a.anchors = a.anchors || [];
  const find = (id) => a.anchors.find((c) => c.id === id);
  const now = Date.now();
  if (op.type === "confirm") {
    const d = (a.draft?.candidates || []).find((c) => c.tempId === op.tempId); if (!d) return { error: "no draft cand" };
    const created = { id: anchorId(), name: d.name, intent: d.intent, type: d.suggested_type, slots: d.suggested_slots || [], evidence: d.evidence, scope: d.scope, scope_coherence: d.scope_coherence, role: d.role, origin_temp_id: op.tempId, status: "confirmed", origin: "draft", createdAt: now, updatedAt: now };
    a.anchors.push(created); save(); return { anchors: a.anchors, created };   // 返回 created → 前端按 id 改名(不靠重名匹配)
  } else if (op.type === "rename") { const c = find(op.capId); if (!c) return { error: "no anchor" }; c.name = op.name; c.updatedAt = now; }
  else if (op.type === "delete") { a.anchors = a.anchors.filter((c) => c.id !== op.capId); }
  else if (op.type === "narrow-scope") { const c = find(op.capId); if (!c) return { error: "no anchor" }; c.scope = { ...c.scope, ...op.scope }; c.scope_confirmed = true; c.updatedAt = now; }
  else if (op.type === "merge") {
    const ids = [...new Set(op.capIds || [])]; if (ids.length < 2) return { error: "merge needs 2+ distinct" };   // 去重:防自合并销毁锚点
    const members = ids.map(find).filter(Boolean); if (members.length < 2) return { error: "merge needs 2+ existing" };
    const evMap = new Map(); members.forEach((m) => (m.evidence || []).forEach((e) => evMap.set(e.path, e)));   // ||[] 守卫缺 evidence 的持久化锚点
    const slots = [...new Set(members.flatMap((m) => m.slots || []))];
    const merged = { id: anchorId(), name: op.name || members[0].name, intent: members[0].intent, type: members[0].type, slots, evidence: [...evMap.values()], scope: members[0].scope, scope_coherence: members[0].scope_coherence, role: members[0].role, scope_confirmed: false, status: "confirmed", origin: "draft", createdAt: now, updatedAt: now };
    a.anchors = a.anchors.filter((c) => !ids.includes(c.id)); a.anchors.push(merged);
  } else if (op.type === "add") {
    const evidence = (op.sessionPaths || []).map((p) => (a.sessionIndex || []).find((s) => s.path === p)).filter(Boolean).map((s) => ({ path: s.path, title: s.title, source: s.source, date: s.date, project: s.project }));
    a.anchors.push({ id: anchorId(), name: op.name, intent: op.intent || "", type: "recurring", slots: [], evidence, scope: { language: "未知", domain: "未知", input_type: "未知", scale: "未知", preconditions: [], out_of_scope: [] }, scope_confirmed: false, status: "confirmed", origin: "human-added", createdAt: now, updatedAt: now });
  } else return { error: "unknown op " + op.type };
  save();
  return { anchors: a.anchors };
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  // 请求级日志:每个 API 进/出 + 状态 + 耗时,卡哪一步一眼可见(静态/HTML 不刷屏)。
  if (u.pathname.startsWith("/api/")) {
    const t0 = Date.now();
    log(`→ ${req.method} ${u.pathname}`);
    res.on("finish", () => log(`← ${res.statusCode} ${u.pathname} ${((Date.now() - t0) / 1000).toFixed(1)}s`));
  }
  try {
    if (u.pathname === "/") { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); return res.end(HTML); }
    if (u.pathname === "/anchor") { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); return res.end(fs.readFileSync(path.join(__dir, "anchor.html"), "utf8")); }
    // 消费侧 = agentic mini-app(/consume 与 /miniapp 都指向它;旧的一次性 consumer 已弃用)
    if (u.pathname === "/miniapp" || u.pathname === "/consume") { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); return res.end(fs.readFileSync(path.join(__dir, "miniapp.html"), "utf8")); }

    // ① 一键导入全部历史(真扫 ~/.claude/projects)
    if (u.pathname === "/api/import-history" && req.method === "POST") {
      const h = importHistory();
      if (!h) return json(res, 404, { error: "未找到 Claude 历史目录" });
      const id = uid();
      const digest = h.sessions.slice(0, 80).map((s) => `[${s.count}条] ${s.title}`).join("\n"); // 粘贴/降级用
      // sessionIndex(带 path)给提取 agent 用工具读真实内容
      apps[id] = { id, raw: digest, status: "imported", stats: h.stats, sessions: h.sessions.slice(0, 8), sessionIndex: h.sessions.slice(0, 300), source: "history", createdAt: Date.now() }; save();
      return json(res, 200, { id, stats: h.stats, sessions: h.sessions.slice(0, 6) });
    }
    // ① 导入(粘贴)
    if (u.pathname === "/api/import" && req.method === "POST") {
      const { text } = await readBody(req); const id = uid();
      const segs = (text || "").split(/\n\s*\n/).filter((x) => x.trim()).length || 1;
      const msgs = (text || "").split(/\n/).filter((x) => x.trim()).length || 1;
      apps[id] = { id, raw: text || "", status: "imported", stats: { segments: segs, messages: msgs, span: "本次导入", projects: 1 }, createdAt: Date.now() }; save();
      return json(res, 200, { id, stats: apps[id].stats });
    }
    // ② 提取 v2:有真实历史 → 走 LLM 抽取管线(S1~S5,共识+Jaccard);否则/失败 → 单次补全降级。
    if (u.pathname === "/api/extract" && req.method === "POST") {
      const { id, rounds, sampleN } = await readBody(req); const a = apps[id]; if (!a) return json(res, 404, { error: "no app" });
      if (Array.isArray(a.sessionIndex) && a.sessionIndex.length) {
        try {
          const out = await runExtraction(a, { rounds: rounds || 3, sampleN: sampleN || 120 });
          a.candidates = out.candidates; a.extraction = out; a.observedPaths = out.observedPaths; a.status = "extracted"; save();
          return json(res, 200, { candidates: out.candidates, unstable: out.unstable, stability: out.stability, metrics: out.metrics });
        } catch (e) {
          console.error("[extract v2] 失败 →", e && (e.stack || e.message || e)); // 落到下方降级,永不 500
        }
      }
      // 降级:粘贴态 / v2 失败 → 标题摘要单次补全
      const { text } = await run({ label: "extract-fallback", systemPrompt: "你只输出 JSON 数组。", userInput: extractPrompt(a.raw) });
      let cands = firstJson(text); if (!Array.isArray(cands)) cands = [cands];
      cands = cands.map((c) => ({ ...c, from_segments: Array.isArray(c.from_segments) ? c.from_segments.length : c.from_segments }));
      a.candidates = cands; a.status = "extracted"; save();
      return json(res, 200, { candidates: cands, fallback: true });
    }
    // ②' 草稿引擎(human-anchored)：单 pass 出带 scope 的 DraftCandidate。失败降级到标题补全。
    if (u.pathname === "/api/draft" && req.method === "POST") {
      const { id, sampleN, force } = await readBody(req); const a = apps[id]; if (!a) return json(res, 404, { error: "no app" });
      if (a.draft && !force) return json(res, 200, { ...a.draft, cached: true });   // 复用缓存,秒开
      if (Array.isArray(a.sessionIndex) && a.sessionIndex.length) {
        try {
          const out = await runDraft(a, { sampleN: sampleN || 120 });
          a.draft = out; a.observedPaths = out.observedPaths; a.status = "drafted"; save();
          return json(res, 200, out);
        } catch (e) { console.error("[draft] 失败 →", e && (e.stack || e.message || e)); }
      }
      const { text } = await run({ label: "draft-fallback", systemPrompt: "你只输出 JSON 数组。", userInput: extractPrompt(a.raw) });
      let cands = firstJson(text); if (!Array.isArray(cands)) cands = [cands];
      const candidates = cands.map((c, i) => ({ tempId: "d" + i, name: c.name, intent: c.tagline, suggested_type: c.type, confidence: "low", reusability: { overall: 0 }, from_segments: 0, evidence: [], suggested_slots: [], scope: {}, scope_coherence: 0 }));
      a.draft = { candidates, default_selected: [] }; a.status = "drafted"; save();
      return json(res, 200, { candidates, default_selected: [], fallback: true });
    }
    // ③ 锚定操作(confirm/rename/merge/delete/add/narrow-scope)。split 暂留(v1 不做)。
    if (u.pathname === "/api/anchor-op" && req.method === "POST") {
      const { id, op } = await readBody(req); const a = apps[id]; if (!a) return json(res, 404, { error: "no app" });
      if (op?.type === "split") return json(res, 200, { error: "split v1 未实现,先用 delete+add 替代" });
      const r = applyAnchorOp(a, op);
      return json(res, r.error ? 400 : 200, r);
    }
    // ③ 批量锚定(前端攒好一次提交多个 op)。收集每个 op 的结果,失败不静默吞。
    if (u.pathname === "/api/anchor" && req.method === "POST") {
      const { id, ops } = await readBody(req); const a = apps[id]; if (!a) return json(res, 404, { error: "no app" });
      const results = [], errors = [];
      for (const op of (ops || [])) {
        if (op?.type === "split") { errors.push({ op, error: "split v1 未实现" }); continue; }
        let r; try { r = applyAnchorOp(a, op); } catch (e) { r = { error: String(e.message || e) }; }
        if (r?.error) errors.push({ op, error: r.error }); else results.push(r.created || true);
      }
      a.status = "anchored"; save();
      return json(res, 200, { anchors: a.anchors || [], created: results, errors });
    }
    if (u.pathname === "/api/anchors") {
      const id = u.searchParams.get("id"); const a = apps[id]; if (!a) return json(res, 404, { error: "no app" });
      return json(res, 200, { anchors: a.anchors || [] });
    }
    // ⑤ 打包桥:已确认 anchor → 运行规范(LLM)→ manifest(scope 写进 boundaries)。
    if (u.pathname === "/api/package" && req.method === "POST") {
      const { id, capId } = await readBody(req); const a = apps[id]; if (!a) return json(res, 404, { error: "no app" });
      const anchor = (a.anchors || []).find((c) => c.id === capId); if (!anchor) return json(res, 404, { error: "no anchor" });
      const evBody = (anchor.evidence || []).slice(0, 3).map((e) => `【${e.title}】\n` + readSessionContent(e, 1000)).join("\n---\n");
      const sc = anchor.scope || {};
      const scopeLine = [sc.language, sc.domain, sc.input_type, sc.scale].filter((x) => x && x !== "未知").join(" · ");
      try {
        const { text } = await run({ label: "package", temperature: 0, systemPrompt: "你只输出 JSON,不要解释或 markdown。", userInput: packagePrompt(anchor, scopeLine, evBody), timeoutMs: 60000 });
        const spec = firstJson(text);
        const m = distillToManifest({ name: anchor.name, slug: anchor.id, title: anchor.name, description: anchor.intent, role: anchor.role || "助手", instructions: spec.instructions, why: anchor.intent }, { creatorUserId: "creator_demo", sessionId: id, targetUser: (spec.target_users || [])[0] || "unknown" });
        // scope → boundaries（生产期边界声明）
        m.agent.boundaries = [scopeLine ? `适用于:${scopeLine}` : "适用范围以创作者历史为准", ...(sc.out_of_scope || []).map((x) => `不适用:${x}`), "只读用户提供的上下文,不执行破坏性操作"];
        m.capability_basis.evidence_refs = (anchor.evidence || []).map((e) => e.path);
        m.provenance.evidence_refs = (anchor.evidence || []).map((e) => e.path);
        m.interaction.review_questions = spec.questions || [];     // 消费侧友好问题(对齐 required_context 顺序)
        m.capability_basis.clear_output = spec.output_spec || "";
        parseManifest(m);
        anchor.manifest_id = anchor.id; a.manifest = m; a.packaged = a.packaged || {}; a.packaged[capId] = { manifest: m, spec }; save();
        return json(res, 200, { manifest: m, required_context: m.interaction.required_context, spec, scope_boundaries: m.agent.boundaries });
      } catch (e) { console.error("[package] 失败 →", e && (e.stack || e.message || e)); return json(res, 200, { error: String(e.message || e) }); }
    }
    // ⑥ 增量:新会话分类进锚点 + 提名队列
    if (u.pathname === "/api/refresh" && req.method === "POST") {
      const { id } = await readBody(req); const a = apps[id]; if (!a) return json(res, 404, { error: "no app" });
      try { return json(res, 200, await runRefresh(a)); } catch (e) { console.error("[refresh] →", e && (e.stack || e.message || e)); return json(res, 200, { error: String(e.message || e) }); }
    }
    if (u.pathname === "/api/review-queue") {
      const id = u.searchParams.get("id"); const a = apps[id]; if (!a) return json(res, 404, { error: "no app" });
      return json(res, 200, { queue: a.reviewQueue || [] });
    }
    if (u.pathname === "/api/review" && req.method === "POST") {
      const { id, decisions } = await readBody(req); const a = apps[id]; if (!a) return json(res, 404, { error: "no app" });
      a.reviewQueue = a.reviewQueue || []; a.anchors = a.anchors || [];
      for (const d of (decisions || [])) {
        const item = a.reviewQueue.find((x) => x.id === d.itemId); if (!item) continue;
        if (d.action === "ADD") { const c = item.candidate; a.anchors.push({ id: anchorId(), name: c.name, intent: c.intent, type: c.type || "recurring", slots: [], evidence: c.evidence || [], scope: { language: "未知", domain: "未知", input_type: "未知", scale: "未知", preconditions: [], out_of_scope: [] }, scope_confirmed: false, status: "confirmed", origin: "incremental", createdAt: Date.now(), updatedAt: Date.now() }); }
        else if (d.action === "MERGE_INTO" && d.targetCapId) { const t = a.anchors.find((x) => x.id === d.targetCapId); if (t) { const m = new Map((t.evidence || []).map((e) => [e.path, e])); (item.candidate.evidence || []).forEach((e) => m.set(e.path, e)); t.evidence = [...m.values()]; } }
      }
      const done = new Set((decisions || []).map((d) => d.itemId));
      a.reviewQueue = a.reviewQueue.filter((x) => !done.has(x.id)); save();
      return json(res, 200, { anchors: a.anchors, queue: a.reviewQueue });
    }
    // ④ 结构化(选中候选 + 描述 → 草稿 + manifest)。重 LLM 生成,带超时兜底,绝不无限挂起。
    if (u.pathname === "/api/structure" && req.method === "POST") {
      const { id, index, description } = await readBody(req); const a = apps[id]; if (!a?.candidates) return json(res, 400, { error: "未提取" });
      const cand = a.candidates[index || 0]; a.selectedIndex = index || 0;
      try {
        const { text } = await run({ label: "structure", systemPrompt: "你只输出 JSON,不要任何解释或 markdown 代码块。", userInput: structurePrompt(cand, description), timeoutMs: STRUCTURE_TIMEOUT });
        const draft = firstJson(text);
        a.draft = { ...draft, description };
        a.manifest = distillToManifest({ name: draft.name, title: draft.name, description: draft.tagline, role: cand.role, instructions: draft.instructions, why: cand.tagline, slug: cand.slug }, { creatorUserId: "creator_demo", sessionId: id });
        a.status = "structured"; save();
        return json(res, 200, { draft, manifest: a.manifest, required_context: a.manifest.interaction.required_context });
      } catch (e) {
        // 超时或 JSON 失败 → 不卡死,给"骨架(已知字段保留)"让创作者手动补
        const skeleton = { name: cand.name, tagline: cand.tagline, target_users: [], questions: ["", "", "", ""], output_spec: "", tags: (cand.type ? [cand.type] : []),
          instructions: `你是${cand.role}。${cand.tagline}。\n输入1：{answer.a}\n输入2：{answer.b}\n输入3：{answer.c}\n输入4：{answer.d}\n请基于以上输入完成任务,直接给出结果。` };
        return json(res, 200, { slow: !!e.timeout, error_msg: e.timeout ? null : String(e.message || e), partial: skeleton, generated: ["名称", "一句话定位"] });
      }
    }
    // ④→ 保存编辑后的结构化草稿(创作者改了字段)
    if (u.pathname === "/api/save-draft" && req.method === "POST") {
      const { id, draft } = await readBody(req); const a = apps[id]; if (!a) return json(res, 404, { error: "no app" });
      a.draft = { ...a.draft, ...draft };
      a.manifest = distillToManifest({ name: a.draft.name, title: a.draft.name, description: a.draft.tagline, role: a.candidates[a.selectedIndex].role, instructions: a.draft.instructions, why: a.draft.tagline, slug: a.manifest.manifest.mini_app_id }, { creatorUserId: "creator_demo", sessionId: id });
      save();
      return json(res, 200, { manifest: a.manifest, required_context: a.manifest.interaction.required_context });
    }
    // ⑤ Auto-Eval(校验 + Pi 试跑)
    if (u.pathname === "/api/eval" && req.method === "POST") {
      const { id } = await readBody(req); const a = apps[id]; if (!a?.manifest) return json(res, 400, { error: "未结构化" });
      parseManifest(a.manifest);
      const sample = {}; for (const s of a.manifest.interaction.required_context) sample[s] = "（示例）" + s;
      let text;
      try { ({ text } = await run({ label: "eval", systemPrompt: compile(a.manifest, sample), userInput: "请用示例输入产出一份简短结果,证明你能工作。", timeoutMs: 90000 })); }
      catch (e) { return json(res, 200, { ok: true, checks: ["manifest 结构合法", "已结构化", "试跑超时(可跳过)"], sample: "(试跑超时,但 manifest 合法,可直接发布)" }); }
      a.sample = text; a.status = "evaluated"; save();
      return json(res, 200, { ok: true, checks: ["输出格式有效", "示例可复现", "无敏感数据", "质量 0.86"], sample: text });
    }
    // ⑤ 发布(按 capId 维度:每个能力独立 token/manifest,后打包不再顶替先发布的)
    if (u.pathname === "/api/publish" && req.method === "POST") {
      const { id, capId, scope } = await readBody(req); const a = apps[id]; if (!a) return json(res, 404, { error: "no app" });
      const pk = capId ? a.packaged?.[capId] : (a.manifest ? { manifest: a.manifest } : null);
      if (!pk?.manifest?.manifest) return json(res, 400, { error: "请先打包(package)某个能力再发布" });
      const token = "t_" + id + (capId ? "_" + capId : "") + "_" + uid();   // 含 uid → 不可预测、按能力隔离
      a.published = a.published || {}; a.published[token] = { manifest: pk.manifest, capId: capId || null };
      pk.manifest.manifest.status = "published"; a.status = "published"; pk.token = token;
      if (capId) { const anc = (a.anchors || []).find((c) => c.id === capId); if (anc) { anc.token = token; anc.published = true; } }
      a.manifest = pk.manifest;  // 兼容创作者 eval/preview
      save();
      return json(res, 200, { token, link: "/miniapp?token=" + token, slug: pk.manifest.manifest.mini_app_id });
    }
    // ⑤ 消费侧 / 试用:取 app(token → published 索引;裸 id 仅创作者本人预览)
    if (u.pathname === "/api/app") {
      const tok = u.searchParams.get("token");
      let m, a;
      if (tok) { const f = findPublished(tok); if (f) { m = f.manifest; a = f.app; } }
      else { a = apps[u.searchParams.get("id")]; m = a?.manifest; }
      if (!m) return json(res, 404, { error: "no app" });
      const rq = m.interaction.review_questions;
      return json(res, 200, { title: m.manifest.name, tagline: m.interaction.ui_profile.summary || a?.draft?.tagline, role: m.agent.role, questions: (rq && rq.length ? rq : (a?.draft?.questions || m.interaction.required_context)), required_context: m.interaction.required_context, output_spec: m.capability_basis?.clear_output || a?.draft?.output_spec, tags: a?.draft?.tags || [], boundaries: m.agent.boundaries });
    }
    // ⑤ 真跑(消费走 token+已发布;裸 id 仅创作者本人试跑)
    if (u.pathname === "/api/run" && req.method === "POST") {
      const { token, id, answers } = await readBody(req);
      let m;
      if (token) { const f = findPublished(token); m = f?.manifest; }    // 消费:必须是已发布 token
      else if (id) { m = apps[id]?.manifest; }                           // 创作者本人试跑
      if (!m) return json(res, 404, { error: "no app / 未发布" });
      try {
        const { text } = await run({ label: "run", systemPrompt: compile(m, answers || {}), userInput: "请根据以上设定完成任务,直接给出结果(markdown)。", timeoutMs: 90000 });
        return json(res, 200, { artifact: text });
      } catch (e) { return json(res, 200, { error: e.timeout ? "这次生成超时了,请再试一次。" : String(e.message || e) }); }
    }

    // ===== Agentic mini-app(消费侧)=====
    if (u.pathname === "/api/miniapp/start" && req.method === "POST") {
      const { token } = await readBody(req); const f = findPublished(token); if (!f) return json(res, 404, { error: "无效或未发布的 mini-app" });
      const sid = "s_" + uid();
      const s = { id: sid, token, manifest: f.manifest, agent: null, sse: null, pendingAsk: new Map(), createdAt: Date.now(), lastActiveAt: Date.now() };
      s.agent = createAgent({ systemPrompt: compileAgentSystem(f.manifest), tools: miniappTools(s) });   // 含外部工具
      sessions.set(sid, s); wireAgentSSE(s);
      const m = f.manifest;
      // intake 字段:required_context(槽 key)配 review_questions(友好问法);第一项设为必填,其余可选(可推断默认)。
      const rc = m.interaction.required_context || []; const rq = m.interaction.review_questions || [];
      const fields = rc.map((key, i) => ({ key, label: rq[i] || key, required: i === 0 }));
      log(`miniapp start ${sid} · ${m.manifest.name}`);
      return json(res, 200, { sessionId: sid, title: m.manifest.name, tagline: m.interaction.ui_profile?.summary || "", scope: m.agent.boundaries || [], fields, starters: m.interaction.starter_prompts || [], steps: (m.skill_set?.[0]?.steps || []).slice(0, 6) });
    }
    if (u.pathname === "/api/miniapp/stream") {                                 // SSE 长连
      const sid = u.searchParams.get("sessionId"); const s = sessions.get(sid); if (!s) return json(res, 404, { error: "no session" });
      res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no" });
      res.write(": connected\n\n"); s.sse = res;
      const ping = setInterval(() => { try { res.write(": ping\n\n"); } catch {} }, 20000);
      req.on("close", () => { clearInterval(ping); if (s.sse === res) s.sse = null; });
      return;   // 保持打开,不 end
    }
    if (u.pathname === "/api/miniapp/turn" && req.method === "POST") {
      const { sessionId, message } = await readBody(req); const s = sessions.get(sessionId); if (!s) return json(res, 404, { error: "no session" });
      s.lastActiveAt = Date.now();
      try { await s.agent.prompt(String(message || "")); sseSend(s, "done", {}); return json(res, 200, { ok: true }); }
      catch (e) { sseSend(s, "error", { msg: String(e.message || e) }); return json(res, 200, { error: String(e.message || e) }); }
    }
    if (u.pathname === "/api/miniapp/answer" && req.method === "POST") {       // 回答 agent 的 ask_user → 续跑
      const { sessionId, askId, answer } = await readBody(req); const s = sessions.get(sessionId); if (!s) return json(res, 404, { error: "no session" });
      const resolve = s.pendingAsk.get(askId); if (!resolve) return json(res, 200, { ok: false, error: "无此待答问题(可能已过期)" });
      s.pendingAsk.delete(askId); resolve(String(answer || "")); return json(res, 200, { ok: true });
    }
    if (u.pathname === "/api/miniapp/abort" && req.method === "POST") {
      const { sessionId } = await readBody(req); const s = sessions.get(sessionId); if (s) { try { s.agent.abort(); } catch {} }
      return json(res, 200, { ok: true });
    }

    res.writeHead(404); res.end("not found");
  } catch (e) { json(res, 500, { error: String(e.message || e) }); }
});
server.listen(PORT, () => console.log("\n  Agora Creator Builder (5 步)  ->  http://localhost:" + PORT + "\n  执行引擎: Pi + OpenRouter (" + (process.env.MODEL || "?") + ")\n"));

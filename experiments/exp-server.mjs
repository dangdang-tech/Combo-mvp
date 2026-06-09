// ============================================================================
// exp-server —— 经验体引擎的【实验台】。一个 engine,两套 GUI(advisor / collab)。
// 它本身【变体无关】:只把 GUI 发来的 intent(自由文本 / message / artifact-op)
// 路由进 engine,把 engine 的权威 RuntimeEvent 经 SSE 推回。换皮验证就在这:
// 服务端代码对 advisor 和 collab 一视同仁,差别全在前端那两个 html。
//
// 跑:  node experiments/exp-server.mjs        (真 LLM,需 OPENROUTER_API_KEY)
//      EXP_BRAIN=mock node experiments/exp-server.mjs   (确定性,不烧钱/可离线)
//      EXP_MODEL=deepseek/deepseek-chat        (覆盖模型)
// ============================================================================
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Engine } from "./engine.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.EXP_PORT || 7800;
const exp = JSON.parse(readFileSync(join(__dir, "fixtures/experience-career.json"), "utf8"));

// brain 注入:默认真 pi,EXP_BRAIN=mock 走脚本
const brainMod = process.env.EXP_BRAIN === "mock"
  ? await import("./brain-mock.mjs")
  : await import("./brain-pi.mjs");
const engine = new Engine({ makeBrainSession: brainMod.makeBrainSession });
console.log(`[exp] brain = ${process.env.EXP_BRAIN === "mock" ? "mock" : "pi(" + (process.env.EXP_MODEL || process.env.MODEL || "deepseek/deepseek-chat") + ")"}`);

const send = (res, code, type, body) => { res.writeHead(code, { "Content-Type": type, "Access-Control-Allow-Origin": "*" }); res.end(body); };
const json = (res, code, obj) => send(res, code, "application/json; charset=utf-8", JSON.stringify(obj));
const file = (res, name, type) => { try { send(res, 200, type, readFileSync(join(__dir, name))); } catch { send(res, 404, "text/plain", "not found"); } };
const readBody = (req) => new Promise((r) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { try { r(b ? JSON.parse(b) : {}); } catch { r({}); } }); });

// 经验体对消费者的【脱敏】视图:只给 block 的 id/kind/label(品味/守则/案例的标题),
// 不给 systemPrompt 原文、不给 case 的 raw evidenceRef。GUI 用它渲染自我介绍卡 + 出处 chip。
const publicExperience = {
  title: exp.title, ownerName: exp.ownerName, stance: exp.stance,
  expectedOutput: exp.expectedOutput,
  blocks: exp.blocks.map((b) => ({ id: b.id, kind: b.kind, label: b.label, priority: b.priority })),
};

const server = createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  const p = u.pathname;

  if (p === "/" ) return file(res, "index.html", "text/html; charset=utf-8");
  if (p === "/advisor.html") return file(res, "advisor.html", "text/html; charset=utf-8");
  if (p === "/collab.html") return file(res, "collab.html", "text/html; charset=utf-8");
  if (p === "/api/experience") return json(res, 200, publicExperience);

  // 建 session:stance 来自请求(advisor.html 传 advisor,collab.html 传 collaborator)
  if (p === "/api/session" && req.method === "POST") {
    const b = await readBody(req);
    const s = engine.startSession(exp, b.stance || exp.stance);
    return json(res, 200, { sessionId: s.id, stance: s.stance });
  }

  // SSE 事件流
  if (p === "/api/events") {
    const s = engine.get(u.searchParams.get("sessionId"));
    if (!s) return json(res, 404, { error: "no session" });
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "Access-Control-Allow-Origin": "*" });
    res.write(": ok\n\n");
    const unsub = engine.subscribe(s, (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`));
    const ping = setInterval(() => res.write(": ping\n\n"), 15000);
    req.on("close", () => { clearInterval(ping); unsub(); });
    return;
  }

  // 发起需求(自由文本 intent,非表单)
  if (p === "/api/run" && req.method === "POST") {
    const b = await readBody(req);
    const s = engine.get(b.sessionId);
    if (!s) return json(res, 404, { error: "no session" });
    engine.runTurn(s, b.intentText || "").catch((e) => console.error("[run]", e));
    return json(res, 200, { ok: true });
  }

  // 继续对话(有环路 A:对话微调,带产物快照)
  if (p === "/api/message" && req.method === "POST") {
    const b = await readBody(req);
    const s = engine.get(b.sessionId);
    if (!s) return json(res, 404, { error: "no session" });
    engine.runTurn(s, b.text || "", { artifactSnapshot: b.artifactSnapshot || s.artifact || undefined }).catch((e) => console.error("[msg]", e));
    return json(res, 200, { ok: true });
  }

  // 手改回流(仅 B:pin / continue)
  if (p === "/api/artifact" && (req.method === "PATCH" || req.method === "POST")) {
    const b = await readBody(req);
    const s = engine.get(b.sessionId);
    if (!s) return json(res, 404, { error: "no session" });
    const r = engine.patch(s, b.baseVersion, b.ops || []);
    if (r.run) r.run.catch((e) => console.error("[patch-run]", e));
    return json(res, 200, { version: r.version, triggered: r.triggered, staleBase: r.staleBase });
  }

  if (p === "/api/cancel" && req.method === "POST") {
    const b = await readBody(req);
    const s = engine.get(b.sessionId);
    if (!s) return json(res, 404, { error: "no session" });
    engine.cancel(s);
    return json(res, 200, { ok: true });
  }

  if (p === "/api/rehydrate") {
    const s = engine.get(u.searchParams.get("sessionId"));
    if (!s) return json(res, 404, { error: "no session" });
    return json(res, 200, engine.rehydrate(s));
  }

  send(res, 404, "text/plain", "not found");
});

server.listen(PORT, () => console.log(`[exp] http://localhost:${PORT}  (/ 选 advisor 或 collab)`));

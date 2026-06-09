// ============================================================================
// engine.mjs —— 经验体 agentic mini-app 的【变体无关】引擎。
//
// 核心命题(来自 docs/重构-agentic-miniapp-经验体而非流水线.md):
//   mini-app = 被某人「经验」condition 的灵活 agent。
//   - 经验体(灵魂):一组 memory block(品味/守则/案例),creator 拥有、只读。
//   - 有环行为(执行壳):turn 链 + checkpoint;「手改/继续对话」= 指回更早节点的环。
//   - 自适应交互(外壳):stance 决定怎么暴露同一份经验(advisor/coach/collaborator/delegate)。
//
// 本文件【不含任何 GUI 分支】。同一个 engine 被 advisor.html 与 collab.html 复用,
// 差别只在:GUI 发不发 artifact-op、渲不渲可编辑产物。这就是「换皮实验」——
// 若同一 engine 能裸驱动两套 GUI,则证明 GUI↔Engine 边界真的解耦(目标1)。
//
// brain 可插拔:brain-pi(真·pi createAgent 流式)/ brain-mock(确定性脚本,供测试)。
// engine 只管:编译 systemPrompt、跑 turn、解析产物契约、合并/锁定产物、发事件。
// ============================================================================

// ── 权威事件集(复用,不发明新类型)。两套 GUI 都只消费它的子集。 ──
export const EVENTS = Object.freeze([
  "task.accepted",          // 收到,排队中(GUI 显示过渡)
  "task.progress",          // 流式 token / 正在按某条守则判断
  "task.output",            // 一段成型输出(advisor→答案气泡 / collaborator→填充产物单元)
  "task.completed",         // 本轮 commit:advisor→AnswerTurn checkpoint / collaborator→ArtifactRecord
  "task.failed",            // 友好失败态,保留半成品
  "task.cancelled",         // 中断;terminal-guard 防复活
  "task.needs_user_confirm",// 写操作/越界前的内联审批(本实验默认无副作用工具,占位)
]);

const STANCE_RULES = {
  advisor:
    "stance=advisor:只回答、只给判断,不产生任何副作用、不产出结构化产物。" +
    "把回答写成『像 ${owner} 会给的判断』,可被用户继续追问推翻。",
  coach:
    "stance=coach:陪用户一起把事做好。每做一个取舍都附上简短 rationale 和命中的 block," +
    "让用户学会『${owner} 是怎么判断的』。",
  collaborator:
    "stance=collaborator:用户给方向后你就动手做,产出一个结构化、可被用户手动编辑的产物。" +
    "严格尊重用户已锁定(locked)的单元——绝不覆盖它们;用户继续提要求或手改后," +
    "带着当前产物做增量调整,而不是推倒重来。",
  delegate:
    "stance=delegate:尽量少打扰用户,直接产出可交付的终稿,只在重大分叉处才确认。",
};

// ── 1. 由经验体编译 systemPrompt(纯函数)。 ──
// 关键不变量:换 stance 只改 [STANCE RULES] 段;[TASTE]/[GUARDRAILS]/[CASES] 逐字不变。
// → 同一份经验,四种 stance 复用。test-engine.mjs 对此做断言。
export function compileSystemPrompt(exp, stance = exp.stance) {
  const owner = exp.ownerName || "这位创作者";
  const tastes = exp.blocks.filter((b) => b.kind === "taste");
  const guards = exp.blocks.filter((b) => b.kind === "guardrail").sort((a, b) => (a.priority || 99) - (b.priority || 99));
  const cases = exp.blocks.filter((b) => b.kind === "case");

  const L = [];
  L.push(`[ROLE] 你以「${owner}」的判断力和品味来工作。你不是泛泛的 AI 助手,你复用的是这个人反复表现出来的【决策模式】,不是事实库。`);
  L.push("");
  L.push("[TASTE] 这个人的偏好/品味:");
  tastes.forEach((b) => L.push(`- (${b.id}) ${b.body}`));
  L.push("");
  L.push("[GUARDRAILS] 判断守则,按优先级从高到低;冲突时高优先级压过低优先级、也压过 taste:");
  guards.forEach((b) => L.push(`- (${b.id}, P${b.priority}) ${b.body}`));
  L.push("");
  L.push("[CASES] 过去的真实判断(情景→决定→为什么):");
  cases.forEach((b) => L.push(`- (${b.id}) 情景:${b.situation} 决定:${b.decision} 为什么:${b.why}`));
  L.push("");
  L.push("[STANCE RULES] " + STANCE_RULES[stance].replace(/\$\{owner\}/g, owner));
  L.push("");
  L.push(outputContract(exp, stance));
  return L.join("\n");
}

// 产物契约:要求模型在回答末尾追加一个 ```json fenced block。engine 据此解析结构 + 出处。
function outputContract(exp, stance) {
  const structured = stance === "collaborator" || stance === "delegate";
  if (!structured) {
    return [
      "[OUTPUT CONTRACT] 正常用自然语言回答。回答末尾【必须】追加一个 ```json 代码块,形如:",
      '```json',
      '{"citedBlockIds":["g1","taste1"],"confidence":0.0到1.0,"outOfScope":false}',
      "```",
      "citedBlockIds = 这次判断真正命中的 block id(只填上面列出的真实 id)。" +
      "若问题超出你的经验覆盖范围,outOfScope=true 并诚实说明这是外推。",
    ].join("\n");
  }
  const type = exp.expectedOutput?.type || "diagnostic_matrix";
  return [
    "[OUTPUT CONTRACT] 先用一两句话说你打算怎么做。然后末尾【必须】追加一个 ```json 代码块,产出 type=" + type + " 的结构化产物:",
    "```json",
    '{"artifact":{"type":"' + type + '","columns":[{"key":"opt_a","label":"选项A"},{"key":"opt_b","label":"选项B"}],' +
    '"rows":[{"key":"learning","label":"能学到什么","cells":[{"colKey":"opt_a","value":"...","citedBlockIds":["taste2"]},{"colKey":"opt_b","value":"...","citedBlockIds":[]}]}]}}',
    "```",
    "每个单元的 value 是你站在创作者立场给出的判断;citedBlockIds 填命中的真实 block id。" +
    "rows 是评估维度、columns 是被比较的选项(若任务不是比较型,可只用一列)。" +
    "单元的稳定地址 path = rowKey + '/' + colKey,后续用户可能手动锁定某个 path,届时你绝不能覆盖它。",
  ].join("\n");
}

// ── 2. 编译一轮的 prompt(systemPrompt 已带人格,这里只给本轮输入 + B 的产物上下文)。 ──
export function compilePrompts(exp, stance, turnInput, ctx = {}) {
  const displayPrompt = (turnInput || "").slice(0, 200); // 给 UI/audit 的摘要
  const parts = [turnInput || ""];
  if (ctx.artifactSnapshot) {
    parts.push("\n[CURRENT ARTIFACT] 这是当前产物快照(JSON),在它基础上增量调整:");
    parts.push("```json\n" + JSON.stringify(stripArtifactForPrompt(ctx.artifactSnapshot)) + "\n```");
  }
  if (ctx.editConstraint) {
    parts.push("\n[EDIT CONSTRAINT] " + ctx.editConstraint);
  }
  return { displayPrompt, runtimePrompt: parts.join("\n") };
}

function stripArtifactForPrompt(a) {
  // 只把模型需要的 path/value/locked 喂回去,别塞内部字段
  return {
    type: a.type,
    columns: a.columns,
    rows: a.rows.map((r) => ({
      key: r.key, label: r.label,
      cells: r.cells.map((c) => ({ colKey: c.colKey, value: c.value, locked: !!c.locked })),
    })),
  };
}

// ── 解析产物契约:抓回答末尾最后一个 ```json block。 ──
export function parseContract(text, stance) {
  const m = [...(text || "").matchAll(/```json\s*([\s\S]*?)```/g)];
  let parsed = null;
  if (m.length) { try { parsed = JSON.parse(m[m.length - 1][1].trim()); } catch { parsed = null; } }
  const prose = (text || "").replace(/```json[\s\S]*?```/g, "").trim();
  if (stance === "collaborator" || stance === "delegate") {
    return { prose, artifact: parsed?.artifact || null };
  }
  return { prose, meta: parsed || { citedBlockIds: [], confidence: null, outOfScope: false } };
}

// ── 产物地址/合并/锁定:B 的「手改回流 vs in-flight agent 输出」并发正确性面。 ──
export const cellPath = (rowKey, colKey) => `${rowKey}/${colKey}`;

function cloneArtifact(a) { return a ? JSON.parse(JSON.stringify(a)) : a; }

function findCell(art, path) {
  for (const r of art.rows) for (const c of r.cells) if ((c.path || cellPath(r.key, c.colKey)) === path) return { r, c };
  return null;
}

// 把 agent 产出的 artifact 合并进 session;【遇到 locked path 跳过】(last-writer-by-origin:user 赢)。
export function mergeAgentArtifact(session, incoming) {
  const warnings = [];
  if (!incoming) return { warnings: ["agent 未产出 artifact"] };
  if (!session.artifact) {
    // 首次:全量接收,标 origin=agent;但若某 path 已被预锁(理论上不会),仍尊重
    const a = cloneArtifact(incoming);
    a.rows = (a.rows || []).map((r) => ({
      key: r.key, label: r.label,
      cells: (r.cells || []).map((c) => ({
        colKey: c.colKey, value: c.value, citedBlockIds: c.citedBlockIds || [],
        path: cellPath(r.key, c.colKey), origin: "agent", locked: false,
      })),
    }));
    session.artifact = a;
  } else {
    const next = cloneArtifact(session.artifact);
    if (incoming.columns?.length) next.columns = incoming.columns;
    for (const ir of incoming.rows || []) {
      let nr = next.rows.find((r) => r.key === ir.key);
      if (!nr) { nr = { key: ir.key, label: ir.label, cells: [] }; next.rows.push(nr); }
      for (const ic of ir.cells || []) {
        const path = cellPath(ir.key, ic.colKey);
        if (session.locked.has(path)) { warnings.push(`跳过已锁定单元 ${path}(user 赢)`); continue; }
        let nc = nr.cells.find((c) => c.colKey === ic.colKey);
        if (!nc) { nc = { colKey: ic.colKey }; nr.cells.push(nc); }
        Object.assign(nc, { value: ic.value, citedBlockIds: ic.citedBlockIds || [], path, origin: "agent", locked: false });
      }
    }
    session.artifact = next;
  }
  session.version++;
  return { warnings };
}

// 用户手改回流:pin=只写不跑;continue=写+锁定+注入 EditConstraint+触发新 turn。
// 并发护栏:每个手改锁定它写的 path → 之后迟到的 agent 输出在 mergeAgentArtifact 里被跳过。
export function patchArtifact(session, baseVersion, ops, runTurnFn) {
  const next = cloneArtifact(session.artifact) || { type: session.exp.expectedOutput?.type || "diagnostic_matrix", columns: [], rows: [] };
  const constraints = [];
  let triggerContinue = false;
  const staleBase = baseVersion != null && baseVersion < session.version; // 仅用于告警,user 的 locked 永远赢

  for (const op of ops) {
    if (op.op === "delete") {
      const hit = findCell(next, op.path);
      if (hit) hit.r.cells = hit.r.cells.filter((c) => (c.path || cellPath(hit.r.key, c.colKey)) !== op.path);
      session.locked.delete(op.path);
      continue;
    }
    // set / reorder → 落到某个 cell
    let hit = findCell(next, op.path);
    if (!hit) {
      const [rowKey, colKey] = op.path.split("/");
      let nr = next.rows.find((r) => r.key === rowKey);
      if (!nr) { nr = { key: rowKey, label: rowKey, cells: [] }; next.rows.push(nr); }
      const nc = { colKey, path: op.path };
      nr.cells.push(nc); hit = { r: nr, c: nc };
    }
    Object.assign(hit.c, { value: op.value, origin: "user", locked: true, path: op.path });
    session.locked.add(op.path);
    if (op.intent === "continue") {
      triggerContinue = true;
      constraints.push(`用户已把单元 ${op.path} 改为「${op.value}」并锁定,请尊重它并据此调整其余【未锁定】单元。`);
    }
  }
  session.artifact = next;
  session.version++;
  const result = { version: session.version, triggered: triggerContinue, staleBase };
  if (triggerContinue && runTurnFn) {
    result.run = runTurnFn(session, "(用户手动改了产物并要求据此继续顺一遍)", {
      artifactSnapshot: next, editConstraint: constraints.join("\n"),
    });
  }
  return result;
}

// ── 3. Engine:管理 session,跑 turn,发事件。brain 注入(pi / mock)。 ──
let _sid = 0, _runId = 0;

export class Engine {
  constructor({ makeBrainSession }) { this.makeBrainSession = makeBrainSession; this.sessions = new Map(); }

  startSession(exp, stance = exp.stance) {
    const id = `s${++_sid}`;
    const sys = compileSystemPrompt(exp, stance);
    const session = {
      id, exp, stance, systemPrompt: sys,
      brain: this.makeBrainSession(sys, { stance, exp }),
      listeners: new Set(), turns: [], artifact: null, version: 0,
      locked: new Set(), runState: new Map(), // runId → 'running'|'done'|'cancelled'
      currentRunId: null,
    };
    this.sessions.set(id, session);
    return session;
  }

  get(id) { return this.sessions.get(id); }
  subscribe(session, fn) { session.listeners.add(fn); return () => session.listeners.delete(fn); }
  _emit(session, type, payload = {}) {
    if (!EVENTS.includes(type)) throw new Error(`非权威事件类型: ${type}`); // 不许发明新事件 → 守住边界
    const ev = { type, sessionId: session.id, ...payload };
    for (const fn of session.listeners) { try { fn(ev); } catch {} }
    return ev;
  }

  // 跑一轮。turnInput=本轮用户输入;ctx={artifactSnapshot, editConstraint}(B 用)。
  async runTurn(session, turnInput, ctx = {}) {
    const runId = `r${++_runId}`;
    session.currentRunId = runId;
    session.runState.set(runId, "running");
    const { displayPrompt, runtimePrompt } = compilePrompts(session.exp, session.stance, turnInput, ctx);
    this._emit(session, "task.accepted", { runId, displayPrompt });
    let buf = "";
    try {
      buf = await session.brain.turn(runtimePrompt, {
        onDelta: (d) => { if (session.runState.get(runId) === "cancelled") return; buf += d; this._emit(session, "task.progress", { runId, delta: d }); },
      });
    } catch (e) {
      session.runState.set(runId, "done");
      return this._emit(session, "task.failed", { runId, error: String(e?.message || e) });
    }
    // terminal-guard:本轮若已被取消,迟到的完成不得复活产物
    if (session.runState.get(runId) === "cancelled") {
      return this._emit(session, "task.cancelled", { runId });
    }
    const parsed = parseContract(buf, session.stance);
    this._emit(session, "task.output", { runId, messageId: runId, text: parsed.prose });

    if (session.stance === "collaborator" || session.stance === "delegate") {
      const { warnings } = mergeAgentArtifact(session, parsed.artifact);
      const turn = { runId, kind: "artifact", prose: parsed.prose, version: session.version };
      session.turns.push(turn);
      session.runState.set(runId, "done");
      return this._emit(session, "task.completed", {
        runId, kind: "artifact", prose: parsed.prose, artifact: session.artifact, version: session.version, warnings,
      });
    } else {
      const answerTurn = {
        runId, kind: "answer", text: parsed.prose,
        citedBlockIds: parsed.meta?.citedBlockIds || [],
        confidence: parsed.meta?.confidence ?? null,
        outOfScope: !!parsed.meta?.outOfScope,
      };
      session.turns.push(answerTurn);
      session.runState.set(runId, "done");
      return this._emit(session, "task.completed", { runId, kind: "answer", answerTurn });
    }
  }

  cancel(session) {
    const rid = session.currentRunId;
    if (rid && session.runState.get(rid) === "running") {
      session.runState.set(rid, "cancelled");
      try { session.brain.abort?.(); } catch {}
      return this._emit(session, "task.cancelled", { runId: rid });
    }
    return null;
  }

  // 手改回流(仅 B)。绑定 runTurn 以支持 continue 触发新 turn。
  patch(session, baseVersion, ops) {
    return patchArtifact(session, baseVersion, ops, (s, input, c) => this.runTurn(s, input, c));
  }

  // 只读再水合(刷新/重放)。
  rehydrate(session) {
    return { id: session.id, stance: session.stance, artifact: session.artifact, version: session.version, turns: session.turns };
  }
}

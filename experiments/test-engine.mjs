// ============================================================================
// test-engine.mjs —— 对【经验体引擎】的自动化验收。用 brain-mock(确定性,不烧钱)。
// 直接回答用户的两个目标:
//   目标1  GUI↔Engine 兼容性 → 「换皮实验」:同一份经验体 + 同一 engine,只换 stance,
//          能驱动 advisor / collaborator 两条路;两路只消费权威事件集;engine 无 GUI 分支。
//   目标2  交付/有环成立 → 产物合并、locked-by-origin 仲裁、terminal-guard、跨 session 隔离、
//          pin 不触发 / continue 触发并尊重锁定、有环回指。
// ============================================================================
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Engine, EVENTS, compileSystemPrompt, parseContract, cellPath } from "./engine.mjs";
import { makeBrainSession } from "./brain-mock.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const exp = JSON.parse(readFileSync(join(__dir, "fixtures/experience-career.json"), "utf8"));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log("  ✗ " + m); } };
const sect = (s) => console.log("\n" + s);

// 收集一个 session 的全部事件
function collect(engine, session) {
  const evs = [];
  engine.subscribe(session, (e) => evs.push(e));
  return evs;
}

// ── 目标1-a:经验体编译 —— 换 stance 只改 [STANCE RULES],TASTE/GUARDRAILS/CASES 逐字不变 ──
sect("● 经验体:同一份经验,四 stance 复用(只换 STANCE RULES 段)");
{
  const seg = (sys, tag) => sys.split("[" + tag + "]")[1].split("[")[0].trim();
  const sysA = compileSystemPrompt(exp, "advisor");
  const sysC = compileSystemPrompt(exp, "collaborator");
  ok(seg(sysA, "TASTE") === seg(sysC, "TASTE"), "TASTE 段应跨 stance 逐字相同");
  ok(seg(sysA, "GUARDRAILS") === seg(sysC, "GUARDRAILS"), "GUARDRAILS 段应跨 stance 逐字相同");
  ok(seg(sysA, "CASES") === seg(sysC, "CASES"), "CASES 段应跨 stance 逐字相同");
  ok(seg(sysA, "STANCE RULES") !== seg(sysC, "STANCE RULES"), "STANCE RULES 段应随 stance 改变");
  // 守则按优先级升序进 prompt
  ok(sysA.indexOf("(g1, P1)") < sysA.indexOf("(g2, P2)") && sysA.indexOf("(g2, P2)") < sysA.indexOf("(g3, P3)"), "守则应按 priority 升序");
}

// ── 目标1-b:换皮实验 —— 同一 engine 实例,裸驱动 advisor + collaborator ──
sect("● 换皮实验:同一 engine + 同一经验体,只换 stance 驱动两套 GUI 的后端");
{
  const engine = new Engine({ makeBrainSession });           // ← 唯一一个 engine,两 stance 共用
  const sA = engine.startSession(exp, "advisor");
  const sC = engine.startSession(exp, "collaborator");
  const evA = collect(engine, sA), evC = collect(engine, sC);

  await engine.runTurn(sA, "我手里 A、B 两个 offer,B 多 30%,怎么选?");
  await engine.runTurn(sC, "帮我把 A、B 两个 offer 摆出来对比一下");

  // 两路事件类型都必须是权威集子集(engine 不为某个 GUI 发明事件)
  const allTypes = [...evA, ...evC].map((e) => e.type);
  ok(allTypes.every((t) => EVENTS.includes(t)), "两路事件都应属权威集 EVENTS");
  // advisor 完成产 AnswerTurn(无 artifact);collaborator 完成产 artifact
  const doneA = evA.find((e) => e.type === "task.completed");
  const doneC = evC.find((e) => e.type === "task.completed");
  ok(doneA?.kind === "answer" && doneA.answerTurn && !doneA.artifact, "advisor 完成应产 AnswerTurn、无 artifact");
  ok(doneC?.kind === "artifact" && doneC.artifact?.rows?.length, "collaborator 完成应产结构化 artifact");
  // 证据可追溯:引用的 blockId 必须是真实存在的 block
  const ids = new Set(exp.blocks.map((b) => b.id));
  ok((doneA.answerTurn.citedBlockIds || []).every((i) => ids.has(i)), "advisor 引用的 blockId 应真实存在");
  const cellCites = doneC.artifact.rows.flatMap((r) => r.cells.flatMap((c) => c.citedBlockIds || []));
  ok(cellCites.length > 0 && cellCites.every((i) => ids.has(i)), "collaborator 单元引用的 blockId 应真实存在");
  // 两路走的是同一个 runTurn(代码层面无 stance×GUI 的二维分支:stance 决定产物形态,GUI 不进 engine)
  ok(typeof engine.runTurn === "function" && engine.sessions.size === 2, "同一 engine 同时持有两 stance 的 session");
}

// ── 目标2-a:产物合并 + locked-by-origin —— 迟到的 agent 输出不得覆盖 user 锁定单元 ──
sect("● 并发:user 手改并锁定后,迟到的 agent 输出不得覆盖(last-writer-by-origin)");
{
  const engine = new Engine({ makeBrainSession });
  const s = engine.startSession(exp, "collaborator");
  await engine.runTurn(s, "摆出 A、B 对比");                  // 首产 artifact,version=1
  const v0 = s.version;
  const path = cellPath("learning", "opt_a");
  // user 手改并 pin(锁定)这个单元
  engine.patch(s, v0, [{ path, op: "set", value: "我自己拍板:这格就这么定", intent: "pin" }]);
  const lockedVal = "我自己拍板:这格就这么定";
  // 模拟一个"基于旧版本"的 agent 产出,试图覆盖该 path
  const lateIncoming = {
    type: "diagnostic_matrix",
    columns: s.artifact.columns,
    rows: [{ key: "learning", label: "能学到什么", cells: [{ colKey: "opt_a", value: "agent 想覆盖的值", citedBlockIds: [] }] }],
  };
  const before = s.version;
  // 直接走 engine 的合并(等价于迟到 task.completed 落库)
  const { mergeAgentArtifact } = await import("./engine.mjs");
  const { warnings } = mergeAgentArtifact(s, lateIncoming);
  const cell = s.artifact.rows.find((r) => r.key === "learning").cells.find((c) => c.colKey === "opt_a");
  ok(cell.value === lockedVal, "锁定单元的值应保持 user 的,不被 agent 覆盖");
  ok(cell.origin === "user" && cell.locked, "锁定单元 origin 应为 user 且 locked");
  ok(warnings.some((w) => w.includes("跳过已锁定")), "应产生『跳过已锁定单元』告警");
  ok(s.version === before + 1, "版本号应单调递增");
}

// ── 目标2-b:terminal-guard —— 已取消的 run 迟到完成,不得复活产物 ──
sect("● terminal-guard:取消后迟到的完成不得复活产物");
{
  const engine = new Engine({ makeBrainSession });
  const s = engine.startSession(exp, "collaborator");
  const evs = collect(engine, s);
  // 用一个慢 brain 模拟:开跑→取消→才回包
  let release;
  s.brain = {
    async turn(_p, { onDelta }) {
      onDelta?.("正在想…");
      await new Promise((r) => (release = r));               // 卡住直到我们放行
      return '好了```json\n{"artifact":{"type":"diagnostic_matrix","columns":[],"rows":[{"key":"x","label":"x","cells":[{"colKey":"c","value":"迟到产物","citedBlockIds":[]}]}]}}\n```';
    },
    abort() {},
  };
  const p = engine.runTurn(s, "开始");
  engine.cancel(s);                                          // 跑到一半取消
  release();                                                 // brain 现在才回包
  await p;
  ok(s.artifact === null, "取消后迟到的完成不得写入产物(artifact 仍为 null)");
  ok(evs.some((e) => e.type === "task.cancelled"), "应发出 task.cancelled");
  ok(!evs.some((e) => e.type === "task.completed"), "取消的 run 不得发 task.completed");
}

// ── 目标2-c:跨 session 隔离 —— 改一个不影响另一个 ──
sect("● 跨 session 隔离:产物/锁定互不串");
{
  const engine = new Engine({ makeBrainSession });
  const s1 = engine.startSession(exp, "collaborator");
  const s2 = engine.startSession(exp, "collaborator");
  await engine.runTurn(s1, "摆 A/B");
  await engine.runTurn(s2, "摆 A/B");
  engine.patch(s1, s1.version, [{ path: cellPath("learning", "opt_a"), op: "set", value: "只改 s1", intent: "pin" }]);
  ok(s2.locked.size === 0, "s2 不应有任何锁定(隔离)");
  const s2cell = s2.artifact.rows.find((r) => r.key === "learning").cells.find((c) => c.colKey === "opt_a");
  ok(s2cell.value !== "只改 s1", "s2 的产物不应被 s1 的手改污染");
}

// ── 目标2-d:pin 不触发 run / continue 触发 run 且尊重锁定(有环) ──
sect("● 有环:pin 只写不跑;continue 写+锁定+触发新 turn 且尊重 locked");
{
  const engine = new Engine({ makeBrainSession });
  const s = engine.startSession(exp, "collaborator");
  await engine.runTurn(s, "摆 A/B");                          // version 1
  const evs = collect(engine, s);

  // pin:不应触发新 run(无新 task.accepted)
  const r1 = engine.patch(s, s.version, [{ path: cellPath("burnout", "opt_b"), op: "set", value: "我认定:直接淘汰", intent: "pin" }]);
  ok(r1.triggered === false, "pin 不应触发 run");
  ok(!evs.some((e) => e.type === "task.accepted"), "pin 后不应有 task.accepted");

  // continue:应触发新 run,且新一轮里锁定单元保持 user 值
  const lockedPath = cellPath("learning", "opt_a");
  const r2 = engine.patch(s, s.version, [{ path: lockedPath, op: "set", value: "锁死这格", intent: "continue" }]);
  ok(r2.triggered === true, "continue 应触发 run");
  await r2.run;                                              // 等新 turn 跑完
  ok(evs.some((e) => e.type === "task.accepted"), "continue 后应有 task.accepted");
  const lockedCell = s.artifact.rows.find((r) => r.key === "learning").cells.find((c) => c.colKey === "opt_a");
  ok(lockedCell.value === "锁死这格" && lockedCell.locked, "continue 重跑后,锁定单元仍是 user 的值");
  // 未锁定单元应被 agent 增量调整过(mock 会加后缀)
  const freeCell = s.artifact.rows.find((r) => r.key === "cash").cells.find((c) => c.colKey === "opt_a");
  ok(/调整/.test(freeCell.value), "未锁定单元应被 agent 增量调整");
}

// ── 契约解析鲁棒性 ──
sect("● 契约解析:能从带散文+代码块的文本里抽出结构与出处");
{
  const a = parseContract('判断是这样。\n```json\n{"citedBlockIds":["g1"],"confidence":0.5}\n```', "advisor");
  ok(a.prose === "判断是这样。" && a.meta.citedBlockIds[0] === "g1", "advisor 契约解析");
  const c = parseContract('做了表。\n```json\n{"artifact":{"type":"diagnostic_matrix","columns":[],"rows":[]}}\n```', "collaborator");
  ok(c.prose === "做了表。" && c.artifact.type === "diagnostic_matrix", "collaborator 契约解析");
  const bad = parseContract("没有 json", "advisor");
  ok(bad.meta && Array.isArray(bad.meta.citedBlockIds), "无 json 时 advisor 应安全降级");
}

// ── 总结 ──
console.log(`\n${fail === 0 ? "✅" : "❌"} engine 验收:${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);

// brain-pi —— 真·brain,用 pi-agent-core 的常驻 Agent(跨轮保留对话历史)+ 流式 token。
// 契约同 brain-mock:makeBrainSession(systemPrompt,{stance,exp}) → { turn(prompt,{onDelta}) → fullText, abort() }。
// 跨轮历史由 Agent 自己维护:每 session 一个 agent,systemPrompt 固定,turn 只发本轮输入。
import { createAgent } from "../pi-exec.mjs";

const MODEL = process.env.EXP_MODEL || process.env.MODEL || "deepseek/deepseek-chat";

export function makeBrainSession(systemPrompt) {
  const agent = createAgent({ systemPrompt, tools: [], model: MODEL });
  return {
    async turn(prompt, { onDelta } = {}) {
      let buf = "";
      const unsub = agent.subscribe((ev) => {
        if (ev.type === "message_update" && ev.assistantMessageEvent?.type === "text_delta") {
          const d = ev.assistantMessageEvent.delta || "";
          buf += d; onDelta?.(d);
        }
      });
      try { await agent.prompt(prompt); } finally { try { unsub?.(); } catch {} }
      return buf;
    },
    abort() { try { agent.abort(); } catch {} },
  };
}

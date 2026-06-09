// brain-mock —— 确定性脚本 brain,供 test-engine.mjs 跑通流程而不烧钱/不靠网络。
// 契约和 brain-pi 完全一致:makeBrainSession(systemPrompt,{stance,exp}) → { turn(prompt,{onDelta}) → fullText }。
// engine 负责解析 fullText 里的 ```json 契约,brain 只产文本。
// 它会读 systemPrompt/prompt 里的线索,产出合规的 advisor 答案 或 collaborator 产物。

function chunked(text, onDelta) {
  // 模拟流式:按句子切片回吐
  const parts = text.split(/(?<=[。;\n])/);
  for (const p of parts) onDelta?.(p);
  return text;
}

export function makeBrainSession(systemPrompt, { stance } = {}) {
  let turnNo = 0;
  return {
    async turn(prompt, { onDelta } = {}) {
      turnNo++;
      const structured = stance === "collaborator" || stance === "delegate";
      if (!structured) {
        // advisor:给一段判断 + 契约 json
        const body =
          `就你这个情况,我会先看会不会让你 6 个月内倦怠(这条压一切)。` +
          `钱多 30% 不是不重要,但三年后你还想不想干这件事更重要。\n`;
        const json = `\`\`\`json\n${JSON.stringify({ citedBlockIds: ["g1", "taste1"], confidence: 0.7, outOfScope: false })}\n\`\`\``;
        return chunked(body + json, onDelta);
      }
      // collaborator:若 prompt 带 [CURRENT ARTIFACT],就增量调整(尊重 locked);否则首产
      const cur = extractCurrentArtifact(prompt);
      let artifact;
      if (cur) {
        // 增量:把所有【未锁定】单元的 value 追加一个"(已据你的要求调整)",locked 的原样
        artifact = {
          type: cur.type, columns: cur.columns,
          rows: cur.rows.map((r) => ({
            key: r.key, label: r.label,
            cells: r.cells.map((c) =>
              c.locked
                ? { colKey: c.colKey, value: c.value, citedBlockIds: [] }            // 锁定:agent 不该动(且 engine 会兜底跳过)
                : { colKey: c.colKey, value: (c.value || "") + "(已据你的要求调整)", citedBlockIds: ["g2"] }
            ),
          })),
        };
      } else {
        artifact = {
          type: "diagnostic_matrix",
          columns: [{ key: "opt_a", label: "选项A" }, { key: "opt_b", label: "选项B(多30%)" }],
          rows: [
            { key: "learning", label: "能学到什么", cells: [
              { colKey: "opt_a", value: "有高人带,能学稀缺能力", citedBlockIds: ["taste2"] },
              { colKey: "opt_b", value: "钱多但偏消耗战", citedBlockIds: ["taste2"] }] },
            { key: "burnout", label: "倦怠风险", cells: [
              { colKey: "opt_a", value: "低", citedBlockIds: ["g1"] },
              { colKey: "opt_b", value: "高(6个月内可能倦怠→一票否决)", citedBlockIds: ["g1"] }] },
            { key: "cash", label: "现金流", cells: [
              { colKey: "opt_a", value: "够用", citedBlockIds: ["g2"] },
              { colKey: "opt_b", value: "更宽裕", citedBlockIds: ["g2"] }] },
          ],
        };
      }
      const prose = "我按你一贯的优先级(倦怠一票否决 > 学习曲线 > 钱)做了张对比矩阵:\n";
      const json = `\`\`\`json\n${JSON.stringify({ artifact })}\n\`\`\``;
      return chunked(prose + json, onDelta);
    },
    abort() {},
  };
}

function extractCurrentArtifact(prompt) {
  const m = prompt.match(/\[CURRENT ARTIFACT\][\s\S]*?```json\s*([\s\S]*?)```/);
  if (!m) return null;
  try { return JSON.parse(m[1].trim()); } catch { return null; }
}

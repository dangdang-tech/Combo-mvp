// 系统提示词编排：把能力包契约揉成一份注入 pi 的 systemPrompt。
//   = 作者写的 instructions（逐字）+ 平台补的运行约定（inputs/output/boundaries）+ Artifact 产物协议。
//   契约文档「第一版先把 inputs/output/boundaries 一并写进提示词让模型遵守」即此。
import type { ArtifactKind, OutputType, SkillPackageRuntimeView } from '@cb/shared';

/** output.type → 推荐 artifact 形态。 */
function recommendedKind(outputType: OutputType): ArtifactKind {
  switch (outputType) {
    case 'text':
      return 'markdown';
    case 'structured':
    case 'score':
    case 'checklist':
      return 'structured';
    default:
      return 'markdown';
  }
}

/** output.type → 产出形态人话指引。 */
function outputGuidance(outputType: OutputType): string {
  switch (outputType) {
    case 'text':
      return '一篇成文的文本成品（报告 / 文章 / 文案）。';
    case 'structured':
      return '一份字段清晰的结构化文档。';
    case 'score':
      return '一份评估打分（给出分数 + 逐项依据）。';
    case 'checklist':
      return '一份核查清单（逐条 + 是否通过 / 状态）。';
    default:
      return '一份成品。';
  }
}

function inputsBlock(view: SkillPackageRuntimeView): string {
  const fields = view.inputs.fields;
  if (fields.length === 0) return '本能力无预设结构化输入，按用户自然语言诉求工作。';
  return fields
    .map((f) => `- ${f.label}（${f.key}，${f.type}${f.required ? '，必填' : ''}）`)
    .join('\n');
}

function boundariesBlock(view: SkillPackageRuntimeView): string {
  const { riskLevel, redLines } = view.boundaries;
  const lines = redLines.length > 0 ? redLines.map((r) => `- ${r}`).join('\n') : '- （无显式红线）';
  return `风险级别：${riskLevel}\n红线（越过即拒答并简要说明原因）：\n${lines}`;
}

/** 产物协议：约束模型「成品进 artifact、正文只放说明」，并按 output.type 选 kind。 */
function artifactProtocol(view: SkillPackageRuntimeView): string {
  const kind = recommendedKind(view.output.type);
  return [
    '# 产物（Artifact）协议 —— 必须遵守',
    '当你要产出「可独立留存、用户会保存/复用/反复查看」的成品（一篇文档、一个网页、一段代码、一份结构化报告/清单/评分）时，',
    '必须调用 upsert_artifact 工具把成品写成 artifact，而不是把成品全文堆进聊天正文。',
    '',
    '- 聊天正文只放：简短说明、思路、给用户的提示与追问；成品本体进 artifact。',
    '- artifactKey：同一份成品反复修改时复用同一个 key（产生新版本，类似版本演进）；不同成品用不同 key。常用 "main"。',
    '- kind 选择：',
    '  - html：可交互/可视化网页，会被放进【沙箱 iframe】预览。必须产出【完整自包含 HTML 文档】',
    '    （含 <!doctype html>、<html>、内联 <style>/<script>）；可用公共 CDN，禁止外链需要鉴权的私有资源。',
    '  - markdown：富文本文档（报告/文章/说明）。',
    '  - code：单文件代码产物（用 language 标注语言，如 ts/python/sql）。',
    '  - structured：结构化数据产物（评分卡/清单/字段表），content 用 JSON 字符串。',
    `- 本能力 output.type=${view.output.type} → 优先用 kind=${kind}。`,
    '- 产出后用一两句话说明你做了什么、可以怎么用，并主动邀请用户继续迭代；不要在正文重复 artifact 全文。',
  ].join('\n');
}

/** 编排完整 systemPrompt。 */
export function composeSystemPrompt(view: SkillPackageRuntimeView): string {
  return [
    view.instructions.trim(),
    '',
    '———',
    '以下为平台注入的运行约定（请严格遵守）：',
    '',
    `# 这个能力`,
    `名称：${view.name}`,
    `简介：${view.tagline}`,
    '',
    '# 用户会提供的输入',
    inputsBlock(view),
    '（若用户首条消息附带了结构化输入，已并入其消息正文。）',
    '',
    '# 期望产出',
    outputGuidance(view.output.type),
    '',
    '# 边界',
    boundariesBlock(view),
    '',
    artifactProtocol(view),
  ].join('\n');
}

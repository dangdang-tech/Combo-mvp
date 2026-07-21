import type { ComboElementSelection } from '../components/ArtifactRenderer.js';

const CONTEXT_PREFIX = '请只围绕当前选中的页面元素「';
const CONTEXT_SUFFIX = '」进行修改。';
const PRESERVE_INSTRUCTION =
  '保留其它区域的内容结构与真实运行行为，并继续保留所有稳定的 data-combo-key。';

export function buildContextualStudioPrompt(
  element: ComboElementSelection,
  instruction: string,
): string {
  return [
    `${CONTEXT_PREFIX}${element.label}${CONTEXT_SUFFIX}`,
    `定位键是 data-combo-key="${element.key}"。`,
    instruction.trim(),
    PRESERVE_INSTRUCTION,
  ].join('\n');
}

/** Keep the locator protocol in model context without exposing it in the creator conversation. */
export function formatStudioAnnotationMessage(value: string): string {
  const lines = value.split('\n');
  const firstLine = lines[0] ?? '';
  if (
    !firstLine.startsWith(CONTEXT_PREFIX) ||
    !firstLine.endsWith(CONTEXT_SUFFIX) ||
    !lines[1]?.startsWith('定位键是 data-combo-key=') ||
    lines.at(-1) !== PRESERVE_INSTRUCTION
  ) {
    return value;
  }

  const label = firstLine.slice(CONTEXT_PREFIX.length, -CONTEXT_SUFFIX.length).trim();
  const instruction = lines.slice(2, -1).join('\n').trim();
  if (!label || !instruction) return value;
  return `标注「${label}」\n${instruction}`;
}

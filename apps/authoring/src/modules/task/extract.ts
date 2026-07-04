// LLM 提取：把切好的去敏段落分批喂 LLM 网关，归纳出结构化能力列表（name/summary/kind/instructions）。
//   - 上游降级/坏输出/无 key：落到确定性兜底（按段落标题生成占位能力），保证链路可跑、不裸抛。
//   - 每次 LLM 调用记 audit_llm_calls（经注入的 LlmAuditSink，归属 task_id）。
import type { LlmGatewayPort } from '@cb/shared';
import type { LlmAuditSink } from '../../platform/infra/llm/types.js';
import {
  firstNonEmptyLine,
  isBlockedCapabilityLabel,
  stripRolePrefix,
} from '../../platform/text/session-noise.js';

/** 提取输入段（去敏后正文）。 */
export interface ExtractSegment {
  title: string;
  content: string;
  project?: string;
  messageCount: number;
}

/** 提取产出（未落库的能力草稿；写 MinIO/insert 由 pipeline 负责）。 */
export interface CapabilityDraft {
  name: string;
  summary: string;
  kind: string;
  instructions: string;
  meta: Record<string, unknown>;
}

export interface ExtractDeps {
  llm: LlmGatewayPort;
  audit: LlmAuditSink;
  /** 审计记账用的模型名（网关内部已定，这里只为落库可读）。 */
  model?: string;
}

export interface ExtractInput {
  taskId: string;
  ownerUserId: string;
  traceId: string;
  segments: ExtractSegment[];
  /** 每归纳完一批回调一次，报已处理段数/总段数（pipeline 据此推进度）。 */
  onBatchDone?: (segmentsDone: number, segmentsTotal: number) => Promise<void>;
}

export interface ExtractOutput {
  items: CapabilityDraft[];
  /** 任一批走了兜底（上游降级/坏输出）。 */
  degraded: boolean;
}

/** 每批喂给 LLM 的段数（控制单次 prompt 体量）。 */
const BATCH_SIZE = 8;
/** 单段正文喂给 LLM 的截断长度。 */
const SEGMENT_SAMPLE_CHARS = 1500;
/** 全任务能力项上限（防 LLM 发散刷屏）。 */
const MAX_CAPABILITIES = 12;

/**
 * 提取主入口：分批归纳 → 跨批按名去重合并 → 空结果落兜底。
 * 不抛上游错误：网关异常按该批降级处理（部分批成功仍产出）。
 */
export async function extractCapabilities(
  deps: ExtractDeps,
  input: ExtractInput,
): Promise<ExtractOutput> {
  const batches: ExtractSegment[][] = [];
  for (let i = 0; i < input.segments.length; i += BATCH_SIZE) {
    batches.push(input.segments.slice(i, i + BATCH_SIZE));
  }

  const merged: CapabilityDraft[] = [];
  const seenNames = new Set<string>();
  let degraded = false;

  for (let i = 0; i < batches.length; i += 1) {
    const drafts = await extractBatch(deps, input, batches[i]!);
    if (drafts === null) degraded = true;
    for (const d of drafts ?? []) {
      const nameKey = d.name.replace(/\s+/g, '').toLowerCase();
      if (seenNames.has(nameKey)) continue;
      seenNames.add(nameKey);
      if (merged.length < MAX_CAPABILITIES) merged.push(d);
    }
    const segmentsDone = Math.min((i + 1) * BATCH_SIZE, input.segments.length);
    await input.onBatchDone?.(segmentsDone, input.segments.length);
  }

  if (merged.length === 0) {
    // 全部批降级/空产出：确定性兜底，保证任务有可试用的产物、链路可跑。
    return { items: buildFallbackCapabilities(input.segments), degraded: true };
  }
  return { items: merged, degraded };
}

/** 归纳一批段落。返回 null 表示本批降级（上游不稳/坏输出），调用方计 degraded。 */
async function extractBatch(
  deps: ExtractDeps,
  input: ExtractInput,
  segments: ExtractSegment[],
): Promise<CapabilityDraft[] | null> {
  const prompt = buildPrompt(segments);
  let result;
  try {
    result = await deps.llm.complete(prompt, {
      taskClass: 'extract',
      traceId: input.traceId,
      ownerUserId: input.ownerUserId,
    });
  } catch {
    return null; // 网关异常 escape：本批降级，不阻塞其余批。
  }

  await recordAudit(deps, input, result.usage, result.degraded);
  if (result.degraded || !result.text) return null;

  const parsed = parseCapabilityJson(result.text);
  if (!parsed || parsed.length === 0) return null;
  return parsed;
}

function buildPrompt(segments: ExtractSegment[]): string {
  const body = segments
    .map((s, i) => {
      const head = `【段 ${i + 1}】标题：${s.title}${s.project ? `（项目：${s.project}）` : ''}`;
      return `${head}\n${s.content.slice(0, SEGMENT_SAMPLE_CHARS)}`;
    })
    .join('\n\n');
  return (
    `下面是一位用户与 coding agent 的若干段去敏工作会话。请从中归纳出可复用的「能力项」——` +
    `每个能力项是一类可以反复交给 AI 执行的工作流（不是复述单次会话）。\n` +
    `每个能力项输出四个字段：\n` +
    `  name：中文能力名，≤12 字，像一个 mini 应用的名字；\n` +
    `  summary：一句话说明这个能力帮用户完成什么；\n` +
    `  kind：能力类型，从「写作 / 编码 / 分析 / 结构化文档 / 工作流」中选一个；\n` +
    `  instructions：给执行这个能力的 AI 的系统提示词（怎么干活的完整知识，含步骤与输出要求），200-800 字。\n` +
    `只归纳确有支撑的能力，最多 4 个；没有可归纳的就输出空数组。\n` +
    `严格输出 JSON 数组：[{"name":"...","summary":"...","kind":"...","instructions":"..."}]，不要其它内容。\n\n` +
    body
  );
}

/** 容错解析 LLM 输出的能力数组（提取首个 [...]；坏 JSON / 坏条目 → 丢弃）。 */
function parseCapabilityJson(text: string): CapabilityDraft[] | null {
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) return null;
  let arr: unknown;
  try {
    arr = JSON.parse(m[0]);
  } catch {
    return null;
  }
  if (!Array.isArray(arr)) return null;
  const out: CapabilityDraft[] = [];
  for (const item of arr) {
    if (typeof item !== 'object' || item === null) continue;
    const o = item as Record<string, unknown>;
    const name = typeof o.name === 'string' ? o.name.trim().slice(0, 24) : '';
    const instructions = typeof o.instructions === 'string' ? o.instructions.trim() : '';
    if (!name || !instructions || isBlockedCapabilityLabel(name)) continue;
    out.push({
      name,
      summary: typeof o.summary === 'string' ? o.summary.trim().slice(0, 200) : '',
      kind: typeof o.kind === 'string' ? o.kind.trim().slice(0, 20) : '工作流',
      instructions,
      meta: { origin: 'llm' },
    });
  }
  return out;
}

/**
 * 确定性兜底：无 LLM key / 全批降级时，按段落主题生成占位能力（每段一个，取消息最多的前几段），
 * instructions 用模板 + 段落节选拼出，保证链路可跑、可试用。
 */
export function buildFallbackCapabilities(segments: ExtractSegment[]): CapabilityDraft[] {
  const picked = [...segments]
    .filter((s) => {
      const title = stripRolePrefix(firstNonEmptyLine(s.title));
      return title.length > 0 && !isBlockedCapabilityLabel(title);
    })
    .sort((a, b) => b.messageCount - a.messageCount)
    .slice(0, 3);

  return picked.map((s) => {
    const title = stripRolePrefix(firstNonEmptyLine(s.title)).slice(0, 24);
    return {
      name: title,
      summary: `从会话「${title}」提炼的能力（模型服务不可用时的占位归纳）`,
      kind: '工作流',
      instructions:
        `你是执行「${title}」这类工作的助手。参考下面这段真实工作记录的做法，` +
        `按同样的思路完成用户交给你的同类任务，先澄清目标，再分步执行，最后给出结果核对清单。\n\n` +
        `参考记录（已去敏，节选）：\n${s.content.slice(0, 2000)}`,
      meta: { origin: 'fallback' },
    };
  });
}

async function recordAudit(
  deps: ExtractDeps,
  input: ExtractInput,
  usage: { promptTokens: number; completionTokens: number; costMicros: number },
  degraded: boolean,
): Promise<void> {
  try {
    await deps.audit.record({
      ownerUserId: input.ownerUserId,
      taskId: input.taskId,
      taskClass: 'extract',
      model: deps.model ?? '',
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      costMicros: usage.costMicros,
      degraded,
      retries: 0,
      traceId: input.traceId,
    });
  } catch {
    // 审计失败不阻塞提取（非计费真源）。
  }
}

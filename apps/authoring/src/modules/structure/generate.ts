// 40 · 软字段流式生成（B-25，40-step3-4-structure §3.2/§3.3/§3.4）。经 3A LLM 网关流式生成软字段。
//   - 单值字段（name/tagline/role/goal/instructions）：流 deltaText → 累积成终值（field_start/field_delta/field_done）。
//   - 数组字段（skill_set/starter_prompts）：逐项浮现（item-appended，一条条补；§3.2 验收-24/贯穿-07）。
//   - degraded（无 key / 上游不稳，§10）：用确定性兜底文案（直读 candidate_evidence/session_segments 派生），不裸转圈、不裸 502。
//   - 单字段重试 ≤2（脊柱 §3.1 LLM_MAX_RETRIES）：两次仍真抛 → 调用方落字段级错误态（§3.4，不在此抛人话信封）。
// 本模块只产「字段值 + 是否 degraded」，不写库、不发 SSE 帧（帧/落库由 handler 编排，关注点分离）。
import { LLM_MAX_RETRIES, type LlmGatewayPort, type SoftFieldKey } from '@cb/shared';
import type { StructureEvidence } from './repo.js';

/** 单软字段生成结果（值 + degraded 标；数组字段 value 为 string[]）。 */
export interface FieldGenResult {
  value: string | string[];
  degraded: boolean;
}

/** 生成上下文：直读的证据（candidate_evidence/session_segments 派生，不依赖 ExperiencePack，§4.C）。 */
export interface GenContext {
  /** 已生成的软字段（供后字段参考，如 instructions 参考 name/role；逐字段顺序生成时累积）。 */
  generated: Partial<Record<SoftFieldKey, string | string[]>>;
  evidence: StructureEvidence;
  traceId: string;
  ownerUserId?: string;
}

/** 数组字段默认目标条数（逐条浮现 N 条；确定性兜底也产 N 条骨架）。 */
const ARRAY_TARGET = 4;

/**
 * 流式生成一个【单值】软字段。回调 onDelta 推 field_delta（边生成边显示，永不裸转圈）。
 *   - gateway.stream 正常 → 累积 deltaText，每片回调 onDelta；空输出 → 兜底（degraded）。
 *   - 真抛 → 上抛（调用方据重试次数决定再试 / 落错误态，§3.4）。本函数不吞真抛、不在此重试。
 */
export async function streamScalarField(
  gateway: LlmGatewayPort,
  field: Exclude<SoftFieldKey, 'skill_set' | 'starter_prompts'>,
  ctx: GenContext,
  onDelta: (deltaText: string) => Promise<void>,
): Promise<FieldGenResult> {
  const prompt = scalarPrompt(field, ctx);
  let acc = '';
  for await (const chunk of gateway.stream(prompt, {
    taskClass: 'structure_field',
    traceId: ctx.traceId,
    stream: true,
    ...(ctx.ownerUserId ? { ownerUserId: ctx.ownerUserId } : {}),
  })) {
    if (!chunk.deltaText) continue;
    acc += chunk.deltaText;
    await onDelta(chunk.deltaText);
  }
  const value = acc.trim();
  if (value.length === 0) {
    // 空输出（网关 degraded 无内容）→ 确定性兜底（不裸转圈、不裸空）。
    const fallback = scalarFallback(field, ctx);
    await onDelta(fallback);
    return { value: fallback, degraded: true };
  }
  return { value: trimScalar(field, value), degraded: false };
}

/**
 * 逐项生成一个【数组】软字段。回调 onItem 推 item-appended（一条条补，§3.2 验收-24）。
 *   - 经 complete（taskClass='structure_field'）一次出多条，逐条回调 onItem（边生成边显示）。
 *   - degraded / 解析空 → 确定性兜底骨架（从证据派生 N 条），逐条 onItem。
 *   - 真抛 → 上抛（调用方据重试决定再试 / 落错误态）。
 */
export async function generateArrayField(
  gateway: LlmGatewayPort,
  field: 'skill_set' | 'starter_prompts',
  ctx: GenContext,
  onItem: (itemIndex: number, value: string) => Promise<void>,
): Promise<FieldGenResult> {
  const prompt = arrayPrompt(field, ctx);
  const res = await gateway.complete(prompt, {
    taskClass: 'structure_field',
    traceId: ctx.traceId,
    ...(ctx.ownerUserId ? { ownerUserId: ctx.ownerUserId } : {}),
  });
  let items: string[];
  let degraded: boolean;
  if (res.degraded || !res.text) {
    items = arrayFallback(field, ctx);
    degraded = true;
  } else {
    const parsed = parseArray(res.text);
    if (parsed.length === 0) {
      items = arrayFallback(field, ctx);
      degraded = true;
    } else {
      items = parsed.slice(0, 8).map((s) => s.slice(0, 120));
      degraded = false;
    }
  }
  for (let i = 0; i < items.length; i++) {
    await onItem(i, items[i]!);
  }
  return { value: items, degraded };
}

/**
 * 带重试的单字段生成（脊柱 §3.1 LLM_MAX_RETRIES=2，§3.4）。返回成功结果或 'failed'（含累计 attempts + 是否终态）。
 *   失败预算是【跨调用累计】的（§3.4「结构化 Job 内部重试 ≤2，或用户经端点 F regen 累计」）：
 *     - attemptsBefore = 该字段此前已累计的失败次数（端点 F 重生成跨调用累计）；本轮从它起算。
 *     - maxAttemptsThisRound = 本轮（本 job/本次 regen 点击）最多再试几次（full 自动结构化 = LLM_MAX_RETRIES 内部重试；
 *       端点 F 单字段 regen = 1，即「每次点重生成 = 一次用户驱动的尝试」，连点累计而非每次全新预算）。
 *     - 累计 attempts 恒夹在 [0, LLM_MAX_RETRIES]（不溢出；attemptsBefore 已达上限则本轮一次失败即终态）。
 *   返回：
 *     - { kind:'ok', result }：成功（本轮某次试成功；degraded 不算失败，§10 用兜底、不裸 502）。
 *     - { kind:'failed', attempts, terminal }：本轮预算用尽仍真抛。terminal = 累计 attempts ≥ LLM_MAX_RETRIES
 *       （= §3.4「同处重试两次仍失败」→ 调用方落字段级错误态）；terminal=false = 仅累计未达上限（持久化 attempts，
 *       用户可再 regen 继续累计，尚未落错误态）。
 *   注意：重试会重发 field_start/field_delta（前端按 field 覆盖渲染，已生成的【其它】字段不受影响）。
 */
export async function generateFieldWithRetry(
  gateway: LlmGatewayPort,
  field: SoftFieldKey,
  ctx: GenContext,
  hooks: {
    onAttemptStart: (attemptNo: number) => Promise<void>;
    onScalarDelta: (deltaText: string) => Promise<void>;
    onArrayItem: (itemIndex: number, value: string) => Promise<void>;
  },
  attemptsBefore = 0,
  maxAttemptsThisRound = LLM_MAX_RETRIES,
): Promise<
  { kind: 'ok'; result: FieldGenResult } | { kind: 'failed'; attempts: number; terminal: boolean }
> {
  // 累计起点夹在 [0, LLM_MAX_RETRIES]（attemptsBefore 越界/已达上限的防御，避免溢出，修 off-by-one）。
  let attempts = Math.max(0, Math.min(attemptsBefore, LLM_MAX_RETRIES));
  // 本轮可用预算 = min(本轮上限, 剩余总预算)；至少 1（attemptsBefore 已达上限时本轮一次失败即终态）。
  const roundBudget = Math.max(1, Math.min(maxAttemptsThisRound, LLM_MAX_RETRIES - attempts || 1));
  let triedThisRound = 0;
  for (;;) {
    const attemptNo = attempts + 1;
    await hooks.onAttemptStart(attemptNo);
    try {
      const result = isArray(field)
        ? await generateArrayField(gateway, field, ctx, hooks.onArrayItem)
        : await streamScalarField(gateway, field, ctx, hooks.onScalarDelta);
      return { kind: 'ok', result };
    } catch {
      attempts = Math.min(attempts + 1, LLM_MAX_RETRIES); // 累计 +1，夹上限（不溢出）。
      triedThisRound += 1;
      const terminal = attempts >= LLM_MAX_RETRIES; // 累计达上限 → §3.4 错误态。
      if (terminal || triedThisRound >= roundBudget) {
        // 本轮预算用尽（或已终态）→ 返回累计 attempts + 是否终态（非终态仅持久化，用户可再 regen 累计）。
        return { kind: 'failed', attempts, terminal };
      }
      // 本轮预算未尽且未终态：继续重试（重发 onAttemptStart → 前端重置该字段加载条，已生成其它字段不动）。
    }
  }
}

function isArray(field: SoftFieldKey): field is 'skill_set' | 'starter_prompts' {
  return field === 'skill_set' || field === 'starter_prompts';
}

// ===========================================================================
// prompts（直读证据派生；去敏段已抹隐私，本模块只用作生成上下文）
// ===========================================================================

function evidenceBlurb(ctx: GenContext): string {
  const segs = ctx.evidence.segments
    .slice(0, 4)
    .map((s, i) => `${i + 1}. ${(s.title ?? '').slice(0, 40)}：${s.content.slice(0, 160)}`)
    .join('\n');
  const known = Object.entries(ctx.generated)
    .filter(([, v]) => (Array.isArray(v) ? v.length > 0 : Boolean(v)))
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join('、') : v}`)
    .join('\n');
  return `${known ? `已知信息：\n${known}\n\n` : ''}支撑会话片段：\n${segs}`;
}

const SCALAR_INSTRUCTION: Record<Exclude<SoftFieldKey, 'skill_set' | 'starter_prompts'>, string> = {
  name: '给这个可复用能力起一个简短中文名称（≤12字），只输出名称本身。',
  tagline: '用一句话写出这个能力的卖点/定位（≤30字），只输出这句话。',
  role: '一句话描述这个能力扮演的角色（如「资深产品经理」）。',
  goal: '一句话描述这个能力要为使用者达成的目标。',
  instructions:
    '写出这个能力的系统指令（工作步骤），可分步；需要使用者填的内容用 {{key|人话提示}} 占位（如 {{product_idea|你想做的产品一句话}}）。',
};

function scalarPrompt(
  field: Exclude<SoftFieldKey, 'skill_set' | 'starter_prompts'>,
  ctx: GenContext,
): string {
  return `${SCALAR_INSTRUCTION[field]}\n\n${evidenceBlurb(ctx)}`;
}

function arrayPrompt(field: 'skill_set' | 'starter_prompts', ctx: GenContext): string {
  const what =
    field === 'skill_set'
      ? `列出这个能力的 ${ARRAY_TARGET} 项拿手本事（技能集），每条一句话。`
      : `给消费者写 ${ARRAY_TARGET} 条起手示例提示（starter prompts），每条一句话。`;
  return `${what}\n严格输出 JSON 字符串数组：["...","..."]，不要其它内容。\n\n${evidenceBlurb(ctx)}`;
}

// ===========================================================================
// 确定性兜底（degraded / 空输出时，从证据派生，绝不裸空/裸转圈，§10）
// ===========================================================================

/** 证据派生的兜底主题词（项目名优先，否则首段标题）。 */
function evidenceTopic(ctx: GenContext): string {
  const withProj = ctx.evidence.segments.find((s) => s.project && s.project.trim());
  if (withProj?.project) return withProj.project.trim();
  const titled = ctx.evidence.segments.find((s) => s.title && s.title.trim());
  return titled?.title?.trim() ?? '这类工作流';
}

function scalarFallback(
  field: Exclude<SoftFieldKey, 'skill_set' | 'starter_prompts'>,
  ctx: GenContext,
): string {
  const topic = evidenceTopic(ctx);
  switch (field) {
    case 'name':
      return topic.slice(0, 12) || '未命名能力';
    case 'tagline':
      return `把「${topic}」这类反复出现的工作流打包成可复用能力`;
    case 'role':
      return `${topic}领域的得力助手`;
    case 'goal':
      return `帮助使用者高效完成「${topic}」相关任务`;
    case 'instructions':
      return `第一步，澄清使用者的目标：{{goal|你想达成什么}}。\n第二步，围绕「${topic}」给出可执行的产出。`;
    default:
      return topic;
  }
}

function arrayFallback(field: 'skill_set' | 'starter_prompts', ctx: GenContext): string[] {
  const topic = evidenceTopic(ctx);
  if (field === 'skill_set') {
    return [
      `理解「${topic}」类需求并拆解`,
      '按结构化模板组织输出',
      '基于历史会话给出可复用方案',
      '在产出中保留可调整的占位项',
    ];
  }
  return [
    `帮我处理一个「${topic}」相关的任务`,
    '请按你的标准步骤开始',
    '给我一个可直接用的产出',
    '在结果里标出我还需要补充什么',
  ];
}

/** 容错解析 LLM 数组 JSON（提取首个 [...]；坏 JSON / 非数组 → 空，调用方兜底）。 */
function parseArray(text: string): string[] {
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) return [];
  try {
    const arr = JSON.parse(m[0]) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
      .map((s) => s.trim());
  } catch {
    return [];
  }
}

/** 单值字段裁剪（name ≤24、tagline ≤60；其余原样）。 */
function trimScalar(field: SoftFieldKey, value: string): string {
  if (field === 'name') return value.slice(0, 24);
  if (field === 'tagline') return value.slice(0, 60);
  return value;
}

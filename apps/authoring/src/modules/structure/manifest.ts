// 40 · manifest 软硬分层 + structure_state 构造（B-24/B-25，40-step3-4-structure §2/§3.1）。纯逻辑，不写库、不调 LLM。
//   硬字段（id/version/status/inputs/output/boundaries）平台锁定：不生成、不参与流、永不报字段级错误（§2.2）。
//   软字段（7 个）经结构化 Job 流式生成（§2.1）；structure_state 是字段级真源（已生成不丢，硬规则③）。
//   inputs.schema 由 instructions 占位抽取（§2.3，derivedFrom:'instructions'，锁定不可手改）。
import {
  SOFT_FIELD_KEYS,
  HARD_FIELD_KEYS,
  type SoftFieldKey,
  type HardFieldKey,
  type Manifest,
  type InputSchema,
  type InputField,
  type OutputSpec,
  type OutputType,
  type Boundaries,
  type StructureState,
  type FieldState,
  type FieldStatus,
  type ErrorBody,
} from '@cb/shared';

/** locked = 硬字段全集（§2.5 ManifestView.locked）。 */
export const LOCKED_HARD_FIELDS: HardFieldKey[] = HARD_FIELD_KEYS;

/** 软字段是否数组型（skill_set / starter_prompts 逐项流；其余单值流，§2.1）。 */
export function isArrayField(field: SoftFieldKey): boolean {
  return field === 'skill_set' || field === 'starter_prompts';
}

/** 软字段空初值（数组 → []，单值 → ''）。建体时软字段空待结构化（§4.A）。 */
export function emptySoftValue(field: SoftFieldKey): string | string[] {
  return isArrayField(field) ? [] : '';
}

/**
 * 平台默认硬字段（建体即锁定填充，不生成、不参与流，§2.2/§4.A）。
 *   - id = capabilityId（对外唯一标识）；version/status 平台管理。
 *   - inputs.schema 初始空（结构化 / PATCH instructions 时由 deriveInputSchema 系统重算，§2.3/§4.E）。
 *   - output.type 默认 'text'（本期形态，可由抽取推断但锁定，§2.2）。
 *   - boundaries 平台默认（low + 默认红线）。
 */
export function defaultHardFields(
  capabilityId: string,
  version: string,
): {
  id: string;
  version: string;
  status: 'draft';
  inputs: InputSchema;
  output: OutputSpec;
  boundaries: Boundaries;
} {
  return {
    id: capabilityId,
    version,
    status: 'draft',
    inputs: { fields: [] },
    output: { type: 'text' },
    boundaries: { riskLevel: 'low', redLines: defaultRedLines() },
  };
}

/** 平台默认红线（boundaries.redLines；锁定，§2.3）。可由抽取补充（本期固定默认集）。 */
export function defaultRedLines(): string[] {
  return [
    '不输出违法、欺诈或人身伤害相关内容',
    '不替代专业医疗/法律/金融建议',
    '不泄露使用者的隐私信息',
  ];
}

/** 建一条全空软字段的初始 manifest（硬字段锁定填充，软字段空，§4.A CreateCapabilityResult.manifest）。 */
export function initialManifest(capabilityId: string, version: string): Manifest {
  const hard = defaultHardFields(capabilityId, version);
  return {
    ...hard,
    name: '',
    tagline: '',
    role: '',
    goal: '',
    instructions: '',
    skill_set: [],
    starter_prompts: [],
  };
}

/**
 * 从 instructions 占位抽取 inputs.schema（§2.3 系统派生，derivedFrom:'instructions'，锁定不可手改）。
 *   占位语法：`{{key}}` 或 `{{key|人话提示}}`（人话提示可空，缺则用 key 兜底标签）。
 *   去重（同 key 取首次出现，保持序）；无占位 → fields 空数组（消费者无需填项）。
 *   类型本期统一 'string'、required=true（本期不暴露细粒度类型推断，硬字段锁定即可）。
 */
export function deriveInputSchema(instructions: string): InputSchema {
  const fields: InputField[] = [];
  const seen = new Set<string>();
  // 匹配 {{ key }} 或 {{ key | label }}（key = 字母数字下划线，宽松匹配）。
  const re = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:\|\s*([^}]*?)\s*)?\}\}/g;
  for (const m of instructions.matchAll(re)) {
    const key = m[1]!;
    if (seen.has(key)) continue;
    seen.add(key);
    const label = (m[2] && m[2].trim()) || key;
    fields.push({ key, label, type: 'string', required: true, derivedFrom: 'instructions' });
  }
  return { fields };
}

/**
 * output.type 由 instructions 抽取推断（§2.2/§4.E：可由抽取推断更新但锁定）。
 *   关键词启发（确定性、非 LLM）：PRD/结构化文档 → 'structured'；打分/评估 → 'score'；清单/核查 → 'checklist'；其余 'text'。
 */
export function deriveOutputType(instructions: string, name: string, goal: string): OutputType {
  const blob = `${instructions} ${name} ${goal}`.toLowerCase();
  if (/(打分|评分|评估|score|rating|rubric)/.test(blob)) return 'score';
  if (/(清单|核查|checklist|check\s?list|todo)/.test(blob)) return 'checklist';
  if (/(prd|结构化|文档|大纲|spec|规格|schema)/.test(blob)) return 'structured';
  return 'text';
}

/**
 * 软字段值落进 manifest（同时按 instructions 重算硬字段 inputs/output——系统派生、仍锁定，§4.E 派生规则）。
 *   不触碰 status（恒 draft，验收-31）；id/version/boundaries 不随软字段动（平台锁定）。
 *   返回新 manifest（不就地改入参）。用于结构化逐字段落库与 PATCH 软字段。
 */
export function applySoftField(
  manifest: Manifest,
  field: SoftFieldKey,
  value: string | string[],
): Manifest {
  const next: Manifest = { ...manifest, [field]: value } as Manifest;
  // instructions 变 → 系统重算 inputs.schema + output.type（仍锁定，§2.3/§4.E）。
  if (field === 'instructions' && typeof value === 'string') {
    next.inputs = deriveInputSchema(value);
    next.output = { type: deriveOutputType(value, next.name, next.goal) };
  }
  return next;
}

/** 批量落软字段（PATCH 多软字段，§4.E）：逐个 applySoftField（含 instructions 派生重算）。 */
export function applySoftFields(
  manifest: Manifest,
  patch: Partial<Record<SoftFieldKey, string | string[]>>,
): Manifest {
  let next = manifest;
  // instructions 放最后应用，确保用最新 name/goal 推断 output.type。
  const keys = (Object.keys(patch) as SoftFieldKey[]).sort((a, b) =>
    a === 'instructions' ? 1 : b === 'instructions' ? -1 : 0,
  );
  for (const k of keys) {
    const v = patch[k];
    if (v !== undefined) next = applySoftField(next, k, v);
  }
  return next;
}

// ===========================================================================
// structure_state（字段级真源，§3.1 state_snapshot(structure) 全量来源）
// ===========================================================================

/** 硬字段在 structure_state 里的 locked 值（§3.1 示例：硬字段 status='locked' + value）。 */
function hardFieldState(field: HardFieldKey, manifest: Manifest): FieldState {
  return { field, status: 'locked', value: manifest[field] as unknown };
}

/**
 * 建初始 structure_state（软字段全 pending、硬字段全 locked，§4.A）。
 *   selectedFields 限定要生成的软字段子集（续传只补未生成，§4.C StartStructureBody.fields）；
 *   不在子集里的软字段：若已有非空值 → done（已生成回显）；否则 pending。
 */
export function initialStructureState(
  versionId: string,
  manifest: Manifest,
  selectedFields?: SoftFieldKey[],
): StructureState {
  const selected = selectedFields && selectedFields.length > 0 ? new Set(selectedFields) : null;
  const softStates: FieldState[] = SOFT_FIELD_KEYS.map((field) => {
    const value = manifest[field];
    const hasValue = isArrayField(field)
      ? Array.isArray(value) && value.length > 0
      : typeof value === 'string' && value.length > 0;
    // 已有值 → done（已生成不丢）；否则 pending（待生成）。selected 子集外的已生成字段保持 done。
    const status: FieldStatus = hasValue ? 'done' : 'pending';
    return { field, status, value };
  });
  const hardStates: FieldState[] = HARD_FIELD_KEYS.map((field) => hardFieldState(field, manifest));
  void selected; // selected 仅在 worker 决定生成哪些字段时用；structure_state 初值据 manifest 已有值判 done/pending。
  return buildStructureState(versionId, [...softStates, ...hardStates]);
}

/** 据 fields 数组重算 doneCount/totalCount（done 只数软字段；硬字段 locked 不计入 total，§3.1 totalCount=7）。 */
export function buildStructureState(versionId: string, fields: FieldState[]): StructureState {
  const soft = fields.filter((f) => SOFT_FIELD_KEYS.includes(f.field as SoftFieldKey));
  const doneCount = soft.filter((f) => f.status === 'done').length;
  return { versionId, fields, doneCount, totalCount: soft.length };
}

/** 取某软字段当前 state（用于续传/重生成判断）。 */
export function getFieldState(state: StructureState, field: SoftFieldKey): FieldState | undefined {
  return state.fields.find((f) => f.field === field);
}

/** 读某软字段当前累计失败次数（缺省 0；§3.4 跨 job/跨端点 F 调用累计的起算基线）。 */
export function getFieldAttempts(state: StructureState, field: SoftFieldKey): number {
  const fs = getFieldState(state, field);
  return fs?.attempts ?? 0;
}

/**
 * 改写某软字段的 state（status/value/stuckMs/error/attempts），返回新 StructureState（不就地改）。
 *   只动该字段——其余软字段 + 硬字段原样保留（已生成不丢，硬规则③；重生成不丢其它，§4.F）。
 *   attempts：累计失败次数（§3.4）。patch.attempts 给则覆写；不给则【保留已存 attempts】（不清零，跨调用累计）。
 */
export function setFieldState(
  state: StructureState,
  field: SoftFieldKey,
  patch: {
    status: FieldStatus;
    value?: string | string[];
    stuckMs?: number;
    error?: ErrorBody;
    attempts?: number;
  },
): StructureState {
  const fields = state.fields.map((f) => {
    if (f.field !== field) return f;
    const next: FieldState & { error?: ErrorBody } = { field, status: patch.status };
    if (patch.value !== undefined) next.value = patch.value;
    else if (f.value !== undefined) next.value = f.value; // 保留已生成值（失败/卡住不清已生成，§3.4）。
    if (patch.stuckMs !== undefined) next.stuckMs = patch.stuckMs;
    if (patch.error !== undefined) next.error = patch.error;
    // attempts：显式给则覆写（成功置 0 / 失败写累计值），不给则保留已存（不清零 → 跨调用累计，§3.4）。
    if (patch.attempts !== undefined) next.attempts = patch.attempts;
    else if (f.attempts !== undefined) next.attempts = f.attempts;
    return next;
  });
  return buildStructureState(state.versionId, fields);
}

/** 把 manifest 软字段值同步进 structure_state（worker 落库时 manifest + structure_state 一致，§4.C）。 */
export function manifestToStructureState(versionId: string, manifest: Manifest): StructureState {
  return initialStructureState(versionId, manifest);
}

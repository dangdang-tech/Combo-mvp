// STEP④ 字段视图归并（F-13）——纯函数，把 manifest 基线 + structure_state（SSE/快照）合成软硬字段视图。
//
// 真源分工（40 §2/§3）：
//   - manifest（端点 B ManifestView.manifest）：硬字段终值（id/version/status/inputs/output/boundaries 锁定）+
//     软字段已落库终值（断流兜底）。
//   - structureState（端点 B 快照 / SSE field_* 帧累积）：每字段实时状态（pending/generating/done/stuck/failed/locked）
//     + 已生成 partial 值 + 卡住时长 + 失败错误体。流式优先于 manifest 基线（边生成边显示）。
//
// 软字段（7）：可改 / 可重生成 / 流式（generating 显骨架、done 显终值、failed 显错误态三退路）。
// 硬字段（6）：平台锁定，恒 locked，不参与生成、不显加载条、不可改（一眼区分，验收 选择结构化-09/11/27）。
import {
  SOFT_FIELD_KEYS,
  HARD_FIELD_KEYS,
  type SoftFieldKey,
  type HardFieldKey,
  type Manifest,
  type StructureState,
  type FieldState,
  type FieldStatus,
  type ErrorBody,
} from '@cb/shared';

/** 软字段人话标签（§5.4.1 / 选择结构化-02）。 */
export const SOFT_FIELD_LABEL: Record<SoftFieldKey, string> = {
  name: '名称',
  tagline: '一句话卖点',
  role: '它扮演的角色',
  goal: '它要达成的目标',
  instructions: '工作步骤 / 说明',
  skill_set: '拿手本事',
  starter_prompts: '起手示例',
};

/** 硬字段人话标签（§5.4.2，平台锁定）。 */
export const HARD_FIELD_LABEL: Record<HardFieldKey, string> = {
  id: '唯一标识',
  version: '版本号',
  status: '当前状态',
  inputs: '运行时输入项',
  output: '产出物形态',
  boundaries: '风险等级与红线',
};

/** 数组型软字段（逐项流 / 逐项展示）。 */
export const ARRAY_SOFT_FIELDS: ReadonlySet<SoftFieldKey> = new Set<SoftFieldKey>([
  'skill_set',
  'starter_prompts',
]);

/** 软字段视图（渲染真源：值 + 状态 + 卡住/失败信息）。 */
export interface SoftFieldView {
  field: SoftFieldKey;
  label: string;
  /** 是否数组型（逐项展示）。 */
  isArray: boolean;
  status: FieldStatus;
  /** 单值字段当前文本（含流式 partial）；数组字段用 items。 */
  text: string;
  /** 数组字段当前已生成项（逐项浮现）。 */
  items: string[];
  /** 卡住/失败错误体（failed 态人话错误 + 退路；无 code）。 */
  error?: ErrorBody;
  /** 字段级累计失败次数（§3.4，跨 regen 累计）。 */
  attempts: number;
}

/** 硬字段视图（恒锁定，只读展示）。 */
export interface HardFieldView {
  field: HardFieldKey;
  label: string;
  /** 锁定终值的人话展示文本。 */
  display: string;
}

/** 软字段是否处于「正在生成」（显骨架，永不裸转圈）。 */
export function isGenerating(status: FieldStatus): boolean {
  return status === 'generating' || status === 'pending';
}

/** 软字段是否已落终值（显终值，可改/可重生成）。 */
export function isDone(status: FieldStatus): boolean {
  return status === 'done';
}

/** 把 structure_state.fields 索引成 map（按 field 键）。 */
function indexFields(state: StructureState | undefined): Map<string, FieldState> {
  const m = new Map<string, FieldState>();
  for (const f of state?.fields ?? []) m.set(f.field, f);
  return m;
}

/** structure_state 值转单值文本（流式 partial 可能是 string）。 */
function valueToText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** structure_state 值转数组项（数组字段逐项；过滤非字符串噪声）。 */
function valueToItems(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

/**
 * 合成软字段视图（7 个，固定序 SOFT_FIELD_KEYS）。流式态优先 structureState，缺则回落 manifest 终值。
 *   - structureState 有该字段：用其 status + value（流式 partial / 终值 / 数组逐项）。
 *   - 缺该字段但 manifest 有值：视作 done（断流兜底回显终值，贯穿-28 不打回加载条）。
 *   - 都没有：pending（待生成，显骨架）。
 */
export function buildSoftFields(
  manifest: Manifest | undefined,
  state: StructureState | undefined,
): SoftFieldView[] {
  const idx = indexFields(state);
  return SOFT_FIELD_KEYS.map((field) => {
    const isArray = ARRAY_SOFT_FIELDS.has(field);
    const fs = idx.get(field);
    const manifestVal: unknown = manifest ? (manifest[field] as unknown) : undefined;

    if (fs) {
      // 流式真源：用 structure_state 的状态 + 值（partial / 终值）。
      const status = fs.status;
      const value = fs.value ?? (status === 'done' ? manifestVal : undefined);
      return {
        field,
        label: SOFT_FIELD_LABEL[field],
        isArray,
        status,
        text: isArray ? '' : valueToText(value),
        items: isArray ? valueToItems(value) : [],
        ...(fs.error ? { error: fs.error } : {}),
        attempts: fs.attempts ?? 0,
      } satisfies SoftFieldView;
    }

    // 无 structure_state 记录：manifest 有值 → done（断流兜底）；否则 pending（待生成）。
    const hasManifestVal = isArray
      ? valueToItems(manifestVal).length > 0
      : valueToText(manifestVal).length > 0;
    const status: FieldStatus = hasManifestVal ? 'done' : 'pending';
    return {
      field,
      label: SOFT_FIELD_LABEL[field],
      isArray,
      status,
      text: isArray ? '' : valueToText(manifestVal),
      items: isArray ? valueToItems(manifestVal) : [],
      attempts: 0,
    } satisfies SoftFieldView;
  });
}

/** 硬字段终值人话展示（锁定，§5.4.2）。 */
function hardDisplay(field: HardFieldKey, manifest: Manifest | undefined): string {
  if (!manifest) return '—';
  switch (field) {
    case 'id':
      return manifest.id || '—';
    case 'version':
      return manifest.version || '—';
    case 'status':
      return manifest.status === 'draft' ? '未提交的草稿' : manifest.status;
    case 'inputs': {
      const fields = manifest.inputs?.fields ?? [];
      if (fields.length === 0) return '无运行时输入项';
      return fields.map((f) => f.label || f.key).join('、');
    }
    case 'output':
      return OUTPUT_TYPE_LABEL[manifest.output?.type] ?? manifest.output?.type ?? '—';
    case 'boundaries': {
      const b = manifest.boundaries;
      if (!b) return '—';
      const risk = RISK_LABEL[b.riskLevel] ?? b.riskLevel;
      const lines = b.redLines.length > 0 ? `；红线：${b.redLines.join('、')}` : '';
      return `风险${risk}${lines}`;
    }
    default:
      return '—';
  }
}

/** 产出物形态人话（硬字段 output.type）。 */
const OUTPUT_TYPE_LABEL: Record<string, string> = {
  text: '文本产物',
  structured: '结构化文档',
  score: '评分 / 评估结果',
  checklist: '核查清单',
};

/** 风险等级人话（硬字段 boundaries.riskLevel）。 */
const RISK_LABEL: Record<string, string> = {
  low: '低',
  medium: '中',
  high: '高',
};

/** 合成硬字段视图（6 个，固定序 HARD_FIELD_KEYS，恒锁定只读）。 */
export function buildHardFields(manifest: Manifest | undefined): HardFieldView[] {
  return HARD_FIELD_KEYS.map((field) => ({
    field,
    label: HARD_FIELD_LABEL[field],
    display: hardDisplay(field, manifest),
  }));
}

/** 软字段整体进度短语（已补 N / 7，永不裸转圈的量化文案）。 */
export function softProgressText(soft: SoftFieldView[]): string {
  const done = soft.filter((s) => isDone(s.status)).length;
  return `已补全字段 ${done} / ${soft.length}`;
}

/** 全部软字段是否已生成完（决定能否进入下一步发布）。 */
export function allSoftReady(soft: SoftFieldView[]): boolean {
  return soft.every((s) => isDone(s.status));
}

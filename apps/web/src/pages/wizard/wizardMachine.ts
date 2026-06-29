// 五步上传向导步骤状态机（F-09，开工总纲 §5.0）——纯函数，无 React，给后续步骤复用的真源。
//
// 步骤条状态语义（§5.0）四态：
//   - done    已完成：可回看（贯穿-16），步骤条显示对勾。
//   - current 进行中：当前所处步骤（高亮），底栏摘要/主按钮按它算。
//   - todo    待办：尚未到达，显示步骤数字（§5.0「待办显数字」）。
//   - error   异常：该步落错误态（永不裸转圈/裸错由各步内 ErrorState 承担，此处只标步骤条颜色）。
//
// 续传（F-15）落地：后端 DraftView.currentStep 决定「进行中」步，其前皆 done（可回看）、其后皆 todo；
//   某步异常由前端 stepStatuses 覆写为 error（局部失败不阻塞其它步，开工总纲 §八①）。
import type { DraftStep } from '@cb/shared';
import { CREATE_STEPS } from '../../shell/routes.js';

/** 步骤条单段状态（§5.0 四态语义）。 */
export type StepStatus = 'done' | 'current' | 'todo' | 'error';

/** 五步固定序（映射 DraftStep，CREATE_STEPS 单源，不另列一套）。 */
export const WIZARD_STEPS: DraftStep[] = CREATE_STEPS.map((s) => s.step);

/** 五步总数（底栏「第 X 步，共 N 步」的 N）。 */
export const WIZARD_STEP_COUNT = WIZARD_STEPS.length;

/** step → 序号（1-based，底栏摘要 / 待办数字 / 步骤条编号）。 */
export function stepIndex(step: DraftStep): number {
  return WIZARD_STEPS.indexOf(step) + 1;
}

/** step → 五步路由（CREATE_STEPS 单源；缺映射兜底第一步，与 DraftStrip 同口径）。 */
export function pathForStep(step: DraftStep): string {
  return (
    CREATE_STEPS.find((s) => s.step === step)?.path ?? CREATE_STEPS[0]?.path ?? '/create/import'
  );
}

/** 路由 path → step（反查，路由变化时定位当前步；非五步子路由返回 undefined）。 */
export function stepForPath(pathname: string): DraftStep | undefined {
  return CREATE_STEPS.find((s) => s.path === pathname)?.step;
}

/** step → 步骤条短标签（如「STEP③ 选择」，面包屑/步骤条共用 CREATE_STEPS.label）。 */
export function stepLabel(step: DraftStep): string {
  return CREATE_STEPS.find((s) => s.step === step)?.label ?? step;
}

/**
 * 底栏右主按钮的「下一步：（动态步骤名）→」里的步骤名（开工总纲 §5.0 / 5.1.3「下一步：提取能力项」）。
 * 取下一步的人话动作名；STEP③ 选中态由调用方追加能力名（「结构化『X』」，§5.3），此处给通用兜底。
 */
const NEXT_STEP_ACTION: Record<DraftStep, string> = {
  import: '提取能力项',
  extract: '选择能力',
  select: '结构化',
  structure: '发布到市集',
  publish: '完成发布',
};

/** 下一步动作名（底栏主按钮文案，§5.0 恒定底栏）。末步无下一步返回 undefined。 */
export function nextStepAction(step: DraftStep): string | undefined {
  if (isLastStep(step)) return undefined;
  return NEXT_STEP_ACTION[step];
}

/** 是否首步（首步不渲染「上一步」/ 底栏摘要据此）。 */
export function isFirstStep(step: DraftStep): boolean {
  return stepIndex(step) === 1;
}

/** 是否末步（末步底栏主按钮变「完成发布」，不再是「下一步」）。 */
export function isLastStep(step: DraftStep): boolean {
  return stepIndex(step) === WIZARD_STEP_COUNT;
}

/** 下一步 step（末步返回 undefined）。 */
export function nextStep(step: DraftStep): DraftStep | undefined {
  const i = WIZARD_STEPS.indexOf(step);
  if (i < 0 || i >= WIZARD_STEP_COUNT - 1) return undefined;
  return WIZARD_STEPS[i + 1];
}

/** 上一步 step（首步返回 undefined）。 */
export function prevStep(step: DraftStep): DraftStep | undefined {
  const i = WIZARD_STEPS.indexOf(step);
  if (i <= 0) return undefined;
  return WIZARD_STEPS[i - 1];
}

/** 步骤条单段视图（渲染真源：序号 + 步骤 + 状态 + 标签 + 可否回看）。 */
export interface StepNodeView {
  step: DraftStep;
  /** 1-based 序号（待办态步骤条直接显它，§5.0）。 */
  index: number;
  label: string;
  status: StepStatus;
  /** 已完成步可回看（贯穿-16），可点回跳；todo/current 不可点回跳。 */
  navigable: boolean;
}

/** 步骤异常覆写表：{ [step]: true } 标该步落错误态（局部失败不连坐其它步）。 */
export type StepErrors = Partial<Record<DraftStep, boolean>>;

/**
 * 据「当前步（URL 落点）+ 实际进度 + 异常覆写」算出五段步骤条视图
 *   （F-09 步骤条真源 + F-15 续传：脊柱 §8「步骤条状态由 draft 实际进度推导，非 URL 伪造」）。
 *
 * 两个游标分工（BUG-009 修复核心）：
 *   - currentStep = URL 落点（用户正看哪一步）→ 该步 current。
 *   - progressStep = 实际进度前沿（草稿 DraftView.currentStep；无草稿/无锚点时退回首步 import）。
 *     某步只有「既在 URL 落点之前、又在实际进度之内」才算 done——避免无锚点深链把没做过的前序伪造成已完成。
 *
 * 状态推导：
 *   - errors[step]=true：覆写为 error（无论前后，局部失败不阻塞）；error 步可点进去重试。
 *   - idx === curIdx：current（不可点自身回跳）。
 *   - idx < min(curIdx, progressIdx)：done（真实已完成，navigable 可回看，贯穿-16）。
 *   - 其余（URL 跳到了实际进度之外的前序 / current 之后）：todo（显数字，不可点——没真做过 / 还没到，§5.0）。
 *
 * @param progressStep 实际进度前沿步；缺省退回 currentStep（纯函数单测口径不变：有进度即按 URL 推 done）。
 *   WizardShell 据 draft 锚点判定：有 draft/锚点 → 传 URL 落点（合法续传/前进）；无任何锚点 → 传首步（不伪造前序 done）。
 * @param completedStep 终态覆写（BUG-022）：该步即便正被 URL 落点（current），也强制标 done——用于「末步
 *   STEP⑤ 单条发布成功」后，步骤条不再显「进行中」。缺省 undefined（不覆写，行为与原三参一致，向后兼容）。
 */
export function buildStepNodes(
  currentStep: DraftStep,
  errors: StepErrors = {},
  progressStep: DraftStep = currentStep,
  completedStep?: DraftStep,
): StepNodeView[] {
  const curIdx = stepIndex(currentStep);
  // done 前沿 = URL 落点与实际进度二者取小：URL 再深，没真实进度托底也不标前序 done（BUG-009）。
  const doneFrontier = Math.min(curIdx, stepIndex(progressStep));
  return WIZARD_STEPS.map((step) => {
    const idx = stepIndex(step);
    let status: StepStatus;
    if (errors[step]) status = 'error';
    // 终态覆写（BUG-022）：某步已完成（如末步发布成功）即便正被 URL 落点，也标 done、不再「进行中」。
    else if (step === completedStep) status = 'done';
    else if (idx === curIdx) status = 'current';
    else if (idx < doneFrontier) status = 'done';
    else status = 'todo';
    // 可回看 = 已完成步；异常步也允许点进去重试（开工总纲 §八②带退路）；待办步未到/未做、不可点。
    const navigable = status === 'done' || status === 'error';
    return { step, index: idx, label: stepLabel(step), status, navigable };
  });
}

/** 底栏左侧步骤摘要文案（开工总纲 §5.0「第 X 步，共 N 步」）。 */
export function stepSummary(step: DraftStep): string {
  return `第 ${stepIndex(step)} 步，共 ${WIZARD_STEP_COUNT} 步`;
}

/**
 * 真实进度锚点（BUG-009）——草稿已落库产物引用 ∪ 前进流程中各步已 set 的引用。
 * 每个非空字段 = 对应步「真做过」的证据；**draftId 不在此**：草稿存在 ≠ 走过任何后续步。
 */
export interface ProgressAnchors {
  /** STEP① 导入产物（snapshot）。 */
  snapshotId?: string | undefined;
  /** STEP② 萃取 job（萃取已起）。 */
  extractJobId?: string | undefined;
  /** STEP③ 选择态非空（选过能力）。 */
  hasSelection?: boolean | undefined;
  /** STEP④ 建版产物。 */
  versionId?: string | undefined;
  /** STEP④ 能力体（建版同事务回填）。 */
  capabilityId?: string | undefined;
  /** STEP⑤ 批量发布批次。 */
  batchId?: string | undefined;
}

/**
 * 据真实产物锚点推导「进度前沿步」（BUG-009 核心）——只认已落库 / 已生成的证据，**绝不看 URL 落点**。
 *
 * 每个锚点证明某步真做完，对应「现在最远可处于」的步（取最远证据）：
 *   - versionId / capabilityId / batchId → 已建版 / 已建批（结构化做完）→ publish。
 *   - hasSelection                        → 已定选择（选择做完）        → structure。
 *   - extractJobId                        → 萃取已起（提取做过）        → select。
 *   - snapshotId                          → 导入已出快照（导入做完）    → extract。
 *   - 无任何锚点                           → 还在第一步                 → import。
 *
 * 关键：仅有 draftId（无任一上述锚点）绝不构成进度证据——深链 `?draftId=` 到中后段时，
 *   前序步据本前沿仍判 todo（真实未开始），不被 URL 伪造成 done（脊柱 §8 续传语义 / BUG-009 修复要旨）。
 *   注：select 是纯前端步、后端 current_step 跳过它，故进度前沿取产物锚点而非后端 currentStep。
 */
export function progressFrontier(a: ProgressAnchors): DraftStep {
  if (a.versionId || a.capabilityId || a.batchId) return 'publish';
  if (a.hasSelection) return 'structure';
  if (a.extractJobId) return 'select';
  if (a.snapshotId) return 'extract';
  return 'import';
}

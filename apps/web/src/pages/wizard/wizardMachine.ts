// 上传向导步骤纯函数（F-09）——PRD 收敛为 2 步（上传 → 能力页）后，只留路由 ↔ 步的映射真源。
//
// 已随「结构坍缩」下线（原五步步骤条专用）：buildStepNodes / progressFrontier / StepBar 状态推导 /
//   底栏「下一步」文案（NEXT_STEP_ACTION / nextStepAction / stepSummary）——2 步流程无常驻步骤条、
//   无恒定底栏主按钮（上传完成即自动进入能力页、能力页自带「一键发布」），故这些机制整体移除。
import type { DraftStep } from '@cb/shared';
import { CREATE_STEPS } from '../../shell/routes.js';

/** 上传两步固定序（CREATE_STEPS 单源，不另列一套）。注意含非 DraftStep 的 'capabilities'，故为 string。 */
export const WIZARD_STEPS: string[] = CREATE_STEPS.map((s) => s.step);

/** 步骤总数（2）。 */
export const WIZARD_STEP_COUNT = WIZARD_STEPS.length;

/** step → 序号（1-based）。 */
export function stepIndex(step: string): number {
  return WIZARD_STEPS.indexOf(step) + 1;
}

/** step → 路由（CREATE_STEPS 单源；缺映射兜底第一步）。 */
export function pathForStep(step: string): string {
  return (
    CREATE_STEPS.find((s) => s.step === step)?.path ?? CREATE_STEPS[0]?.path ?? '/create/import'
  );
}

/** 路由 path → step（反查，路由变化时定位当前步；非上传子路由返回 undefined）。 */
export function stepForPath(pathname: string): string | undefined {
  return CREATE_STEPS.find((s) => s.path === pathname)?.step;
}

/** step → 短标签（面包屑共用 CREATE_STEPS.label）。 */
export function stepLabel(step: string): string {
  return CREATE_STEPS.find((s) => s.step === step)?.label ?? step;
}

/** 是否首步。 */
export function isFirstStep(step: string): boolean {
  return stepIndex(step) === 1;
}

/** 是否末步。 */
export function isLastStep(step: string): boolean {
  return stepIndex(step) === WIZARD_STEP_COUNT;
}

/** 步骤异常覆写表：{ [step]: true } 标该步落错误态（局部失败不连坐其它步）。 */
export type StepErrors = Partial<Record<DraftStep, boolean>>;

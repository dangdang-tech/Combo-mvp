// 底栏导航（F-09，开工总纲 §5.0 / 5.1.3）——恒定底栏，左步骤摘要 + 右动态主按钮。
//
// 左：当前步骤摘要「第 X 步，共 5 步」（§5.0）。可由各步注入前缀（如「原始数据仅你可见 · 第 1 步…」5.1.3）。
// 右：主按钮「下一步：（动态步骤名）→」（§5.0），文案/行为随状态变：
//   - 各步经 primaryAction 注册自己的 onNext + label 覆盖（如 STEP③ 选中「下一步：结构化『X』」，§5.3）。
//   - 未注册或未就绪（enabled=false）→ 主按钮禁用（该步未达可前进条件，不假装能走）。
//   - busy → 显「处理中…」并禁用（推进请求在途防重复点；永不裸转圈靠各步内加载件，此处仅按钮态）。
// 末步无「下一步」：label 兜底用机器给的「完成发布」。
import type { ReactElement } from 'react';
import type { DraftStep } from '@cb/shared';
import { isLastStep, nextStepAction, stepSummary } from './wizardMachine.js';
import type { PrimaryAction } from './WizardContext.js';

export interface WizardFooterProps {
  currentStep: DraftStep;
  /** 当前步注册的主按钮行为（无则机器默认：默认「下一步：（动态步骤名）→」、禁用直到注册 onNext）。 */
  primaryAction: PrimaryAction | null;
  /** 底栏摘要前缀（各步可选注入，如「原始数据仅你可见 · 」5.1.3）。 */
  summaryPrefix?: string;
}

/** 机器默认主按钮文案（§5.0「下一步：（动态步骤名）→」；末步「完成发布」）。 */
function defaultPrimaryLabel(step: DraftStep): string {
  if (isLastStep(step)) return '完成发布';
  const action = nextStepAction(step);
  return action ? `下一步：${action} →` : '下一步 →';
}

export function WizardFooter({
  currentStep,
  primaryAction,
  summaryPrefix,
}: WizardFooterProps): ReactElement {
  const label = primaryAction?.label ?? defaultPrimaryLabel(currentStep);
  const busy = primaryAction?.busy === true;
  // 可点 = 有 onNext + 未显式禁用 + 不在途。未注册 onNext 的步主按钮恒禁用（未就绪不假装可走）。
  const canNext = !!primaryAction?.onNext && primaryAction.enabled !== false && !busy;
  const summary = `${summaryPrefix ?? ''}${stepSummary(currentStep)}`;

  return (
    <footer className="cb-wizard-footer" aria-label="向导导航">
      <p className="cb-wizard-footer__summary">{summary}</p>
      <button
        type="button"
        className="cb-btn cb-btn--primary cb-wizard-footer__next"
        onClick={() => primaryAction?.onNext?.()}
        disabled={!canNext}
        aria-disabled={!canNext}
      >
        {busy ? '处理中…' : label}
      </button>
    </footer>
  );
}

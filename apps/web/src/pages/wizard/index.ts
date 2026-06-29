// 向导模块出口（F-09 WizardShell + F-12 STEP③ + F-15 续传）。
//
// 给后续步骤（STEP①②④⑤）的接入面：
//   - WizardProvider / useWizard：五步共享状态（currentStep / draftId / selection / stepErrors / primaryAction）。
//   - 步骤状态机（wizardMachine）：buildStepNodes / nextStep / pathForStep / stepLabel 等纯函数真源。
//   - 各步在 effect 里 setPrimaryAction 注册底栏「下一步」行为；用 markStepError/clearStepError 标步骤条异常态。
export { WizardShell } from './WizardShell.js';
export { WizardLayout } from './WizardLayout.js';
export { SelectStepPage } from './SelectStepPage.js';
export { WizardProvider, useWizard } from './WizardContext.js';
export type {
  WizardContextValue,
  WizardState,
  WizardActions,
  PrimaryAction,
} from './WizardContext.js';

export { StepBar, type StepBarProps } from './StepBar.js';
export { WizardFooter, type WizardFooterProps } from './WizardFooter.js';
export { SelectStep, type SelectStepProps } from './SelectStep.js';

export { useSaveDraft, type UseSaveDraftResult, type SaveDraftState } from './useSaveDraft.js';
export { useResumeDraft, type UseResumeDraftResult, type ResumeStatus } from './useResumeDraft.js';
export {
  useBootstrapDraft,
  type UseBootstrapDraftResult,
  type BootstrapStatus,
} from './useBootstrapDraft.js';

export {
  createDraft,
  getDraft,
  patchSelection,
  findDraftById,
  selectionPath,
  draftsPath,
  draftPath,
} from './draftApi.js';
export { fetchSelectCandidates, candidatesPath, type SelectCandidatesResult } from './selectApi.js';

export {
  WIZARD_STEPS,
  WIZARD_STEP_COUNT,
  stepIndex,
  pathForStep,
  stepForPath,
  stepLabel,
  nextStep,
  prevStep,
  nextStepAction,
  isFirstStep,
  isLastStep,
  buildStepNodes,
  stepSummary,
  type StepStatus,
  type StepNodeView,
  type StepErrors,
} from './wizardMachine.js';

// 向导模块出口（F-09 WizardShell + F-15 续传）——PRD 2 步坍缩后精简。
//
// 给上传各步的接入面：
//   - WizardProvider / useWizard：共享状态（currentStep / draftId / snapshotId / stepErrors / …）。
//   - 步骤纯函数（wizardMachine）：pathForStep / stepForPath / stepLabel / WIZARD_STEPS 等路由↔步映射真源。
//   - 存草稿 / 续传 / bootstrap hooks。
export { WizardShell } from './WizardShell.js';
export { WizardLayout } from './WizardLayout.js';
export { WizardProvider, useWizard } from './WizardContext.js';
export type {
  WizardContextValue,
  WizardState,
  WizardActions,
  PrimaryAction,
} from './WizardContext.js';

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

export {
  WIZARD_STEPS,
  WIZARD_STEP_COUNT,
  stepIndex,
  pathForStep,
  stepForPath,
  stepLabel,
  isFirstStep,
  isLastStep,
  type StepErrors,
} from './wizardMachine.js';

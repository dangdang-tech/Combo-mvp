// 向导上下文（F-09 / F-12 / F-15）——五步共享状态真源，后续步骤经 useWizard() 读写。
//
// 持有什么（与各步内部 SSE/表单态分工）：
//   - currentStep：当前所处步（由路由派生，stepForPath）。后续步骤切路由即更新，外壳/步骤条/底栏据它算。
//   - stepErrors：哪些步落错误态（步骤条标红，§5.0 异常态）。某步两次失败由该步自己 markStepError(step)，
//     局部失败不连坐其它步（开工总纲 §八①「失败可重试不阻塞其它」）。
//   - selection：STEP③ 选择态（SelectionDraft | null）。选择切换纯前端即时写本态、不打后端（§1.1(a)）；
//     「保存草稿」/ 进入下一步才 patchSelection 持久化（F-12）。
//   - draftId：当前草稿 id（续传/存草稿用）。新建流程从 undefined 起，建产物后由后端回填（各步接）。
//   - primaryAction：底栏右主按钮的动态行为（各步注册自己的「下一步」语义 + 可用性 + 文案覆盖，§5.0 恒定底栏）。
//
// 续传（F-15）：hydrateFromDraft(draft) 用 DraftView 恢复 draftId + selection（current_step 由路由落点决定）。
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useReducer,
  type ReactNode,
  type ReactElement,
} from 'react';
import type { DraftStep, DraftView, SelectionDraft } from '@cb/shared';
import type { StepErrors } from './wizardMachine.js';

/** 底栏主按钮注册项：当前步把「下一步」语义交给外壳渲染（§5.0 底栏恒定、文案随状态变）。 */
export interface PrimaryAction {
  /** 覆盖默认「下一步：（动态步骤名）→」文案（如 STEP③ 选中「下一步：结构化『X』」，§5.3）。不给用机器默认。 */
  label?: string;
  /** 点主按钮的行为（各步自定义：建产物 / 推进 / 发布等）。不给则主按钮禁用（该步未就绪不可前进）。 */
  onNext?: () => void;
  /** 主按钮是否可点（如 STEP③ 既未选单个也未全选时不可前进；默认有 onNext 即可点）。 */
  enabled?: boolean;
  /** 主按钮是否处于进行中（推进请求在途，禁用防重复点；底栏显「处理中…」，永不裸转圈靠各步内加载件）。 */
  busy?: boolean;
}

export interface WizardState {
  /** 当前所处步（路由派生；2 步流程含非 DraftStep 的 'capabilities'，故为 string）。 */
  currentStep: string;
  /** 异常步覆写（步骤条标红，§5.0）。 */
  stepErrors: StepErrors;
  /** STEP③ 选择态（纯前端即时，§1.1(a)）。 */
  selection: SelectionDraft | null;
  /** 当前草稿 id（续传 / 存草稿）。 */
  draftId: string | undefined;
  /** 当前导入快照 id（STEP②/④ 据它续提取/续看；续传从 DraftView.snapshotId 回填，避免重新导入）。 */
  snapshotId: string | undefined;
  /** 当前萃取 job id（STEP③ 据它取候选；续传 hydrateFromDraft 从 DraftView.extractJobId 回填）。 */
  extractJobId: string | undefined;
  /** 当前能力版本 id（STEP④ 建版回填 + 续传从 DraftView.versionId 回填；STEP⑤ 单发布据它发布，续传不重建版）。 */
  versionId: string | undefined;
  /**
   * 当前能力体 id（capabilities.id；STEP④ 建版回填真实 capabilityId + 续传从 DraftView.capabilityId 回填）。
   * STEP⑤ 单发布据它读 publication（拒绝态闭环，P1-5）——drafts.id ≠ capabilities.id，绝不拿 draftId 冒充。
   */
  capabilityId: string | undefined;
  /** 当前批量发布批次 id（STEP⑤「全部发布」建批回填 + 续传从 DraftView.batchId 回填，续传恢复同一批次不重建）。 */
  batchId: string | undefined;
  /** 提取结果中是否已有可继续包装的 Agent；由能力结果页的真实候选响应回填，不用 job id 猜完成。 */
  agentReady: boolean;
  /**
   * 底栏步骤摘要前缀（各步可选注入，如 STEP① 完成态「原始数据仅你可见 · 」5.1.3 / 导入-17）。
   * 各步在 effect 内 setSummaryPrefix（离开/卸载时清回 undefined），WizardShell 透传给 WizardFooter。
   */
  summaryPrefix: string | undefined;
  /**
   * 末步（STEP⑤）单条发布是否已进入终态（发布成功，reviewStatus=alpha_pending/published，BUG-022）。
   * 能力结果页从真实发布批次 item 恢复并 setPublishCompleted(true)；WizardShell 据它把共享旅程标为完成。
   */
  publishCompleted: boolean;
}

export interface WizardActions {
  /** 路由变化时同步当前步（外壳在路由层调，后续步骤一般不需要）。 */
  setCurrentStep: (step: string) => void;
  /** 某步落错误态（步骤条标红，§5.0；局部失败不连坐其它步）。 */
  markStepError: (step: DraftStep) => void;
  /** 清某步错误（重试成功后复位步骤条颜色）。 */
  clearStepError: (step: DraftStep) => void;
  /** STEP③ 即时写选择态（纯前端，不打后端，§1.1(a)）。 */
  setSelection: (selection: SelectionDraft | null) => void;
  /** 设/换当前草稿 id（建产物后各步回填）。 */
  setDraftId: (draftId: string | undefined) => void;
  /** 设/换当前导入快照 id（STEP① 完成 / 续传带入，供 STEP②/④ 续用不重导）。 */
  setSnapshotId: (snapshotId: string | undefined) => void;
  /** 设/换当前萃取 job id（STEP② 进 STEP③ 时带入，供取候选）。 */
  setExtractJobId: (extractJobId: string | undefined) => void;
  /** 设/换当前版本 id（STEP④ 建版后回填，供 STEP⑤ 单发布据它发布、续传不重建版）。 */
  setVersionId: (versionId: string | undefined) => void;
  /** 设/换当前能力体 id（STEP④ 建版后回填真实 capabilityId，供 STEP⑤ 单发布读 publication 拒绝态，P1-5）。 */
  setCapabilityId: (capabilityId: string | undefined) => void;
  /** 设/换当前批次 id（STEP⑤「全部发布」建批后回填，续传恢复同一批次）。 */
  setBatchId: (batchId: string | undefined) => void;
  /** 标记真实候选是否已准备好，让上传页与结果页共享同一阶段事实。 */
  setAgentReady: (ready: boolean) => void;
  /**
   * 续传：用 DraftView 恢复 draftId + selection + snapshot/extract/version/capability/batch 全引用（F-15，
   * current_step 由路由落点决定）。各步优先读这些引用而非新建任务（STEP④ 不重建版、STEP⑤ 不缺 version、
   * 拒绝态读 publication 命中真实 capabilityId）。
   */
  hydrateFromDraft: (draft: DraftView) => void;
  /** 注册底栏主按钮行为（各步在 effect 里注册自己的「下一步」；卸载置空回机器默认）。 */
  setPrimaryAction: (action: PrimaryAction | null) => void;
  /** 设/清底栏摘要前缀（各步 effect 内注入，如 STEP① 完成态「原始数据仅你可见 · 」5.1.3；卸载置 undefined）。 */
  setSummaryPrefix: (prefix: string | undefined) => void;
  /** 标/清发布终态（能力结果页从真实批次 item 写入，使共享旅程标已完成）。 */
  setPublishCompleted: (completed: boolean) => void;
}

export interface WizardContextValue extends WizardState, WizardActions {
  /** 底栏主按钮当前注册项（外壳读它渲染右侧主按钮，无则用机器默认文案 + 默认前进路由）。 */
  primaryAction: PrimaryAction | null;
}

type Action =
  | { type: 'setCurrentStep'; step: string }
  | { type: 'markStepError'; step: DraftStep }
  | { type: 'clearStepError'; step: DraftStep }
  | { type: 'setSelection'; selection: SelectionDraft | null }
  | { type: 'setDraftId'; draftId: string | undefined }
  | { type: 'setSnapshotId'; snapshotId: string | undefined }
  | { type: 'setExtractJobId'; extractJobId: string | undefined }
  | { type: 'setVersionId'; versionId: string | undefined }
  | { type: 'setCapabilityId'; capabilityId: string | undefined }
  | { type: 'setBatchId'; batchId: string | undefined }
  | { type: 'setAgentReady'; ready: boolean }
  | { type: 'hydrateFromDraft'; draft: DraftView }
  | { type: 'setPrimaryAction'; action: PrimaryAction | null }
  | { type: 'setSummaryPrefix'; prefix: string | undefined }
  | { type: 'setPublishCompleted'; completed: boolean };

interface InternalState extends WizardState {
  primaryAction: PrimaryAction | null;
}

/** DraftView.selection 是 z.unknown()（脊柱避免循环）；窄化回 SelectionDraft（mode 判别），不合形态置 null。 */
//   认 single / subset（子集化 P0-1）/ all（向后兼容别名）三态；不认其它（旧脏数据）→ null（不崩、不预置）。
function coerceSelection(raw: unknown): SelectionDraft | null {
  if (raw && typeof raw === 'object' && 'mode' in raw) {
    const m = (raw as { mode?: unknown }).mode;
    if (m === 'single' || m === 'subset' || m === 'all') return raw as SelectionDraft;
  }
  return null;
}

function reducer(state: InternalState, action: Action): InternalState {
  switch (action.type) {
    case 'setCurrentStep':
      return state.currentStep === action.step ? state : { ...state, currentStep: action.step };
    case 'markStepError':
      return { ...state, stepErrors: { ...state.stepErrors, [action.step]: true } };
    case 'clearStepError': {
      if (!state.stepErrors[action.step]) return state;
      const next = { ...state.stepErrors };
      delete next[action.step];
      return { ...state, stepErrors: next };
    }
    case 'setSelection':
      return { ...state, selection: action.selection };
    case 'setDraftId':
      return state.draftId === action.draftId ? state : { ...state, draftId: action.draftId };
    case 'setSnapshotId':
      return state.snapshotId === action.snapshotId
        ? state
        : { ...state, snapshotId: action.snapshotId };
    case 'setExtractJobId':
      return state.extractJobId === action.extractJobId
        ? state
        : { ...state, extractJobId: action.extractJobId };
    case 'setVersionId':
      return state.versionId === action.versionId
        ? state
        : { ...state, versionId: action.versionId };
    case 'setCapabilityId':
      return state.capabilityId === action.capabilityId
        ? state
        : { ...state, capabilityId: action.capabilityId };
    case 'setBatchId':
      return state.batchId === action.batchId ? state : { ...state, batchId: action.batchId };
    case 'setAgentReady':
      return state.agentReady === action.ready ? state : { ...state, agentReady: action.ready };
    case 'hydrateFromDraft':
      // 续传恢复 draftId + selection + snapshot/extract/version/batch 全引用（current_step 由路由落点决定，
      // 不在此覆写 currentStep）。各步据这些引用续接已生成产物，不重建任务（已生成不丢、续传精确）。
      return {
        ...state,
        draftId: action.draft.id,
        snapshotId: action.draft.snapshotId ?? state.snapshotId,
        extractJobId: action.draft.extractJobId ?? state.extractJobId,
        versionId: action.draft.versionId ?? state.versionId,
        capabilityId: action.draft.capabilityId ?? state.capabilityId,
        batchId: action.draft.batchId ?? state.batchId,
        agentReady:
          state.agentReady ||
          action.draft.currentStep === 'select' ||
          action.draft.currentStep === 'structure' ||
          action.draft.currentStep === 'publish' ||
          Boolean(action.draft.versionId || action.draft.capabilityId),
        selection: coerceSelection(action.draft.selection),
      };
    case 'setPrimaryAction':
      return { ...state, primaryAction: action.action };
    case 'setSummaryPrefix':
      return state.summaryPrefix === action.prefix
        ? state
        : { ...state, summaryPrefix: action.prefix };
    case 'setPublishCompleted':
      return state.publishCompleted === action.completed
        ? state
        : { ...state, publishCompleted: action.completed };
    default:
      return state;
  }
}

const WizardCtx = createContext<WizardContextValue | null>(null);

export interface WizardProviderProps {
  /** 初始当前步（外壳由路由派生传入；2 步流程含 'capabilities'，故为 string）。 */
  initialStep: string;
  /** 初始草稿 id（深链续传 / 新建留空）。 */
  initialDraftId?: string | undefined;
  /** 初始导入快照 id（深链续传 / 新建留空）。 */
  initialSnapshotId?: string | undefined;
  /** 初始萃取 job id（STEP② 进 STEP③ 带入 / 深链）。 */
  initialExtractJobId?: string | undefined;
  /** 初始版本 id（深链续传 STEP④/⑤ / 新建留空）。 */
  initialVersionId?: string | undefined;
  /** 初始能力体 id（深链续传 STEP⑤ 读 publication 拒绝态 / 新建留空，P1-5）。 */
  initialCapabilityId?: string | undefined;
  /** 初始批次 id（深链续传 STEP⑤「全部发布」/ 新建留空）。 */
  initialBatchId?: string | undefined;
  children: ReactNode;
}

export function WizardProvider({
  initialStep,
  initialDraftId,
  initialSnapshotId,
  initialExtractJobId,
  initialVersionId,
  initialCapabilityId,
  initialBatchId,
  children,
}: WizardProviderProps): ReactElement {
  const [state, dispatch] = useReducer(reducer, {
    currentStep: initialStep,
    stepErrors: {},
    selection: null,
    draftId: initialDraftId,
    snapshotId: initialSnapshotId,
    extractJobId: initialExtractJobId,
    versionId: initialVersionId,
    capabilityId: initialCapabilityId,
    batchId: initialBatchId,
    agentReady: Boolean(initialVersionId || initialCapabilityId || initialBatchId),
    summaryPrefix: undefined,
    publishCompleted: false,
    primaryAction: null,
  });

  const setCurrentStep = useCallback(
    (step: string) => dispatch({ type: 'setCurrentStep', step }),
    [],
  );
  const markStepError = useCallback(
    (step: DraftStep) => dispatch({ type: 'markStepError', step }),
    [],
  );
  const clearStepError = useCallback(
    (step: DraftStep) => dispatch({ type: 'clearStepError', step }),
    [],
  );
  const setSelection = useCallback(
    (selection: SelectionDraft | null) => dispatch({ type: 'setSelection', selection }),
    [],
  );
  const setDraftId = useCallback(
    (draftId: string | undefined) => dispatch({ type: 'setDraftId', draftId }),
    [],
  );
  const setSnapshotId = useCallback(
    (snapshotId: string | undefined) => dispatch({ type: 'setSnapshotId', snapshotId }),
    [],
  );
  const setExtractJobId = useCallback(
    (extractJobId: string | undefined) => dispatch({ type: 'setExtractJobId', extractJobId }),
    [],
  );
  const setVersionId = useCallback(
    (versionId: string | undefined) => dispatch({ type: 'setVersionId', versionId }),
    [],
  );
  const setCapabilityId = useCallback(
    (capabilityId: string | undefined) => dispatch({ type: 'setCapabilityId', capabilityId }),
    [],
  );
  const setBatchId = useCallback(
    (batchId: string | undefined) => dispatch({ type: 'setBatchId', batchId }),
    [],
  );
  const setAgentReady = useCallback(
    (ready: boolean) => dispatch({ type: 'setAgentReady', ready }),
    [],
  );
  const hydrateFromDraft = useCallback(
    (draft: DraftView) => dispatch({ type: 'hydrateFromDraft', draft }),
    [],
  );
  const setPrimaryAction = useCallback(
    (action: PrimaryAction | null) => dispatch({ type: 'setPrimaryAction', action }),
    [],
  );
  const setSummaryPrefix = useCallback(
    (prefix: string | undefined) => dispatch({ type: 'setSummaryPrefix', prefix }),
    [],
  );
  const setPublishCompleted = useCallback(
    (completed: boolean) => dispatch({ type: 'setPublishCompleted', completed }),
    [],
  );

  const value = useMemo<WizardContextValue>(
    () => ({
      ...state,
      setCurrentStep,
      markStepError,
      clearStepError,
      setSelection,
      setDraftId,
      setSnapshotId,
      setExtractJobId,
      setVersionId,
      setCapabilityId,
      setBatchId,
      setAgentReady,
      hydrateFromDraft,
      setPrimaryAction,
      setSummaryPrefix,
      setPublishCompleted,
    }),
    [
      state,
      setCurrentStep,
      markStepError,
      clearStepError,
      setSelection,
      setDraftId,
      setSnapshotId,
      setExtractJobId,
      setVersionId,
      setCapabilityId,
      setBatchId,
      setAgentReady,
      hydrateFromDraft,
      setPrimaryAction,
      setSummaryPrefix,
      setPublishCompleted,
    ],
  );

  return <WizardCtx.Provider value={value}>{children}</WizardCtx.Provider>;
}

/** 读向导上下文（必须在 WizardProvider 内；后续步骤标准接入点）。 */
export function useWizard(): WizardContextValue {
  const ctx = useContext(WizardCtx);
  if (!ctx) throw new Error('useWizard 必须在 <WizardProvider> 内使用');
  return ctx;
}

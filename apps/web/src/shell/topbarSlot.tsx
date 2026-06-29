// 顶栏动作插槽（Figma STEP 顶栏：面包屑 + 「保存草稿」+ 头像同处一条 64px 栏）。
//
// 为什么要插槽：4A Shell 顶栏由 ProtectedLayout 渲染，在 WizardProvider 之上；而「保存草稿」的逻辑
//   （存草稿 + 退出）落在更深的 WizardShell 里（WizardProvider 内）。子要把按钮渲染进祖先顶栏，靠这个
//   provider 把动作「上抬」——与底栏 primaryAction 同一套「子注册、外壳渲染」惯例，只是抬到 Shell 这层。
// 无 Provider 时（Shell 独立单测 / 非受保护场景）注册是 no-op、渲染为空，绝不崩。
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';

/** 顶栏右侧动作（当前仅向导「保存草稿」用；保持最小面，够用即可）。 */
export interface TopbarAction {
  /** 按钮文案（如「保存草稿」/ 在途「保存中…」）。 */
  label: string;
  /** 点击回调（子注册时闭包捕获自己的处理器）。 */
  onClick: () => void;
  /** 在途禁用（防重复点；永不裸转圈靠 label 内联文案）。 */
  disabled?: boolean;
}

interface TopbarSlotValue {
  action: TopbarAction | null;
  setAction: (a: TopbarAction | null) => void;
}

const TopbarSlotContext = createContext<TopbarSlotValue | null>(null);

/** 在 Shell 之上提供插槽状态（ProtectedLayout 挂）。 */
export function TopbarSlotProvider({ children }: { children: ReactNode }): ReactElement {
  const [action, setActionState] = useState<TopbarAction | null>(null);
  const setAction = useCallback((a: TopbarAction | null) => setActionState(a), []);
  const value = useMemo(() => ({ action, setAction }), [action, setAction]);
  return <TopbarSlotContext.Provider value={value}>{children}</TopbarSlotContext.Provider>;
}

/**
 * 子组件注册顶栏动作的稳定 setter（供 effect 依赖、不引发渲染抖动）。
 * 无 Provider 时回退稳定 no-op（独立单测 / 非受保护场景不崩，注册即空操作）。
 */
export function useTopbarActionSetter(): (a: TopbarAction | null) => void {
  const ctx = useContext(TopbarSlotContext);
  const noop = useCallback((_a: TopbarAction | null) => {}, []);
  return ctx?.setAction ?? noop;
}

/**
 * 顶栏动作渲染件——Shell 顶栏与 WizardShell 单测夹具共用同一渲染口径（单一真源，不各写一套按钮）。
 * 无 Provider / 无注册动作时渲染为空。
 */
export function TopbarActionSlot(): ReactElement | null {
  const ctx = useContext(TopbarSlotContext);
  const action = ctx?.action ?? null;
  if (!action) return null;
  return (
    <button
      type="button"
      className="cb-shell__topbar-save"
      onClick={action.onClick}
      disabled={action.disabled}
    >
      {action.label}
    </button>
  );
}

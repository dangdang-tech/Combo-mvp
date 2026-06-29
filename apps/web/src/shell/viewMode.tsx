// 创作者 / 消费者双视角开关（D14 占位）。
// 本期只切前端视角态（不改鉴权、不调端点）；消费链路在范围外（仅冻结 schema）。
import { createContext, useContext, useState, type ReactElement, type ReactNode } from 'react';
import type { Role } from '@cb/shared';

/** 视角即 shared 的 Role 枚举（creator | consumer），复用契约真源不另立。 */
export type ViewMode = Role;

interface ViewModeContextValue {
  mode: ViewMode;
  setMode: (m: ViewMode) => void;
  toggle: () => void;
}

const ViewModeContext = createContext<ViewModeContextValue | null>(null);

export function ViewModeProvider({ children }: { children: ReactNode }): ReactElement {
  const [mode, setMode] = useState<ViewMode>('creator');
  const toggle = () => setMode((m) => (m === 'creator' ? 'consumer' : 'creator'));
  return (
    <ViewModeContext.Provider value={{ mode, setMode, toggle }}>
      {children}
    </ViewModeContext.Provider>
  );
}

export function useViewMode(): ViewModeContextValue {
  const ctx = useContext(ViewModeContext);
  if (!ctx) throw new Error('useViewMode 必须在 ViewModeProvider 内使用');
  return ctx;
}

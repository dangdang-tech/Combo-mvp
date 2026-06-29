// 侧栏收起 / 展开偏好（外壳首页-04 收起为纯图标态；外壳首页-36 偏好刷新/换页不丢）。
//
// 偏好落 localStorage：刷新或换页回来维持上次状态，不强制弹回默认展开（外壳首页-36 P2）。
// SSR / jsdom 无 localStorage 时静默降级（读默认、写吞异常），不抛错、不裸崩。
import { useCallback, useState } from 'react';

const STORAGE_KEY = 'cb:shell:sidebar-collapsed';

function readInitial(): boolean {
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function persist(collapsed: boolean): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, collapsed ? '1' : '0');
  } catch {
    // 隐私模式 / 无 storage：静默降级，仍维持本会话内存态。
  }
}

export interface CollapseState {
  collapsed: boolean;
  toggle: () => void;
}

export function useCollapse(): CollapseState {
  const [collapsed, setCollapsed] = useState<boolean>(readInitial);
  const toggle = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      persist(next);
      return next;
    });
  }, []);
  return { collapsed, toggle };
}

export const SIDEBAR_COLLAPSE_KEY = STORAGE_KEY;

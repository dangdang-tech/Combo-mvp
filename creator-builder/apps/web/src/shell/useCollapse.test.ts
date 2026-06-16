// 收起偏好持久化测试（外壳首页-04 toggle；外壳首页-36 刷新/换页不丢，落 localStorage）。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useCollapse, SIDEBAR_COLLAPSE_KEY } from './useCollapse.js';

describe('useCollapse', () => {
  beforeEach(() => {
    globalThis.localStorage.clear();
  });

  it('默认展开（collapsed=false）', () => {
    const { result } = renderHook(() => useCollapse());
    expect(result.current.collapsed).toBe(false);
  });

  it('toggle 切换并写入 localStorage（外壳首页-04）', () => {
    const { result } = renderHook(() => useCollapse());
    act(() => result.current.toggle());
    expect(result.current.collapsed).toBe(true);
    expect(globalThis.localStorage.getItem(SIDEBAR_COLLAPSE_KEY)).toBe('1');
    act(() => result.current.toggle());
    expect(result.current.collapsed).toBe(false);
    expect(globalThis.localStorage.getItem(SIDEBAR_COLLAPSE_KEY)).toBe('0');
  });

  it('已存收起偏好 → 初始即收起（外壳首页-36 刷新不丢）', () => {
    globalThis.localStorage.setItem(SIDEBAR_COLLAPSE_KEY, '1');
    const { result } = renderHook(() => useCollapse());
    expect(result.current.collapsed).toBe(true);
  });

  it('localStorage 读抛错时静默降级为默认展开，不裸崩', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const { result } = renderHook(() => useCollapse());
    expect(result.current.collapsed).toBe(false);
    spy.mockRestore();
  });

  it('localStorage 写抛错时仍切换内存态，不裸崩（隐私模式降级）', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    const { result } = renderHook(() => useCollapse());
    act(() => result.current.toggle());
    // 写失败被吞，但本会话内存态仍翻转（不抛错）。
    expect(result.current.collapsed).toBe(true);
    spy.mockRestore();
  });
});

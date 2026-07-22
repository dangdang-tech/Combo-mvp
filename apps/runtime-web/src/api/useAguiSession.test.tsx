import type { PropsWithChildren } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SessionDetail } from '@cb/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiPostMock = vi.hoisted(() => vi.fn());

vi.mock('./client.js', () => ({
  apiPost: apiPostMock,
}));

import { useAguiSession } from './useAguiSession.js';

function detail(updatedAt = '2026-07-21T10:00:00.000Z'): SessionDetail {
  return {
    session: {
      id: '11111111-1111-4111-8111-111111111111',
      capabilityId: '22222222-2222-4222-8222-222222222222',
      slug: 'daily-agent',
      version: '0.1.0',
      mode: 'trial',
      title: '每日待办管家',
      createdAt: '2026-07-21T09:00:00.000Z',
      updatedAt,
    },
    capability: {},
    messages: [],
    artifacts: [],
  } as unknown as SessionDetail;
}

function createWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

describe('useAguiSession', () => {
  beforeEach(() => {
    apiPostMock.mockReset();
  });

  it('keeps the optimistic Studio turn running when React Query refreshes session detail', () => {
    apiPostMock.mockReturnValue(new Promise(() => undefined));
    let currentDetail = detail();
    const { result, rerender } = renderHook(
      () => useAguiSession(currentDetail.session.id, currentDetail),
      { wrapper: createWrapper() },
    );

    act(() => {
      expect(result.current.send('把主任务按钮放到首屏', undefined, 'design')).toBe(true);
    });

    expect(result.current.isRunning).toBe(true);
    expect(result.current.messages).toEqual([
      expect.objectContaining({ role: 'user', text: '把主任务按钮放到首屏' }),
    ]);

    currentDetail = detail('2026-07-21T10:00:01.000Z');
    rerender();

    expect(result.current.isRunning).toBe(true);
    expect(result.current.messages).toEqual([
      expect.objectContaining({ role: 'user', text: '把主任务按钮放到首屏' }),
    ]);
    expect(apiPostMock).toHaveBeenCalledTimes(1);
  });

  it('rejects a second send synchronously while the first run is starting', () => {
    apiPostMock.mockReturnValue(new Promise(() => undefined));
    const currentDetail = detail();
    const { result } = renderHook(() => useAguiSession(currentDetail.session.id, currentDetail), {
      wrapper: createWrapper(),
    });

    act(() => {
      expect(result.current.send('生成首版', undefined, 'design')).toBe(true);
      expect(result.current.send('再生成一次', undefined, 'design')).toBe(false);
    });

    expect(apiPostMock).toHaveBeenCalledTimes(1);
    expect(result.current.messages).toHaveLength(1);
  });

  it('keeps a startup error visible when stale session detail arrives afterwards', async () => {
    apiPostMock.mockRejectedValue(new Error('request rejected'));
    let currentDetail = detail();
    const { result, rerender } = renderHook(
      () => useAguiSession(currentDetail.session.id, currentDetail),
      { wrapper: createWrapper() },
    );

    act(() => {
      expect(result.current.send('生成首版', undefined, 'design')).toBe(true);
    });
    await waitFor(() => expect(result.current.error).toBe('无法启动运行，请重试。'));

    currentDetail = detail('2026-07-21T10:00:02.000Z');
    rerender();

    expect(result.current.error).toBe('无法启动运行，请重试。');
  });

  it('can interrupt a durable run restored after the page reloads', () => {
    apiPostMock.mockResolvedValue(undefined);
    const currentDetail = detail();
    const { result } = renderHook(() => useAguiSession(currentDetail.session.id, currentDetail), {
      wrapper: createWrapper(),
    });

    act(() => result.current.interrupt('33333333-3333-4333-8333-333333333333'));

    expect(apiPostMock).toHaveBeenCalledWith(
      '/runtime/runs/33333333-3333-4333-8333-333333333333/interrupt',
    );
  });
});

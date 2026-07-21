import type { PropsWithChildren } from 'react';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiPostMock = vi.hoisted(() => vi.fn());

vi.mock('./client.js', () => ({
  apiGet: vi.fn(),
  apiPost: apiPostMock,
}));

import { useStudioTestRun } from './useStudioSession.js';

function createWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

describe('useStudioTestRun', () => {
  beforeEach(() => {
    apiPostMock.mockReset();
  });

  it('accepts only one test while the first request is starting', () => {
    apiPostMock.mockReturnValue(new Promise(() => undefined));
    const { result } = renderHook(() => useStudioTestRun('11111111-1111-4111-8111-111111111111'), {
      wrapper: createWrapper(),
    });

    act(() => {
      expect(result.current.run('22222222-2222-4222-8222-222222222222', '真实任务一')).toBe(true);
      expect(result.current.run('22222222-2222-4222-8222-222222222222', '真实任务二')).toBe(false);
    });

    expect(apiPostMock).toHaveBeenCalledTimes(1);
    expect(result.current.prompt).toBe('真实任务一');
  });
});

// 工作台数据层 hooks 测试（F-05）——能力表分页摊平后按 capabilityId 去重（与 /capabilities 同口径）。
//
// cursor 分页边界处后端可能重叠返回（同一 capabilityId 落在相邻两页）。useCapabilities 须摊平后去重，
// 否则同一能力出现两行。本测试翻第二页（边界 cap 重叠）后断言：累积行去重、保留首次出现、顺序稳定。
import type { ReactElement, ReactNode } from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { DashboardCapabilityRow } from '@cb/shared';
import { installFetchMock, type FetchMock } from '../../test/mockFetch.js';
import { useCapabilities } from './hooks.js';

function row(over: Partial<DashboardCapabilityRow> = {}): DashboardCapabilityRow {
  return {
    capabilityId: 'cap-1',
    versionId: 'v-1',
    slug: 'demo',
    name: '能力',
    tagline: '一句话简介',
    reviewStatus: 'published',
    statusLabel: '已上架',
    rejectReason: null,
    retryEditable: false,
    monthlyInvocations: null,
    spendSparkline: null,
    revenueMicros: null,
    publicPageAvailable: true,
    publishedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    ...over,
  };
}

/** Paginated 信封：data + meta.page。 */
function pageBody(
  rows: DashboardCapabilityRow[],
  opts: { hasMore?: boolean; nextCursor?: string | null } = {},
): unknown {
  return {
    data: rows,
    meta: {
      traceId: 't',
      page: {
        nextCursor: opts.nextCursor ?? null,
        hasMore: opts.hasMore ?? false,
        limit: 20,
        order: 'desc',
      },
    },
  };
}

function wrapper({ children }: { children: ReactNode }): ReactElement {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

let fm: FetchMock | undefined;
afterEach(() => {
  fm?.restore();
  fm = undefined;
});

describe('useCapabilities — 分页摊平去重', () => {
  it('翻第二页（边界 cap 重叠返回）→ 累积行按 capabilityId 去重，保留首次出现、不出重复行', async () => {
    // 第一页 [cap-1, cap-2]（hasMore），第二页边界重叠返回 [cap-2, cap-3]（cap-2 与上页重复）。
    fm = installFetchMock([
      {
        status: 200,
        json: pageBody([row({ capabilityId: 'cap-1' }), row({ capabilityId: 'cap-2' })], {
          hasMore: true,
          nextCursor: 'c2',
        }),
      },
      {
        status: 200,
        json: pageBody([row({ capabilityId: 'cap-2' }), row({ capabilityId: 'cap-3' })], {
          hasMore: false,
        }),
      },
    ]);

    const { result } = renderHook(() => useCapabilities('30d'), { wrapper });

    // 首页就位：cap-1, cap-2（无重复）。
    await waitFor(() =>
      expect(result.current.items.map((r) => r.capabilityId)).toEqual(['cap-1', 'cap-2']),
    );
    expect(result.current.hasMore).toBe(true);

    // 翻第二页：边界 cap-2 重叠返回 → 去重后累积 [cap-1, cap-2, cap-3]，cap-2 只出现一次。
    act(() => result.current.loadMore());
    await waitFor(() =>
      expect(result.current.items.map((r) => r.capabilityId)).toEqual(['cap-1', 'cap-2', 'cap-3']),
    );
    const ids = result.current.items.map((r) => r.capabilityId);
    expect(new Set(ids).size).toBe(ids.length); // 无重复行
    expect(result.current.hasMore).toBe(false);
  });
});

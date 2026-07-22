// 工作台 react-query hooks（F-05）——每端点一个 query，各自 loading/error/retry。
//
// 「拆 5 端点」的前端兑现（外壳首页-25）：summary / metrics / tokenTrend / capabilities / drafts
// 各 useQuery，互不连坐；某区块失败只在该区块出 ErrorState + 重试，外壳与其他区块照常。
// 分页（能力表 / 草稿条）用 useInfiniteQuery（cursor 原生累积，外壳首页-11）：点「加载更多」翻下一页。
import { useMemo } from 'react';
import { useQuery, useInfiniteQuery, type UseQueryResult } from '@tanstack/react-query';
import type {
  Range,
  DashboardSummary,
  DashboardMetrics,
  TokenTrend,
  DashboardCapabilityRow,
  DraftView,
  Meta,
  PageMeta,
} from '@cb/shared';
import {
  fetchSummary,
  fetchMetrics,
  fetchTokenTrend,
  fetchCapabilities,
  fetchDrafts,
  type EnvelopeResult,
  type PagedResult,
  type TrendMetric,
} from './api.js';
import { dedupeByCapabilityId } from './dedupe.js';

/** query key 命名空间（按端点 + range/metric 维度，切档自动重取）。 */
export const dashboardKeys = {
  summary: (range: Range) => ['dashboard', 'summary', range] as const,
  metrics: (range: Range) => ['dashboard', 'metrics', range] as const,
  tokenTrend: (range: Range, metric: TrendMetric) =>
    ['dashboard', 'token-trend', range, metric] as const,
  capabilities: (range: Range) => ['dashboard', 'capabilities', range] as const,
  drafts: () => ['dashboard', 'drafts'] as const,
};

export function useSummary(range: Range): UseQueryResult<EnvelopeResult<DashboardSummary>> {
  return useQuery({
    queryKey: dashboardKeys.summary(range),
    queryFn: ({ signal }) => fetchSummary(range, { signal }),
  });
}

export function useMetrics(range: Range): UseQueryResult<EnvelopeResult<DashboardMetrics>> {
  return useQuery({
    queryKey: dashboardKeys.metrics(range),
    queryFn: ({ signal }) => fetchMetrics(range, { signal }),
  });
}

export function useTokenTrend(
  range: Range,
  metric: TrendMetric,
): UseQueryResult<EnvelopeResult<TokenTrend>> {
  return useQuery({
    queryKey: dashboardKeys.tokenTrend(range, metric),
    queryFn: ({ signal }) => fetchTokenTrend(range, metric, { signal }),
  });
}

/**
 * 累积分页结果的统一形态（能力表 / 草稿条共用）。
 *   - items：所有已翻页累积后的全量行。
 *   - meta/page：最近一页 meta（含 placeholders + nextCursor/hasMore）。
 *   - loadMore：有下一页时翻页（追加，不替换）。
 *   - retry：重取（局部重试，不整页崩）。
 */
export interface PagedState<T> {
  items: T[];
  meta: Meta | undefined;
  page: PageMeta | undefined;
  isLoading: boolean;
  isFetching: boolean;
  isError: boolean;
  error: unknown;
  hasMore: boolean;
  loadMore: () => void;
  retry: () => void;
}

/**
 * 把 useInfiniteQuery 的多页结果摊平成 PagedState（最近一页 meta 作占位/分页源）。内含 useMemo，须由 hook 调用。
 * 可选 dedupe：摊平后按业务键去重（cursor 边界后端可能重叠返回同一项，否则会出重复行）。
 */
function useFlattenInfinite<T>(
  query: ReturnType<typeof useInfiniteQuery<PagedResult<T>, Error>>,
  dedupe?: (items: T[]) => T[],
): PagedState<T> {
  const pages = query.data?.pages ?? [];
  const items = useMemo(() => {
    const flat = pages.flatMap((p) => p.items);
    return dedupe ? dedupe(flat) : flat;
  }, [pages, dedupe]);
  const last = pages.length > 0 ? pages[pages.length - 1] : undefined;
  return {
    items,
    meta: last?.meta,
    page: last?.page,
    isLoading: query.isLoading,
    isFetching: query.isFetchingNextPage || query.isFetching,
    isError: query.isError,
    error: query.error,
    hasMore: query.hasNextPage,
    loadMore: () => {
      void query.fetchNextPage();
    },
    retry: () => {
      void query.refetch();
    },
  };
}

export function useCapabilities(range: Range): PagedState<DashboardCapabilityRow> {
  const query = useInfiniteQuery<PagedResult<DashboardCapabilityRow>, Error>({
    queryKey: dashboardKeys.capabilities(range),
    queryFn: ({ pageParam }) =>
      fetchCapabilities({ range, cursor: pageParam as string | undefined }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) =>
      lastPage.page?.hasMore ? (lastPage.page.nextCursor ?? undefined) : undefined,
  });
  // 摊平后按 capabilityId 去重（与 /capabilities 独立页同口径，dedupeByCapabilityId 单源）：
  //   cursor 边界后端重叠返回时同一能力不出两行；保留首次出现，旧行不被后页覆盖。
  return useFlattenInfinite(query, dedupeByCapabilityId);
}

export function useDrafts(): PagedState<DraftView> {
  const query = useInfiniteQuery<PagedResult<DraftView>, Error>({
    queryKey: dashboardKeys.drafts(),
    queryFn: ({ pageParam }) => fetchDrafts({ cursor: pageParam as string | undefined }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) =>
      lastPage.page?.hasMore ? (lastPage.page.nextCursor ?? undefined) : undefined,
    // 上传、提取和页面生成都可能在用户离开当前页后继续。入口页低频刷新同一份
    // Draft 真源，让“进行中的创作”无需手动刷新即可长出最新阶段。
    refetchInterval: 5_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });
  return useFlattenInfinite(query);
}

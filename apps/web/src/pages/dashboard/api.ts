// 工作台数据层（F-05）——5 个聚合端点各自取数（60 域 §1，「拆 5 端点」取舍）。
//
// 全部走 4A typed client：apiGetEnvelope（保留 meta：usage 占位 placeholders + 分页 page）。
// 每个端点独立函数 → 上层 react-query 各自 useQuery → 局部失败不连坐、局部重试（外壳首页-25）。
// 不在这里造任何 usage 数据：value 为 null + meta.placeholders 由后端给，前端只透传。
import { apiGetEnvelope, type RequestOptions } from '../../api/index.js';
import type {
  Meta,
  PageMeta,
  Range,
  DashboardSummary,
  DashboardMetrics,
  TokenTrend,
  DashboardCapabilityRow,
  DraftView,
  PageOrder,
} from '@cb/shared';

/** 趋势口径（与 TokenTrendChart 的 TrendMetric 同义；TokenTrend.metric 真源）。 */
export type TrendMetric = 'tokens' | 'invocations';

/** 单体端点返回：data + meta（meta 携 usage 占位 placeholders）。 */
export interface EnvelopeResult<T> {
  data: T;
  meta: Meta | undefined;
}

/** 分页端点返回：data[] + meta.page（cursor）+ meta.placeholders。 */
export interface PagedResult<T> {
  items: T[];
  page: PageMeta | undefined;
  meta: Meta | undefined;
}

function toPaged<T>(res: { data: T[]; meta?: Meta }): PagedResult<T> {
  return { items: res.data, page: res.meta?.page, meta: res.meta };
}

/** 1.1 页头经营摘要（外壳首页-08）。 */
export async function fetchSummary(
  range: Range,
  opts: RequestOptions = {},
): Promise<EnvelopeResult<DashboardSummary>> {
  const res = await apiGetEnvelope<DashboardSummary>('/dashboard/summary', {
    ...opts,
    query: { range },
  });
  return { data: res.data, meta: res.meta };
}

/** 1.2 四张大数字卡 + 环比（外壳首页-09）。 */
export async function fetchMetrics(
  range: Range,
  opts: RequestOptions = {},
): Promise<EnvelopeResult<DashboardMetrics>> {
  const res = await apiGetEnvelope<DashboardMetrics>('/dashboard/metrics', {
    ...opts,
    query: { range },
  });
  return { data: res.data, meta: res.meta };
}

/** 1.3 每日 token 消耗趋势（外壳首页-10），双口径 metric。 */
export async function fetchTokenTrend(
  range: Range,
  metric: TrendMetric,
  opts: RequestOptions = {},
): Promise<EnvelopeResult<TokenTrend>> {
  const res = await apiGetEnvelope<TokenTrend>('/dashboard/token-trend', {
    ...opts,
    query: { range, metric },
  });
  return { data: res.data, meta: res.meta };
}

export interface CapabilitiesParams {
  range: Range;
  cursor?: string | undefined;
  limit?: number | undefined;
  order?: PageOrder | undefined;
}

/** 1.4 能力体列表（外壳首页-11），cursor 分页。 */
export async function fetchCapabilities(
  params: CapabilitiesParams,
  opts: RequestOptions = {},
): Promise<PagedResult<DashboardCapabilityRow>> {
  const res = await apiGetEnvelope<DashboardCapabilityRow[]>('/dashboard/capabilities', {
    ...opts,
    query: {
      range: params.range,
      cursor: params.cursor,
      limit: params.limit,
      order: params.order,
    },
  });
  return toPaged(res);
}

export interface DraftsParams {
  cursor?: string | undefined;
  limit?: number | undefined;
  order?: PageOrder | undefined;
}

/** 1.5 草稿与上传中条（外壳首页-16），cursor 分页，真实数据（非 usage）。 */
export async function fetchDrafts(
  params: DraftsParams = {},
  opts: RequestOptions = {},
): Promise<PagedResult<DraftView>> {
  const res = await apiGetEnvelope<DraftView[]>('/dashboard/drafts', {
    ...opts,
    query: {
      cursor: params.cursor,
      limit: params.limit,
      order: params.order,
    },
  });
  return toPaged(res);
}

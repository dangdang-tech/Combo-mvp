// 个人主页数据层（F-06）——主聚合 + 4 个可独立加载/重试的分区子端点（60 域 §2，「主聚合 + 4 分区子端点」取舍）。
//
// 全部走 4A typed client：apiGetEnvelope（保留 meta：usage 占位 placeholders + 分页 page）。
// 主聚合一次返回六分区首屏切片（§2.0）；密度榜展开、热力图/网络/作品墙的「分区局部失败重试」走子端点。
// 公开只读：这里只取数，绝不发任何写命令、绝不查经营维度。usage 占位的值（null）与文案（placeholders）由后端给，前端只透传。
import { apiGetEnvelope, type RequestOptions } from '../../api/index.js';
import type {
  Meta,
  PageMeta,
  PageOrder,
  CreatorProfile,
  DensityRankRow,
  ProfileHeatmap,
  ProfileNetwork,
  WorkCard,
} from '@cb/shared';

/** 单体端点返回：data + meta（meta 携 usage 占位 placeholders / sectionErrors 由 data 内嵌）。 */
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

/** 2.0 主聚合：六分区首屏全量（§2.0，主页-01）。 */
export async function fetchProfile(
  creatorId: string,
  opts: RequestOptions = {},
): Promise<EnvelopeResult<CreatorProfile>> {
  const res = await apiGetEnvelope<CreatorProfile>(
    `/creators/${encodeURIComponent(creatorId)}/profile`,
    opts,
  );
  return { data: res.data, meta: res.meta };
}

export interface DensityParams {
  cursor?: string | undefined;
  limit?: number | undefined;
}

/** 2.3 能力按会话密度榜（§2.3，主页-05/06），cursor 分页（展开更多 / 局部重试）。 */
export async function fetchDensity(
  creatorId: string,
  params: DensityParams = {},
  opts: RequestOptions = {},
): Promise<PagedResult<DensityRankRow>> {
  const res = await apiGetEnvelope<DensityRankRow[]>(
    `/creators/${encodeURIComponent(creatorId)}/capabilities`,
    {
      ...opts,
      query: { byDensity: true, cursor: params.cursor, limit: params.limit },
    },
  );
  return toPaged(res);
}

/** 2.4 会话足迹热力图（§2.4，主页-09），半年格子（局部重试）。 */
export async function fetchHeatmap(
  creatorId: string,
  opts: RequestOptions = {},
): Promise<EnvelopeResult<ProfileHeatmap>> {
  const res = await apiGetEnvelope<ProfileHeatmap>(
    `/creators/${encodeURIComponent(creatorId)}/heatmap`,
    opts,
  );
  return { data: res.data, meta: res.meta };
}

/** 2.5 能力网络缩略（§2.5，主页-10），共现即时生成、仅缩略无展开（局部重试）。 */
export async function fetchNetwork(
  creatorId: string,
  opts: RequestOptions = {},
): Promise<EnvelopeResult<ProfileNetwork>> {
  const res = await apiGetEnvelope<ProfileNetwork>(
    `/creators/${encodeURIComponent(creatorId)}/network`,
    opts,
  );
  return { data: res.data, meta: res.meta };
}

export interface WorksParams {
  cursor?: string | undefined;
  limit?: number | undefined;
  order?: PageOrder | undefined;
}

/** 2.6 作品墙（§2.6，主页-11），cursor 分页（翻页 / 局部重试），按 B-30 单源过滤由后端完成。 */
export async function fetchWorks(
  creatorId: string,
  params: WorksParams = {},
  opts: RequestOptions = {},
): Promise<PagedResult<WorkCard>> {
  const res = await apiGetEnvelope<WorkCard[]>(`/creators/${encodeURIComponent(creatorId)}/works`, {
    ...opts,
    query: { cursor: params.cursor, limit: params.limit, order: params.order },
  });
  return toPaged(res);
}

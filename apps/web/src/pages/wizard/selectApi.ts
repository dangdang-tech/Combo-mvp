// STEP③ 候选数据层（F-12）——只为「选择」读 ready 候选（一句话类型 / 段数 / 置信度，§5.3）。
//
// 候选列表端点属【提取域 30】（`GET /api/v1/extract-jobs/{jobId}/candidates`，B-22）——非本模块所有。
// 本文件只做 STEP③ 选择必需的最小只读取数（不重定义提取域数据层、不碰其建任务/重试逻辑）；
// 续传回 STEP③ 时据 draft.extractJobId 重拉 ready 候选，渲染单选列表。诚实边界：STEP② 提取页若已持有
// 候选清单，可直接把 ready 候选作为 prop 传入 SelectStep（首选，省一次往返）；本 hook 仅服务「续传 / 直进
// STEP③ 无候选上下文」时的兜底取数。
import type { CandidateView } from '@cb/shared';
import { apiGetEnvelope, type RequestOptions } from '../../api/index.js';

/** 候选列表路径（提取域 30 §2.2；本模块只读不写）。 */
export function candidatesPath(extractJobId: string): string {
  return `/extract-jobs/${encodeURIComponent(extractJobId)}/candidates`;
}

export interface SelectCandidatesResult {
  /** ready 候选（STEP③ 只选已就绪的；generating/failed 不可选）。 */
  candidates: CandidateView[];
  nextCursor: string | undefined;
  hasMore: boolean;
}

/**
 * 读某次萃取的候选（STEP③ 单选列表数据源）。order=asc 与「逐个浮现」顺序一致（提取域口径）。
 * 仅取本步需要的字段交由 CandidateView 承载（name/type/segmentCount/confidence，§5.3 四项）。
 */
export async function fetchSelectCandidates(
  extractJobId: string,
  params: { cursor?: string | undefined; limit?: number | undefined } = {},
  opts: RequestOptions = {},
): Promise<SelectCandidatesResult> {
  const res = await apiGetEnvelope<CandidateView[]>(candidatesPath(extractJobId), {
    ...opts,
    query: {
      cursor: params.cursor,
      limit: params.limit,
      order: 'asc',
      // 只要可选的 ready 候选（与提取域 status 过滤口径一致）。
      status: 'ready',
    },
  });
  return {
    candidates: res.data,
    nextCursor: res.meta?.page?.nextCursor ?? undefined,
    hasMore: res.meta?.page?.hasMore ?? false,
  };
}

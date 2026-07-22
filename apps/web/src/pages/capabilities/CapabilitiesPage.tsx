// 我的 Agent（F-07，接 GET /api/v1/dashboard/capabilities，60 域 §1.4）。
//
// 已发布 / 草稿等 Agent 列表管理（按状态筛选 + cursor 分页）。合规要点：
//   - 复用工作台已建的 CapabilityTable（行渲染、状态徽章、真实可执行动作）——不另造行。
//   - 状态后端单源：reviewStatus / statusLabel / retryEditable / actions 全从后端派生，不前端自造。
//   - usage 列（本月调用 / 消耗 sparkline / 收益）统一占位（CapabilityTable 内部 UsagePlaceholder / MiniSparkline）。
//   - 管理页不展示尚未兑现的「试用」入口；真实试用从创作流程进入。
//   - 加载用 4A 加载件（Skeleton），错误用 ErrorState（只 userMessage + action）。
//   - 空态友好（区分「确实没有」与「该筛选下没有」），不裸转圈、不空白。
//   - 渲染在 4A Shell 主区（侧栏「我的 Agent」对应项），页面自身不重搭外壳。
//
// 分页用 useInfiniteQuery（cursor 原生累积，外壳首页-11）：点「加载更多」翻下一页 → 真追加，旧行不被替换。
// 多页累积后按 capabilityId 去重（防后端重叠返回时同一能力出现两行），保留首次出现（旧行口径不被覆盖）。
import { useMemo, useState, type ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';
import { useInfiniteQuery } from '@tanstack/react-query';
import type { DashboardCapabilityRow, Meta, PageMeta, Range } from '@cb/shared';
import { apiGetEnvelope } from '../../api/index.js';
import { ErrorState, LoadingState } from '../../components/index.js';
import { CapabilityTable } from '../dashboard/CapabilityTable.js';
import { dedupeByCapabilityId } from '../dashboard/dedupe.js';

/** 状态筛选档（与后端 DashboardCapabilitiesQuery.status 一致）。 */
export type CapabilityStatusFilter =
  | 'all'
  | 'alpha_pending'
  | 'published'
  | 'review_rejected'
  | 'draft';

const STATUS_FILTERS: ReadonlyArray<{ key: CapabilityStatusFilter; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'published', label: '已上架' },
  { key: 'alpha_pending', label: 'Alpha·审核中' },
  { key: 'draft', label: '草稿' },
  { key: 'review_rejected', label: '已退回' },
];

interface CapabilitiesPageResult {
  rows: DashboardCapabilityRow[];
  page: PageMeta;
  meta: Meta;
}

const EMPTY_PAGE: PageMeta = { nextCursor: null, hasMore: false, limit: 20, order: 'desc' };

/**
 * 拉一页能力体（带 status 筛选 + cursor 分页）。
 * 工作台共享 fetchCapabilities 不含 status 维度（其列表不筛选），故本页特有的状态筛选直调 typed client，
 * 但行渲染复用工作台 CapabilityTable，不重复造轮子。
 */
async function fetchCapabilitiesPage(params: {
  status: CapabilityStatusFilter;
  cursor: string | undefined;
  range: Range;
  signal: AbortSignal | undefined;
}): Promise<CapabilitiesPageResult> {
  const { data, meta } = await apiGetEnvelope<DashboardCapabilityRow[]>('/dashboard/capabilities', {
    query: {
      status: params.status,
      range: params.range,
      limit: 20,
      ...(params.cursor !== undefined ? { cursor: params.cursor } : {}),
    },
    ...(params.signal !== undefined ? { signal: params.signal } : {}),
  });
  return { rows: data, page: meta?.page ?? EMPTY_PAGE, meta: meta ?? {} };
}

export function CapabilitiesPage(): ReactElement {
  const navigate = useNavigate();
  const [status, setStatus] = useState<CapabilityStatusFilter>('all');
  const range: Range = '30d';

  const query = useInfiniteQuery<CapabilitiesPageResult, Error>({
    // 换筛选即换 queryKey → 新口径独立累积（旧筛选累积页不串台，cursor 自然回第一页，60 §1.6）。
    queryKey: ['capabilities-page', status, range],
    queryFn: ({ pageParam, signal }) =>
      fetchCapabilitiesPage({
        status,
        cursor: pageParam as string | undefined,
        range,
        signal,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) =>
      last.page.hasMore ? (last.page.nextCursor ?? undefined) : undefined,
  });
  const pages = query.data?.pages ?? [];
  // 真追加：摊平所有已翻页 → 去重（旧行不被替换）。最近一页 meta 作 usage 占位/分页源。
  const rows = useMemo(() => dedupeByCapabilityId(pages.flatMap((p) => p.rows)), [pages]);
  const lastPage = pages.length > 0 ? pages[pages.length - 1] : undefined;
  const lastMeta = lastPage?.meta ?? {};

  function changeFilter(next: CapabilityStatusFilter): void {
    setStatus(next); // queryKey 变化即重取第一页，旧累积弃用（换筛选回第一页，60 §1.6）。
  }

  const hasFilter = status !== 'all';
  const hasLoaded = query.data !== undefined;

  return (
    <section className="cb-page cb-capabilities" aria-labelledby="cb-capabilities-title">
      <header className="cb-page__head cb-page__head--split">
        <div className="cb-page__head-copy">
          <h2 className="cb-page__title" id="cb-capabilities-title">
            我的 Agent
          </h2>
          <p className="cb-page__lead">
            查看每个 Agent 的当前状态；公开版本可直接打开，新的创作从右上角开始。
          </p>
        </div>
        <button
          type="button"
          className="cb-btn cb-btn--primary"
          onClick={() => navigate('/create/import')}
        >
          创建 Agent
        </button>
      </header>

      {/* 状态筛选段控（当前档有选中标识）。 */}
      <div className="cb-capabilities__filters" role="group" aria-label="按状态筛选">
        {STATUS_FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            className={`cb-filter-chip${status === f.key ? ' cb-filter-chip--active' : ''}`}
            aria-pressed={status === f.key}
            onClick={() => changeFilter(f.key)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* 首屏加载（无任何已渲染数据）→ 骨架，永不裸转圈。 */}
      {query.isPending ? (
        <LoadingState skeletonRows={5} label="Agent 列表加载中" />
      ) : query.isError && !hasLoaded ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : hasLoaded && rows.length === 0 ? (
        <div className="cb-empty" role="status">
          <p className="cb-empty__title">{hasFilter ? '该筛选下还没有 Agent' : '还没有 Agent'}</p>
          <p className="cb-empty__hint">
            {hasFilter
              ? '换一个状态筛选，或创建你的第一个 Agent。'
              : '从「创建 Agent」开始，导入工作记录并生成你的第一个 Agent。'}
          </p>
          {hasFilter && (
            <button type="button" className="cb-empty__action" onClick={() => changeFilter('all')}>
              查看全部
            </button>
          )}
        </div>
      ) : hasLoaded ? (
        <>
          <CapabilityTable rows={rows} meta={lastMeta} />

          {/* 翻页：cursor 分页，hasMore 时给「加载更多」（追加，不替换；不做 total）。 */}
          <div className="cb-capabilities__pager">
            {query.hasNextPage ? (
              <button
                type="button"
                className="cb-pager__more"
                disabled={query.isFetchingNextPage}
                onClick={() => void query.fetchNextPage()}
              >
                {query.isFetchingNextPage ? '加载中…' : '加载更多'}
              </button>
            ) : (
              <p className="cb-pager__end">没有更多了</p>
            )}
          </div>
        </>
      ) : null}
    </section>
  );
}

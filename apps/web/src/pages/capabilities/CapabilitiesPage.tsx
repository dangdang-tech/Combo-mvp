// 能力页：GET /capabilities 列表（可按 ?taskId= 过滤），每项发布/下架 + 分享令牌 + 去试用。
// 发布是能力项上的标记动作：POST /capabilities/:id/publish|unpublish 返回 PublishResult，
// 就地合并进缓存（不整页重拉）。「去试用」跳 runtime-web（同域 /try/ 子路径）。
import { useMemo, useState, type ReactElement, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
  type InfiniteData,
} from '@tanstack/react-query';
import type { CapabilityView, PublishResult } from '@cb/shared';
import {
  listCapabilities,
  publishCapability,
  unpublishCapability,
  type Page,
} from '../../api/index.js';
import { ErrorState, Skeleton } from '../../components/index.js';
import { useDocumentTitle } from '../../shell/useDocumentTitle.js';
import { CapabilityRow } from './CapabilityRow.js';

type CapabilityPages = InfiniteData<Page<CapabilityView>>;

type CapabilityFilter = 'all' | 'published' | 'unpublished';

const CAPABILITY_FILTERS: ReadonlyArray<{ key: CapabilityFilter; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'published', label: '已上架' },
  { key: 'unpublished', label: '未上架' },
];

/** 把 PublishResult 就地合并进列表缓存（所有 capabilities 查询键，含带 taskId 过滤的）。 */
export function mergePublishResult(
  data: CapabilityPages | undefined,
  result: PublishResult,
): CapabilityPages | undefined {
  if (!data) return data;
  return {
    ...data,
    pages: data.pages.map((page) => ({
      ...page,
      items: page.items.map((item) =>
        item.id === result.id
          ? {
              ...item,
              published: result.published,
              ...(result.publishedAt !== undefined ? { publishedAt: result.publishedAt } : {}),
              // 下架保留 share_token（后端语义）；publish 结果缺省时也不清掉已有的。
              ...(result.shareToken !== undefined ? { shareToken: result.shareToken } : {}),
            }
          : item,
      ),
    })),
  };
}

export function CapabilitiesPage(): ReactElement {
  const [params] = useSearchParams();
  const taskId = params.get('taskId') ?? undefined;
  const [filter, setFilter] = useState<CapabilityFilter>('all');
  useDocumentTitle(taskId ? '本次提取结果 · Combo' : '我的能力 · Combo');
  const qc = useQueryClient();

  const capsQuery = useInfiniteQuery({
    queryKey: ['capabilities', taskId ?? null],
    queryFn: ({ pageParam }) =>
      listCapabilities({
        ...(taskId ? { taskId } : {}),
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    initialPageParam: '',
    getNextPageParam: (last) => last.page.nextCursor ?? undefined,
  });

  const toggleMutation = useMutation({
    mutationFn: (input: { id: string; publish: boolean }) =>
      input.publish ? publishCapability(input.id) : unpublishCapability(input.id),
    onSuccess: (result) => {
      qc.setQueriesData<CapabilityPages>({ queryKey: ['capabilities'] }, (data) =>
        mergePublishResult(data, result),
      );
    },
  });

  const items = capsQuery.data?.pages.flatMap((p) => p.items) ?? [];
  const visibleItems = useMemo(
    () =>
      items.filter((cap) => {
        if (filter === 'all') return true;
        return filter === 'published' ? cap.published : !cap.published;
      }),
    [filter, items],
  );

  let body: ReactNode;
  if (capsQuery.isPending) {
    body = <Skeleton rows={4} label="正在加载能力列表" />;
  } else if (capsQuery.isError) {
    body = <ErrorState error={capsQuery.error} onRetry={() => void capsQuery.refetch()} />;
  } else if (items.length === 0) {
    body = (
      <div className="cb-empty">
        <p className="cb-empty__title">{taskId ? '这个任务还没有能力项' : '还没有能力项'}</p>
        <p className="cb-empty__hint">先在任务页上传对话历史，提取完成后能力项会出现在这里。</p>
        <Link className="cb-empty__action" to="/tasks">
          去任务页
        </Link>
      </div>
    );
  } else {
    body = (
      <>
        <div className="cb-capabilities__filters" role="group" aria-label="按发布状态筛选">
          {CAPABILITY_FILTERS.map((item) => (
            <button
              key={item.key}
              type="button"
              className={`cb-filter-chip${filter === item.key ? ' cb-filter-chip--active' : ''}`}
              aria-pressed={filter === item.key}
              onClick={() => setFilter(item.key)}
            >
              {item.label}
            </button>
          ))}
        </div>

        {visibleItems.length === 0 ? (
          <div className="cb-empty cb-capabilities__filtered-empty" role="status">
            <p className="cb-empty__title">该筛选下还没有能力项</p>
            <p className="cb-empty__hint">切换状态，或继续加载更多能力项。</p>
            <button type="button" className="cb-empty__action" onClick={() => setFilter('all')}>
              查看全部
            </button>
          </div>
        ) : (
          <div className="cb-cap-table-wrap">
            <table className="cb-cap-table" aria-label={taskId ? '本次提取能力项' : '我的能力'}>
              <thead>
                <tr>
                  <th scope="col">能力体</th>
                  <th scope="col">状态</th>
                  <th scope="col">本月调用</th>
                  <th scope="col">消耗趋势</th>
                  <th scope="col">收益</th>
                  <th scope="col">操作</th>
                </tr>
              </thead>
              <tbody>
                {visibleItems.map((cap) => (
                  <CapabilityRow
                    key={cap.id}
                    cap={cap}
                    pending={toggleMutation.isPending && toggleMutation.variables?.id === cap.id}
                    onToggle={(publish) => toggleMutation.mutate({ id: cap.id, publish })}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="cb-pager">
          {capsQuery.hasNextPage ? (
            <button
              type="button"
              className="cb-pager__more"
              onClick={() => void capsQuery.fetchNextPage()}
              disabled={capsQuery.isFetchingNextPage}
            >
              {capsQuery.isFetchingNextPage ? '加载中…' : '加载更多'}
            </button>
          ) : (
            <p className="cb-pager__end">没有更多了</p>
          )}
        </div>
      </>
    );
  }

  return (
    <section className="cb-page" aria-labelledby="cb-caps-title">
      <div className="cb-page__head">
        <h2 className="cb-page__title" id="cb-caps-title">
          {taskId ? '本次提取结果' : '我的能力'}
        </h2>
        <p className="cb-page__lead">
          {taskId
            ? '这次上传提取出的能力项：查看状态、发布、试用与分享。'
            : '管理你创建的能力体：查看状态、发布、试用与分享。'}
        </p>
      </div>

      {toggleMutation.isError && <ErrorState error={toggleMutation.error} />}
      {body}
    </section>
  );
}

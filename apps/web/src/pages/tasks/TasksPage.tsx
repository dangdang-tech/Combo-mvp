// 任务页（默认页）：「新建上传任务」+ 任务列表（游标分页）。
// 建任务成功 → PairingCard 展示配对码（明文仅此一次）+ 助手连接命令；行点入任务详情看实时进度。
import { useState, type ReactElement, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { CreateTaskResult, TaskView } from '@cb/shared';
import { createTask, listTasks } from '../../api/index.js';
import { ErrorState, Skeleton } from '../../components/index.js';
import { useDocumentTitle } from '../../shell/useDocumentTitle.js';
import { PairingCard } from './PairingCard.js';
import {
  formatTime,
  taskStatusLabel,
  taskStatusVariant,
  taskTitle,
  uploadProgressLabel,
} from './taskPresent.js';

export function TasksPage(): ReactElement {
  useDocumentTitle('上传任务 · Combo');
  const qc = useQueryClient();
  const [created, setCreated] = useState<CreateTaskResult | null>(null);

  const tasksQuery = useInfiniteQuery({
    queryKey: ['tasks'],
    queryFn: ({ pageParam }) => listTasks({ ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: '',
    getNextPageParam: (last) => last.page.nextCursor ?? undefined,
  });

  const createMutation = useMutation({
    mutationFn: () => createTask(),
    onSuccess: (result) => {
      setCreated(result);
      void qc.invalidateQueries({ queryKey: ['tasks'] });
    },
  });

  const tasks = tasksQuery.data?.pages.flatMap((p) => p.items) ?? [];
  const runningCount = tasks.filter((task) => task.status === 'running').length;
  const completedCount = tasks.filter((task) => task.status === 'succeeded').length;
  const capabilityCount = tasks.reduce((sum, task) => sum + task.capabilityCount, 0);

  let listBody: ReactNode;
  if (tasksQuery.isPending) {
    listBody = <Skeleton rows={4} label="正在加载任务列表" />;
  } else if (tasksQuery.isError) {
    listBody = <ErrorState error={tasksQuery.error} onRetry={() => void tasksQuery.refetch()} />;
  } else if (tasks.length === 0) {
    listBody = (
      <div className="cb-empty">
        <p className="cb-empty__title">还没有上传任务</p>
        <p className="cb-empty__hint">新建一个任务，把你的对话历史变成可分享的能力。</p>
        <button
          type="button"
          className="cb-empty__action"
          onClick={() => createMutation.mutate()}
          disabled={createMutation.isPending}
        >
          新建第一个任务
        </button>
      </div>
    );
  } else {
    listBody = (
      <>
        <table className="cb-table cb-tasks-table">
          <thead>
            <tr>
              <th scope="col">任务</th>
              <th scope="col">状态</th>
              <th scope="col">上传进度</th>
              <th scope="col">能力项</th>
              <th scope="col">说明</th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((t) => (
              <TaskRow key={t.id} task={t} />
            ))}
          </tbody>
        </table>
        <div className="cb-pager">
          {tasksQuery.hasNextPage ? (
            <button
              type="button"
              className="cb-pager__more"
              onClick={() => void tasksQuery.fetchNextPage()}
              disabled={tasksQuery.isFetchingNextPage}
            >
              {tasksQuery.isFetchingNextPage ? '加载中…' : '加载更多'}
            </button>
          ) : (
            <p className="cb-pager__end">没有更多了</p>
          )}
        </div>
      </>
    );
  }

  return (
    <section className="cb-page cb-page--tasks" aria-labelledby="cb-tasks-title">
      <div className="cb-page__head cb-page__head--split">
        <div>
          <h2 className="cb-page__title" id="cb-tasks-title">
            上传任务
          </h2>
          <p className="cb-page__lead">
            新建任务拿到配对码，在本机跑一条命令上传对话历史；云端自动提取成能力项。
          </p>
        </div>
        <button
          type="button"
          className="cb-primary-btn"
          onClick={() => createMutation.mutate()}
          disabled={createMutation.isPending}
        >
          {createMutation.isPending ? '正在创建…' : '新建上传任务'}
        </button>
      </div>

      {createMutation.isError && (
        <ErrorState error={createMutation.error} onRetry={() => createMutation.mutate()} />
      )}
      {created && <PairingCard created={created} onDismiss={() => setCreated(null)} />}

      <div className="cb-tasks-panel">
        <div className="cb-tasks-panel__header">
          <div>
            <p className="cb-section-kicker">任务列表</p>
            <h3 className="cb-tasks-panel__title">上传与提取队列</h3>
            <p className="cb-tasks-panel__hint">
              每个任务都会保留上传进度、提取状态和生成的能力数量。
            </p>
          </div>
          <dl className="cb-tasks-stats" aria-label="任务概览">
            <div>
              <dt>运行中</dt>
              <dd>{runningCount}</dd>
            </div>
            <div>
              <dt>已完成</dt>
              <dd>{completedCount}</dd>
            </div>
            <div>
              <dt>能力项</dt>
              <dd>{capabilityCount}</dd>
            </div>
          </dl>
        </div>
        <div className="cb-tasks-panel__body">{listBody}</div>
      </div>
    </section>
  );
}

function TaskRow({ task }: { task: TaskView }): ReactElement {
  return (
    <tr>
      <td>
        <Link className="cb-task-link" to={`/tasks/${task.id}`}>
          {taskTitle(task)}
        </Link>
        <p className="cb-task-time">{formatTime(task.createdAt)}</p>
      </td>
      <td>
        <span className={`cb-status-badge is-${taskStatusVariant(task)}`}>
          {taskStatusLabel(task)}
        </span>
      </td>
      <td>{uploadProgressLabel(task)}</td>
      <td>{task.capabilityCount > 0 ? `${task.capabilityCount} 个` : '—'}</td>
      <td className="cb-task-note">
        {task.status === 'failed' && task.lastError ? (
          <span className="cb-task-error">{task.lastError.userMessage}</span>
        ) : task.status === 'succeeded' ? (
          <Link to={`/capabilities?taskId=${task.id}`}>查看能力项</Link>
        ) : (
          '—'
        )}
      </td>
    </tr>
  );
}

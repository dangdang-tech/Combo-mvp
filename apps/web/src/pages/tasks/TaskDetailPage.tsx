// 任务详情：GET /tasks/:id + SSE GET /tasks/:id/events 实时进度。
//   - 进行中 / 失败：任务头 + 上传进度卡 + 提取进度卡（SSE）+（有产出时）能力挑选区 + 失败重试卡；
//   - 提取完成（succeeded）：整页切换成成果形态——eyebrow + 衬线大标题 + 引导句 + 能力挑选区
//     （统计工具条 / 勾选行卡 / 一键发布），上传与进度卡不再渲染。
//   - state_snapshot 全量 progress（subtasks 逐条点亮）+ progress 增量帧；
//   - item-appended 帧触发能力项列表刷新（边提取边出现，刷新页面不丢）；
//   - done 帧终态 → 重拉任务定格视图。
import { useEffect, type ReactElement } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CapabilityView, TaskView } from '@cb/shared';
import {
  getTask,
  listCapabilities,
  retryTask,
  taskEventsUrl,
  useTaskEvents,
  type Page,
} from '../../api/index.js';
import {
  ErrorState,
  ProgressBar,
  Skeleton,
  SlowHint,
  SubtaskChecklist,
} from '../../components/index.js';
import { useDocumentTitle } from '../../shell/useDocumentTitle.js';
import { CapabilityPicker } from './CapabilityPicker.js';
import {
  formatTime,
  taskStatusLabel,
  taskStatusVariant,
  taskTitle,
  uploadProgressLabel,
} from './taskPresent.js';

export function TaskDetailPage(): ReactElement {
  useDocumentTitle('任务详情 · Combo');
  const { taskId = '' } = useParams();
  const qc = useQueryClient();

  const taskQuery = useQuery({
    queryKey: ['task', taskId],
    queryFn: () => getTask(taskId),
    enabled: taskId.length > 0,
    // 上传阶段没有 SSE 帧（分片计数在任务视图里），跑着的任务轮询兜底刷新；终态停。
    refetchInterval: (query) => (query.state.data?.status === 'running' ? 3000 : false),
  });
  const task = taskQuery.data;

  // 只有在跑的任务才建流；SSE 定终态后重拉任务（capabilityCount / lastError 定格）。
  const sse = useTaskEvents(task ? taskEventsUrl(task.id) : null, {
    enabled: task?.status === 'running',
  });
  const sseTerminal = sse.status === 'done' || (sse.status === 'error' && !!sse.done);
  useEffect(() => {
    if (sseTerminal) void qc.invalidateQueries({ queryKey: ['task', taskId] });
  }, [sseTerminal, qc, taskId]);

  // 本任务提取出的能力项（就地展示挑选发布）。SSE 每推一个 item-appended
  // 就触发一次重拉——列表以库为真源，刷新页面不丢。
  const extracting = task?.status === 'running' && task.currentStep === 'extract';
  const capsQuery = useQuery({
    queryKey: ['task-capabilities', taskId],
    queryFn: () => listCapabilities({ taskId, limit: 50 }),
    enabled: taskId.length > 0 && (extracting || task?.status === 'succeeded'),
  });
  useEffect(() => {
    if (sse.items.length > 0) {
      void qc.invalidateQueries({ queryKey: ['task-capabilities', taskId] });
    }
  }, [sse.items.length, qc, taskId]);

  const retryMutation = useMutation({
    mutationFn: () => retryTask(taskId),
    onSuccess: (view) => {
      qc.setQueryData(['task', taskId], view); // 立即回 running，重新建流。
    },
  });

  if (taskQuery.isPending) return <Skeleton rows={5} label="正在加载任务" />;
  if (taskQuery.isError) {
    return <ErrorState error={taskQuery.error} onRetry={() => void taskQuery.refetch()} />;
  }
  if (!task) return <ErrorState error={undefined} />;

  // —— 提取完成：整页成果形态（eyebrow + 大标题 + 引导 + 挑选发布区）——
  if (task.status === 'succeeded') {
    return (
      <section className="cb-page cb-capabilities" aria-labelledby="cb-task-detail-title">
        <p className="cb-page__back">
          <Link to="/tasks">← 返回任务列表</Link>
        </p>
        <header className="cb-capabilities__header">
          <p className="cb-capabilities__eyebrow">提取完成 · 能力</p>
          <h2 className="cb-capabilities__title" id="cb-task-detail-title">
            你的能力，挑选后一键发布
          </h2>
          <p className="cb-capabilities__lead">
            这次上传共提取出 {task.capabilityCount}{' '}
            个能力项。点任意一项可直接打开「试用」跑一遍，确认后勾选、一键发布到市集；历史全部能力项在{' '}
            <Link to="/capabilities">能力页</Link>。
          </p>
        </header>
        <TaskCapabilitiesArea taskId={taskId} task={task} query={capsQuery} extracting={false} />
      </section>
    );
  }

  // —— 进行中 / 失败：任务头 + 进度卡（+ 已浮现的能力挑选区）+ 失败重试卡 ——
  return (
    <section className="cb-page" aria-labelledby="cb-task-detail-title">
      <p className="cb-page__back">
        <Link to="/tasks">← 返回任务列表</Link>
      </p>
      <div className="cb-page__head">
        <h2 className="cb-page__title" id="cb-task-detail-title">
          {taskTitle(task)}
        </h2>
        <p className="cb-page__lead">
          创建于 {formatTime(task.createdAt)} ·{' '}
          <span className={`cb-status-badge is-${taskStatusVariant(task)}`}>
            {taskStatusLabel(task)}
          </span>
        </p>
      </div>

      <UploadCard task={task} />
      {extracting && <ExtractCard sse={sse} />}
      {extracting && (
        <TaskCapabilitiesArea taskId={taskId} task={task} query={capsQuery} extracting />
      )}
      {task.status === 'failed' && (
        <FailedCard
          task={task}
          onRetry={() => retryMutation.mutate()}
          retryPending={retryMutation.isPending}
          retryError={retryMutation.isError ? retryMutation.error : null}
        />
      )}
    </section>
  );
}

/** 上传阶段卡：分片进度 + 配对提示。 */
function UploadCard({ task }: { task: TaskView }): ReactElement {
  const waiting = task.currentStep === 'upload' && task.status === 'running';
  const hasProgress = task.upload.partsExpected != null && task.upload.partsExpected > 0;
  const progressRatio = hasProgress
    ? Math.min(1, task.upload.partsLanded / task.upload.partsExpected!)
    : 0;
  const detailLine = uploadDetailLine(task);
  return (
    <div className={`cb-card cb-upload-card${waiting ? ' cb-upload-card--waiting' : ''}`}>
      <div className="cb-upload-card__top">
        <p className="cb-section-kicker">上传</p>
        <span className={`cb-status-badge is-${taskStatusVariant(task)}`}>
          {uploadProgressLabel(task)}
        </span>
      </div>
      <h3 className="cb-card__title">
        {waiting && !hasProgress ? '等待本机助手连接' : '正在接收对话历史'}
      </h3>
      {hasProgress && (
        <div
          className="cb-upload-card__meter"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progressRatio * 100)}
        >
          <span style={{ width: `${progressRatio * 100}%` }} />
        </div>
      )}
      <p className="cb-card__line">{detailLine}</p>
      {waiting && (
        <>
          <div className="cb-upload-card__steps" aria-label="上传步骤">
            <span className="is-active">连接助手</span>
            <span>上传分片</span>
            <span>进入提取</span>
          </div>
          <p className="cb-card__hint">
            在本机运行建任务时给出的连接命令即可开始上传（配对码有效期至{' '}
            {formatTime(task.upload.pairingExpiresAt)}
            ）；配对码过期或丢失时，回任务列表重新建一个任务。
          </p>
        </>
      )}
    </div>
  );
}

function uploadDetailLine(task: TaskView): string {
  const { partsExpected, partsLanded, status } = task.upload;
  if (status === 'processed') {
    if (partsExpected != null) return `已接收 ${partsLanded} / ${partsExpected} 片，进入提取阶段`;
    return '上传内容已接收，进入提取阶段';
  }
  if (partsExpected != null) return `本机助手正在上传 ${partsLanded} / ${partsExpected} 片`;
  if (partsLanded > 0) return `本机助手已上传 ${partsLanded} 片`;
  return '运行连接命令后，这里会显示实时分片进度';
}

/** 提取阶段卡：SSE 实时进度（进度条 + 子任务点亮 + 慢提示 + 重连安抚）。 */
function ExtractCard({ sse }: { sse: ReturnType<typeof useTaskEvents> }): ReactElement {
  return (
    <div className="cb-card" data-sse-status={sse.status}>
      <h3 className="cb-card__title">提取</h3>
      {sse.status === 'reconnecting' && (
        <p className="cb-card__reconnect" role="status" aria-live="polite">
          连接断了，正在自动重连…（进度不会丢）
        </p>
      )}
      {sse.progress ? (
        <>
          <ProgressBar progress={sse.progress} />
          {sse.progress.subtasks.length > 0 && (
            <SubtaskChecklist subtasks={sse.progress.subtasks} />
          )}
        </>
      ) : (
        <Skeleton rows={2} label="正在连接进度流" />
      )}
      <SlowHint slowHint={sse.slowHint} />
    </div>
  );
}

/** 能力挑选区的查询三态收口：错误给人话重试、空给引导、有货交给 CapabilityPicker。 */
function TaskCapabilitiesArea({
  taskId,
  task,
  query,
  extracting,
}: {
  taskId: string;
  task: TaskView;
  query: ReturnType<typeof useQuery<Page<CapabilityView>>>;
  extracting: boolean;
}): ReactElement | null {
  if (query.isError) {
    return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  }
  if (!query.isSuccess) {
    // 提取中列表还没到，不占版面；完成态给骨架（避免大标题下空一块）。
    return extracting ? null : <Skeleton rows={3} label="正在加载能力项" />;
  }
  const items = query.data.items;
  if (items.length === 0) {
    if (extracting) return null; // 还在提取、暂无产出：进度卡已经在讲话
    return (
      <p className="cb-capabilities__empty">
        没识别出可复用的能力。可以回任务列表换一批会话再上传试试。
      </p>
    );
  }
  return <CapabilityPicker taskId={taskId} task={task} items={items} extracting={extracting} />;
}

/** 失败卡：人话 lastError + 重试。 */
function FailedCard({
  task,
  onRetry,
  retryPending,
  retryError,
}: {
  task: TaskView;
  onRetry: () => void;
  retryPending: boolean;
  retryError: unknown;
}): ReactElement {
  return (
    <div className="cb-card cb-card--failed">
      <h3 className="cb-card__title">这次没成功</h3>
      {task.lastError ? (
        <p className="cb-card__line cb-task-error">{task.lastError.userMessage}</p>
      ) : (
        <p className="cb-card__line cb-task-error">任务失败了，可以重试一次。</p>
      )}
      {task.retryCount > 0 && <p className="cb-card__hint">已重试 {task.retryCount} 次。</p>}
      <button type="button" className="cb-primary-btn" onClick={onRetry} disabled={retryPending}>
        {retryPending ? '正在重试…' : '重试'}
      </button>
      {retryError != null && <ErrorState error={retryError} onRetry={onRetry} />}
    </div>
  );
}

// STEP① 导入页容器（F-10，开工总纲 §5.1）——空态 → 配对 → SSE 加载 → 完成 的状态编排。
//
// 链路（主路径浏览器直传，BUG-013；本机助手 / CURL 为高级入口）：
//   1. 空态 ImportEmptyState：主卡「从浏览器导入」选文件/目录/拖拽 → useBrowserImport 编排 → 进上传中态。
//      高级入口点「开始导入」→ createPair 铸码 → 进配对态。
//   2. 上传中态 BrowserUploadProgress：presign → 分批 PUT 进度条 → 拿 jobId 进加载态（断点续传/重试）。
//   3. 配对态 CommandBox：展示一行命令 + usePairPolling 轮询 → 拿 jobId 进加载态。
//   4. 加载态 ImportLoading：useSSE(job 流) 三层进度 + 落库卡逐条 + 取消；done.result.snapshotId → 完成。
//   5. 完成态：取快照统计后【自动进入能力页】/create/capabilities（带 snapshotId + draftId；PRD：传完自动进入提取，无需手动点下一步）。
// 续传（F-15）：URL ?jobId= / ?snapshotId= 深链直进加载态 / 完成态（工作台草稿条可带）。
// 退路：整体失败由 useSSE error → StreamLoading 内 ErrorState（重试重连）；两次失败 markStepError('import')。
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { PairResult, SnapshotView, SnapshotSegmentView, DonePayload } from '@cb/shared';
import { ApiError, useSSE, type UseSSEState } from '../../../api/index.js';
import { ErrorState, LoadingState } from '../../../components/index.js';
import { findDraftById, useWizard, useBootstrapDraft } from '../../wizard/index.js';
import { ImportEmptyState } from './ImportEmptyState.js';
import { BrowserUploadProgress } from './BrowserUploadProgress.js';
import { useBrowserImport } from './useBrowserImport.js';
import { CommandBox } from './CommandBox.js';
import { ImportLoading } from './ImportLoading.js';
import { ImportComplete } from './ImportComplete.js';
import { usePairPolling } from './usePairPolling.js';
import {
  createPair,
  cancelImportJob,
  fetchSnapshot,
  fetchSnapshotSegments,
  importJobEventsUrl,
} from './importApi.js';

type Phase =
  | { kind: 'empty' }
  | { kind: 'uploading' } // 浏览器直传中（BUG-013）：presign → 分批 PUT，进度由 useBrowserImport 承载
  | { kind: 'pairing'; pair: PairResult }
  | { kind: 'loading'; jobId: string }
  | { kind: 'restoring' } // 深链 ?snapshotId=：异步取完成态前的占位
  | { kind: 'complete'; snapshot: SnapshotView; segments: SnapshotSegmentView[] };

/** 兜底人话 ApiError（取数失败时，永不裸错）。 */
function fallbackError(userMessage: string): ApiError {
  return new ApiError({ error: { userMessage, retriable: true, action: 'retry', traceId: '' } });
}

/** done.result.snapshotId 安全取（done.result 是 unknown）。 */
function snapshotIdFromDone(done: DonePayload | undefined): string | undefined {
  const result = done?.result;
  if (result && typeof result === 'object' && 'snapshotId' in result) {
    const id = (result as { snapshotId?: unknown }).snapshotId;
    if (typeof id === 'string') return id;
  }
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * SSE 加载子组件：订阅导入 job 流并渲染三层加载态。
 * 用 key={jobId+attempt} 挂载本组件即可整条重订阅（重试重连），URL 不变靠 remount 触发新流。
 */
function ImportJobStream({
  jobId,
  onDone,
  onDoneWithoutSnapshot,
  onError,
  onCancel,
  cancelling,
  onRetry,
}: {
  jobId: string;
  onDone: (snapshotId: string) => void;
  onDoneWithoutSnapshot: () => void;
  onError: () => void;
  onCancel: () => void;
  cancelling: boolean;
  onRetry: () => void;
}): ReactElement {
  const sse: UseSSEState = useSSE(importJobEventsUrl(jobId), 'job');
  const doneSnapshotId = snapshotIdFromDone(sse.done);
  const fallbackStartedRef = useRef(false);

  useEffect(() => {
    if (sse.status === 'done' && doneSnapshotId) onDone(doneSnapshotId);
  }, [sse.status, doneSnapshotId, onDone]);

  useEffect(() => {
    if (fallbackStartedRef.current) return;
    const progress = sse.progress;
    const completedSnapshot =
      progress?.percent === 100 &&
      progress.subtasks.length > 0 &&
      progress.subtasks.every((task) => task.status === 'done');
    const doneWithoutSnapshot = sse.status === 'done' && !doneSnapshotId;
    if (!doneWithoutSnapshot && !completedSnapshot) return;
    fallbackStartedRef.current = true;
    onDoneWithoutSnapshot();
  }, [sse.status, sse.progress, doneSnapshotId, onDoneWithoutSnapshot]);

  useEffect(() => {
    if (sse.status === 'error') onError();
  }, [sse.status, onError]);

  return (
    <ImportLoading state={sse} onCancel={onCancel} cancelling={cancelling} onRetry={onRetry} />
  );
}

export function ImportStepPage(): ReactElement {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const {
    draftId,
    snapshotId: ctxSnapshotId,
    setSnapshotId,
    markStepError,
    clearStepError,
  } = useWizard();

  // 深链续传：?snapshotId= 直进完成态、?jobId= 直进加载态（工作台草稿条可带）；?draftId= 续传带入。
  const urlJobId = searchParams.get('jobId') ?? undefined;
  const urlSnapshotId = searchParams.get('snapshotId') ?? undefined;
  const urlDraftId = searchParams.get('draftId') ?? undefined;
  const activeDraftId = draftId ?? urlDraftId;

  // 草稿 bootstrap（P0-2，续传基线）：全新进入（无 draftId、无 snapshot/job 深链）即建真实草稿，拿 draftId
  //   贯穿 WizardContext + 续传 URL。续传 / 回看（有任一来源）不建。失败就地 ErrorState + 重试（永不裸错）。
  const needsBootstrap = !draftId && !urlDraftId && !urlSnapshotId && !urlJobId;
  const bootstrap = useBootstrapDraft({ needsBootstrap });

  // 新建出 draftId 后回写续传 URL（?draftId=）：刷新 / 分享即精确续传基线；replace 不堆历史。
  useEffect(() => {
    if (!draftId || urlDraftId === draftId) return;
    const next = new URLSearchParams(searchParams);
    next.set('draftId', draftId);
    setSearchParams(next, { replace: true });
  }, [draftId, urlDraftId, searchParams, setSearchParams]);

  const initialPhase: Phase = urlSnapshotId
    ? { kind: 'restoring' }
    : urlJobId
      ? { kind: 'loading', jobId: urlJobId }
      : { kind: 'empty' };

  const [phase, setPhase] = useState<Phase>(initialPhase);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<ApiError | null>(null);
  const [copied, setCopied] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  // 重试 nonce：递增即 remount ImportJobStream 整条重订阅。
  const [attempt, setAttempt] = useState(0);
  // SSE 整体失败次数（两次失败 → markStepError，开工总纲 §八②）。
  const failCountRef = useRef(0);

  // 配对轮询（仅 pairing 态有 pairId）。
  const pairId = phase.kind === 'pairing' ? phase.pair.pairId : undefined;
  const poll = usePairPolling(pairId);

  // 浏览器直传编排（BUG-013 主路径）：选文件 → presign → 分批 PUT → 建 Job → 拿 jobId 转 SSE 加载态。
  //   拿到 jobId 即进现有 loading 链路复用（jobId → SSE → 完成态）。
  const browserImport = useBrowserImport({
    onJobId: (jobId) => setPhase({ kind: 'loading', jobId }),
    ...(activeDraftId ? { draftId: activeDraftId } : {}),
  });

  // 配对拿到 jobId → 进加载态。
  useEffect(() => {
    if (phase.kind === 'pairing' && poll.jobId) {
      setPhase({ kind: 'loading', jobId: poll.jobId });
    }
  }, [phase, poll.jobId]);

  // 取完成态快照（snapshotId 来自 SSE done 或深链 ?snapshotId=）。
  const loadComplete = useCallback(
    async (snapshotId: string): Promise<void> => {
      try {
        const [snapshot, segs] = await Promise.all([
          fetchSnapshot(snapshotId),
          fetchSnapshotSegments(snapshotId, { limit: 30 }),
        ]);
        clearStepError('import');
        failCountRef.current = 0;
        setPhase({ kind: 'complete', snapshot, segments: segs.segments });
      } catch (e) {
        setStartError(e instanceof ApiError ? e : fallbackError('导入结果加载失败，请稍后重试。'));
      }
    },
    [clearStepError],
  );

  const navigateToCapabilities = useCallback(
    (snapshotId: string): void => {
      setSnapshotId(snapshotId);
      const dq = activeDraftId ? `&draftId=${encodeURIComponent(activeDraftId)}` : '';
      navigate(`/create/capabilities?snapshotId=${encodeURIComponent(snapshotId)}${dq}`);
    },
    [activeDraftId, navigate, setSnapshotId],
  );

  const resolveCompletedSnapshotFromDraft = useCallback(async (): Promise<void> => {
    if (!activeDraftId) {
      setStartError(fallbackError('导入已完成，但没拿到结果地址。请刷新后重试。'));
      return;
    }
    try {
      for (let i = 0; i < 6; i += 1) {
        const draft = await findDraftById(activeDraftId);
        if (draft?.snapshotId) {
          await loadComplete(draft.snapshotId);
          return;
        }
        await sleep(800);
      }
      setStartError(fallbackError('导入结果还在收尾，请稍后刷新重试。'));
    } catch (e) {
      setStartError(e instanceof ApiError ? e : fallbackError('导入结果加载失败，请稍后重试。'));
    }
  }, [activeDraftId, loadComplete]);

  // 深链 ?snapshotId= → 直接取完成态。
  useEffect(() => {
    if (phase.kind === 'restoring' && urlSnapshotId) void loadComplete(urlSnapshotId);
  }, [phase.kind, urlSnapshotId, loadComplete]);

  // 仅带 ?draftId= 恢复时，草稿里若已经有 snapshotId，直接进入能力页，不再展示原始 session 清单。
  useEffect(() => {
    if (!ctxSnapshotId) return;
    if (urlSnapshotId || urlJobId) return;
    if (phase.kind !== 'empty' && phase.kind !== 'restoring') return;
    navigateToCapabilities(ctxSnapshotId);
  }, [ctxSnapshotId, urlSnapshotId, urlJobId, phase.kind, navigateToCapabilities]);

  // SSE done 成功 → 取快照进完成态。
  const handleStreamDone = useCallback(
    (snapshotId: string): void => void loadComplete(snapshotId),
    [loadComplete],
  );

  // SSE 整体失败 → 累计；两次失败标步骤异常态（步骤条标红，不连坐其它步）。
  const handleStreamError = useCallback((): void => {
    failCountRef.current += 1;
    if (failCountRef.current >= 2) markStepError('import');
  }, [markStepError]);

  // 完成态：回填 snapshotId 到向导（能力页/续传据它续提取、不重导；等价后端建快照同事务回填 drafts.snapshot_id），
  // 然后【自动进入能力页】（PRD：传完自动进入提取，无需手动点下一步），带 snapshotId + draftId 续传上下文。
  useEffect(() => {
    if (phase.kind !== 'complete') return;
    navigateToCapabilities(phase.snapshot.id);
  }, [phase, navigateToCapabilities]);

  // —— 动作 ——
  const handleStart = useCallback(async (): Promise<void> => {
    setStarting(true);
    setStartError(null);
    try {
      const pair = await createPair(activeDraftId ? { draftId: activeDraftId } : {});
      setCopied(false);
      setPhase({ kind: 'pairing', pair });
    } catch (e) {
      setStartError(e instanceof ApiError ? e : fallbackError('生成连接命令失败，请稍后重试。'));
    } finally {
      setStarting(false);
    }
  }, [activeDraftId]);

  // 浏览器直传：选了文件/目录或拖拽 → 进上传中态 + 启动编排（BUG-013 主路径）。
  const handleBrowserFiles = useCallback(
    (files: File[]): void => {
      setStartError(null);
      setPhase({ kind: 'uploading' });
      browserImport.start(files);
    },
    [browserImport],
  );

  // 上传中取消 / 出错回退：abort 编排 + 回空态（已传分片后端可清，前端回可重选态，不卡死）。
  const handleBrowserCancel = useCallback((): void => {
    browserImport.reset();
    setPhase({ kind: 'empty' });
  }, [browserImport]);

  // 上传失败重试：续传（已传分片不重传，建 Job 复用同 key，硬规则③）。
  const handleBrowserRetry = useCallback((): void => {
    browserImport.retry();
  }, [browserImport]);

  const handleCopy = useCallback((): void => {
    if (phase.kind !== 'pairing') return;
    void navigator.clipboard?.writeText(phase.pair.command).catch(() => undefined);
    setCopied(true);
  }, [phase]);

  const handleCancel = useCallback(async (): Promise<void> => {
    if (phase.kind !== 'loading') return;
    const jobId = phase.jobId;
    setCancelling(true);
    try {
      await cancelImportJob(jobId);
      setPhase({ kind: 'empty' }); // 取消后回可重新发起导入态（已完成段后端保留，导入-12）。
    } catch {
      // 取消失败：留在加载态、不阻断（worker 仍可能自然完成）。
    } finally {
      setCancelling(false);
    }
  }, [phase]);

  const handleRetry = useCallback((): void => {
    // 不重置 failCount：重试后若再失败即「两次失败」→ markStepError（开工总纲 §八②两次失败错误态）。
    // 计数只在成功（loadComplete）时归零。重试只清步骤条红 + remount 重订阅。
    clearStepError('import');
    setAttempt((a) => a + 1); // remount 流子组件 → 整条重订阅。
  }, [clearStepError]);

  // 完成态「重新导入」（导入-13/21）：回空态重新发起导入流程（铸新码 → 新快照；旧快照后端保留，导入-21）。
  //   注：2 步流程下完成态会自动跳能力页，此入口一般不可达，保留以兼容深链 ?snapshotId= 恢复态。
  const handleReimport = useCallback((): void => {
    setPhase({ kind: 'empty' });
    void handleStart();
  }, [handleStart]);

  // —— 渲染 ——
  // 草稿 bootstrap 失败（全新进入建草稿没成）：就地人话错误 + 重试（复用同 key 回放/补建，永不裸错）。
  //   只在空态分支前拦截（续传 / 加载 / 完成态不依赖 bootstrap）。
  if (bootstrap.status === 'error' && bootstrap.error && phase.kind === 'empty') {
    return <ErrorState error={bootstrap.error} onRetry={bootstrap.retry} />;
  }

  if (startError) {
    return (
      <ErrorState
        error={startError}
        onRetry={() => {
          setStartError(null);
          if (phase.kind === 'empty') void handleStart();
          else if (phase.kind === 'restoring' && urlSnapshotId) void loadComplete(urlSnapshotId);
        }}
        onChangeInput={() => setStartError(null)}
      />
    );
  }

  if (phase.kind === 'empty') {
    // 全新进入：建草稿在途时禁用入口（拿到真实 draftId 才铸码/挂 job，确保挂在真实 draft 上）；
    //   永不裸转圈靠按钮内联「准备中…」（ImportEmptyState starting）。
    const bootstrapBusy = bootstrap.status === 'creating';
    return (
      <ImportEmptyState
        onFiles={handleBrowserFiles}
        uploading={bootstrapBusy}
        onStart={() => void handleStart()}
        starting={starting || bootstrapBusy}
      />
    );
  }

  if (phase.kind === 'uploading') {
    // 浏览器直传出错（presign / PUT / 建 Job 失败）→ 就地人话错误 + 退路（重试续传 / 换输入回空态）。
    if (browserImport.progress.phase === 'error' && browserImport.progress.error) {
      return (
        <ErrorState
          error={browserImport.progress.error}
          onRetry={handleBrowserRetry}
          onChangeInput={handleBrowserCancel}
        />
      );
    }
    return (
      <BrowserUploadProgress progress={browserImport.progress} onCancel={handleBrowserCancel} />
    );
  }

  if (phase.kind === 'pairing') {
    return (
      <CommandBox
        pair={phase.pair}
        status={poll.status}
        onCopy={handleCopy}
        copied={copied}
        onRegenerate={() => void handleStart()}
      />
    );
  }

  if (phase.kind === 'restoring') {
    return <LoadingState skeletonRows={4} label="正在恢复导入结果" />;
  }

  if (phase.kind === 'loading') {
    return (
      <ImportJobStream
        key={`${phase.jobId}-${attempt}`}
        jobId={phase.jobId}
        onDone={handleStreamDone}
        onDoneWithoutSnapshot={() => void resolveCompletedSnapshotFromDraft()}
        onError={handleStreamError}
        onCancel={() => void handleCancel()}
        cancelling={cancelling}
        onRetry={handleRetry}
      />
    );
  }

  return (
    <ImportComplete
      snapshot={phase.snapshot}
      segments={phase.segments}
      onReimport={handleReimport}
    />
  );
}

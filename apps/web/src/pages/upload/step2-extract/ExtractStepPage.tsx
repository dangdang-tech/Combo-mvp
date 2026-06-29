// STEP② 提取页容器（F-11，开工总纲 §5.2）——触发萃取 → SSE 加载逐个浮现 → 结果批量选择。
//
// 链路：
//   1. 进入（带 ?snapshotId=）→ createExtractJob 触发 → 拿 jobId → SSE 加载态（逐个浮现 + 子任务点亮）。
//      续传 ?extractJobId= 深链：直接连该 job 流（已在途）/ done 后拉候选进结果态。
//   2. SSE done → 拉全量候选（提取-24「离开再回来不重跑」）+ confidenceSummary → 结果态。
//   3. 结果态批量选择：勾选数变 → 注册底栏「下一步：批量处理已选 N 项 →」（带选中 ids + extractJobId 进 STEP③）。
//      失败行行内重试：retryCandidate → 新 retryJob 流（RetryStream）回填，不阻塞其它（B-23）。
// 退路：触发失败/整体超时 → ErrorState（人话 + 退路）；两次失败 markStepError('extract')，不连坐其它步。
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type {
  CandidateView,
  CandidateItem,
  ConfidenceSummary,
  ExtractDoneResult,
  DonePayload,
} from '@cb/shared';
import { ApiError, useSSE, type UseSSEState } from '../../../api/index.js';
import { ErrorState, LoadingState } from '../../../components/index.js';
import { useWizard, pathForStep } from '../../wizard/index.js';
import { ExtractLoading } from './ExtractLoading.js';
import { ExtractResult } from './ExtractResult.js';
import { RetryStream } from './RetryStream.js';
import { createExtractJob, fetchCandidates, retryCandidate, jobEventsUrl } from './extractApi.js';

type Phase = { kind: 'triggering' } | { kind: 'loading'; jobId: string } | { kind: 'result' };

interface ActiveRetry {
  candidateId: string;
  retryJobId: string;
}

function fallbackError(userMessage: string): ApiError {
  return new ApiError({ error: { userMessage, retriable: true, action: 'retry', traceId: '' } });
}

/** done.result → ExtractDoneResult（done.result 是 unknown，安全收窄；形态不符则 undefined）。 */
function doneResultOf(done: DonePayload | undefined): ExtractDoneResult | undefined {
  const r = done?.result;
  if (r && typeof r === 'object' && 'candidateCount' in r) return r as ExtractDoneResult;
  return undefined;
}

/** SSE 加载子组件：订阅萃取 job 流；done → 上抛 jobId 拉候选；两次失败上抛错误。key 控重订阅。 */
function ExtractJobStream({
  jobId,
  onDone,
  onError,
  retryingIds,
  onRowRetry,
  onJobRetry,
}: {
  jobId: string;
  onDone: (jobId: string, done: DonePayload | undefined) => void;
  onError: () => void;
  retryingIds: ReadonlySet<string>;
  onRowRetry: (candidateId: string) => void;
  onJobRetry: () => void;
}): ReactElement {
  const sse: UseSSEState = useSSE(jobEventsUrl(jobId), 'job');

  useEffect(() => {
    if (sse.status === 'done') onDone(jobId, sse.done);
  }, [sse.status, sse.done, jobId, onDone]);

  useEffect(() => {
    if (sse.status === 'error') onError();
  }, [sse.status, onError]);

  return (
    <ExtractLoading
      state={sse}
      onRetry={onRowRetry}
      retryingIds={retryingIds}
      onJobRetry={onJobRetry}
    />
  );
}

export function ExtractStepPage(): ReactElement {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const {
    draftId,
    snapshotId: ctxSnapshotId,
    extractJobId: ctxExtractJobId,
    setSelection,
    setExtractJobId,
    setPrimaryAction,
    markStepError,
    clearStepError,
  } = useWizard();

  // 来源优先级（续传不重导/不重提取，提取-24/25）：URL ?snapshotId= / ?extractJobId=（STEP① 进入或深链带入）
  //   → 草稿续传回填的 ctxSnapshotId / ctxExtractJobId（hydrateFromDraft 从 DraftView 恢复）。
  //   有 extractJobId 直接连该流（已在途）/ done 后拉候选，不另触发新萃取（已生成不丢）。
  const snapshotId = searchParams.get('snapshotId') ?? ctxSnapshotId ?? undefined;
  const urlExtractJobId = searchParams.get('extractJobId') ?? ctxExtractJobId ?? undefined;

  // 续传 ?extractJobId= → 直接进加载态连该流（done 后拉候选）；否则触发新萃取。
  const [phase, setPhase] = useState<Phase>(
    urlExtractJobId ? { kind: 'loading', jobId: urlExtractJobId } : { kind: 'triggering' },
  );
  const [jobId, setJobId] = useState<string | undefined>(urlExtractJobId);
  const [candidates, setCandidates] = useState<CandidateView[]>([]);
  const [confidenceSummary, setConfidenceSummary] = useState<ConfidenceSummary | undefined>();
  const [doneResult, setDoneResult] = useState<ExtractDoneResult | undefined>();
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState<ApiError | null>(null);
  const [attempt, setAttempt] = useState(0);

  // 在途重试（每个挂一个 RetryStream 新流回填）。
  const [activeRetries, setActiveRetries] = useState<ActiveRetry[]>([]);
  const retryingIds = useMemo(
    () => new Set(activeRetries.map((r) => r.candidateId)),
    [activeRetries],
  );

  const failCountRef = useRef(0);

  // 触发幂等键（P1-4，提取-25）：首轮创建即用稳定 key，首轮 + 后续重试 + 刷新全用同一 key，绝不让
  //   client 自动生成随机 key（那会让「首轮随机 key、重试用 jobId」两 key 不一致 → 重复建萃取任务），
  //   也绝不把 jobId 当 key（jobId 是首轮产物、刷新前拿不到 → 刷新即新 key 新任务）。
  //   key 由萃取的天然主体 snapshotId 派生（同一快照 = 同一萃取逻辑操作）：刷新/重进同 snapshot 复用同 key →
  //   后端按幂等行为矩阵回放首次萃取（同 jobId、不重复跑）。draftId 在则一并入键（多草稿挂同快照时各自独立）。
  const triggerKey = useMemo(
    () => (snapshotId ? `extract:${draftId ?? 'nodraft'}:${snapshotId}` : undefined),
    [snapshotId, draftId],
  );

  // 触发萃取（仅 triggering 态且有 snapshotId）。
  useEffect(() => {
    if (phase.kind !== 'triggering') return;
    if (!snapshotId || !triggerKey) {
      setError(fallbackError('没找到要提取的原始数据，回上一步重新导入。'));
      return;
    }
    let active = true;
    void (async () => {
      try {
        // 首轮 + 重试同一稳定 key（同 snapshot 不另建 job；刷新复用同 key 回放首次，提取-25）。
        //   draftId 串进 body：后端同事务把 extract_job_id 焊到本草稿，续传按 draftId 恢复 extractJobId 回断点（P0）。
        const accepted = await createExtractJob(snapshotId, triggerKey, draftId ? { draftId } : {});
        if (!active) return;
        setJobId(accepted.jobId);
        setExtractJobId(accepted.jobId);
        setPhase({ kind: 'loading', jobId: accepted.jobId });
      } catch (e) {
        if (!active) return;
        setError(e instanceof ApiError ? e : fallbackError('提取没能开始，请稍后重试。'));
      }
    })();
    return () => {
      active = false;
    };
  }, [phase.kind, snapshotId, triggerKey, draftId, setExtractJobId, attempt]);

  // SSE done → 拉全量候选（提取-24）+ 置信分布 → 结果态。
  const handleJobDone = useCallback(
    (doneJobId: string, done: DonePayload | undefined): void => {
      setExtractJobId(doneJobId);
      setDoneResult(doneResultOf(done));
      void (async () => {
        try {
          const res = await fetchCandidates(doneJobId, { limit: 50 });
          clearStepError('extract');
          failCountRef.current = 0;
          setCandidates(res.candidates);
          setConfidenceSummary(res.confidenceSummary);
          setPhase({ kind: 'result' });
        } catch (e) {
          setError(e instanceof ApiError ? e : fallbackError('候选加载失败，请稍后重试。'));
        }
      })();
    },
    [setExtractJobId, clearStepError],
  );

  // SSE 整体失败 → 累计；两次失败标步骤异常态（不连坐其它步）。
  const handleJobError = useCallback((): void => {
    failCountRef.current += 1;
    if (failCountRef.current >= 2) markStepError('extract');
  }, [markStepError]);

  // 勾选切换（仅 ready 可勾，失败行无勾选框）。
  const handleToggle = useCallback((candidateId: string): void => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(candidateId)) next.delete(candidateId);
      else next.add(candidateId);
      return next;
    });
  }, []);

  // 行内重试：retryCandidate → 新 retryJob 流挂 RetryStream 回填（不阻塞其它）。
  const handleRowRetry = useCallback(
    async (candidateId: string): Promise<void> => {
      if (retryingIds.has(candidateId)) return;
      try {
        const accepted = await retryCandidate(candidateId);
        setActiveRetries((prev) => [
          ...prev.filter((r) => r.candidateId !== candidateId),
          { candidateId, retryJobId: accepted.retryJobId },
        ]);
      } catch {
        // 重试触发失败：不阻塞其它，行内态复位即可（不弹全屏错误，B-23 局部失败不连坐）。
      }
    },
    [retryingIds],
  );

  // RetryStream 回填：原地替换该候选（ready→正常卡 / failed→仍失败行，提取-19/20）。
  const handleRetryItem = useCallback((item: CandidateItem): void => {
    setCandidates((prev) => prev.map((c) => (c.id === item.id ? mergeRetryItem(c, item) : c)));
  }, []);

  const handleRetryFinished = useCallback((candidateId: string): void => {
    setActiveRetries((prev) => prev.filter((r) => r.candidateId !== candidateId));
  }, []);

  // 结果态：注册底栏「下一步：批量处理已选 N 项 →」（带选中 ids + extractJobId 进 STEP③）。
  useEffect(() => {
    if (phase.kind !== 'result') return;
    const n = selectedIds.size;
    setPrimaryAction({
      label: `下一步：批量处理已选 ${n} 项 →`,
      enabled: n > 0,
      onNext: () => {
        const ids = Array.from(selectedIds);
        // 多选 → subset（批量勾选 N 项，§5.2；写【勾选的 N 个】而非全集，N<total 也合法）；单选 → single
        // （精确进结构化）。把选中态写进向导 selection 供 STEP③ 续用——绝不把子集写成 'all'（旧写法会让后端
        // 误以为「全部 ready」、勾子集 N<total 时 PATCH 400 卡死，Codex r6 P1）。subset 是新规范模式，'all' 仅留作
        // 旧草稿向后兼容别名（§4.G）；前端一律新写 subset。
        if (ids.length === 1) setSelection({ mode: 'single', candidateId: ids[0]! });
        else setSelection({ mode: 'subset', candidateIds: ids });
        const params = new URLSearchParams();
        const ej = jobId ?? urlExtractJobId;
        if (ej) params.set('extractJobId', ej);
        if (draftId) params.set('draftId', draftId);
        const qs = params.toString();
        navigate(`${pathForStep('select')}${qs ? `?${qs}` : ''}`);
      },
    });
    return () => setPrimaryAction(null);
  }, [
    phase.kind,
    selectedIds,
    jobId,
    urlExtractJobId,
    draftId,
    navigate,
    setPrimaryAction,
    setSelection,
  ]);

  const handleJobRetry = useCallback((): void => {
    failCountRef.current = 0;
    clearStepError('extract');
    setAttempt((a) => a + 1);
  }, [clearStepError]);

  // —— 渲染 ——
  // 在途重试流（隐形订阅；任何态都保持挂载，回填不丢）。
  const retryStreams = activeRetries.map((r) => (
    <RetryStream
      key={r.retryJobId}
      candidateId={r.candidateId}
      retryJobId={r.retryJobId}
      onItem={handleRetryItem}
      onFinished={handleRetryFinished}
    />
  ));

  if (error) {
    return (
      <ErrorState
        error={error}
        onRetry={() => {
          setError(null);
          if (phase.kind === 'triggering') setAttempt((a) => a + 1);
          else if (phase.kind === 'loading') handleJobRetry();
        }}
        onChangeInput={() => navigate(pathForStep('import'))}
      />
    );
  }

  if (phase.kind === 'triggering') {
    return <LoadingState skeletonRows={4} label="正在准备提取" />;
  }

  if (phase.kind === 'loading') {
    return (
      <>
        {retryStreams}
        <ExtractJobStream
          key={`${phase.jobId}-${attempt}`}
          jobId={phase.jobId}
          onDone={handleJobDone}
          onError={handleJobError}
          retryingIds={retryingIds}
          onRowRetry={(id) => void handleRowRetry(id)}
          onJobRetry={handleJobRetry}
        />
      </>
    );
  }

  return (
    <>
      {retryStreams}
      <ExtractResult
        candidates={candidates}
        selectedIds={selectedIds}
        onToggle={handleToggle}
        confidenceSummary={confidenceSummary}
        doneResult={doneResult}
        onRetry={(id) => void handleRowRetry(id)}
        retryingIds={retryingIds}
      />
    </>
  );
}

/** 把 retry 回填的轻摘要 CandidateItem 并进既有 CandidateView（只覆盖回填带来的字段，保留其余）。 */
function mergeRetryItem(prev: CandidateView, item: CandidateItem): CandidateView {
  return {
    ...prev,
    status: item.status,
    name: item.name ?? prev.name,
    type: item.type ?? prev.type,
    confidence: item.confidence ?? prev.confidence,
    segmentCount: item.segmentCount ?? prev.segmentCount,
    scopeCoherence: item.scopeCoherence ?? prev.scopeCoherence,
    splitSuggested: item.splitSuggested ?? prev.splitSuggested,
    error: item.error ?? null,
  };
}

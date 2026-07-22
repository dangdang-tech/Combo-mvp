// 能力页（PRD 2 步之第 2 步）——融合原「提取过程态 + 批量发布」为单页三态，接 3C 提取 + 3E 批量发布 API/SSE。
//
// 三态（结构坍缩：提取过程态不占独立路由，是本页的第一个阶段）：
//   1. extracting（过程态）：带 ?snapshotId= 进入 → 若无 extractJobId 先 createExtractJob 触发 → 订阅 job SSE，
//      复用 step2-extract 的 ExtractLoading（圆环进度 + 指标 + 已发现列表）。job 终态 → 拉候选进 ready。
//   2. ready：按真实 reusability 稳定排序，默认把第一项作为主 Agent；用户先进入真实 runtime 试用，
//      回流经 session 校验后再发布。其它候选收在渐进式备选区，避免首屏要求用户做批量选择。
//   3. publishing → done：单 Agent 发布 → createPublishBatch（仅一个已试用 versionId + idempotencyKey；封面/档位/可见性走后端默认
//      glyph/free/public）→ 订阅批次 job SSE，mergeBatchState 合并逐项态 → 卡片状态槽反映 发布中 / 已发布 / 失败；
//      完成后给已发布数 + 每个已发布能力的市集链接（/a/{slug}）。
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import {
  SSE_ROUTES,
  type CandidateTrialCapability,
  type CandidateView,
  type DonePayload,
  type ExtractDoneResult,
  type PublishBatchView,
  type PublishBatchItemView,
  type CreatePublishBatchBody,
} from '@cb/shared';
import { ApiError, useSSE, type UseSSEState } from '../../../api/index.js';
import { ErrorState, LoadingState } from '../../../components/index.js';
import { useWizard } from '../../wizard/index.js';
import {
  ExtractLoading,
  createExtractJob,
  fetchCandidates,
  jobEventsUrl,
  nameText,
  typeText,
  confidenceText,
  segmentText,
} from '../step2-extract/index.js';
import {
  createPublishBatch,
  fetchPublishBatch,
  retryBatchItem,
  itemsFromSnapshot,
  mergeBatchState,
} from '../step5-publish/index.js';
import {
  createCapabilityForTrial,
  createRuntimeTrialSession,
  fetchLatestRuntimeTrialSession,
  openRuntimeTrial,
  resolveTrialAuthenticationError,
  startStructureForTrial,
} from './trialApi.js';

type Phase = { kind: 'triggering' } | { kind: 'extracting'; jobId: string } | { kind: 'ready' };
type TrialLaunchPhase = 'creating' | 'structuring' | 'opening' | 'error';

interface TrialLaunchState {
  candidateId: string;
  candidateName: string;
  phase: TrialLaunchPhase;
  capabilityId?: string;
  versionId?: string;
  structureUrl?: string;
  error?: string;
}

type TrialVerificationState =
  | { kind: 'idle' }
  | { kind: 'checking'; candidateId: string }
  | { kind: 'available'; candidateId: string; sessionId: string; version: string }
  | { kind: 'verified'; candidateId: string; sessionId: string; version: string }
  | { kind: 'recovery_error'; candidateId: string; message: string }
  | { kind: 'failed'; candidateId: string; message: string };

const TRIAL_PHASE_LABEL: Record<TrialLaunchPhase, string> = {
  creating: '准备试用…',
  structuring: '生成试用能力…',
  opening: '打开试用…',
  error: '重试试用 →',
};

const EXTRACT_IDEMPOTENCY_VERSION = 'full-cluster-v2';

function fallbackError(userMessage: string): ApiError {
  return new ApiError({ error: { userMessage, retriable: true, action: 'retry', traceId: '' } });
}

/** done.result → ExtractDoneResult（done.result 是 unknown，安全收窄；形态不符则 undefined）。 */
function doneResultOf(done: DonePayload | undefined): ExtractDoneResult | undefined {
  const r = done?.result;
  if (r && typeof r === 'object' && 'candidateCount' in r) return r as ExtractDoneResult;
  return undefined;
}

/** 生成每 item / 批次的独立幂等键（无连坐核心，回放首次）。 */
function newKey(): string {
  return (
    globalThis.crypto?.randomUUID?.() ?? `bi-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.userMessage;
  if (error instanceof Error && error.message.trim()) return error.message;
  return fallback;
}

function capabilitiesReturnTo(input: {
  pathname: string;
  search: string;
  hash: string;
  draftId?: string;
  snapshotId?: string;
  extractJobId?: string;
  batchId?: string;
  candidateId?: string;
  trialVersionId?: string;
  trialVersion?: string;
  preserveTrialResult?: boolean;
}): string {
  const params = new URLSearchParams(input.search);
  if (input.snapshotId && !params.has('snapshotId')) params.set('snapshotId', input.snapshotId);
  if (input.draftId && !params.has('draftId')) params.set('draftId', input.draftId);
  if (input.extractJobId && !params.has('extractJobId')) {
    params.set('extractJobId', input.extractJobId);
  }
  if (input.batchId && !params.has('batchId')) params.set('batchId', input.batchId);
  if (input.candidateId) params.set('candidateId', input.candidateId);
  if (input.trialVersionId) params.set('trialVersionId', input.trialVersionId);
  if (input.trialVersion) params.set('trialVersion', input.trialVersion);
  if (!input.preserveTrialResult) {
    params.delete('tested');
    params.delete('failed');
    params.delete('session');
  }
  const query = params.toString();
  return `${input.pathname}${query ? `?${query}` : ''}${input.hash}`;
}

function candidateRank(a: CandidateView, b: CandidateView): number {
  const aScore = a.reusability ?? -1;
  const bScore = b.reusability ?? -1;
  if (aScore !== bScore) return bScore - aScore;
  const aSegments = a.segmentCount ?? -1;
  const bSegments = b.segmentCount ?? -1;
  if (aSegments !== bSegments) return bSegments - aSegments;
  const slug = a.slug.localeCompare(b.slug);
  return slug || a.id.localeCompare(b.id);
}

/** SSE 加载子组件：订阅萃取 job 流；done → 上抛 jobId 拉候选；失败上抛。key 控重订阅。 */
function ExtractJobStream({
  jobId,
  onDone,
  onError,
  onJobRetry,
}: {
  jobId: string;
  onDone: (jobId: string, done: DonePayload | undefined) => void;
  onError: () => void;
  onJobRetry: () => void;
}): ReactElement {
  const sse: UseSSEState = useSSE(jobEventsUrl(jobId), 'job');

  useEffect(() => {
    if (sse.status === 'done') onDone(jobId, sse.done);
  }, [sse.status, sse.done, jobId, onDone]);

  useEffect(() => {
    if (sse.status === 'error') onError();
  }, [sse.status, onError]);

  return <ExtractLoading state={sse} onJobRetry={onJobRetry} />;
}

export function CapabilitiesStepPage(): ReactElement {
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const {
    draftId: ctxDraftId,
    snapshotId: ctxSnapshotId,
    extractJobId: ctxExtractJobId,
    batchId: ctxBatchId,
    setExtractJobId,
    setBatchId,
    versionId: ctxVersionId,
    capabilityId: ctxCapabilityId,
    setVersionId,
    setCapabilityId,
    setAgentReady,
    setPublishCompleted,
    selection: draftSelection,
    setSelection,
  } = useWizard();

  // 来源优先级：URL ?snapshotId= / ?extractJobId=（上传自动带入或深链）→ 向导上下文回填。
  const snapshotId = searchParams.get('snapshotId') ?? ctxSnapshotId ?? undefined;
  const urlExtractJobId = searchParams.get('extractJobId') ?? undefined;
  const urlBatchId = searchParams.get('batchId') ?? undefined;
  const extractJobId = urlExtractJobId ?? ctxExtractJobId ?? undefined;
  const batchId = urlBatchId ?? ctxBatchId ?? undefined;
  const draftId = ctxDraftId ?? searchParams.get('draftId') ?? undefined;
  const requestedCandidateId = searchParams.get('candidateId') ?? undefined;
  const testedCapabilityId = searchParams.get('tested') ?? undefined;
  const failedCapabilityId = searchParams.get('failed') ?? undefined;
  const returnedSessionId = searchParams.get('session') ?? undefined;
  const returnedTrialVersionId = searchParams.get('trialVersionId') ?? undefined;
  const returnedTrialVersion = searchParams.get('trialVersion') ?? undefined;

  // 有 extractJobId → 直接连该流；否则触发新萃取。
  const [phase, setPhase] = useState<Phase>(
    extractJobId ? { kind: 'extracting', jobId: extractJobId } : { kind: 'triggering' },
  );
  const [candidates, setCandidates] = useState<CandidateView[]>([]);
  const [doneResult, setDoneResult] = useState<ExtractDoneResult | undefined>();
  const [error, setError] = useState<ApiError | null>(null);
  const [attempt, setAttempt] = useState(0);
  const failCountRef = useRef(0);

  // —— 批量发布态（叠在 ready 上）——
  const [batchView, setBatchView] = useState<PublishBatchView | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState<ApiError | null>(null);
  const [trialLaunch, setTrialLaunch] = useState<TrialLaunchState | null>(null);
  const [trialVerification, setTrialVerification] = useState<TrialVerificationState>({
    kind: 'idle',
  });
  const [trialRecoveryAttempt, setTrialRecoveryAttempt] = useState(0);
  const [showAlternatives, setShowAlternatives] = useState(false);
  const batchKeyRef = useRef<string>(newKey());
  const itemKeysRef = useRef<Map<string, string>>(new Map());

  // 续传（脊柱 §8）：URL 带 ?batchId=（工作台草稿条对「已发起批量」的续传）→ 拉回该批直接进「发布中/已发布」态，
  //   绝不重新触发一次发布（否则同候选被重复建版重复发布 → 市集重复上架，回归 BUG）。批 SSE 订阅其 jobId 恢复逐项态。
  const resumedBatchRef = useRef(false);
  useEffect(() => {
    if (!batchId || resumedBatchRef.current) return;
    resumedBatchRef.current = true;
    let active = true;
    void (async () => {
      try {
        const view = await fetchPublishBatch(batchId);
        if (active) setBatchView(view);
      } catch {
        // 拉批失败不致命：退回普通 ready 态（用户可重新发布，幂等键仍防重）。
      }
    })();
    return () => {
      active = false;
    };
  }, [batchId]);

  useEffect(() => {
    if (!extractJobId || phase.kind !== 'triggering') return;
    setPhase({ kind: 'extracting', jobId: extractJobId });
  }, [extractJobId, phase.kind]);

  // 触发幂等键带萃取策略版本：同一 snapshot 切到新版真实聚类策略后要重新跑，不回放旧结果。
  const triggerKey = useMemo(
    () =>
      snapshotId
        ? `extract:${EXTRACT_IDEMPOTENCY_VERSION}:${draftId ?? 'nodraft'}:${snapshotId}`
        : undefined,
    [snapshotId, draftId],
  );

  // 触发萃取（仅 triggering 且有 snapshotId）。
  useEffect(() => {
    if (phase.kind !== 'triggering') return;
    if (!snapshotId || !triggerKey) {
      setError(fallbackError('没找到要提取的原始数据，回上一步重新导入。'));
      return;
    }
    let active = true;
    void (async () => {
      try {
        const accepted = await createExtractJob(snapshotId, triggerKey, draftId ? { draftId } : {});
        if (!active) return;
        setExtractJobId(accepted.jobId);
        setSearchParams(
          (current) => {
            const next = new URLSearchParams(current);
            if (!next.has('extractJobId')) next.set('extractJobId', accepted.jobId);
            return next;
          },
          { replace: true },
        );
        setPhase({ kind: 'extracting', jobId: accepted.jobId });
      } catch (e) {
        if (!active) return;
        setError(e instanceof ApiError ? e : fallbackError('提取没能开始，请稍后重试。'));
      }
    })();
    return () => {
      active = false;
    };
  }, [phase.kind, snapshotId, triggerKey, draftId, attempt, setExtractJobId, setSearchParams]);

  // SSE done → 拉全量候选；ready 渲染层再按真实 reusability 稳定排序。
  const handleJobDone = useCallback(
    (doneJobId: string, done: DonePayload | undefined): void => {
      setDoneResult(doneResultOf(done));
      void (async () => {
        try {
          const res = await fetchCandidates(doneJobId, { limit: 50 });
          failCountRef.current = 0;
          setCandidates(res.candidates);
          setAgentReady(res.candidates.some((candidate) => candidate.status === 'ready'));
          setPhase({ kind: 'ready' });
        } catch (e) {
          setError(e instanceof ApiError ? e : fallbackError('候选加载失败，请稍后重试。'));
        }
      })();
    },
    [setAgentReady],
  );

  const handleJobError = useCallback((): void => {
    failCountRef.current += 1;
  }, []);

  const handleJobRetry = useCallback((): void => {
    failCountRef.current = 0;
    setAttempt((a) => a + 1);
  }, []);

  const readyCandidates = useMemo(
    () => candidates.filter((candidate) => candidate.status === 'ready').sort(candidateRank),
    [candidates],
  );
  const failedCandidates = useMemo(
    () => candidates.filter((candidate) => candidate.status === 'failed'),
    [candidates],
  );
  const selectedCandidateId =
    draftSelection?.mode === 'single' ? draftSelection.candidateId : undefined;
  const activeCandidate =
    readyCandidates.find((candidate) => candidate.id === requestedCandidateId) ??
    readyCandidates.find((candidate) => candidate.id === selectedCandidateId) ??
    readyCandidates[0];
  const activeCandidateId = activeCandidate?.id;
  const alternativeCandidates = activeCandidate
    ? readyCandidates.filter((candidate) => candidate.id !== activeCandidate.id)
    : [];

  // 已保存草稿中的 candidate + capability + version 是恢复真源，优先级高于候选接口的“最新 draft”。
  // 这同时覆盖两个边界：同候选后来出现新 draft 时不篡改旧草稿，以及发布后候选接口不再返回 draft 时
  // 仍能精确恢复刚刚试用过的 published version。
  const persistedDraftTrialTarget = useMemo<CandidateTrialCapability | undefined>(() => {
    if (
      !activeCandidate ||
      selectedCandidateId !== activeCandidate.id ||
      !ctxCapabilityId ||
      !ctxVersionId
    ) {
      return undefined;
    }
    return {
      capabilityId: ctxCapabilityId,
      versionId: ctxVersionId,
      slug: activeCandidate.slug,
    };
  }, [activeCandidate, ctxCapabilityId, ctxVersionId, selectedCandidateId]);
  const activeTrialCapability = useMemo<CandidateTrialCapability | undefined>(() => {
    const candidateTarget = activeCandidate?.trialCapability;
    if (!persistedDraftTrialTarget) return candidateTarget;
    // 后端候选目标与草稿精确引用一致时保留原对象，避免幂等回填 Context 后触发无意义二次恢复。
    if (
      candidateTarget?.capabilityId === persistedDraftTrialTarget.capabilityId &&
      candidateTarget.versionId === persistedDraftTrialTarget.versionId
    ) {
      return candidateTarget;
    }
    return persistedDraftTrialTarget;
  }, [activeCandidate?.trialCapability, persistedDraftTrialTarget]);
  const persistedDraftTrialTargetRef = useRef(persistedDraftTrialTarget);
  persistedDraftTrialTargetRef.current = persistedDraftTrialTarget;

  // 主结果就是当前创作选择：写入 Wizard 状态后，既能被顶栏“保存草稿”持久化，
  // 也能沿用既有续传契约；这里不私自增加新的自动保存请求。
  useEffect(() => {
    if (phase.kind !== 'ready') return;
    setSelection(activeCandidateId ? { mode: 'single', candidateId: activeCandidateId } : null);
  }, [activeCandidateId, phase.kind, setSelection]);

  const handleChooseCandidate = useCallback(
    (candidateId: string): void => {
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current);
          next.set('candidateId', candidateId);
          next.delete('tested');
          next.delete('failed');
          next.delete('session');
          next.delete('trialVersionId');
          next.delete('trialVersion');
          return next;
        },
        { replace: true },
      );
      setTrialLaunch(null);
      setTrialVerification({ kind: 'idle' });
      setShowAlternatives(false);
      setVersionId(undefined);
      setCapabilityId(undefined);
    },
    [setCapabilityId, setSearchParams, setVersionId],
  );

  // URL 只负责把刚完成的 session 带回；持久真源是 Runtime 的 latest-session。
  // 无回流 URL（刷新、关闭标签、从草稿重进）也按当前 candidate/version 恢复最近试用；服务端 verified
  // 已同时核对 owner、版本/manifest、completed run 与有效 assistant 输出，Web 再核对轻量 session 身份。
  useEffect(() => {
    if (phase.kind !== 'ready' || !activeCandidate) {
      setTrialVerification({ kind: 'idle' });
      return;
    }

    const trialCapability = activeTrialCapability;
    if (failedCapabilityId) {
      if (trialCapability?.capabilityId === failedCapabilityId) {
        setTrialVerification({
          kind: 'failed',
          candidateId: activeCandidate.id,
          message: '这个结果不符合预期，可以换一个已准备好的 Agent。',
        });
        setShowAlternatives(true);
      } else {
        setTrialVerification({
          kind: 'failed',
          candidateId: activeCandidate.id,
          message: '这次反馈与当前 Agent 不匹配，请重新试用。',
        });
      }
      return;
    }
    if (!trialCapability) {
      setTrialVerification({ kind: 'idle' });
      return;
    }
    if (testedCapabilityId && trialCapability.capabilityId !== testedCapabilityId) {
      setTrialVerification({
        kind: 'failed',
        candidateId: activeCandidate.id,
        message: '这次试用与当前 Agent 不匹配，请重新试用。',
      });
      return;
    }
    if (returnedTrialVersionId && trialCapability.versionId !== returnedTrialVersionId) {
      setTrialVerification({
        kind: 'failed',
        candidateId: activeCandidate.id,
        message: '这次试用版本与当前 Agent 不匹配，请重新试用。',
      });
      return;
    }

    let active = true;
    setTrialVerification({ kind: 'checking', candidateId: activeCandidate.id });
    void (async () => {
      try {
        const result = await fetchLatestRuntimeTrialSession({
          capabilityId: trialCapability.capabilityId,
          versionId: trialCapability.versionId,
          ...(returnedSessionId ? { sessionId: returnedSessionId } : {}),
        });
        if (!active) return;
        const session = result.session;
        if (!session) {
          setTrialVerification(
            returnedSessionId
              ? {
                  kind: 'failed',
                  candidateId: activeCandidate.id,
                  message: '没有找到这次试用记录，请重新试用。',
                }
              : { kind: 'idle' },
          );
          return;
        }
        const matches =
          (!returnedSessionId || session.id === returnedSessionId) &&
          session.mode === 'trial' &&
          session.capabilityId === trialCapability.capabilityId &&
          (!returnedTrialVersion || session.version === returnedTrialVersion);
        if (!matches) {
          setTrialVerification(
            returnedSessionId
              ? {
                  kind: 'failed',
                  candidateId: activeCandidate.id,
                  message: '这次试用与当前 Agent 不匹配，请重新试用。',
                }
              : { kind: 'idle' },
          );
          return;
        }
        if (
          draftId &&
          !persistedDraftTrialTargetRef.current &&
          activeCandidate.trialCapability?.capabilityId === trialCapability.capabilityId &&
          activeCandidate.trialCapability.versionId === trialCapability.versionId
        ) {
          const ensured = await createCapabilityForTrial(activeCandidate.id, draftId);
          if (!active) return;
          if (
            ensured.capabilityId !== trialCapability.capabilityId ||
            ensured.versionId !== trialCapability.versionId
          ) {
            setTrialVerification({
              kind: 'failed',
              candidateId: activeCandidate.id,
              message: '草稿中的 Agent 版本已经变化，请重新试用。',
            });
            return;
          }
          setCapabilityId(ensured.capabilityId);
          setVersionId(ensured.versionId);
        }
        setTrialVerification(
          result.verified
            ? {
                kind: 'verified',
                candidateId: activeCandidate.id,
                sessionId: session.id,
                version: session.version,
              }
            : {
                kind: 'available',
                candidateId: activeCandidate.id,
                sessionId: session.id,
                version: session.version,
              },
        );
      } catch (verificationError) {
        if (!active) return;
        const authResolution = await resolveTrialAuthenticationError(
          verificationError,
          capabilitiesReturnTo({
            pathname: location.pathname,
            search: location.search,
            hash: location.hash,
            draftId,
            snapshotId,
            extractJobId,
            batchId,
            candidateId: activeCandidate.id,
            trialVersionId: returnedTrialVersionId,
            trialVersion: returnedTrialVersion,
            preserveTrialResult: Boolean(returnedSessionId),
          }),
        );
        if (!active || authResolution.kind === 'redirected') return;
        setTrialVerification(
          returnedSessionId
            ? {
                kind: 'failed',
                candidateId: activeCandidate.id,
                message: errorMessage(authResolution.error, '暂时无法确认试用结果，请重试。'),
              }
            : {
                kind: 'recovery_error',
                candidateId: activeCandidate.id,
                message: errorMessage(authResolution.error, '暂时无法恢复上次试用，请重新连接。'),
              },
        );
      }
    })();
    return () => {
      active = false;
    };
  }, [
    activeCandidate,
    activeTrialCapability,
    batchId,
    draftId,
    extractJobId,
    failedCapabilityId,
    location.hash,
    location.pathname,
    location.search,
    phase.kind,
    returnedSessionId,
    returnedTrialVersion,
    returnedTrialVersionId,
    setCapabilityId,
    setVersionId,
    snapshotId,
    testedCapabilityId,
    trialRecoveryAttempt,
  ]);

  const trialVerified =
    trialVerification.kind === 'verified' && trialVerification.candidateId === activeCandidate?.id;
  const persistedTrial =
    (trialVerification.kind === 'verified' || trialVerification.kind === 'available') &&
    trialVerification.candidateId === activeCandidate?.id
      ? trialVerification
      : undefined;

  // —— 单 Agent 发布：只发刚刚试用并校验过的 draft version，绝不重新挑版本/重复结构化。——
  const handlePublish = useCallback((): void => {
    const trialCapability = activeTrialCapability;
    if (publishing || batchView || !trialVerified || !activeCandidate || !trialCapability) return;
    const candidate = activeCandidate;
    const versionId = trialCapability.versionId;
    setPublishing(true);
    setPublishError(null);
    void (async () => {
      try {
        const key = itemKeysRef.current.get(candidate.id) ?? newKey();
        itemKeysRef.current.set(candidate.id, key);
        const body: CreatePublishBatchBody = {
          items: [
            {
              versionId,
              idempotencyKey: key,
            },
          ],
          ...(draftId ? { draftId } : {}),
        };
        const view = await createPublishBatch(body, batchKeyRef.current);
        setBatchView(view);
        setBatchId(view.batchId);
        setSearchParams(
          (current) => {
            const next = new URLSearchParams(current);
            next.set('batchId', view.batchId);
            return next;
          },
          { replace: true },
        );
      } catch (e) {
        setPublishError(e instanceof ApiError ? e : fallbackError('没能开始发布，请重试。'));
      } finally {
        setPublishing(false);
      }
    })();
  }, [
    publishing,
    batchView,
    trialVerified,
    activeCandidate,
    activeTrialCapability,
    draftId,
    setBatchId,
    setSearchParams,
  ]);

  // 重订阅批次流：先置 null 断开旧订阅，再拉回最新批（新对象触发 useSSE 重连）——用于批流出错重连 / 单项重试后续读。
  const refreshBatch = useCallback((batchId: string): void => {
    setBatchView(null);
    void (async () => {
      try {
        const v = await fetchPublishBatch(batchId);
        setBatchView(v);
      } catch (e) {
        setPublishError(
          e instanceof ApiError ? e : fallbackError('刷新发布进度失败，请稍后再试。'),
        );
      }
    })();
  }, []);

  // 批流硬错（onopen 拿到非 event-stream / 500）→ 页面给错误 + 重连入口，不永久停在「发布中」。
  const handleBatchRetry = useCallback((): void => {
    if (batchView) refreshBatch(batchView.batchId);
  }, [batchView, refreshBatch]);

  // 单项重试（无连坐，选择结构化-29）：仅 failed 项，换该 item 幂等键重投，重订阅批流看后续态。
  const handleRetryItem = useCallback(
    (itemId: string): void => {
      const bid = batchView?.batchId;
      if (!bid) return;
      void (async () => {
        try {
          await retryBatchItem(bid, itemId, {}, newKey());
          refreshBatch(bid);
        } catch (e) {
          setPublishError(
            e instanceof ApiError ? e : fallbackError('这一项重试没成功，稍后再试。'),
          );
        }
      })();
    },
    [batchView, refreshBatch],
  );

  const handleTrial = useCallback(
    (candidate: CandidateView): void => {
      if (trialLaunch && trialLaunch.phase !== 'error') return;
      const candidateName = nameText(candidate.name);
      const trialCapability =
        candidate.id === activeCandidateId ? activeTrialCapability : candidate.trialCapability;
      if (trialCapability) {
        setTrialLaunch({ candidateId: candidate.id, candidateName, phase: 'opening' });
        void (async () => {
          let capabilityId = trialCapability.capabilityId;
          let versionId = trialCapability.versionId;
          try {
            // 预生成能力也要经过一次带 draftId 的幂等 ensure：后端据此把 selection/version/capability
            // 原子回填到草稿，关闭标签后仍能从工作台恢复精确 candidate/version。
            if (
              draftId &&
              candidate.id === activeCandidateId &&
              !persistedDraftTrialTargetRef.current &&
              candidate.trialCapability?.capabilityId === trialCapability.capabilityId &&
              candidate.trialCapability.versionId === trialCapability.versionId
            ) {
              const ensured = await createCapabilityForTrial(candidate.id, draftId);
              capabilityId = ensured.capabilityId;
              versionId = ensured.versionId;
              setCapabilityId(ensured.capabilityId);
              setVersionId(ensured.versionId);
            }
            const created = await createRuntimeTrialSession({
              capabilityId,
              versionId,
              title: `${candidateName} 试用`,
            });
            const returnTo = encodeURIComponent(
              capabilitiesReturnTo({
                pathname: location.pathname,
                search: location.search,
                hash: location.hash,
                draftId,
                snapshotId,
                extractJobId,
                batchId,
                candidateId: candidate.id,
                trialVersionId: versionId,
                trialVersion: created.capability.version,
              }),
            );
            openRuntimeTrial(`/try/session/${created.session.id}?returnTo=${returnTo}`);
          } catch (e) {
            const authResolution = await resolveTrialAuthenticationError(
              e,
              capabilitiesReturnTo({
                pathname: location.pathname,
                search: location.search,
                hash: location.hash,
                draftId,
                snapshotId,
                extractJobId,
                batchId,
                candidateId: candidate.id,
                trialVersionId: versionId,
              }),
            );
            if (authResolution.kind === 'redirected') return;
            setTrialLaunch((current) =>
              current?.candidateId === candidate.id
                ? {
                    ...current,
                    phase: 'error',
                    error: errorMessage(authResolution.error, '没能打开试用，请稍后重试。'),
                  }
                : current,
            );
          }
        })();
        return;
      }

      setTrialLaunch({ candidateId: candidate.id, candidateName, phase: 'creating' });
      void (async () => {
        try {
          const created = await createCapabilityForTrial(candidate.id, draftId);
          setCapabilityId(created.capabilityId);
          setVersionId(created.versionId);
          setTrialLaunch((current) =>
            current?.candidateId === candidate.id
              ? {
                  ...current,
                  phase: 'structuring',
                  capabilityId: created.capabilityId,
                  versionId: created.versionId,
                }
              : current,
          );
          const structure = await startStructureForTrial(created.versionId);
          setTrialLaunch((current) =>
            current?.candidateId === candidate.id
              ? {
                  ...current,
                  phase: 'structuring',
                  capabilityId: created.capabilityId,
                  versionId: created.versionId,
                  structureUrl: structure.eventsUrl,
                }
              : current,
          );
        } catch (e) {
          setTrialLaunch((current) =>
            current?.candidateId === candidate.id
              ? {
                  ...current,
                  phase: 'error',
                  error: errorMessage(e, '没能准备试用，请稍后重试。'),
                }
              : current,
          );
        }
      })();
    },
    [
      draftId,
      activeCandidateId,
      activeTrialCapability,
      location.hash,
      location.pathname,
      location.search,
      snapshotId,
      trialLaunch,
      batchId,
      extractJobId,
      setCapabilityId,
      setVersionId,
    ],
  );

  const handleContinueTrial = useCallback(
    (candidate: CandidateView, sessionId: string, version: string): void => {
      const trialCapability =
        candidate.id === activeCandidateId ? activeTrialCapability : candidate.trialCapability;
      if (!trialCapability) return;
      const returnTo = encodeURIComponent(
        capabilitiesReturnTo({
          pathname: location.pathname,
          search: location.search,
          hash: location.hash,
          draftId,
          snapshotId,
          extractJobId,
          batchId,
          candidateId: candidate.id,
          trialVersionId: trialCapability.versionId,
          trialVersion: version,
        }),
      );
      openRuntimeTrial(`/try/session/${encodeURIComponent(sessionId)}?returnTo=${returnTo}`);
    },
    [
      activeCandidateId,
      activeTrialCapability,
      batchId,
      draftId,
      extractJobId,
      location.hash,
      location.pathname,
      location.search,
      snapshotId,
    ],
  );

  // —— 批次 SSE（逐项浮现 + 完成度）——
  const sseUrl = batchView ? SSE_ROUTES.jobEvents(batchView.jobId) : null;
  const batchSse = useSSE(sseUrl, 'job', { enabled: !!batchView });
  const trialSse = useSSE(trialLaunch?.structureUrl ?? null, 'structure', {
    enabled: Boolean(trialLaunch?.structureUrl),
  });

  useEffect(() => {
    if (
      !trialLaunch ||
      trialLaunch.phase !== 'structuring' ||
      !trialLaunch.capabilityId ||
      !trialLaunch.versionId
    ) {
      return;
    }
    if (trialSse.status === 'error') {
      setTrialLaunch((current) =>
        current?.candidateId === trialLaunch.candidateId
          ? {
              ...current,
              phase: 'error',
              error: trialSse.error?.userMessage ?? '生成试用能力失败，请稍后重试。',
            }
          : current,
      );
      return;
    }
    if (trialSse.status !== 'done') return;
    if (trialSse.done?.status !== 'completed') {
      setTrialLaunch((current) =>
        current?.candidateId === trialLaunch.candidateId
          ? {
              ...current,
              phase: 'error',
              error: trialSse.done?.error?.error.userMessage ?? '生成试用能力失败，请稍后重试。',
            }
          : current,
      );
      return;
    }

    const { candidateId, candidateName, capabilityId, versionId } = trialLaunch;
    setTrialLaunch((current) =>
      current?.candidateId === candidateId ? { ...current, phase: 'opening' } : current,
    );
    void (async () => {
      try {
        const created = await createRuntimeTrialSession({
          capabilityId,
          versionId,
          title: `${candidateName} 试用`,
        });
        const returnTo = encodeURIComponent(
          capabilitiesReturnTo({
            pathname: location.pathname,
            search: location.search,
            hash: location.hash,
            draftId,
            snapshotId,
            extractJobId,
            batchId,
            candidateId,
            trialVersionId: versionId,
            trialVersion: created.capability.version,
          }),
        );
        openRuntimeTrial(`/try/session/${created.session.id}?returnTo=${returnTo}`);
      } catch (e) {
        const authResolution = await resolveTrialAuthenticationError(
          e,
          capabilitiesReturnTo({
            pathname: location.pathname,
            search: location.search,
            hash: location.hash,
            draftId,
            snapshotId,
            extractJobId,
            batchId,
            candidateId,
            trialVersionId: versionId,
          }),
        );
        if (authResolution.kind === 'redirected') return;
        setTrialLaunch((current) =>
          current?.candidateId === candidateId
            ? {
                ...current,
                phase: 'error',
                error: errorMessage(authResolution.error, '没能打开试用，请稍后重试。'),
              }
            : current,
        );
      }
    })();
  }, [
    draftId,
    location.hash,
    location.pathname,
    location.search,
    snapshotId,
    trialLaunch,
    trialSse.done,
    trialSse.error,
    trialSse.status,
    batchId,
    extractJobId,
  ]);

  const merged = useMemo(() => {
    if (!batchView) return null;
    const snapshotItems = itemsFromSnapshot(batchSse.progress);
    const appended = (batchSse.items as PublishBatchItemView[]).filter(
      (x) =>
        typeof x === 'object' &&
        x !== null &&
        typeof (x as { itemId?: unknown }).itemId === 'string',
    );
    return mergeBatchState(batchView.items, snapshotItems, appended, batchView.total);
  }, [batchView, batchSse.progress, batchSse.items]);

  // 单项发布走 versionId；兼容旧批次 candidateId，并统一映射回候选用于结果态展示。
  const itemByCandidate = useMemo(() => {
    const m = new Map<string, PublishBatchItemView>();
    if (merged) {
      for (const item of merged.items) {
        if (item.candidateId) {
          m.set(item.candidateId, item);
          continue;
        }
        if (!item.versionId) continue;
        const candidate = candidates.find((entry) => {
          const trialCapability =
            entry.id === activeCandidateId ? activeTrialCapability : entry.trialCapability;
          return trialCapability?.versionId === item.versionId;
        });
        if (candidate) m.set(candidate.id, item);
      }
    }
    return m;
  }, [activeCandidateId, activeTrialCapability, candidates, merged]);

  const primaryItem = activeCandidate ? itemByCandidate.get(activeCandidate.id) : undefined;
  const trialForPrimary =
    activeCandidate && trialLaunch?.candidateId === activeCandidate.id ? trialLaunch : null;
  const trialBusy = Boolean(trialLaunch && trialLaunch.phase !== 'error');
  const readyCount = readyCandidates.length;
  const allDone = merged ? merged.processedCount >= merged.total && merged.total > 0 : false;
  const published = primaryItem?.state === 'published';

  // 发布终态来自真实批次 item；刷新/续传重新拉到 published 后仍会恢复旅程完成态。
  useEffect(() => {
    setPublishCompleted(published);
  }, [published, setPublishCompleted]);

  // —— 渲染 ——
  if (error) {
    return (
      <ErrorState
        error={error}
        onRetry={() => {
          setError(null);
          if (phase.kind === 'triggering') setAttempt((a) => a + 1);
          else handleJobRetry();
        }}
      />
    );
  }

  if (phase.kind === 'triggering') {
    return <LoadingState skeletonRows={4} label="正在准备提取" />;
  }

  if (phase.kind === 'extracting') {
    return (
      <ExtractJobStream
        key={`${phase.jobId}-${attempt}`}
        jobId={phase.jobId}
        onDone={handleJobDone}
        onError={handleJobError}
        onJobRetry={handleJobRetry}
      />
    );
  }

  const analyzed = doneResult?.analyzedSegments;
  const identified = doneResult?.candidateCount ?? candidates.length;
  const trialBadge = published ? '已发布' : trialVerified ? '已试用' : '可试用';

  return (
    <section className="cb-capabilities cb-agent-result" aria-label="Agent 创作结果">
      <header className="cb-capabilities__header">
        <p className="cb-capabilities__eyebrow">导入完成 · 提取完成</p>
        <h1 className="cb-capabilities__title">第一个 Agent 已经准备好了</h1>
        <p className="cb-capabilities__lead">
          我们已经按复用性替你排好顺序。先用一个真实任务跑一遍，满意后直接发布。
        </p>
        <dl className="cb-agent-result__summary" aria-label="提取摘要">
          {typeof analyzed === 'number' && (
            <div>
              <dt>已分析</dt>
              <dd>{analyzed.toLocaleString('en-US')} 段</dd>
            </div>
          )}
          <div>
            <dt>识别结果</dt>
            <dd>{identified} 项</dd>
          </div>
          <div>
            <dt>当前路径</dt>
            <dd>
              {published
                ? '发布完成'
                : trialVerified
                  ? '等待发布'
                  : persistedTrial
                    ? '继续试用'
                    : '等待试用'}
            </dd>
          </div>
        </dl>
      </header>

      {readyCount === 0 ? (
        <p className="cb-capabilities__empty">
          没识别出可复用的能力。可以回上一步换个目录再导入，或多积累一些对话历史后再来。
        </p>
      ) : activeCandidate ? (
        <>
          <article
            className="cb-agent-primary"
            data-trial={trialVerification.kind}
            data-publish={primaryItem?.state ?? 'idle'}
          >
            <div className="cb-agent-primary__rank" aria-label="优先结果">
              <span>优先结果</span>
              <strong>01</strong>
              <small>共 {readyCount} 项</small>
            </div>

            <div className="cb-agent-primary__body">
              <header className="cb-agent-primary__head">
                <div>
                  <div className="cb-agent-primary__kicker">
                    <span>{typeText(activeCandidate.type)}</span>
                    <span>{confidenceText(activeCandidate.confidence)}</span>
                  </div>
                  <h2>{nameText(activeCandidate.name)}</h2>
                  {activeCandidate.intent && <p>{activeCandidate.intent}</p>}
                </div>
                <span
                  className="cb-agent-primary__ready"
                  data-state={published ? 'published' : trialVerified ? 'tested' : 'ready'}
                >
                  {trialBadge}
                </span>
              </header>

              <div className="cb-agent-primary__evidence" aria-label="排序依据">
                <div>
                  <span>来源证据</span>
                  <strong>{segmentText(activeCandidate.segmentCount)} session</strong>
                </div>
                {activeCandidate.reusability !== null && (
                  <div>
                    <span>复用强度</span>
                    <strong>{Math.round(activeCandidate.reusability * 100)}%</strong>
                  </div>
                )}
                <div>
                  <span>发布方式</span>
                  <strong>试用后单项发布</strong>
                </div>
              </div>

              {trialVerification.kind === 'checking' && (
                <p className="cb-agent-primary__notice" data-tone="live" role="status">
                  正在核对这次真实试用结果…
                </p>
              )}
              {trialVerified && (
                <p className="cb-agent-primary__notice" data-tone="success" role="status">
                  上次试用已保存。你可以继续调整，确认满意后再发布。
                </p>
              )}
              {trialVerification.kind === 'available' &&
                trialVerification.candidateId === activeCandidate.id && (
                  <p className="cb-agent-primary__notice" data-tone="live" role="status">
                    上次试用还没有完成，可以从保存的位置继续。
                  </p>
                )}
              {trialVerification.kind === 'failed' &&
                trialVerification.candidateId === activeCandidate.id && (
                  <p className="cb-agent-primary__notice" data-tone="error" role="alert">
                    {trialVerification.message}
                  </p>
                )}
              {trialVerification.kind === 'recovery_error' &&
                trialVerification.candidateId === activeCandidate.id && (
                  <p className="cb-agent-primary__notice" data-tone="error" role="alert">
                    {trialVerification.message}
                  </p>
                )}
              {trialForPrimary?.phase === 'error' && trialForPrimary.error && (
                <p className="cb-agent-primary__notice" data-tone="error" role="alert">
                  {trialForPrimary.error}
                </p>
              )}
              {publishError && (
                <ErrorState
                  error={publishError}
                  onRetry={() => {
                    setPublishError(null);
                    handlePublish();
                  }}
                />
              )}
              {batchView && batchSse.status === 'error' && (
                <ErrorState
                  error={batchSse.error ?? fallbackError('发布进度连接中断了，重试一下。')}
                  onRetry={handleBatchRetry}
                />
              )}

              <div className="cb-agent-primary__actions">
                {published ? (
                  <Link className="cb-btn cb-btn--primary" to={`/a/${activeCandidate.slug}`}>
                    打开已发布的 Agent →
                  </Link>
                ) : primaryItem?.state === 'failed' ? (
                  <button
                    type="button"
                    className="cb-btn cb-btn--primary"
                    onClick={() => handleRetryItem(primaryItem.itemId)}
                  >
                    重新发布
                  </button>
                ) : primaryItem ? (
                  <button type="button" className="cb-btn cb-btn--primary" disabled>
                    发布中…
                  </button>
                ) : trialVerified ? (
                  <button
                    type="button"
                    className="cb-btn cb-btn--primary"
                    onClick={handlePublish}
                    disabled={publishing}
                  >
                    {publishing ? '正在提交…' : '发布这个 Agent →'}
                  </button>
                ) : persistedTrial ? (
                  <button
                    type="button"
                    className="cb-btn cb-btn--primary"
                    onClick={() =>
                      handleContinueTrial(
                        activeCandidate,
                        persistedTrial.sessionId,
                        persistedTrial.version,
                      )
                    }
                  >
                    继续试用这个 Agent →
                  </button>
                ) : trialVerification.kind === 'recovery_error' ? (
                  <button
                    type="button"
                    className="cb-btn cb-btn--primary"
                    onClick={() => setTrialRecoveryAttempt((attempt) => attempt + 1)}
                  >
                    重新恢复试用记录 →
                  </button>
                ) : (
                  <button
                    type="button"
                    className="cb-btn cb-btn--primary"
                    onClick={() => handleTrial(activeCandidate)}
                    disabled={trialBusy || trialVerification.kind === 'checking'}
                  >
                    {trialForPrimary
                      ? TRIAL_PHASE_LABEL[trialForPrimary.phase]
                      : trialVerification.kind === 'failed'
                        ? '重新试用这个 Agent →'
                        : '用真实任务试一次 →'}
                  </button>
                )}

                {persistedTrial && (trialVerified || Boolean(primaryItem)) && (
                  <button
                    type="button"
                    className="cb-btn"
                    onClick={() =>
                      handleContinueTrial(
                        activeCandidate,
                        persistedTrial.sessionId,
                        persistedTrial.version,
                      )
                    }
                  >
                    继续试用
                  </button>
                )}

                {trialVerified && !primaryItem && alternativeCandidates.length > 0 && (
                  <button
                    type="button"
                    className="cb-agent-primary__secondary"
                    onClick={() => setShowAlternatives(true)}
                  >
                    不符合预期，换一个
                  </button>
                )}
              </div>

              {merged && primaryItem && (
                <p className="cb-capabilities__progress" role="status" aria-live="polite">
                  {allDone
                    ? primaryItem.state === 'published'
                      ? '已提交发布。'
                      : '这次发布未完成，可以就地重试。'
                    : '正在发布刚刚试用过的版本，请稍候…'}
                </p>
              )}
            </div>
          </article>

          {alternativeCandidates.length > 0 && (
            <section className="cb-agent-alternatives" aria-label="其它提取结果">
              <button
                type="button"
                className="cb-agent-alternatives__toggle"
                aria-expanded={showAlternatives}
                onClick={() => setShowAlternatives((value) => !value)}
              >
                <span>
                  {showAlternatives
                    ? '收起其它结果'
                    : `查看其它 ${alternativeCandidates.length} 个结果`}
                </span>
                <span aria-hidden="true">{showAlternatives ? '−' : '+'}</span>
              </button>
              {showAlternatives && (
                <ul className="cb-agent-alternatives__list" aria-label="备选 Agent 列表">
                  {alternativeCandidates.map((candidate, index) => (
                    <li key={candidate.id}>
                      <span className="cb-agent-alternatives__rank">
                        {String(index + 2).padStart(2, '0')}
                      </span>
                      <span className="cb-agent-alternatives__copy">
                        <strong>{nameText(candidate.name)}</strong>
                        <small>
                          {typeText(candidate.type)} · {segmentText(candidate.segmentCount)}证据
                          {candidate.reusability !== null
                            ? ` · 复用强度 ${Math.round(candidate.reusability * 100)}%`
                            : ''}
                        </small>
                      </span>
                      <button type="button" onClick={() => handleChooseCandidate(candidate.id)}>
                        改用这个 →
                      </button>
                    </li>
                  ))}
                  {failedCandidates.map((candidate) => (
                    <li key={candidate.id} data-status="failed">
                      <span className="cb-agent-alternatives__rank">!</span>
                      <span className="cb-agent-alternatives__copy">
                        <strong>{nameText(candidate.name)}</strong>
                        <small>{candidate.error?.userMessage ?? '这一项没能准备完成。'}</small>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </>
      ) : null}
    </section>
  );
}

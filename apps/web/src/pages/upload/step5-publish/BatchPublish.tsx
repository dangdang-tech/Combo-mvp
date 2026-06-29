// 批量发布（F-14，§5.5 / 决策⑤ 无连坐）——全部发布：建批 + SSE job 流逐项浮现 + 失败项重试/去补齐。
//
// 「全部发布」编排真源（开工总纲 §5.3 + 后端 B-29 publish_batch handler）：
//   前端只提交每个候选的 candidateId（无需先在前端逐个建版/结构化）；后端按 §5.3「一次性自动整理、批量发布」
//   对每个 candidate item 编排 create→structure→publish 三子任务（复用 3D/3E），逐项独立状态机
//   pending→structuring→publishing→published/failed，某项失败不连坐其余（决策⑤）。
//   故本组件提交 candidateId 是【后端编排端点的正式可用入口】，不是「裸 candidateId 发 version 批」的半成品路径——
//   candidate 项的 structuring/publishing 子状态由后端编排逐步 appendItem，前端经 SSE 逐个浮现。
//
// 流程（50 §2.3）：
//   1. createPublishBatch（端点 §2.3，202 受理）：每 candidate 一 item，各带独立 idempotencyKey（scope=publish_batch.item，无连坐核心）。
//   2. 订阅 job 流（GET /jobs/{jobId}/events，useSSE kind=job）：snapshot 全量 + item-appended 逐项 + progress 完成度（含失败也满进度）。
//   3. 合并 items（batchState）→ BatchResults 渲染；失败项「重试」（端点 §2.5，单项无连坐）/「去补齐」（回结构化补字段）。
// 合规：永不裸转圈（建批/恢复/SSE 加载 StreamLoading、量化进度）；绝不裸露错误码（每 item error 走 ErrorState，无 code）；
//   已发布不丢（snapshot 全量恢复 + 批次 id 续传回填）；失败只标该 item、可单独重试不连累其余。
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import {
  SSE_ROUTES,
  type PublishBatchView,
  type PublishBatchItemView,
  type CreatePublishBatchBody,
} from '@cb/shared';
import { useSSE, type ApiError } from '../../../api/index.js';
import { ErrorState, LoadingState, StreamLoading } from '../../../components/index.js';
import { toApiError, isAbort } from '../localError.js';
import { BatchResults } from './BatchResults.js';
import { BatchCardPreview } from './BatchCardPreview.js';
import { createPublishBatch, fetchPublishBatch, retryBatchItem } from './publishApi.js';
import { itemsFromSnapshot, mergeBatchState } from './batchState.js';

type SetupState =
  | { kind: 'creating' }
  | { kind: 'ready'; view: PublishBatchView }
  | { kind: 'error'; error: ApiError };

export interface BatchPublishProps {
  /** STEP③「全部发布」选中的候选集合（each → 一个 batch item）。 */
  candidateIds: string[];
  /**
   * 左侧切换列表当前选中的 candidateId（§5.5 / 发布-09）：中间市集卡预览随它切换（切换看卡），
   * 与下方发布结果列表并存（切换看卡 + 发布后看结果）。无（null）则不预览（落回首项由父层兜底）。
   */
  activeCandidateId?: string | null;
  /** 失败项「去补齐」：回结构化向导补字段（决策⑤）。 */
  onFixUp: (item: PublishBatchItemView) => void;
  /**
   * 续传：已建批次 id（草稿续传 / 深链 ?batchId= 回填）。有则恢复同一批次（§2.4 查批次全量 + SSE state_snapshot），
   * 不重建批次（已发布不丢、续传精确）；无则按 candidateIds 建新批次。
   */
  resumeBatchId?: string | undefined;
  /** 续传恢复出 batchId 时回填向导（供刷新/再续传衔接，等价后端 drafts.batch_id 同事务回填）。 */
  onBatchReady?: ((batchId: string) => void) | undefined;
  /**
   * 当前草稿 id（STEP① bootstrap 的真实草稿，P0-2）。建批时随 body 透传给后端，后端建批同事务
   * 回填 drafts.batch_id + current_step='publish'（断点续传：续传回 STEP⑤ 恢复同一批次）。无则不带（回看/无草稿）。
   */
  draftId?: string | undefined;
}

/** 生成每 item 独立幂等键（无连坐核心，scope=publish_batch.item）。 */
function newItemKey(): string {
  return (
    globalThis.crypto?.randomUUID?.() ?? `bi-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

export function BatchPublish({
  candidateIds,
  activeCandidateId,
  onFixUp,
  resumeBatchId,
  onBatchReady,
  draftId,
}: BatchPublishProps): ReactElement {
  const [setup, setSetup] = useState<SetupState>({ kind: 'creating' });
  const [attempt, setAttempt] = useState(0);
  const [retryingItemId, setRetryingItemId] = useState<string | null>(null);
  const [retryError, setRetryError] = useState<ApiError | null>(null);

  // 批次级幂等键 + 每 item 键固定（重建批次复用同键，回放首次批次，选择结构化-08）。
  const batchKeyRef = useRef<string>(newItemKey());
  const itemKeysRef = useRef<Map<string, string>>(new Map());
  // onBatchReady 经 ref 读，避免父组件每渲染换引用时把它放进 effect 依赖触发重跑建批。
  const onBatchReadyRef = useRef(onBatchReady);
  onBatchReadyRef.current = onBatchReady;
  // draftId 经 ref 读：建批 body 透传给后端回填 drafts.batch_id，但它的变化不应触发重跑建批（已生成不丢）。
  const draftIdRef = useRef(draftId);
  draftIdRef.current = draftId;

  // —— 续传恢复已建批次（§2.4 查批次全量）/ 建批（端点 §2.3）——
  useEffect(() => {
    const ctrl = new AbortController();
    let active = true;
    setSetup({ kind: 'creating' });
    void (async () => {
      try {
        // 续传：有 batchId → 查既有批次全量恢复（不重建批次；SSE state_snapshot 互补，已发布不丢）。
        if (resumeBatchId) {
          const view = await fetchPublishBatch(resumeBatchId, { signal: ctrl.signal });
          if (active) {
            onBatchReadyRef.current?.(view.batchId);
            setSetup({ kind: 'ready', view });
          }
          return;
        }
        // 新建：无可发布候选则回上一步补选（不空打后端）。
        if (candidateIds.length === 0) {
          if (active)
            setSetup({
              kind: 'error',
              error: toApiError(null, '这批没有可发布的能力，回上一步选一下。', 'change_input'),
            });
          return;
        }
        const dId = draftIdRef.current;
        const body: CreatePublishBatchBody = {
          items: candidateIds.map((candidateId) => {
            const key = itemKeysRef.current.get(candidateId) ?? newItemKey();
            itemKeysRef.current.set(candidateId, key);
            return { candidateId, idempotencyKey: key, visibility: 'public' };
          }),
          // 草稿续传：后端建批同事务回填 drafts.batch_id + current_step='publish'（无草稿则不带，回看场景）。
          ...(dId ? { draftId: dId } : {}),
        };
        const view = await createPublishBatch(body, batchKeyRef.current, { signal: ctrl.signal });
        if (active) {
          onBatchReadyRef.current?.(view.batchId);
          setSetup({ kind: 'ready', view });
        }
      } catch (e) {
        if (!active || isAbort(e)) return;
        setSetup({ kind: 'error', error: toApiError(e, '没能开始批量发布，请重试。') });
      }
    })();
    return () => {
      active = false;
      ctrl.abort();
    };
  }, [candidateIds, resumeBatchId, attempt]);

  const view = setup.kind === 'ready' ? setup.view : null;

  // —— SSE job 流（逐项浮现 + 完成度）——
  const sseUrl = view ? SSE_ROUTES.jobEvents(view.jobId) : null;
  const sse = useSSE(sseUrl, 'job', { enabled: !!view });

  // 合并：初始批项 + snapshot 全量 + item-appended 增量（itemId 去重，计数聚合重算，幂等）。
  const merged = useMemo(() => {
    if (!view) return null;
    const snapshotItems = itemsFromSnapshot(sse.progress);
    const appended = (sse.items as PublishBatchItemView[]).filter(
      (x) =>
        typeof x === 'object' &&
        x !== null &&
        typeof (x as { itemId?: unknown }).itemId === 'string',
    );
    return mergeBatchState(view.items, snapshotItems, appended, view.total);
  }, [view, sse.progress, sse.items]);

  // —— 单项重试（端点 §2.5，无连坐）——
  const handleRetryItem = (item: PublishBatchItemView): void => {
    if (!view || retryingItemId) return;
    setRetryingItemId(item.itemId);
    setRetryError(null);
    void (async () => {
      try {
        await retryBatchItem(view.batchId, item.itemId);
        // 重试受理后该项经 SSE 回到 pending/structuring→…（item-appended 续流）；本地不直改。
      } catch (e) {
        if (isAbort(e)) return;
        setRetryError(toApiError(e, '这一项没能重试，请稍后再试。'));
      } finally {
        setRetryingItemId(null);
      }
    })();
  };

  // —— 渲染 ——
  if (setup.kind === 'creating') {
    return (
      <LoadingState
        skeletonRows={4}
        label={resumeBatchId ? '正在恢复批量发布' : '正在开始批量发布'}
      />
    );
  }
  if (setup.kind === 'error') {
    return <ErrorState error={setup.error} onRetry={() => setAttempt((a) => a + 1)} />;
  }

  const m = merged!;
  const allDone = m.processedCount >= m.total && m.total > 0;
  // 当前左侧切换选中的 item（按 candidateId 命中；§5.5 切换看卡，发布-09）。
  const activeItem = activeCandidateId
    ? (m.items.find((it) => it.candidateId === activeCandidateId) ?? null)
    : null;

  return (
    <div className="cb-batch-publish">
      {/* 中间市集卡预览：跟随左侧切换换到当前能力（切换看卡，发布-09）。版本就绪即预览其卡，
          尚在整理（无 versionId）则给量化占位短语（永不裸转圈），不阻塞下方结果列表。 */}
      <BatchCardPreview item={activeItem} />

      {retryError && (
        <ErrorState
          error={retryError}
          onRetry={() => setRetryError(null)}
          onChangeInput={() => setRetryError(null)}
        />
      )}

      {/* SSE 建流/重连（未完成且无任何已处理项时）给加载/重连安抚条；批次级 error 走统一错误态。 */}
      {!allDone &&
        m.processedCount === 0 &&
        (sse.status === 'connecting' ||
          sse.status === 'reconnecting' ||
          sse.status === 'error') && (
          <StreamLoading
            state={sse}
            label="正在逐个发布"
            onRetry={() => setAttempt((a) => a + 1)}
          />
        )}

      <BatchResults
        total={m.total}
        processedCount={m.processedCount}
        publishedCount={m.publishedCount}
        failedCount={m.failedCount}
        items={m.items}
        onFixUp={onFixUp}
        onRetryItem={handleRetryItem}
        retryingItemId={retryingItemId}
      />
    </div>
  );
}

// 批量发布·当前能力市集卡预览（F-14，§5.5 中间 / 发布-09）——左侧切换选中哪个能力，这里就显它的市集卡。
//
// 「全部发布」三栏（§5.5）：左 能力切换列表、中 市集卡预览、下 发布结果列表。切换左侧 → 本组件换到该能力的卡
//   （切换看卡），与发布结果列表并存（切换看卡 + 发布后看结果，发布-09）。
// 整理时序：候选项要先在后端编排 create→structure 才拿到 versionId；本组件按当前 item 状态分三态显示：
//   1. versionId 已就绪 → previewMarketCard(versionId) 拉真实市集卡（封面默认 glyph）。
//   2. 还在整理（pending/structuring，无 versionId）→ 量化进度短语占位（永不裸转圈，硬规则①）。
//   3. 该项整理失败 → 人话提示「这个能力还没整理好…」（错误细节走下方结果列表的 ErrorState，不在此裸露 code）。
import { useEffect, useState, type ReactElement } from 'react';
import type { MarketCard, PublishBatchItemView, BatchItemState } from '@cb/shared';
import { ErrorState, LoadingState } from '../../../components/index.js';
import { toApiError, isAbort } from '../localError.js';
import type { ApiError } from '../../../api/index.js';
import { MarketCardPreview } from './MarketCardPreview.js';
import { previewMarketCard } from './publishApi.js';
import { buildCoverInput } from './coverInput.js';

type CardState =
  | { kind: 'loading' }
  | { kind: 'ready'; card: MarketCard }
  | { kind: 'error'; error: ApiError };

/** 整理中（无版本）状态人话短语（永不裸转圈：给量化语义占位，不放空圈）。 */
const PENDING_PHRASE: Partial<Record<BatchItemState, string>> = {
  pending: '排队中，整理好就显示这个能力的市集卡…',
  structuring: '正在整理这个能力的市集卡…',
  publishing: '正在发布这个能力…',
};

export interface BatchCardPreviewProps {
  /** 当前左侧切换选中的批量 item（无则提示去左侧选一个）。 */
  item: PublishBatchItemView | null;
}

export function BatchCardPreview({ item }: BatchCardPreviewProps): ReactElement {
  const [state, setState] = useState<CardState>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const versionId = item?.versionId;

  useEffect(() => {
    if (!versionId) return; // 无版本：不拉卡，渲染分支走占位 / 空提示。
    const ctrl = new AbortController();
    let active = true;
    setState({ kind: 'loading' });
    void (async () => {
      try {
        // 封面默认 glyph（本期仅字形可用，P1-6）；批量预览只读、不写库（§2.2）。
        const card = await previewMarketCard(
          versionId,
          { cover: buildCoverInput('glyph') },
          { signal: ctrl.signal },
        );
        if (active) setState({ kind: 'ready', card });
      } catch (e) {
        if (!active || isAbort(e)) return;
        setState({ kind: 'error', error: toApiError(e, '这个能力的市集卡没加载出来，请重试。') });
      }
    })();
    return () => {
      active = false;
      ctrl.abort();
    };
  }, [versionId, attempt]);

  // 没选中任何能力（父层兜底通常会落首项，仅极端空批/恢复中走这）。
  if (!item) {
    return (
      <section className="cb-batch-card-preview" aria-label="当前能力市集卡">
        <p className="cb-batch-card-preview__hint">在左侧选一个能力，这里预览它的市集卡。</p>
      </section>
    );
  }

  // 版本尚未就绪（还在整理 / 失败）：占位短语，绝不裸转圈；失败细节在下方结果列表（不在此裸露 code）。
  if (!versionId) {
    const phrase =
      item.state === 'failed'
        ? '这个能力还没整理好，下方可重试或去补齐。'
        : (PENDING_PHRASE[item.state] ?? '正在整理这个能力的市集卡…');
    return (
      <section className="cb-batch-card-preview" aria-label="当前能力市集卡">
        <p className="cb-batch-card-preview__hint" role="status">
          {phrase}
        </p>
      </section>
    );
  }

  return (
    <section className="cb-batch-card-preview" aria-label="当前能力市集卡">
      {state.kind === 'loading' ? (
        <LoadingState skeletonRows={4} label="市集卡预览加载中" />
      ) : state.kind === 'error' ? (
        <ErrorState error={state.error} onRetry={() => setAttempt((a) => a + 1)} />
      ) : (
        <MarketCardPreview card={state.card} onTrial={() => undefined} />
      )}
    </section>
  );
}

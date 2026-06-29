// 批量发布结果列表（F-14，§5.5 / 决策⑤ 无连坐）——逐项状态 + 失败项「去补齐」/「重试」。
//
// 无连坐（决策⑤ / 选择结构化-29）：每 item 独立状态机（pending/structuring/publishing/published/failed），
// 某项失败只标该项、不连累其余；失败项给「去补齐」（回结构化向导补字段）+「重试」（单项重试，§2.5）。
// 进度量化（永不裸转圈）：已处理 N / 总 M（成功 X · 失败 Y），有失败也能走到 total（Codex#7 processedCount）。
import type { ReactElement } from 'react';
import type { PublishBatchItemView, BatchItemState } from '@cb/shared';
import { ErrorState } from '../../../components/index.js';

/** 单项状态人话徽章。 */
const ITEM_STATE_LABEL: Record<BatchItemState, string> = {
  pending: '排队中',
  structuring: '结构化中',
  publishing: '发布中',
  published: '已提交 · Alpha 审核中',
  failed: '失败',
};

export interface BatchResultsProps {
  total: number;
  processedCount: number;
  publishedCount: number;
  failedCount: number;
  items: PublishBatchItemView[];
  /** 失败项「去补齐」：回结构化向导补字段（决策⑤ / §2.5 missingFields 入口）。 */
  onFixUp: (item: PublishBatchItemView) => void;
  /** 失败项「重试」：单项重试（无连坐，§2.5）。 */
  onRetryItem: (item: PublishBatchItemView) => void;
  /** 正在重试的 itemId（禁用其按钮，防重复点）。 */
  retryingItemId?: string | null;
}

export function BatchResults({
  total,
  processedCount,
  publishedCount,
  failedCount,
  items,
  onFixUp,
  onRetryItem,
  retryingItemId,
}: BatchResultsProps): ReactElement {
  const pct = total > 0 ? Math.round((processedCount / total) * 100) : 0;
  const allDone = processedCount >= total && total > 0;

  return (
    <section className="cb-batch-results" aria-label="批量发布结果">
      <header className="cb-batch-results__head">
        <h2 className="cb-batch-results__title">{allDone ? '批量发布完成' : '正在逐个发布'}</h2>
        {/* 量化进度短语（永不裸转圈；有失败也满进度，Codex#7）。 */}
        <p className="cb-batch-results__progress" role="status" aria-live="polite">
          已处理 {processedCount} / {total} 个能力（成功 {publishedCount} · 失败 {failedCount}）
        </p>
        {/* 全部发布默认免费档（§5.3 跳过逐个调价，价格用默认 {standard,0}）：诚实告知可后续单条改价。 */}
        <p className="cb-batch-results__price-hint">默认免费发布，可稍后在各能力里单独改价。</p>
        <div
          className="cb-batch-results__bar"
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div className="cb-batch-results__bar-fill" style={{ width: `${pct}%` }} />
        </div>
      </header>

      <ul className="cb-batch-results__list">
        {items.map((it, i) => {
          const failed = it.state === 'failed';
          const retrying = retryingItemId === it.itemId;
          return (
            <li
              key={it.itemId}
              className="cb-batch-results__item"
              data-state={it.state}
              data-failed={failed ? 'true' : 'false'}
            >
              <div className="cb-batch-results__item-head">
                {/* PublishBatchItemView 无人话名字段（packages/shared publish.ts，P2 不改后端契约），
                    与左侧切换列表同口径用序号人话标签「能力 N」（PublishStepPage.tsx），绝不裸露 UUID。
                    真实 id 仅留作 <li> 的非可见 key。 */}
                <span className="cb-batch-results__item-name">能力 {i + 1}</span>
                <span className="cb-batch-results__item-state" data-state={it.state}>
                  {ITEM_STATE_LABEL[it.state]}
                </span>
              </div>

              {/* 失败项：人话错误（无 code）+「去补齐」/「重试」（不连坐）。 */}
              {failed && (
                <div className="cb-batch-results__item-fail">
                  {it.error && <ErrorState error={it.error} />}
                  {it.missingFields && it.missingFields.length > 0 && (
                    <p className="cb-batch-results__missing">还差：{it.missingFields.join('、')}</p>
                  )}
                  <div className="cb-batch-results__item-actions">
                    <button
                      type="button"
                      className="cb-btn"
                      onClick={() => onFixUp(it)}
                      disabled={retrying}
                    >
                      去补齐
                    </button>
                    <button
                      type="button"
                      className="cb-btn"
                      onClick={() => onRetryItem(it)}
                      disabled={retrying}
                    >
                      {retrying ? '重试中…' : '重试'}
                    </button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

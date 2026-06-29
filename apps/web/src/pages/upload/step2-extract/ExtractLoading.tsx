// STEP② 提取加载态（F-11，开工总纲 §5.2）——子任务依次点亮 + 候选逐个浮现 + 占位骨架。
//
// 加载态（提取-03/04/05/06/17）：
//   1. 标题 + 策略说明（在做什么）。
//   2. 子任务清单依次点亮（分析会话段落 / 聚类 / 形成候选 / 评估 / 排序）——复用 4A SubtaskChecklist（StreamLoading）。
//   3. 逐个浮现：已浮现 X / Y；item-appended 取 payload.item（useSSE 已解包进 state.items）逐张卡浮现，
//      刚浮现带「刚识别出」角标（isNew）；未识别的尾部补占位骨架（永不裸转圈）。
//      失败候选也走 item-appended（status=failed + 人话 error），渲染失败行 + 行内重试（不阻塞其它）。
// error 态（整体失败/超时）不在本件渲染（StreamLoading 内切 ErrorState）；reconnecting/slow_hint 由 StreamLoading 承载。
import type { ReactElement } from 'react';
import type { CandidateItem } from '@cb/shared';
import type { UseSSEState } from '../../../api/index.js';
import { StreamLoading } from '../../../components/index.js';
import { CandidateAppearingCard } from './CandidateAppearingCard.js';

export interface ExtractLoadingProps {
  /** useSSE(jobEventsUrl, 'job') 返回的连接级状态。 */
  state: UseSSEState;
  /** 失败行点「重试」（单候选重试，不阻塞其它）。 */
  onRetry?: (candidateId: string) => void;
  /** 某候选重试在途（行内禁用 + 显「重试中…」）。 */
  retryingIds?: ReadonlySet<string>;
  /** 整体失败/超时重试（透传 StreamLoading→ErrorState）。 */
  onJobRetry?: () => void;
}

export function ExtractLoading({
  state,
  onRetry,
  retryingIds,
  onJobRetry,
}: ExtractLoadingProps): ReactElement {
  // 已浮现候选（item-appended 累积；按提取域 DTO 收窄）。
  const items = state.items as CandidateItem[];
  const done = state.progress?.done;
  const total = state.progress?.total;
  // 仍在跑（非 done/error）时尾部补骨架。
  const flowing = state.status !== 'done' && state.status !== 'error';
  // 未浮现数（total 已定且 done 已知时）：补这么多骨架，最多 3 张以免列表过长。
  const pendingCount =
    typeof total === 'number' && total > items.length
      ? Math.min(3, total - items.length)
      : flowing
        ? 2
        : 0;

  return (
    <section className="cb-extract-loading" aria-label="正在识别可复用的能力">
      <h2 className="cb-extract-loading__title">正在从你的对话历史里识别可复用的能力</h2>
      <p className="cb-extract-loading__strategy">
        我们会把相似的工作流聚到一起、评估它出现的频率和可打包程度，把高复用的能力优先排在前面。
      </p>

      {/* 第 1+2 层：进度条 + 量化文案 + 子任务清单（含 reconnecting/slow_hint，永不裸转圈）。 */}
      <StreamLoading
        state={state}
        skeletonRows={5}
        label="正在识别"
        {...(onJobRetry ? { onRetry: onJobRetry } : {})}
      />

      {state.status !== 'error' && (
        <>
          {/* 逐个浮现计数（提取-05/06）。 */}
          {typeof total === 'number' && (
            <p className="cb-extract-loading__count" role="status" aria-live="polite">
              已浮现 {typeof done === 'number' ? done : items.length} / {total} 个能力项
            </p>
          )}

          {/* 已识别卡片逐张浮现 + 未识别骨架（边生成边显示）。 */}
          <ul className="cb-extract-loading__list">
            {items.map((item) => (
              <li key={item.id} className="cb-extract-loading__row">
                <CandidateAppearingCard
                  item={item}
                  {...(onRetry ? { onRetry } : {})}
                  retrying={retryingIds?.has(item.id) ?? false}
                />
              </li>
            ))}
            {Array.from({ length: pendingCount }, (_, i) => (
              <li key={`sk-${i}`} className="cb-extract-loading__row">
                <div
                  className="cb-extract-loading__skeleton"
                  role="status"
                  aria-label="正在识别下一个能力"
                >
                  <span className="cb-extract-loading__skeleton-line" />
                  <span className="cb-extract-loading__skeleton-line cb-extract-loading__skeleton-line--short" />
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

// STEP② 提取加载态：PRD 圆环进度 + 多指标 + 已发现能力列表 + 占位骨架。
//
// 加载态（提取-03/04/05/06/17）：
//   1. 标题 + 策略说明（在做什么）+ 圆环百分比。
//   2. metrics 展示已分析 session / 已发现能力；前端不再从 phrase 解析数量。
//   3. item-appended 取 payload.item（useSSE 已解包进 state.items）渲染已发现列表；
//      未识别的尾部补占位骨架（永不裸转圈）。
//      失败候选也走 item-appended（status=failed + 人话 error），渲染失败行 + 行内重试（不阻塞其它）。
// error 态（整体失败/超时）不在本件渲染（StreamLoading 内切 ErrorState）；reconnecting/slow_hint 由 StreamLoading 承载。
import type { CSSProperties, ReactElement } from 'react';
import type { CandidateItem } from '@cb/shared';
import type { UseSSEState } from '../../../api/index.js';
import { ErrorState } from '../../../components/index.js';
import { nameText } from './candidateDisplay.js';

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
  if (state.status === 'error') {
    return <ErrorState error={state.error} {...(onJobRetry ? { onRetry: onJobRetry } : {})} />;
  }

  // 已发现候选（item-appended 累积；按提取域 DTO 收窄）。
  const items = state.items as CandidateItem[];
  const progress = state.progress;
  const percent = Math.max(0, Math.min(100, Math.round(progress?.percent ?? 0)));
  const analyzed = progress?.metrics?.analyzedSegments ?? 0;
  const discovered =
    progress?.metrics?.discoveredCandidates ??
    (typeof progress?.done === 'number' ? progress.done : items.length);
  const total = state.progress?.total;
  // 仍在跑（非 done/error）时尾部补骨架。
  const flowing = state.status !== 'done';
  // 未浮现数（total 已定且 done 已知时）：补这么多骨架，最多 3 张以免列表过长。
  const pendingCount =
    typeof total === 'number' && total > items.length
      ? Math.min(3, total - items.length)
      : flowing
        ? 2
        : 0;
  const ringStyle = {
    '--cb-extract-progress': `${percent}`,
  } as CSSProperties & Record<'--cb-extract-progress', string>;

  return (
    <section className="cb-extract-loading" aria-label="正在识别可复用的能力">
      <div className="cb-extract-loading__hero">
        {state.status === 'reconnecting' && (
          <p className="cb-extract-loading__reconnect" role="status">
            连接断了，正在自动重连…已发现的能力不会丢。
          </p>
        )}
        <div
          className="cb-extract-loading__ring"
          style={ringStyle}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
        >
          <span>{percent}%</span>
        </div>
        <h2 className="cb-extract-loading__title">正在提取你的能力…</h2>
        <p className="cb-extract-loading__strategy">
          正在阅读你的 sessions，识别你反复展现的能力。稍等片刻，马上就好。
        </p>
        <dl className="cb-extract-loading__metrics" aria-label="提取进度">
          <div>
            <dt>{analyzed.toLocaleString('en-US')}</dt>
            <dd>已分析 session</dd>
          </div>
          <div>
            <dt>{discovered.toLocaleString('en-US')}</dt>
            <dd>已发现能力</dd>
          </div>
        </dl>
      </div>

      {(items.length > 0 || pendingCount > 0) && (
        <>
          <p className="cb-extract-loading__found-title">已发现</p>
          <ul className="cb-extract-loading__list">
            {items.map((item) => {
              const failed = item.status === 'failed';
              return (
                <li key={item.id} className="cb-extract-loading__row">
                  <div className="cb-extract-loading__found" data-status={item.status}>
                    <span className="cb-extract-loading__found-icon" aria-hidden="true">
                      {failed ? '!' : '✓'}
                    </span>
                    <span className="cb-extract-loading__found-name">{nameText(item.name)}</span>
                    {failed && onRetry && (
                      <button
                        type="button"
                        className="cb-link cb-extract-loading__retry"
                        onClick={() => onRetry(item.id)}
                        disabled={retryingIds?.has(item.id) ?? false}
                      >
                        {retryingIds?.has(item.id) ? '重试中…' : '重试'}
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
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

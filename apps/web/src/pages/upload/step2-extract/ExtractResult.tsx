// STEP② 提取结果态（F-11，开工总纲 §5.2）——批量选择列表 + 置信分布摘要 + 失败行重试。
//
// 结果态（提取-08/12/13/17/24）：
//   1. 结果横幅：「已分析 X 段原始数据，识别出 Y 个能力项」（done.result.analyzedSegments / candidateCount）。
//   2. 批量选择列表：每行 勾选 + 名称 + 置信徽章 + 类型标签 + 一句话描述 + 频次条（提取-13）。
//      失败行（status=failed）：! 名称 · 人话错误副文 + 行内「重试」（不阻塞其它，B-23）；失败行不可勾选。
//   3. 底部置信分布摘要：高 X 中 Y 低 Z（提取-12，仅统计 ready）。
// 勾选态由本件持有（受控可由父传初值）；勾选数变化经 onSelectionChange 上抛 → 父注册底栏主按钮
//   「下一步：批量处理已选 N 项 →」（§5.2 底栏随勾选数变）。
import { useMemo, type ReactElement } from 'react';
import type { CandidateView, ConfidenceSummary, ExtractDoneResult } from '@cb/shared';
import {
  nameText,
  typeText,
  confidenceText,
  segmentText,
  frequencyPercent,
} from './candidateDisplay.js';

export interface ExtractResultProps {
  /** 全量候选（ready + failed，按 asc 序）。 */
  candidates: CandidateView[];
  /** 当前勾选的候选 id 集合（受控）。 */
  selectedIds: ReadonlySet<string>;
  /** 勾选/取消某候选。 */
  onToggle: (candidateId: string) => void;
  /** 置信分布摘要（仅 ready；缺则前端从候选现算兜底）。 */
  confidenceSummary?: ConfidenceSummary | undefined;
  /** 结果横幅数据（done.result；缺则从候选现算）。 */
  doneResult?: ExtractDoneResult | undefined;
  /** 失败行点「重试」（单候选重试，不阻塞其它）。 */
  onRetry?: (candidateId: string) => void;
  /** 某候选重试在途（行内禁用 + 显「重试中…」）。 */
  retryingIds?: ReadonlySet<string>;
}

/** 置信分布兜底现算（meta 缺时；仅统计 ready）。 */
function computeSummary(candidates: CandidateView[]): ConfidenceSummary {
  const acc = { high: 0, med: 0, low: 0 };
  for (const c of candidates) {
    if (c.status !== 'ready' || !c.confidence) continue;
    acc[c.confidence] += 1;
  }
  return acc;
}

export function ExtractResult({
  candidates,
  selectedIds,
  onToggle,
  confidenceSummary,
  doneResult,
  onRetry,
  retryingIds,
}: ExtractResultProps): ReactElement {
  const computed = useMemo(() => computeSummary(candidates), [candidates]);
  const summary = confidenceSummary ?? computed;
  const readyCount = useMemo(
    () => candidates.filter((c) => c.status === 'ready').length,
    [candidates],
  );
  const analyzed = doneResult?.analyzedSegments;
  const identified = doneResult?.candidateCount ?? candidates.length;

  return (
    <section className="cb-extract-result" aria-label="选择要进入下一步的能力">
      {/* 1. 结果横幅。 */}
      <div className="cb-extract-result__banner" role="status">
        {typeof analyzed === 'number'
          ? `已分析 ${analyzed.toLocaleString('en-US')} 段原始数据，识别出 ${identified} 个能力项。`
          : `识别出 ${identified} 个能力项。`}
      </div>

      {/* 选择引导（BUG-018：让用户清楚「要勾选后才能进入下一步」，不卡在「已识别候选但已选 0 项」）。 */}
      {candidates.some((c) => c.status === 'ready') && (
        <p className="cb-extract-result__guide">勾选下面要保留的能力项，可多选；选好后点底部按钮进入下一步。</p>
      )}

      {/* 2. 批量选择列表。 */}
      <ul className="cb-extract-result__list" aria-label="候选能力列表">
        {candidates.map((c) => {
          if (c.status === 'failed') {
            return (
              <li key={c.id} className="cb-extract-result__row cb-extract-result__row--failed">
                <span className="cb-extract-result__fail-icon" aria-hidden="true">
                  !
                </span>
                <div className="cb-extract-result__fail-main">
                  <span className="cb-extract-result__name">{nameText(c.name)}</span>
                  <span className="cb-extract-result__fail-msg">
                    {c.error?.userMessage ?? '这一项没能识别出来，可点重试。'}
                  </span>
                </div>
                {onRetry && (
                  <button
                    type="button"
                    className="cb-btn cb-extract-result__retry"
                    onClick={() => onRetry(c.id)}
                    disabled={retryingIds?.has(c.id) ?? false}
                  >
                    {retryingIds?.has(c.id) ? '重试中…' : '重试'}
                  </button>
                )}
              </li>
            );
          }

          const checked = selectedIds.has(c.id);
          const pct = frequencyPercent(c.frequencyRatio ?? c.scopeCoherence);
          return (
            <li
              key={c.id}
              className="cb-extract-result__row"
              data-selected={checked ? 'true' : 'false'}
            >
              <label className="cb-extract-result__option">
                <input
                  type="checkbox"
                  className="cb-extract-result__checkbox"
                  checked={checked}
                  onChange={() => onToggle(c.id)}
                  aria-label={`选择能力项「${nameText(c.name)}」`}
                />
                <span className="cb-extract-result__main">
                  <span className="cb-extract-result__head">
                    <span className="cb-extract-result__name">{nameText(c.name)}</span>
                    <span
                      className="cb-extract-result__confidence"
                      data-confidence={c.confidence ?? 'none'}
                    >
                      {confidenceText(c.confidence)}
                    </span>
                    <span className="cb-extract-result__type">{typeText(c.type)}</span>
                  </span>
                  {c.intent && <span className="cb-extract-result__intent">{c.intent}</span>}
                  <span className="cb-extract-result__freq">
                    <span className="cb-extract-result__freq-track" aria-hidden="true">
                      <span className="cb-extract-result__freq-fill" style={{ width: `${pct}%` }} />
                    </span>
                    <span className="cb-extract-result__freq-label">
                      {segmentText(c.segmentCount)}
                    </span>
                  </span>
                </span>
              </label>
            </li>
          );
        })}
        {candidates.length === 0 && (
          <li className="cb-extract-result__empty">
            没识别出可复用的能力。可以回上一步换个目录再导入，或多积累一些对话历史后再来。
          </li>
        )}
      </ul>

      {/* 3. 底部置信分布摘要（仅 ready）。 */}
      {readyCount > 0 && (
        <p className="cb-extract-result__summary" aria-label="置信分布">
          置信分布：高 {summary.high} · 中 {summary.med} · 低 {summary.low}
        </p>
      )}
    </section>
  );
}

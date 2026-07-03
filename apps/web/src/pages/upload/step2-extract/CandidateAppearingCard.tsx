// 提取加载态：单个候选浮现卡（F-11，开工总纲 §5.2）——刚识别出角标 / 失败行 + 行内重试。
//
// 三态（CandidateItem.status，提取-04/05/17/19）：
//   - generating：占位骨架（理论上 item-appended 多为 ready/failed，留容错）。
//   - ready：已识别卡（名称 + 类型 + 段数 + 置信徽章）；isNew 时带「刚识别出」角标。
//   - failed：失败行（! 名称 · 人话错误副文）+ 行内「重试」（不阻塞其它候选，B-23）。
// 失败副文取 error.userMessage（人话），绝不裸 code/堆栈（脊柱 §11.B）；error.details.stuckAt 作辅助副文。
import type { ReactElement } from 'react';
import type { CandidateItem } from '@cb/shared';
import { nameText, typeText, confidenceText, segmentText } from './candidateDisplay.js';

export interface CandidateAppearingCardProps {
  item: CandidateItem;
  /** 失败行点「重试」（单候选重试）。 */
  onRetry?: (candidateId: string) => void;
  /** 本候选重试在途（按钮禁用 + 显「重试中…」）。 */
  retrying?: boolean;
}

/** 失败副文：error.details.stuckAt（如「段 5 / 9」）作辅助，无则空。 */
function stuckText(item: CandidateItem): string | null {
  const details = item.error?.details;
  if (details && typeof details === 'object' && 'stuckAt' in details) {
    const at = (details as { stuckAt?: unknown }).stuckAt;
    if (typeof at === 'string') return at;
  }
  return null;
}

export function CandidateAppearingCard({
  item,
  onRetry,
  retrying = false,
}: CandidateAppearingCardProps): ReactElement {
  if (item.status === 'failed') {
    const at = stuckText(item);
    return (
      <div className="cb-cand-card cb-cand-card--failed" data-status="failed">
        <span className="cb-cand-card__fail-icon" aria-hidden="true">
          !
        </span>
        <div className="cb-cand-card__fail-main">
          <span className="cb-cand-card__name">{nameText(item.name)}</span>
          <span className="cb-cand-card__fail-msg">
            {item.error?.userMessage ?? '这一项没能识别出来，可点重试。'}
            {at && <span className="cb-cand-card__fail-at"> · {at}</span>}
          </span>
        </div>
        {onRetry && (
          <button
            type="button"
            className="cb-btn cb-cand-card__retry"
            onClick={() => onRetry(item.id)}
            disabled={retrying}
          >
            {retrying ? '重试中…' : '重试'}
          </button>
        )}
      </div>
    );
  }

  if (item.status === 'generating') {
    return (
      <div className="cb-cand-card cb-cand-card--generating" role="status" data-status="generating">
        <span className="cb-cand-card__name">{nameText(item.name)}</span>
        <span className="cb-cand-card__generating-hint">识别中…</span>
      </div>
    );
  }

  // ready
  return (
    <div className="cb-cand-card cb-cand-card--ready" data-status="ready">
      {item.isNew && (
        <span className="cb-cand-card__new-badge" aria-label="刚识别出">
          刚识别出
        </span>
      )}
      <span className="cb-cand-card__name">{nameText(item.name)}</span>
      {item.intent && <span className="cb-cand-card__intent">{item.intent}</span>}
      <span className="cb-cand-card__meta">
        <span className="cb-cand-card__type">{typeText(item.type)}</span>
        <span className="cb-cand-card__segments">{segmentText(item.segmentCount)}</span>
        <span className="cb-cand-card__confidence" data-confidence={item.confidence ?? 'none'}>
          {confidenceText(item.confidence)}
        </span>
      </span>
    </div>
  );
}

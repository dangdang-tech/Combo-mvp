// 核心指标四张大数字卡（外壳首页-09/29）。
//
// 顺序固定（后端给定）：已发布能力体（真实 + 环比）/ 累计调用 / 本月消耗 / 活跃消费者（usage 占位）。
// 真实卡：大数字 + 环比箭头（涨绿跌红平灰，由 deltaDirection 决定）。
// usage 卡：value/delta 均 null → UsagePlaceholder（绝不显 0、绝不画假环比）。
import type { ReactElement } from 'react';
import type { DashboardMetrics, MetricCard, Meta } from '@cb/shared';
import { UsagePlaceholder, compactNumber } from '../../components/index.js';

export interface MetricCardsProps {
  metrics: DashboardMetrics;
  meta: Meta | undefined;
}

const DIRECTION_ARROW: Record<'up' | 'down' | 'flat', string> = {
  up: '▲',
  down: '▼',
  flat: '—',
};

/** 环比小标：真实卡显示「▲ 12.5%」；usage 卡（direction=null）不渲染。 */
function DeltaBadge({ card }: { card: MetricCard }): ReactElement | null {
  if (card.deltaDirection === null || card.deltaPercent === null) return null;
  const dir = card.deltaDirection;
  const pct = Math.abs(card.deltaPercent);
  const label = dir === 'flat' ? '环比持平' : `环比${dir === 'up' ? '上升' : '下降'} ${pct}%`;
  return (
    <span className="cb-metric-card__delta" data-direction={dir} aria-label={label}>
      <span className="cb-metric-card__delta-arrow" aria-hidden="true">
        {DIRECTION_ARROW[dir]}
      </span>
      <span className="cb-metric-card__delta-pct">{pct}%</span>
    </span>
  );
}

function SingleCard({ card, meta }: { card: MetricCard; meta: Meta | undefined }): ReactElement {
  // usage 卡：value 为 null → 占位（绝不显 0）。真实卡：大数字。
  const { value } = card;
  return (
    <li className="cb-metric-card" data-key={card.key} data-placeholder={value === null}>
      <p className="cb-metric-card__label">{card.label}</p>
      {value === null ? (
        <div className="cb-metric-card__value cb-metric-card__value--placeholder">
          <UsagePlaceholder field={card.key} meta={meta} />
        </div>
      ) : (
        <div className="cb-metric-card__value">
          <span className="cb-metric-card__number">{compactNumber(value)}</span>
          {card.unit && <span className="cb-metric-card__unit">{card.unit}</span>}
        </div>
      )}
      <DeltaBadge card={card} />
    </li>
  );
}

export function MetricCards({ metrics, meta }: MetricCardsProps): ReactElement {
  return (
    <ul className="cb-metric-cards" aria-label="核心指标">
      {metrics.cards.map((c) => (
        <SingleCard key={c.key} card={c} meta={meta} />
      ))}
    </ul>
  );
}

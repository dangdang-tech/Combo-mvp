// 四张大数字卡 + 环比（60 §1.2，外壳首页-09/29）。
//
// 合规：每卡口径从后端单源派生——
//   - value=null（usage 卡：累计调用 / 本月消耗 / 活跃消费者）→ UsagePlaceholder，绝不显 0。
//   - value 真实（已发布能力体卡）→ 真实大数字 + 真实环比涨跌方向。
// 卡名/单位用后端 label/unit，不前端编。环比方向用后端 deltaDirection（不前端从 deltaPercent 反推）。
import type { ReactElement } from 'react';
import type { DashboardMetrics, MetricCard, Meta } from '@cb/shared';
import { compactNumber, UsagePlaceholder } from '../../components/index.js';

const DELTA_ARROW: Record<'up' | 'down' | 'flat', string> = {
  up: '↑',
  down: '↓',
  flat: '→',
};

function DeltaBadge({ card }: { card: MetricCard }): ReactElement | null {
  if (card.deltaDirection === null || card.deltaPercent === null) return null;
  return (
    <span className={`cb-metric-card__delta is-${card.deltaDirection}`}>
      {DELTA_ARROW[card.deltaDirection]} {Math.abs(card.deltaPercent)}%
    </span>
  );
}

export interface MetricCardsBandProps {
  metrics: DashboardMetrics;
  meta: Meta | undefined;
}

export function MetricCardsBand({ metrics, meta }: MetricCardsBandProps): ReactElement {
  return (
    <div className="cb-metric-cards" role="list">
      {metrics.cards.map((card) => (
        <div className="cb-metric-card" role="listitem" key={card.key} data-metric={card.key}>
          <p className="cb-metric-card__label">{card.label}</p>
          <p className="cb-metric-card__value">
            {card.value === null ? (
              // usage 卡：占位（不显 0），占位文案优先后端 placeholders[key]。
              <UsagePlaceholder field={card.key} meta={meta} />
            ) : (
              <>
                <span className="cb-metric-card__number">{compactNumber(card.value)}</span>
                {card.unit && <span className="cb-metric-card__unit">{card.unit}</span>}
              </>
            )}
          </p>
          {/* 环比：仅真实卡有方向（usage 卡 null → 不渲染，不编假环比）。 */}
          <DeltaBadge card={card} />
        </div>
      ))}
    </div>
  );
}

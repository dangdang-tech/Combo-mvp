// 市集卡预览（F-14，§5.5 中间）——消费者将来在市集里看到的样子。
//
// 全位置（发布-03 缺一不可）：封面图标 / 类型标签 / 名称 / 一句话卖点 / 能力简介 / 创作者署名 /
// 「源自一次真实会话」可信标记 / 价格 / 试用按钮（本期未开放占位）。
// usage 类（装机量 / 评分）上线前不显假数据（发布-07）：经 UsagePlaceholder 显「上线后填充」（非 0、非裸转圈）。
import type { ReactElement } from 'react';
import type { MarketCard } from '@cb/shared';
import { UsagePlaceholder } from '../../../components/index.js';
import { priceDisplay } from './price.js';

export interface MarketCardPreviewProps {
  card: MarketCard;
  /** 点「试用」→ 本期未开放占位（不进 runtime，决策③）。 */
  onTrial: () => void;
}

export function MarketCardPreview({ card, onTrial }: MarketCardPreviewProps): ReactElement {
  const price = card.price.display ?? priceDisplay(card.price.priceMicros);

  return (
    <article className="cb-market-card" aria-label="市集卡预览">
      {/* 封面图标（三来源之一；无图兜底占位，主页-22）。 */}
      <div className="cb-market-card__cover" data-source={card.cover.source}>
        {card.cover.url ? (
          <img
            className="cb-market-card__cover-img"
            src={card.cover.url}
            alt={`${card.name} 封面`}
          />
        ) : (
          <span className="cb-market-card__cover-glyph" aria-hidden="true">
            {card.name.slice(0, 1) || 'A'}
          </span>
        )}
      </div>

      <div className="cb-market-card__body">
        <span className="cb-market-card__type">{card.typeLabel}</span>
        <h3 className="cb-market-card__name">{card.name}</h3>
        <p className="cb-market-card__tagline">{card.tagline}</p>
        <p className="cb-market-card__summary">{card.summary}</p>

        <div className="cb-market-card__meta">
          <span className="cb-market-card__byline">{card.byline}</span>
          <span className="cb-market-card__trust">{card.trustBadge}</span>
        </div>

        {/* usage 占位（装机量 / 评分）：上线后由真实数据填充（发布-07）。 */}
        <div className="cb-market-card__usage">
          <UsagePlaceholder field="installs" label="装机量" />
          <UsagePlaceholder field="rating" label="评分" />
        </div>

        <div className="cb-market-card__footer">
          <span className="cb-market-card__price">{price}</span>
          {/* 试用按钮固定展示、本期未开放（决策③）。 */}
          <button
            type="button"
            className="cb-btn cb-market-card__trial"
            onClick={onTrial}
            aria-disabled="true"
          >
            试用
          </button>
        </div>
      </div>
    </article>
  );
}

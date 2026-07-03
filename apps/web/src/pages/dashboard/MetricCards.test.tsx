// MetricCards 测试（外壳首页-09/29）：published 真实卡（大数字 + 环比方向）+ 3 张 usage 占位卡。
import { describe, it, expect } from 'vitest';
import { render, within } from '@testing-library/react';
import type { DashboardMetrics, MetricCard, Meta } from '@cb/shared';
import { MetricCards } from './MetricCards.js';

function card(over: Partial<MetricCard> & Pick<MetricCard, 'key' | 'label'>): MetricCard {
  return {
    value: null,
    deltaPercent: null,
    deltaDirection: null,
    ...over,
  };
}

function metrics(): DashboardMetrics {
  return {
    range: '30d',
    cards: [
      card({
        key: 'published',
        label: '已发布能力体',
        value: 8,
        deltaPercent: 12.5,
        deltaDirection: 'up',
        unit: '个',
      }),
      card({ key: 'invocationsTotal', label: '累计调用' }),
      card({ key: 'spendThisMonth', label: '本月消耗' }),
      card({ key: 'activeConsumers', label: '活跃消费者' }),
    ],
  };
}

const PLACEHOLDER_META: Meta = {
  placeholders: {
    invocationsTotal: '暂无数据 / 上线后填充',
    spendThisMonth: '暂无数据 / 上线后填充',
    activeConsumers: '暂无数据 / 上线后填充',
  },
};

describe('MetricCards', () => {
  it('恒渲染四张卡，顺序固定', () => {
    const { container } = render(<MetricCards metrics={metrics()} meta={PLACEHOLDER_META} />);
    const cards = container.querySelectorAll('.cb-metric-card');
    expect(cards).toHaveLength(4);
    expect(Array.from(cards).map((c) => c.getAttribute('data-key'))).toEqual([
      'published',
      'invocationsTotal',
      'spendThisMonth',
      'activeConsumers',
    ]);
  });

  it('published 卡：真实大数字 + 环比方向（up）', () => {
    const { container } = render(<MetricCards metrics={metrics()} meta={PLACEHOLDER_META} />);
    const published = container.querySelector('[data-key="published"]') as HTMLElement;
    expect(within(published).getByText('8')).toBeInTheDocument();
    expect(within(published).getByText('12.5%')).toBeInTheDocument();
    expect(published.querySelector('[data-direction="up"]')).not.toBeNull();
    expect(published.getAttribute('data-placeholder')).toBe('false');
  });

  it('usage 卡：占位文案，绝不显 0，绝不画环比', () => {
    const { container } = render(<MetricCards metrics={metrics()} meta={PLACEHOLDER_META} />);
    const usage = container.querySelector('[data-key="invocationsTotal"]') as HTMLElement;
    expect(usage.getAttribute('data-placeholder')).toBe('true');
    expect(within(usage).getByText('暂无数据 / 上线后填充')).toBeInTheDocument();
    // 不渲染 0、不渲染环比箭头
    expect(within(usage).queryByText('0')).not.toBeInTheDocument();
    expect(usage.querySelector('.cb-metric-card__delta')).toBeNull();
  });

  it('三张 usage 卡都走占位', () => {
    const { container } = render(<MetricCards metrics={metrics()} meta={PLACEHOLDER_META} />);
    const placeholders = container.querySelectorAll('[data-placeholder="true"]');
    expect(placeholders).toHaveLength(3);
  });
});

// TokenTrendChart 测试：四态分流 + 双口径切换。
// jsdom 无 canvas → mock 底层 chart，按是否渲染 echarts-core 判定「画了真图」。
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Meta, TokenTrend } from '@cb/shared';

vi.mock('echarts-for-react/lib/core', () => ({
  default: (props: { option: unknown }) => (
    <div data-testid="echarts-core" data-option={JSON.stringify(props.option)} />
  ),
}));

import { TokenTrendChart } from './TokenTrendChart.js';

function trend(over: Partial<TokenTrend> = {}): TokenTrend {
  return {
    range: '30d',
    metric: 'tokens',
    points: [
      { date: '2026-06-01T00:00:00Z', value: 10 },
      { date: '2026-06-02T00:00:00Z', value: 42 },
    ],
    peak: { date: '2026-06-02T00:00:00Z', value: 42 },
    empty: false,
    ...over,
  };
}

describe('TokenTrendChart 四态', () => {
  it('trend=null → 加载骨架（非真图、非转圈）', () => {
    render(<TokenTrendChart trend={null} />);
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByTestId('echarts-core')).toBeNull();
  });

  it('usage 占位（meta.placeholders.points）→ 占位文案，不画图、不显 0', () => {
    const meta: Meta = { placeholders: { points: '暂无数据 / 上线后填充' } };
    render(<TokenTrendChart trend={trend({ points: [], empty: true })} meta={meta} />);
    expect(screen.getByText('暂无数据 / 上线后填充')).toBeInTheDocument();
    expect(screen.queryByTestId('echarts-core')).toBeNull();
    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });

  it('empty=true → 空态「暂无消耗」，不误标峰值（不画图）', () => {
    render(<TokenTrendChart trend={trend({ points: [], peak: null, empty: true })} />);
    expect(screen.getByText('暂无消耗')).toBeInTheDocument();
    expect(screen.queryByTestId('echarts-core')).toBeNull();
  });

  it('全 null 点 → 空态（不画 0 线）', () => {
    render(
      <TokenTrendChart
        trend={trend({
          points: [
            { date: '2026-06-01T00:00:00Z', value: null },
            { date: '2026-06-02T00:00:00Z', value: null },
          ],
          empty: false,
        })}
      />,
    );
    expect(screen.getByText('暂无消耗')).toBeInTheDocument();
  });

  it('有真实数据 → 画真图，option 含 line 系列', () => {
    render(<TokenTrendChart trend={trend()} />);
    const core = screen.getByTestId('echarts-core');
    const opt = JSON.parse(core.getAttribute('data-option') ?? '{}');
    expect(opt.series[0].type).toBe('line');
  });
});

describe('TokenTrendChart 双口径切换', () => {
  it('给了 metric + onMetricChange → 渲染切换段控，当前档有选中标识', () => {
    render(<TokenTrendChart trend={trend()} metric="tokens" onMetricChange={() => {}} />);
    const tokensBtn = screen.getByRole('button', { name: 'tokens' });
    expect(tokensBtn).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '调用次数' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('点另一档 → 回调带新口径', async () => {
    const onChange = vi.fn();
    render(<TokenTrendChart trend={trend()} metric="tokens" onMetricChange={onChange} />);
    await userEvent.click(screen.getByRole('button', { name: '调用次数' }));
    expect(onChange).toHaveBeenCalledWith('invocations');
  });

  it('不给 metric → 不渲染切换段控', () => {
    render(<TokenTrendChart trend={trend()} />);
    expect(screen.queryByRole('group', { name: '切换趋势口径' })).toBeNull();
  });
});

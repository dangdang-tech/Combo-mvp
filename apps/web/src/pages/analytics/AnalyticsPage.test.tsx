// 数据分析页测试（F-07）：真实维度正常显示 / usage 占位 / 图占位态 / range·metric 切换 /
// 局部失败不连坐 / 错误重试。echarts 用轻量 mock；多端点用按路径路由的 fetch mock（顺序无关）。
import { describe, it, expect, afterEach, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DashboardMetrics, TokenTrend } from '@cb/shared';

vi.mock('echarts-for-react/lib/core', () => ({
  default: (props: { option: unknown }) => (
    <div data-testid="echarts-core" data-option={JSON.stringify(props.option)} />
  ),
}));

import { renderPage } from '../__testutils__/renderPage.js';
import { installRoutedFetchMock, type RoutedFetchMock } from '../__testutils__/routedFetchMock.js';
import { AnalyticsPage } from './AnalyticsPage.js';

const metricsBody = (): { data: DashboardMetrics; meta: unknown } => ({
  data: {
    range: '30d',
    cards: [
      {
        key: 'published',
        label: '已发布能力体',
        value: 8,
        deltaPercent: 12,
        deltaDirection: 'up',
        unit: '个',
      },
      {
        key: 'invocationsTotal',
        label: '累计调用',
        value: null,
        deltaPercent: null,
        deltaDirection: null,
      },
      {
        key: 'spendThisMonth',
        label: '本月消耗',
        value: null,
        deltaPercent: null,
        deltaDirection: null,
      },
      {
        key: 'activeConsumers',
        label: '活跃消费者',
        value: null,
        deltaPercent: null,
        deltaDirection: null,
      },
    ],
  },
  meta: {
    traceId: 't',
    placeholders: {
      invocationsTotal: '暂无数据 / 上线后填充',
      spendThisMonth: '暂无数据 / 上线后填充',
      activeConsumers: '暂无数据 / 上线后填充',
    },
  },
});

const trendBody = (): { data: TokenTrend; meta: unknown } => ({
  data: { range: '30d', metric: 'tokens', points: [], peak: null, empty: true },
  meta: { traceId: 't', placeholders: { points: '暂无数据 / 上线后填充' } },
});

const ERR = {
  status: 500,
  json: {
    error: {
      userMessage: '经营数据没能加载，请重试。',
      retriable: true,
      action: 'retry',
      traceId: 'tr',
    },
  },
};

/** 默认两端点都成功（顺序无关）。 */
function installOk(): RoutedFetchMock {
  return installRoutedFetchMock([
    { match: '/dashboard/metrics', response: { status: 200, json: metricsBody() } },
    { match: '/dashboard/token-trend', response: { status: 200, json: trendBody() } },
  ]);
}

let mock: RoutedFetchMock | undefined;
afterEach(() => mock?.restore());

describe('数据分析页', () => {
  it('真实维度（已发布能力体）正常显示真实值 + 真实环比，不占位', async () => {
    mock = installOk();
    renderPage(<AnalyticsPage />);
    expect(await screen.findByText('已发布能力体')).toBeInTheDocument();
    expect(screen.getByText('8')).toBeInTheDocument();
    expect(screen.getByText(/12%/)).toBeInTheDocument();
  });

  it('usage 卡（累计调用 / 本月消耗 / 活跃消费者）统一占位，绝不显 0', async () => {
    mock = installOk();
    const { container } = renderPage(<AnalyticsPage />);
    await screen.findByText('已发布能力体');
    expect(container.querySelector('[data-placeholder="invocationsTotal"]')).toBeInTheDocument();
    expect(container.querySelector('[data-placeholder="spendThisMonth"]')).toBeInTheDocument();
    expect(container.querySelector('[data-placeholder="activeConsumers"]')).toBeInTheDocument();
    // usage 卡不画假环比、不显 0。
    const usageCard = container.querySelector('[data-metric="invocationsTotal"]');
    expect(usageCard?.querySelector('.cb-metric-card__delta')).toBeNull();
  });

  it('token 趋势 usage 占位 → 图占位态（ChartPlaceholder），不画误导图', async () => {
    mock = installOk();
    const { container } = renderPage(<AnalyticsPage />);
    await screen.findByText('消耗趋势');
    await waitFor(() =>
      expect(container.querySelector('.cb-chart-state--placeholder')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('echarts-core')).toBeNull();
  });

  it('range 三档切换：当前档高亮 + 重新拉数（带 range=7d）', async () => {
    mock = installOk();
    renderPage(<AnalyticsPage />);
    await screen.findByText('已发布能力体');

    const sevenDay = screen.getByRole('button', { name: '近 7 天' });
    await userEvent.click(sevenDay);
    await waitFor(() => expect(sevenDay).toHaveAttribute('aria-pressed', 'true'));
    await waitFor(() => {
      expect(mock?.calls.some((c) => c.url.includes('range=7d'))).toBe(true);
    });
  });

  it('token 趋势双口径 metric 切换：带 metric=invocations 重新拉数', async () => {
    mock = installOk();
    renderPage(<AnalyticsPage />);
    await screen.findByText('消耗趋势');

    const invToggle = await screen.findByRole('button', { name: '调用次数' });
    await userEvent.click(invToggle);
    await waitFor(() => {
      expect(mock?.calls.some((c) => c.url.includes('metric=invocations'))).toBe(true);
    });
  });

  it('局部失败不连坐：指标卡失败出 ErrorState，趋势区照常渲染', async () => {
    mock = installRoutedFetchMock([
      { match: '/dashboard/metrics', response: ERR },
      { match: '/dashboard/token-trend', response: { status: 200, json: trendBody() } },
    ]);
    const { container } = renderPage(<AnalyticsPage />);

    expect(await screen.findByText('经营数据没能加载，请重试。')).toBeInTheDocument();
    // 趋势区仍在（标题 + 图占位），整页不崩。
    expect(screen.getByText('消耗趋势')).toBeInTheDocument();
    await waitFor(() =>
      expect(container.querySelector('.cb-chart-state--placeholder')).toBeInTheDocument(),
    );
  });

  it('错误态：ErrorState 只人话 + 重试，无错误码', async () => {
    // 两端点都失败 → 两处局部错误；断言任一为「人话 + 重试」，且全页无裸状态码。
    mock = installRoutedFetchMock([
      { match: '/dashboard/metrics', response: ERR },
      { match: '/dashboard/token-trend', response: ERR },
    ]);
    const { container } = renderPage(<AnalyticsPage />);

    await screen.findAllByText('经营数据没能加载，请重试。');
    const alerts = screen.getAllByRole('alert');
    expect(
      within(alerts[0] as HTMLElement).getByRole('button', { name: '重试' }),
    ).toBeInTheDocument();
    expect(container.innerHTML).not.toMatch(/\b500\b/);
  });
});

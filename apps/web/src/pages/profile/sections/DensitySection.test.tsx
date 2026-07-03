// ③ 能力·按会话密度测试（主页-05/06/08）——逐条段数+趋势箭头、展开更多、只读无管理动作。
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// DensityBar 内嵌 ECharts，jsdom 下 mock 掉 canvas 实现，只断言行列表（可访问主交互层）。
vi.mock('echarts-for-react/lib/core', () => ({
  default: (props: { option: unknown }) => (
    <div data-testid="echarts-core" data-option={JSON.stringify(props.option)} />
  ),
}));

import { DensitySection } from './DensitySection.js';
import { makeDensity, makeDensityRow } from '../fixtures.js';

describe('DensitySection ③ 密度榜', () => {
  it('逐条渲染：名称 + 支撑段数 + 趋势箭头', () => {
    render(<DensitySection density={makeDensity()} loadingMore={false} onLoadMore={() => {}} />);
    expect(screen.getByText('能力1')).toBeInTheDocument();
    expect(screen.getByText('29 段支撑')).toBeInTheDocument();
    // 趋势上升箭头（按 aria-label）。
    expect(screen.getAllByLabelText('趋势上升').length).toBeGreaterThan(0);
  });

  it('趋势 down/flat 各自渲染对应箭头语义', () => {
    render(
      <DensitySection
        density={makeDensity({
          rows: [
            makeDensityRow({ rank: 1, trend: 'down', capabilityId: 'd' }),
            makeDensityRow({ rank: 2, trend: 'flat', capabilityId: 'f' }),
          ],
          hasMore: false,
        })}
        loadingMore={false}
        onLoadMore={() => {}}
      />,
    );
    expect(screen.getByLabelText('趋势下降')).toBeInTheDocument();
    expect(screen.getByLabelText('趋势持平')).toBeInTheDocument();
  });

  it('hasMore=true → 「展开更多」按钮，点击触发回调（主页-06）', async () => {
    const onLoadMore = vi.fn();
    render(<DensitySection density={makeDensity()} loadingMore={false} onLoadMore={onLoadMore} />);
    await userEvent.click(screen.getByRole('button', { name: '展开更多' }));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it('loadingMore=true → 按钮禁用 + 文案「加载中…」（不裸转圈）', () => {
    render(<DensitySection density={makeDensity()} loadingMore onLoadMore={() => {}} />);
    expect(screen.getByRole('button', { name: '加载中…' })).toBeDisabled();
  });

  it('hasMore=false → 无展开按钮', () => {
    render(
      <DensitySection
        density={makeDensity({ hasMore: false })}
        loadingMore={false}
        onLoadMore={() => {}}
      />,
    );
    expect(screen.queryByRole('button', { name: '展开更多' })).toBeNull();
  });

  it('只读无管理：不出现 发布/编辑/下架/改价 动作', () => {
    render(<DensitySection density={makeDensity()} loadingMore={false} onLoadMore={() => {}} />);
    expect(screen.queryByText(/发布|编辑|下架|改价/)).toBeNull();
  });

  it('逐条下钻本期未开放：按钮 disabled + 可见「本期未开放」反馈（点了有可见结果，非空 preventDefault，Codex r1#4）', () => {
    render(
      <DensitySection
        density={makeDensity({ rows: [makeDensityRow({ rank: 1 })], hasMore: false })}
        loadingMore={false}
        onLoadMore={() => {}}
      />,
    );
    const drill = screen.getByTitle('密度构成详情本期未开放');
    expect(drill).toBeDisabled();
    // 可见占位反馈（静态可见结果，非裸 preventDefault）。
    expect(screen.getByText('本期未开放')).toBeInTheDocument();
  });

  it('空（无能力）→ 空态「还没有能力」', () => {
    render(
      <DensitySection
        density={makeDensity({ rows: [], hasMore: false })}
        loadingMore={false}
        onLoadMore={() => {}}
      />,
    );
    expect(screen.getByText('还没有能力')).toBeInTheDocument();
  });
});

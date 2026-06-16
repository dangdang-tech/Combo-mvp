// 图表三态测试：占位 / 加载骨架 / 空数据——永不裸转圈、不画误导图、绝不显 0。
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Meta } from '@cb/shared';
import { ChartPlaceholder, ChartSkeleton, ChartEmpty } from './ChartStates.js';

describe('ChartPlaceholder（usage 占位）', () => {
  it('显示后端给的占位文案，绝不显 0', () => {
    const meta: Meta = { placeholders: { points: '暂无数据 / 上线后填充' } };
    render(<ChartPlaceholder field="points" meta={meta} />);
    expect(screen.getByText('暂无数据 / 上线后填充')).toBeInTheDocument();
    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });

  it('meta 缺键 → 兜底文案（仍不裸转圈）', () => {
    render(<ChartPlaceholder field="points" meta={{}} />);
    expect(screen.getByText('暂无数据 / 上线后填充')).toBeInTheDocument();
  });

  it('data-placeholder 标记字段键', () => {
    const { container } = render(<ChartPlaceholder field="tokenTrend" />);
    expect(container.querySelector('[data-placeholder="tokenTrend"]')).toBeInTheDocument();
  });

  it('role=img + aria-label（占位也可访问）', () => {
    render(<ChartPlaceholder field="points" label="token 趋势" />);
    expect(screen.getByRole('img', { name: 'token 趋势' })).toBeInTheDocument();
  });
});

describe('ChartSkeleton（加载骨架，非 spinner）', () => {
  it('role=status + aria-busy（无障碍加载语义，不裸转圈）', () => {
    render(<ChartSkeleton label="趋势加载中" />);
    const el = screen.getByRole('status');
    expect(el).toHaveAttribute('aria-busy', 'true');
    expect(el).toHaveAttribute('aria-label', '趋势加载中');
  });

  it('无 spinner（不含 role=progressbar、不含转圈类）', () => {
    const { container } = render(<ChartSkeleton />);
    expect(container.querySelector('[role="progressbar"]')).toBeNull();
    expect(container.querySelector('.cb-chart-state--skeleton')).toBeInTheDocument();
  });
});

describe('ChartEmpty（确有数据源但空区间）', () => {
  it('显示空态文案，role=img', () => {
    render(<ChartEmpty text="暂无消耗" />);
    expect(screen.getByRole('img', { name: '暂无消耗' })).toBeInTheDocument();
    expect(screen.getByText('暂无消耗')).toBeInTheDocument();
  });
});

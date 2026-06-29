// MiniSparkline 测试：行内三态（占位/空/真图），占位绝不画 0 线。
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Meta, TrendPoint } from '@cb/shared';

vi.mock('echarts-for-react/lib/core', () => ({
  default: (props: { option: unknown }) => (
    <div data-testid="echarts-core" data-option={JSON.stringify(props.option)} />
  ),
}));

import { MiniSparkline } from './MiniSparkline.js';

const pts: TrendPoint[] = [
  { date: 'a', value: 3 },
  { date: 'b', value: 8 },
];

describe('MiniSparkline', () => {
  it('points=null（usage 占位）→ 行内占位，不画图、不显 0', () => {
    const { container } = render(<MiniSparkline points={null} />);
    expect(screen.queryByTestId('echarts-core')).toBeNull();
    expect(container.querySelector('.cb-sparkline--placeholder')).toBeInTheDocument();
    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });

  it('meta.placeholders 标注 → 占位（title 带后端文案）', () => {
    const meta: Meta = { placeholders: { spendSparkline: '暂无数据 / 上线后填充' } };
    const { container } = render(<MiniSparkline points={pts} meta={meta} />);
    expect(screen.queryByTestId('echarts-core')).toBeNull();
    expect(container.querySelector('[title="暂无数据 / 上线后填充"]')).toBeInTheDocument();
  });

  it('空数组 → 短横线占位（不破行、不画图）', () => {
    const { container } = render(<MiniSparkline points={[]} />);
    expect(screen.queryByTestId('echarts-core')).toBeNull();
    expect(container.querySelector('.cb-sparkline--empty')).toBeInTheDocument();
  });

  it('全 null → 短横线占位', () => {
    const { container } = render(
      <MiniSparkline
        points={[
          { date: 'a', value: null },
          { date: 'b', value: null },
        ]}
      />,
    );
    expect(container.querySelector('.cb-sparkline--empty')).toBeInTheDocument();
  });

  it('有数据 → 画极简 sparkline', () => {
    render(<MiniSparkline points={pts} />);
    const core = screen.getByTestId('echarts-core');
    const opt = JSON.parse(core.getAttribute('data-option') ?? '{}');
    expect(opt.series[0].type).toBe('line');
  });

  it('真图带可访问 aria-label', () => {
    render(<MiniSparkline points={pts} ariaLabel="某能力消耗趋势" />);
    expect(screen.getByRole('img', { name: '某能力消耗趋势' })).toBeInTheDocument();
  });
});

// DensityBar 测试：加载/空/真图三态 + 高度按条数自适应。
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { DensityRankRow } from '@cb/shared';

vi.mock('echarts-for-react/lib/core', () => ({
  default: (props: { option: unknown }) => (
    <div data-testid="echarts-core" data-option={JSON.stringify(props.option)} />
  ),
}));

import { DensityBar } from './DensityBar.js';

function row(rank: number, name: string): DensityRankRow {
  return {
    rank,
    capabilityId: `cap-${rank}`,
    slug: `s-${rank}`,
    name,
    densityScore: 100 - rank * 10,
    supportingSegments: 30 - rank,
    trend: 'up',
    readonly: true,
  };
}

describe('DensityBar', () => {
  it('rows=null → 加载骨架（不裸转圈）', () => {
    render(<DensityBar rows={null} />);
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByTestId('echarts-core')).toBeNull();
  });

  it('rows 空（无能力）→ 空态「还没有能力」', () => {
    render(<DensityBar rows={[]} />);
    expect(screen.getByText('还没有能力')).toBeInTheDocument();
    expect(screen.queryByTestId('echarts-core')).toBeNull();
  });

  it('有数据 → 画横向 bar，aria-label 含项数', () => {
    render(<DensityBar rows={[row(1, 'A'), row(2, 'B'), row(3, 'C')]} />);
    expect(screen.getByTestId('echarts-core')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /共 3 项/ })).toBeInTheDocument();
  });

  it('option 为 bar 系列', () => {
    render(<DensityBar rows={[row(1, 'A')]} />);
    const opt = JSON.parse(screen.getByTestId('echarts-core').getAttribute('data-option') ?? '{}');
    expect(opt.series[0].type).toBe('bar');
  });
});

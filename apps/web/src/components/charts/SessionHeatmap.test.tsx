// SessionHeatmap 测试：加载/关闭/空/真图四态 + 图例 + 隐私（tooltip 不露正文）。
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ProfileHeatmap } from '@cb/shared';

vi.mock('echarts-for-react/lib/core', () => ({
  default: (props: { option: unknown }) => (
    <div data-testid="echarts-core" data-option={JSON.stringify(props.option)} />
  ),
}));

import { SessionHeatmap } from './SessionHeatmap.js';

function heatmap(over: Partial<ProfileHeatmap> = {}): ProfileHeatmap {
  return {
    range: 'half_year',
    start: '2026-01-01',
    end: '2026-06-15',
    cells: [{ date: '2026-06-01', count: 3, level: 2 }],
    maxCount: 3,
    enabled: true,
    ...over,
  };
}

describe('SessionHeatmap', () => {
  it('heatmap=null → 加载骨架（不裸转圈）', () => {
    render(<SessionHeatmap heatmap={null} />);
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('enabled=false（创作者关闭，主页-20）→ 渲染 null，不占版面/不留空框', () => {
    const { container } = render(<SessionHeatmap heatmap={heatmap({ enabled: false })} />);
    expect(container.firstChild).toBeNull();
  });

  it('cells 空（新创作者）→ 空态「暂无会话足迹」', () => {
    render(<SessionHeatmap heatmap={heatmap({ cells: [] })} />);
    expect(screen.getByText('暂无会话足迹')).toBeInTheDocument();
    expect(screen.queryByTestId('echarts-core')).toBeNull();
  });

  it('有数据 → 画热力图 + 「少/多」图例', () => {
    render(<SessionHeatmap heatmap={heatmap()} />);
    expect(screen.getByTestId('echarts-core')).toBeInTheDocument();
    expect(screen.getByText('少')).toBeInTheDocument();
    expect(screen.getByText('多')).toBeInTheDocument();
  });

  it('真图 aria-label 含「近半年」语义', () => {
    render(<SessionHeatmap heatmap={heatmap()} />);
    expect(screen.getByRole('img', { name: /近半年/ })).toBeInTheDocument();
  });

  it('隐私：option 数据维度只含 [date, level]，不含会话正文', () => {
    render(<SessionHeatmap heatmap={heatmap()} />);
    const opt = JSON.parse(screen.getByTestId('echarts-core').getAttribute('data-option') ?? '{}');
    expect(opt.series[0].data).toEqual([['2026-06-01', 2]]);
  });
});

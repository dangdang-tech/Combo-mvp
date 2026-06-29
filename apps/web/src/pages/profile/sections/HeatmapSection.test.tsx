// ④ 会话足迹热力图测试（主页-09/20）——有数据渲染热力图；enabled=false 整段不渲染（不留空框）。
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('echarts-for-react/lib/core', () => ({
  default: (props: { option: unknown }) => (
    <div data-testid="echarts-core" data-option={JSON.stringify(props.option)} />
  ),
}));

import { HeatmapSection } from './HeatmapSection.js';
import { makeHeatmap } from '../fixtures.js';

describe('HeatmapSection ④ 会话足迹', () => {
  it('有数据 → 渲染标题 + 热力图（4A SessionHeatmap）', () => {
    render(<HeatmapSection heatmap={makeHeatmap()} />);
    expect(screen.getByText('会话足迹 · 近半年')).toBeInTheDocument();
    expect(screen.getByTestId('echarts-core')).toBeInTheDocument();
  });

  it('enabled=false（创作者关闭）→ 整段不渲染，不留空框（主页-20）', () => {
    const { container } = render(<HeatmapSection heatmap={makeHeatmap({ enabled: false })} />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByText('会话足迹 · 近半年')).toBeNull();
  });

  it('cells 空（新创作者）→ 空态「暂无会话足迹」，不画误导图', () => {
    render(<HeatmapSection heatmap={makeHeatmap({ cells: [], maxCount: 0 })} />);
    expect(screen.getByText('暂无会话足迹')).toBeInTheDocument();
    expect(screen.queryByTestId('echarts-core')).toBeNull();
  });
});

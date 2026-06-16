// EChart 薄封装测试。jsdom 无 canvas，故 mock echarts-for-react/lib/core，
// 断言：role=img + aria-label（可访问）、option/notMerge 透传、容器宽高样式（响应式撑满）。
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

// 受控假 chart：把 option 序列化进 data 属性，把 style 落到 DOM，便于断言。
vi.mock('echarts-for-react/lib/core', () => ({
  default: (props: { option: unknown; notMerge?: boolean; style?: React.CSSProperties }) => (
    <div
      data-testid="echarts-core"
      data-option={JSON.stringify(props.option)}
      data-notmerge={String(props.notMerge)}
      style={props.style}
    />
  ),
}));

import { EChart } from './EChart.js';

describe('EChart', () => {
  it('role=img + aria-label（canvas 对读屏不可读，靠 label 兜底）', () => {
    render(<EChart option={{ series: [] }} ariaLabel="测试图表" />);
    expect(screen.getByRole('img', { name: '测试图表' })).toBeInTheDocument();
  });

  it('option 透传给底层 chart', () => {
    render(<EChart option={{ series: [{ type: 'line' }] }} ariaLabel="x" />);
    const core = screen.getByTestId('echarts-core');
    expect(JSON.parse(core.getAttribute('data-option') ?? '{}')).toEqual({
      series: [{ type: 'line' }],
    });
  });

  it('默认 notMerge=true（口径切换不残留旧系列）', () => {
    render(<EChart option={{}} ariaLabel="x" />);
    expect(screen.getByTestId('echarts-core').getAttribute('data-notmerge')).toBe('true');
  });

  it('宽度默认 100%、数字高度转 px（响应式撑满容器）', () => {
    render(<EChart option={{}} ariaLabel="x" height={300} />);
    const core = screen.getByTestId('echarts-core') as HTMLElement;
    expect(core.style.width).toBe('100%');
    expect(core.style.height).toBe('300px');
  });

  it('字符串宽高原样透传', () => {
    render(<EChart option={{}} ariaLabel="x" width="50vw" height="10rem" />);
    const core = screen.getByTestId('echarts-core') as HTMLElement;
    expect(core.style.width).toBe('50vw');
    expect(core.style.height).toBe('10rem');
  });
});

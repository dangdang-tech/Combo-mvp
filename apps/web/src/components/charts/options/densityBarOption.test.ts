// densityBarOption builder 单测（纯函数）。
// 验证：横向 bar、rank1 在最上、前 3 高亮、tooltip 含段数+趋势、空 rows 不崩。
import { describe, it, expect } from 'vitest';
import type { DensityRankRow } from '@cb/shared';
import { buildDensityBarOption, TREND_ARROW } from './densityBarOption.js';

function row(over: Partial<DensityRankRow> & { rank: number; name: string }): DensityRankRow {
  return {
    capabilityId: `cap-${over.rank}`,
    slug: `slug-${over.rank}`,
    densityScore: 50,
    supportingSegments: 12,
    trend: 'up',
    readonly: true,
    ...over,
  };
}

const rows: DensityRankRow[] = [
  row({ rank: 1, name: 'A', densityScore: 90, supportingSegments: 30, trend: 'up' }),
  row({ rank: 2, name: 'B', densityScore: 60, supportingSegments: 18, trend: 'flat' }),
  row({ rank: 3, name: 'C', densityScore: 40, supportingSegments: 9, trend: 'down' }),
  row({ rank: 4, name: 'D', densityScore: 20, supportingSegments: 4, trend: 'up' }),
];

type Bar = {
  type?: string;
  data?: Array<{ value: number; itemStyle: { color: string } }>;
};

describe('buildDensityBarOption', () => {
  it('横向 bar 系列', () => {
    const opt = buildDensityBarOption(rows);
    const series = opt.series as Bar[];
    expect(series[0]!.type).toBe('bar');
  });

  it('rank1 在 Y 轴最上（类目自下而上故倒序）', () => {
    const opt = buildDensityBarOption(rows);
    const yAxis = opt.yAxis as { data: string[] };
    // 最后一个 = 最上 = rank1
    expect(yAxis.data[yAxis.data.length - 1]).toBe('1. A');
    expect(yAxis.data[0]).toBe('4. D');
  });

  it('前 3 名用强调色、第 4 用淡色', () => {
    const opt = buildDensityBarOption(rows);
    const series = opt.series as Bar[];
    const data = series[0]!.data!;
    // data 与 yAxis 同序（倒序）：index0 = rank4（淡），最后 = rank1（亮）
    const rank4 = data[0]!;
    const rank1 = data[data.length - 1]!;
    expect(rank1.itemStyle.color).not.toBe(rank4.itemStyle.color);
  });

  it('tooltip 含密度 + 段数 + 趋势箭头', () => {
    const opt = buildDensityBarOption(rows);
    const tt = opt.tooltip as { formatter: (p: unknown) => string };
    const text = tt.formatter([{ name: '1. A' }]);
    expect(text).toContain('90');
    expect(text).toContain('30 段');
    expect(text).toContain(TREND_ARROW.up);
  });

  it('tooltip 未知项 → 不崩', () => {
    const opt = buildDensityBarOption(rows);
    const tt = opt.tooltip as { formatter: (p: unknown) => string };
    expect(tt.formatter([{ name: '99. X' }])).toBeTypeOf('string');
    expect(tt.formatter([])).toBeTypeOf('string');
  });

  it('空 rows → data 为空，不崩', () => {
    const opt = buildDensityBarOption([]);
    const series = opt.series as Bar[];
    expect(series[0]!.data).toEqual([]);
  });

  it('X 轴 max=100（密度归一）', () => {
    const opt = buildDensityBarOption(rows);
    const xAxis = opt.xAxis as { max?: number };
    expect(xAxis.max).toBe(100);
  });
});

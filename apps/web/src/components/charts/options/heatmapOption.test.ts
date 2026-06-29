// heatmapOption builder 单测（纯函数）。
// 验证：calendar 坐标系 + heatmap 系列、level 上色 piecewise、隐私（数据维度只含 date/level）、
//       tooltip 只显示日期+段数（不含正文）、空 cells 不崩。
import { describe, it, expect } from 'vitest';
import type { ProfileHeatmap } from '@cb/shared';
import { buildHeatmapOption, HEATMAP_LEGEND_LABELS } from './heatmapOption.js';

function heatmap(over: Partial<ProfileHeatmap> = {}): ProfileHeatmap {
  return {
    range: 'half_year',
    start: '2026-01-01',
    end: '2026-06-15',
    cells: [
      { date: '2026-06-01', count: 3, level: 2 },
      { date: '2026-06-10', count: 9, level: 4 },
    ],
    maxCount: 9,
    enabled: true,
    ...over,
  };
}

type HeatSeries = { type?: string; coordinateSystem?: string; data?: Array<[string, number]> };

describe('buildHeatmapOption', () => {
  it('calendar + heatmap 系列', () => {
    const opt = buildHeatmapOption(heatmap());
    const series = opt.series as HeatSeries[];
    expect(series[0]!.type).toBe('heatmap');
    expect(series[0]!.coordinateSystem).toBe('calendar');
  });

  it('数据维度只含 [date, level]（隐私：不含 count/正文）', () => {
    const opt = buildHeatmapOption(heatmap());
    const series = opt.series as HeatSeries[];
    expect(series[0]!.data).toEqual([
      ['2026-06-01', 2],
      ['2026-06-10', 4],
    ]);
  });

  it('calendar.range 用 start/end', () => {
    const opt = buildHeatmapOption(heatmap());
    const cal = opt.calendar as { range?: [string, string] };
    expect(cal.range).toEqual(['2026-01-01', '2026-06-15']);
  });

  it('visualMap 用 piecewise 吃 level 0-4', () => {
    const opt = buildHeatmapOption(heatmap());
    const vm = opt.visualMap as { type?: string; min?: number; max?: number };
    expect(vm.type).toBe('piecewise');
    expect(vm.min).toBe(0);
    expect(vm.max).toBe(4);
  });

  it('tooltip 文案含日期+段数，不含「正文/标题」类字段', () => {
    const opt = buildHeatmapOption(heatmap());
    const tt = opt.tooltip as { formatter: (p: unknown) => string };
    const text = tt.formatter({ value: ['2026-06-01', 2] });
    expect(text).toContain('2026-06-01');
    expect(text).toContain('3 段'); // count 经映射查回
    expect(text).not.toContain('内容');
  });

  it('tooltip 未知日期 → 段数兜底 0，不崩', () => {
    const opt = buildHeatmapOption(heatmap());
    const tt = opt.tooltip as { formatter: (p: unknown) => string };
    expect(tt.formatter({ value: ['1999-01-01', 0] })).toContain('0 段');
    expect(tt.formatter({})).toBeTypeOf('string');
  });

  it('空 cells → data 为空数组，不崩', () => {
    const opt = buildHeatmapOption(heatmap({ cells: [] }));
    const series = opt.series as HeatSeries[];
    expect(series[0]!.data).toEqual([]);
  });

  it('图例文案「少 / 多」', () => {
    expect(HEATMAP_LEGEND_LABELS).toEqual(['少', '多']);
  });
});

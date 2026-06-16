// sparklineOption builder 单测（纯函数）。
import { describe, it, expect } from 'vitest';
import type { TrendPoint } from '@cb/shared';
import { buildSparklineOption } from './sparklineOption.js';

const pts: TrendPoint[] = [
  { date: 'a', value: 3 },
  { date: 'b', value: 8 },
  { date: 'c', value: 5 },
];

type S = { type?: string; data?: Array<number | null>; connectNulls?: boolean };

describe('buildSparklineOption', () => {
  it('line 系列、无 tooltip、不连 null', () => {
    const opt = buildSparklineOption(pts);
    const series = opt.series as S[];
    expect(series[0]!.type).toBe('line');
    expect(series[0]!.connectNulls).toBe(false);
    expect(series[0]!.data).toEqual([3, 8, 5]);
    expect((opt.tooltip as { show?: boolean }).show).toBe(false);
  });

  it('轴隐藏（行内极简）', () => {
    const opt = buildSparklineOption(pts);
    expect((opt.xAxis as { show?: boolean }).show).toBe(false);
  });

  it('含 null → 透传 null，不补 0', () => {
    const opt = buildSparklineOption([
      { date: 'a', value: 3 },
      { date: 'b', value: null },
    ]);
    const series = opt.series as S[];
    expect(series[0]!.data).toEqual([3, null]);
  });
});

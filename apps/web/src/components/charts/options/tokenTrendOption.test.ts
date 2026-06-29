// tokenTrendOption builder 单测（纯函数，无 DOM）。
// 验证：双口径单位/系列名、峰值仅在有真实峰值时标注（外壳首页-26 不误标）、
//       含 null 点透传 null（不补 0）、占位/全空数据不崩。
import { describe, it, expect } from 'vitest';
import type { TokenTrend } from '@cb/shared';
import { buildTokenTrendOption, metricUnit, metricLabel } from './tokenTrendOption.js';

function trend(over: Partial<TokenTrend> = {}): TokenTrend {
  return {
    range: '30d',
    metric: 'tokens',
    points: [
      { date: '2026-06-01T00:00:00Z', value: 10 },
      { date: '2026-06-02T00:00:00Z', value: 42 },
      { date: '2026-06-03T00:00:00Z', value: 7 },
    ],
    peak: { date: '2026-06-02T00:00:00Z', value: 42 },
    empty: false,
    ...over,
  };
}

type SeriesLike = {
  type?: string;
  data?: Array<number | null>;
  connectNulls?: boolean;
  markPoint?: { data: Array<{ value: number }> };
};
function firstSeries(opt: ReturnType<typeof buildTokenTrendOption>): SeriesLike {
  const series = opt.series as SeriesLike[];
  return series[0]!;
}

describe('metricUnit / metricLabel 双口径', () => {
  it('tokens 口径', () => {
    expect(metricUnit('tokens')).toBe('tokens');
    expect(metricLabel('tokens')).toContain('token');
  });
  it('invocations 口径', () => {
    expect(metricUnit('invocations')).toBe('次');
    expect(metricLabel('invocations')).toContain('调用');
  });
});

describe('buildTokenTrendOption', () => {
  it('line 系列 + 面积 + 不连 null（connectNulls=false）', () => {
    const s = firstSeries(buildTokenTrendOption(trend()));
    expect(s.type).toBe('line');
    expect(s.connectNulls).toBe(false);
    expect(s.data).toEqual([10, 42, 7]);
  });

  it('有真实峰值 → markPoint 标注该值', () => {
    const s = firstSeries(buildTokenTrendOption(trend()));
    expect(s.markPoint).toBeDefined();
    expect(s.markPoint!.data[0]!.value).toBe(42);
  });

  it('peak=null → 不标峰值（不误标）', () => {
    const s = firstSeries(buildTokenTrendOption(trend({ peak: null })));
    expect(s.markPoint).toBeUndefined();
  });

  it('peak.value=null → 不标峰值', () => {
    const s = firstSeries(
      buildTokenTrendOption(trend({ peak: { date: '2026-06-02T00:00:00Z', value: null } })),
    );
    expect(s.markPoint).toBeUndefined();
  });

  it('含 null 点 → 透传 null，绝不补 0', () => {
    const s = firstSeries(
      buildTokenTrendOption(
        trend({
          points: [
            { date: '2026-06-01T00:00:00Z', value: 10 },
            { date: '2026-06-02T00:00:00Z', value: null },
            { date: '2026-06-03T00:00:00Z', value: 5 },
          ],
        }),
      ),
    );
    expect(s.data).toEqual([10, null, 5]);
    expect(s.data).not.toContain(0);
  });

  it('全 null 点 + 仍带 peak → 不误标峰值', () => {
    const s = firstSeries(
      buildTokenTrendOption(
        trend({
          points: [
            { date: '2026-06-01T00:00:00Z', value: null },
            { date: '2026-06-02T00:00:00Z', value: null },
          ],
          peak: { date: '2026-06-02T00:00:00Z', value: 42 },
        }),
      ),
    );
    expect(s.markPoint).toBeUndefined();
  });

  it('invocations 口径 → 纵轴名为「次」', () => {
    const opt = buildTokenTrendOption(trend({ metric: 'invocations' }));
    const yAxis = opt.yAxis as { name?: string };
    expect(yAxis.name).toBe('次');
  });
});

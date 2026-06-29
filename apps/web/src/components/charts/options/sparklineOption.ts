// 行内迷你图 sparkline option builder（外壳首页-11 能力体列表行内消耗趋势）。
//
// 极简：无轴、无网格、无 tooltip 标题，只一条带面积的小折线，嵌在表格行里。
// 占位/空（spendSparkline=null 或全 null）→ 调用方走占位组件，不调用本函数。
import type { EChartsOption } from 'echarts';
import type { TrendPoint } from '@cb/shared';
import { CHART_ACCENT, CHART_ACCENT_FADE } from '../theme.js';
import { trendValues } from './util.js';

/** 构造 sparkline option（无坐标系装饰，纯线形）。 */
export function buildSparklineOption(points: TrendPoint[]): EChartsOption {
  const values = trendValues(points);
  return {
    grid: { left: 1, right: 1, top: 2, bottom: 2 },
    xAxis: { type: 'category', show: false, boundaryGap: false, data: points.map((_, i) => i) },
    yAxis: { type: 'value', show: true, scale: true },
    tooltip: { show: false },
    series: [
      {
        type: 'line',
        smooth: true,
        showSymbol: false,
        connectNulls: false,
        data: values,
        lineStyle: { color: CHART_ACCENT, width: 1.5 },
        areaStyle: { color: CHART_ACCENT_FADE, opacity: 0.5 },
      },
    ],
  };
}

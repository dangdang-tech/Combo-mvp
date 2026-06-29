// 每日 token 消耗趋势 option builder（外壳首页-10/26）。
//
// 折线 + 面积，标注峰值，双口径（tokens / 调用次数）由 metric 决定纵轴含义与文案。
// 关键诚实：
//   - 占位/空区间（empty 或全 null）→ 不在这里画图，调用方走占位/空态组件（见 TokenTrendChart）。
//     本 builder 仅当确有数据时被调用；但仍对「峰值 null / 含 null 点」稳健（不误标、不画成 0）。
//   - value=null 的点透传 null（ECharts connectNulls=false 默认断线），绝不补 0 误导。
import type { EChartsOption, MarkPointComponentOption } from 'echarts';
import type { TokenTrend } from '@cb/shared';
import {
  CHART_ACCENT,
  CHART_ACCENT_FADE,
  CHART_ACCENT_FADE_BOTTOM,
  CHART_BORDER,
  CHART_MUTED,
  CHART_PEAK,
} from '../theme.js';
import { shortDate, trendValues, isAllNull, compactNumber } from './util.js';

/** 口径 → 纵轴/tooltip 单位人话。 */
export function metricUnit(metric: TokenTrend['metric']): string {
  return metric === 'tokens' ? 'tokens' : '次';
}

/** 口径 → 系列名（图例/tooltip）。 */
export function metricLabel(metric: TokenTrend['metric']): string {
  return metric === 'tokens' ? '每日 token 消耗' : '每日调用次数';
}

/**
 * 构造趋势图 option。
 * @param trend 后端 TokenTrend（points 非空、且至少一个非 null 时才该调用本函数）。
 * 峰值标注仅当 trend.peak 非 null 且其 value 非 null 时落 markPoint（不误标）。
 */
export function buildTokenTrendOption(trend: TokenTrend): EChartsOption {
  const dates = trend.points.map((p) => shortDate(p.date));
  const values = trendValues(trend.points);
  const unit = metricUnit(trend.metric);
  const name = metricLabel(trend.metric);

  // 峰值：仅在有真实峰值点时标注；全 null 或 peak 缺失则不标（外壳首页-26 不误标峰值）。
  const peak = trend.peak;
  const markPoint: MarkPointComponentOption | undefined =
    peak != null && peak.value != null && !isAllNull(trend.points)
      ? {
          symbolSize: 46,
          itemStyle: { color: CHART_PEAK },
          label: { color: '#fff', fontSize: 10, formatter: '峰值' },
          data: [{ name: '峰值', coord: [shortDate(peak.date), peak.value], value: peak.value }],
        }
      : undefined;

  return {
    grid: { left: 48, right: 16, top: 24, bottom: 28, containLabel: false },
    tooltip: {
      trigger: 'axis',
      valueFormatter: (v) => (v == null ? '暂无' : `${compactNumber(Number(v))} ${unit}`),
    },
    xAxis: {
      type: 'category',
      data: dates,
      boundaryGap: false,
      axisLine: { lineStyle: { color: CHART_BORDER } },
      axisLabel: { color: CHART_MUTED, fontSize: 11, hideOverlap: true },
      axisTick: { show: false },
    },
    yAxis: {
      type: 'value',
      name: unit,
      nameTextStyle: { color: CHART_MUTED, fontSize: 11, align: 'right' },
      axisLabel: { color: CHART_MUTED, fontSize: 11, formatter: (v: number) => compactNumber(v) },
      splitLine: { lineStyle: { color: CHART_BORDER, type: 'dashed' } },
    },
    series: [
      {
        name,
        type: 'line',
        smooth: true,
        showSymbol: false,
        connectNulls: false, // 缺测断线，绝不连成假数据
        data: values,
        lineStyle: { color: CHART_ACCENT, width: 2 },
        areaStyle: {
          color: {
            type: 'linear',
            x: 0,
            y: 0,
            x2: 0,
            y2: 1,
            colorStops: [
              { offset: 0, color: CHART_ACCENT_FADE },
              { offset: 1, color: CHART_ACCENT_FADE_BOTTOM },
            ],
          },
        },
        ...(markPoint ? { markPoint } : {}),
      },
    ],
  };
}

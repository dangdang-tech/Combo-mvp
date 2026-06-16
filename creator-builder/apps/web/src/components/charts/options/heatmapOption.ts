// 会话足迹热力图 option builder（GitHub 风格，主页-09）。
//
// ECharts calendar 坐标系 + heatmap 系列：近半年按天格子，颜色按服务端预算好的 level(0-4)。
// 隐私硬约束（主页-09）：格子只用 date/count/level，绝不含会话正文；tooltip 仅显示日期+当天数量。
import type { EChartsOption } from 'echarts';
import type { ProfileHeatmap } from '@cb/shared';
import { HEATMAP_LEVELS, CHART_BORDER, CHART_MUTED } from '../theme.js';
import { isoDay } from './util.js';

/**
 * 构造日历热力图 option。
 * 颜色用 piecewise visualMap 吃服务端 level(0-4)，不在前端重算分位（口径以后端为准）。
 * 数据维度：[YYYY-MM-DD, level]（值=level 用于上色），tooltip 另带 count（经 cellCount 查回）。
 */
export function buildHeatmapOption(heatmap: ProfileHeatmap): EChartsOption {
  // date → count 映射，tooltip 显示真实数量（值轴用 level 上色）。
  const countByDay = new Map<string, number>();
  for (const c of heatmap.cells) countByDay.set(isoDay(c.date), c.count);

  const data: Array<[string, number]> = heatmap.cells.map((c) => [isoDay(c.date), c.level]);

  return {
    tooltip: {
      formatter: (params: unknown) => {
        const p = params as { value?: [string, number] };
        const day = p.value?.[0] ?? '';
        const count = countByDay.get(day) ?? 0;
        return `${day}<br/>当天会话活跃 ${count} 段`;
      },
    },
    visualMap: {
      type: 'piecewise',
      show: false,
      min: 0,
      max: 4,
      // 每档一色，吃后端 level（绝不前端重算）。
      pieces: [
        { value: 0, color: HEATMAP_LEVELS[0] },
        { value: 1, color: HEATMAP_LEVELS[1] },
        { value: 2, color: HEATMAP_LEVELS[2] },
        { value: 3, color: HEATMAP_LEVELS[3] },
        { value: 4, color: HEATMAP_LEVELS[4] },
      ],
    },
    calendar: {
      top: 20,
      left: 28,
      right: 8,
      cellSize: ['auto', 13],
      range: [heatmap.start, heatmap.end],
      splitLine: { show: false },
      itemStyle: { color: HEATMAP_LEVELS[0], borderColor: '#fff', borderWidth: 2 },
      yearLabel: { show: false },
      monthLabel: { color: CHART_MUTED, fontSize: 10 },
      dayLabel: { color: CHART_MUTED, fontSize: 10, firstDay: 1, nameMap: 'cn' },
    },
    series: [
      {
        type: 'heatmap',
        coordinateSystem: 'calendar',
        data,
        itemStyle: { borderColor: CHART_BORDER, borderWidth: 0 },
      },
    ],
  };
}

/** 图例分档说明文案（前端可渲染在图下方：「少 □□□□□ 多」）。 */
export const HEATMAP_LEGEND_LABELS: readonly [string, string] = ['少', '多'];

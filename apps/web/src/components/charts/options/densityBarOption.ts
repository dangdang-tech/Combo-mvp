// 会话密度条 option builder（个人主页能力按会话密度排行，主页-05/06）。
//
// 横向条形：每条 = 一个能力的 densityScore(0-100)，按名次从上到下，前列更亮。
// 真实数据（不依赖 usage）：densityScore / supportingSegments / trend 都来自段级血缘。
// 数据均真实，无占位分支；空（rows=[]）由调用方走空态组件。
import type { EChartsOption } from 'echarts';
import type { DensityRankRow } from '@cb/shared';
import {
  DENSITY_BAR_TOP,
  DENSITY_BAR_REST,
  CHART_MUTED,
  CHART_FG,
  TREND_COLORS,
} from '../theme.js';

const TREND_ARROW: Record<DensityRankRow['trend'], string> = {
  up: '▲',
  down: '▼',
  flat: '—',
};

/**
 * 构造横向密度排行条 option。
 * Y 轴名称含名次；条值=densityScore；tooltip 带支撑段数(信任货币)+趋势。
 * 名次靠前(前 3)用强调色，其余用淡色，传达「头部能力」。
 */
export function buildDensityBarOption(rows: DensityRankRow[]): EChartsOption {
  // ECharts 类目轴自下而上，故倒序让 rank1 在最上。
  const ordered = [...rows].sort((a, b) => b.rank - a.rank);
  const names = ordered.map((r) => `${r.rank}. ${r.name}`);
  const segByName = new Map<string, DensityRankRow>();
  ordered.forEach((r, i) => segByName.set(names[i]!, r));

  return {
    grid: { left: 8, right: 40, top: 8, bottom: 8, containLabel: true },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: (params: unknown) => {
        const arr = params as Array<{ name: string }>;
        const key = arr[0]?.name ?? '';
        const row = segByName.get(key);
        if (!row) return key;
        const arrow = TREND_ARROW[row.trend];
        return `${row.name}<br/>密度 ${row.densityScore} · ${row.supportingSegments} 段支撑 · 趋势 ${arrow}`;
      },
    },
    xAxis: { type: 'value', max: 100, show: false },
    yAxis: {
      type: 'category',
      data: names,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: CHART_FG, fontSize: 12 },
    },
    series: [
      {
        type: 'bar',
        data: ordered.map((r) => ({
          value: r.densityScore,
          itemStyle: { color: r.rank <= 3 ? DENSITY_BAR_TOP : DENSITY_BAR_REST },
        })),
        barWidth: 14,
        itemStyle: { borderRadius: [0, 7, 7, 0] },
        label: {
          show: true,
          position: 'right',
          color: CHART_MUTED,
          fontSize: 11,
          // 条尾显示趋势箭头 + 段数（信任货币露出）。
          formatter: (p: unknown) => {
            const param = p as { name: string };
            const row = segByName.get(param.name);
            if (!row) return '';
            return `${TREND_ARROW[row.trend]} ${row.supportingSegments}段`;
          },
        },
      },
    ],
  };
}

export { TREND_ARROW, TREND_COLORS };

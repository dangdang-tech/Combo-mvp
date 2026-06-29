// SessionHeatmap —— 会话足迹热力图（GitHub 风格，主页-09/20）。
//
// 真实数据（按 happened_at 算，不依赖 usage）。状态分流：
//   1. heatmap == null（加载中）        → ChartSkeleton
//   2. heatmap.enabled === false（创作者关闭，主页-20）→ 渲染 null（父组件据此不占版面）
//   3. cells 为空（新创作者无足迹）      → ChartEmpty「暂无会话足迹」
//   4. 有数据                            → 日历热力图 + 「少 □□□□□ 多」图例
// 隐私：tooltip 只显示日期 + 当天段数（option builder 已保证不含正文）。
import type { ReactElement } from 'react';
import type { ProfileHeatmap } from '@cb/shared';
import { EChart } from './EChart.js';
import { ChartSkeleton, ChartEmpty } from './ChartStates.js';
import { buildHeatmapOption, HEATMAP_LEGEND_LABELS } from './options/heatmapOption.js';
import { HEATMAP_LEVELS } from './theme.js';

export interface SessionHeatmapProps {
  /** 后端 ProfileHeatmap；null/undefined = 加载中。 */
  heatmap?: ProfileHeatmap | null;
  /** 高度，默认 160（半年日历约 27 周）。 */
  height?: number;
}

/** 色阶图例：少 □□□□□ 多。 */
function Legend(): ReactElement {
  return (
    <div className="cb-heatmap-legend" aria-hidden>
      <span className="cb-heatmap-legend__label">{HEATMAP_LEGEND_LABELS[0]}</span>
      {HEATMAP_LEVELS.map((c, i) => (
        <span key={i} className="cb-heatmap-legend__cell" style={{ background: c }} />
      ))}
      <span className="cb-heatmap-legend__label">{HEATMAP_LEGEND_LABELS[1]}</span>
    </div>
  );
}

/**
 * 创作者关闭热力图（enabled=false）→ 返回 null，父组件分区不渲染、不留空框（主页-20）。
 * 调用方可据 `heatmap?.enabled === false` 提前跳过本分区；这里也兜底返回 null。
 */
export function SessionHeatmap({
  heatmap,
  height = 160,
}: SessionHeatmapProps): ReactElement | null {
  if (heatmap == null) return <ChartSkeleton height={height} label="热力图加载中" />;
  if (heatmap.enabled === false) return null;
  if (heatmap.cells.length === 0) return <ChartEmpty text="暂无会话足迹" height={height} />;
  return (
    <div className="cb-heatmap">
      <EChart
        option={buildHeatmapOption(heatmap)}
        height={height}
        ariaLabel="会话足迹热力图（近半年，每天一格）"
      />
      <Legend />
    </div>
  );
}

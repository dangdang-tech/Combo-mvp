// DensityBar —— 个人主页能力按会话密度排行条（主页-05/06）。
//
// 真实数据（densityScore/supportingSegments/trend，不依赖 usage）。状态分流：
//   1. rows == null（加载中） → ChartSkeleton
//   2. rows 为空（无能力）    → ChartEmpty「还没有能力」
//   3. 有数据                 → 横向密度条（前 3 高亮 + 段数/趋势露出）
// 高度按条数自适应（每条 ~26px），≥1 条不裸转圈。
import type { ReactElement } from 'react';
import type { DensityRankRow } from '@cb/shared';
import { EChart } from './EChart.js';
import { ChartSkeleton, ChartEmpty } from './ChartStates.js';
import { buildDensityBarOption } from './options/densityBarOption.js';

export interface DensityBarProps {
  /** 密度榜行（首屏前 3 或展开后更多）；null/undefined = 加载中。 */
  rows?: DensityRankRow[] | null;
  /** 每条像素高，默认 26（含间距）。 */
  rowHeight?: number;
  /** 最小高度（避免单条太矮），默认 60。 */
  minHeight?: number;
}

export function DensityBar({
  rows,
  rowHeight = 26,
  minHeight = 60,
}: DensityBarProps): ReactElement {
  if (rows == null) return <ChartSkeleton height={minHeight} label="密度榜加载中" />;
  if (rows.length === 0) return <ChartEmpty text="还没有能力" height={minHeight} />;
  const height = Math.max(minHeight, rows.length * rowHeight + 16);
  return (
    <EChart
      option={buildDensityBarOption(rows)}
      height={height}
      ariaLabel={`能力会话密度排行，共 ${rows.length} 项`}
    />
  );
}

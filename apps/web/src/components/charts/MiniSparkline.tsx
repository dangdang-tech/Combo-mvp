// MiniSparkline —— 能力体列表行内消耗迷你图（外壳首页-11）。
//
// 行内尺寸（默认 88×28），无轴无 tooltip。三态：
//   1. spendSparkline == null（usage 占位）→ 行内占位文案（不画 0 线）
//   2. 空数组 / 全 null                    → 短横线占位（视觉对齐，不破行）
//   3. 有数据                              → 极简 sparkline
// 占位用 UsagePlaceholder 的文案口径，但行内尺寸紧凑（用 inline 占位而非大灰框）。
import type { ReactElement } from 'react';
import type { Meta, TrendPoint } from '@cb/shared';
import { EChart } from './EChart.js';
import { buildSparklineOption } from './options/sparklineOption.js';
import { isAllNull } from './options/util.js';
import { isPlaceholder, placeholderText } from '../UsagePlaceholder.js';

export interface MiniSparklineProps {
  /** 行内趋势点；null = usage 占位（与 DashboardCapabilityRow.spendSparkline 一致）。 */
  points?: TrendPoint[] | null;
  /** 响应 meta（usage 占位判定）。 */
  meta?: Meta | undefined;
  /** 占位字段键，默认 'spendSparkline'。 */
  placeholderField?: string;
  width?: number;
  height?: number;
  /** 无障碍标签，默认「消耗趋势迷你图」。 */
  ariaLabel?: string;
}

export function MiniSparkline({
  points,
  meta,
  placeholderField = 'spendSparkline',
  width = 88,
  height = 28,
  ariaLabel = '消耗趋势迷你图',
}: MiniSparklineProps): ReactElement {
  // usage 占位（null 或后端标注）→ 行内得体占位，绝不画 0 线
  if (points == null || isPlaceholder(meta, placeholderField)) {
    return (
      <span
        className="cb-sparkline cb-sparkline--placeholder"
        data-placeholder={placeholderField}
        title={placeholderText(meta, placeholderField)}
      >
        —
      </span>
    );
  }
  // 空 / 全 null → 紧凑短横线（对齐行高，不破图）
  if (points.length === 0 || isAllNull(points)) {
    return (
      <span className="cb-sparkline cb-sparkline--empty" aria-label="暂无趋势">
        —
      </span>
    );
  }
  return (
    <span className="cb-sparkline">
      <EChart
        option={buildSparklineOption(points)}
        width={width}
        height={height}
        ariaLabel={ariaLabel}
      />
    </span>
  );
}

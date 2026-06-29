// 图表三态：占位（usage 未上线）/ 加载骨架 / 空数据。
//
// 永不裸转圈、不画误导图：
//   - ChartPlaceholder：usage 占位（meta.placeholders 标注）——显示「暂无数据/上线后填充」
//     得体文案 + 灰色图形占位框，绝不画一条「全 0」的假趋势线。
//   - ChartSkeleton：数据加载中——脉动骨架（复用全站 cb-skeleton 动画），不转圈。
//   - ChartEmpty：确有数据源但本区间无数据（如某天无消耗、新创作者无足迹）——友好空态文案。
import type { ReactElement } from 'react';
import type { Meta } from '@cb/shared';
import { placeholderText } from '../UsagePlaceholder.js';

interface BoxProps {
  height?: number | string;
  label?: string;
}

function boxStyle(height: number | string): { height: string } {
  return { height: typeof height === 'number' ? `${height}px` : height };
}

export interface ChartPlaceholderProps extends BoxProps {
  /** 占位字段键（与 meta.placeholders 键一致，如 'points'）。 */
  field: string;
  /** 响应 meta（取后端占位文案，缺省兜底）。 */
  meta?: Meta | undefined;
}

/** usage 占位：灰框 + 得体文案，绝不画误导图、绝不显 0、绝不裸转圈。 */
export function ChartPlaceholder({
  field,
  meta,
  height = 240,
  label,
}: ChartPlaceholderProps): ReactElement {
  return (
    <div
      className="cb-chart-state cb-chart-state--placeholder"
      style={boxStyle(height)}
      data-placeholder={field}
      role="img"
      aria-label={label ?? placeholderText(meta, field)}
    >
      {label && <span className="cb-chart-state__label">{label}</span>}
      <span className="cb-chart-state__text">{placeholderText(meta, field)}</span>
    </div>
  );
}

/** 图表加载骨架：脉动占位框（非 spinner）。 */
export function ChartSkeleton({ height = 240, label }: BoxProps): ReactElement {
  return (
    <div
      className="cb-chart-state cb-chart-state--skeleton"
      style={boxStyle(height)}
      role="status"
      aria-busy="true"
      aria-label={label ?? '图表加载中'}
    />
  );
}

export interface ChartEmptyProps extends BoxProps {
  /** 空态文案（如「暂无消耗」「暂无会话足迹」）。 */
  text: string;
}

/** 确有数据源但本区间无数据：友好空态文案 + 灰框，不破图、不误标。 */
export function ChartEmpty({ text, height = 240 }: ChartEmptyProps): ReactElement {
  return (
    <div
      className="cb-chart-state cb-chart-state--empty"
      style={boxStyle(height)}
      role="img"
      aria-label={text}
    >
      <span className="cb-chart-state__text">{text}</span>
    </div>
  );
}

// EChart —— echarts-for-react 的薄封装（统一响应式 + 可访问性 + 精简 echarts 实例）。
//
// 职责边界：只负责「把一份 option 画出来 + 自适应宽高 + 给无障碍语义」。
// 不含任何业务/占位/空态逻辑——那些在各业务图组件里判完，确有数据才渲染本件。
// 测试侧通过 vi.mock('echarts-for-react/lib/core') 注入假 chart，断言传入的 option。
import type { ReactElement, CSSProperties } from 'react';
import ReactEChartsCore from 'echarts-for-react/lib/core';
import type { EChartsOption } from 'echarts';
import { echarts } from './echartsCore.js';

export interface EChartProps {
  /** 已构造好的 ECharts option（业务图组件用 option builder 产出）。 */
  option: EChartsOption;
  /** 高度（px 或 css 串）。默认 240。 */
  height?: number | string;
  /** 宽度，默认 100%（响应式撑满容器）。 */
  width?: number | string;
  /** 无障碍描述（role=img 的 aria-label）。 */
  ariaLabel: string;
  /** notMerge：口径/数据切换时传 true，避免残留旧系列。默认 true。 */
  notMerge?: boolean;
  /** 额外类名。 */
  className?: string;
}

/**
 * 响应式：echarts-for-react 默认监听容器 resize 自适应；外层包裹 width:100% 容器。
 * 可访问：role=img + aria-label（图本身是 canvas，对读屏不可读，靠 label 兜底）。
 */
export function EChart({
  option,
  height = 240,
  width = '100%',
  ariaLabel,
  notMerge = true,
  className,
}: EChartProps): ReactElement {
  const style: CSSProperties = {
    height: typeof height === 'number' ? `${height}px` : height,
    width: typeof width === 'number' ? `${width}px` : width,
  };
  return (
    <div
      className={`cb-chart${className ? ` ${className}` : ''}`}
      role="img"
      aria-label={ariaLabel}
    >
      <ReactEChartsCore
        echarts={echarts}
        option={option}
        notMerge={notMerge}
        lazyUpdate
        style={style}
        opts={{ renderer: 'canvas' }}
      />
    </div>
  );
}

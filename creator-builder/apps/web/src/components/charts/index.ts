// ECharts 图表封装出口（F-08）——可复用图表组件，供工作台 / 个人主页。
//
// 统一原则：占位态（usage placeholder 不画误导图）、加载骨架（永不裸转圈）、空数据不崩、响应式、可访问。
// 业务组件吃 @cb/shared DTO；纯 option builder 单独导出，便于页面定制/单测。

// 业务图组件
export { TokenTrendChart, type TokenTrendChartProps, type TrendMetric } from './TokenTrendChart.js';
export { MiniSparkline, type MiniSparklineProps } from './MiniSparkline.js';
export { SessionHeatmap, type SessionHeatmapProps } from './SessionHeatmap.js';
export { DensityBar, type DensityBarProps } from './DensityBar.js';

// 通用图表件 + 三态
export { EChart, type EChartProps } from './EChart.js';
export {
  ChartPlaceholder,
  ChartSkeleton,
  ChartEmpty,
  type ChartPlaceholderProps,
  type ChartEmptyProps,
} from './ChartStates.js';

// 纯 option builders（无 DOM，可单测 / 页面定制）
export { buildTokenTrendOption, metricUnit, metricLabel } from './options/tokenTrendOption.js';
export { buildSparklineOption } from './options/sparklineOption.js';
export { buildHeatmapOption, HEATMAP_LEGEND_LABELS } from './options/heatmapOption.js';
export { buildDensityBarOption, TREND_ARROW } from './options/densityBarOption.js';
export { shortDate, isoDay, trendValues, isAllNull, compactNumber } from './options/util.js';

// 主题常量（改色一处生效）
export * from './theme.js';

// 统一基础件出口（永不裸转圈 / 绝不裸露错误码 / usage 占位 的 UI 落地）。
export { ErrorState, toErrorBody, type ErrorStateProps } from './ErrorState.js';
export {
  LoadingState,
  ProgressBar,
  SubtaskChecklist,
  Skeleton,
  type LoadingStateProps,
} from './LoadingState.js';
export { SlowHint, type SlowHintProps } from './SlowHint.js';
export { ItemStream, type ItemStreamProps } from './ItemStream.js';
export { StreamLoading, type StreamLoadingProps } from './StreamLoading.js';
export {
  UsagePlaceholder,
  isPlaceholder,
  placeholderText,
  USAGE_PLACEHOLDER_FALLBACK,
  type UsagePlaceholderProps,
} from './UsagePlaceholder.js';

// ECharts 图表封装（F-08）——趋势/迷你图/热力图/密度条，供工作台与个人主页。
export * from './charts/index.js';

// TokenTrendChart —— 每日 token 消耗趋势（外壳首页-10/26，工作台用）。
//
// 双口径切换由父组件控制（metric 透传给后端拉数 + 这里只画当前 trend）；内置一个口径切换 UI
// 供页面直接复用（受控：value + onMetricChange）。
// 三态分流（永不裸转圈、不画误导图）：
//   1. trend == null（加载中）          → ChartSkeleton
//   2. usage 占位（meta.placeholders.points 标注 / trend.points 全空且 empty）→ ChartPlaceholder
//   3. trend.empty 或无任何非 null 点    → ChartEmpty「暂无消耗」（贴零线语义，不误标峰值）
//   4. 有真实数据                        → EChart(buildTokenTrendOption)
import type { ReactElement } from 'react';
import type { Meta, TokenTrend } from '@cb/shared';
import { EChart } from './EChart.js';
import { ChartPlaceholder, ChartSkeleton, ChartEmpty } from './ChartStates.js';
import { buildTokenTrendOption, metricLabel } from './options/tokenTrendOption.js';
import { isAllNull } from './options/util.js';
import { isPlaceholder } from '../UsagePlaceholder.js';

export type TrendMetric = 'tokens' | 'invocations';

export interface TokenTrendChartProps {
  /** 后端 TokenTrend；null/undefined = 加载中（渲染骨架）。 */
  trend?: TokenTrend | null;
  /** 响应 meta（usage 占位判定：placeholders.points）。 */
  meta?: Meta | undefined;
  /** 占位字段键，默认 'points'（与 60 域契约一致）。 */
  placeholderField?: string;
  /** 高度，默认 260。 */
  height?: number;
  /** 双口径切换：当前值 + 回调（父组件据此重新拉数）。给了就渲染切换 UI。 */
  metric?: TrendMetric;
  onMetricChange?: (m: TrendMetric) => void;
}

const METRIC_OPTIONS: ReadonlyArray<{ key: TrendMetric; label: string }> = [
  { key: 'tokens', label: 'tokens' },
  { key: 'invocations', label: '调用次数' },
];

/** 口径切换段控（segmented），当前档有选中标识。 */
function MetricToggle({
  value,
  onChange,
}: {
  value: TrendMetric;
  onChange: (m: TrendMetric) => void;
}): ReactElement {
  return (
    <div className="cb-chart-toggle" role="group" aria-label="切换趋势口径">
      {METRIC_OPTIONS.map((o) => (
        <button
          key={o.key}
          type="button"
          className={`cb-chart-toggle__btn${value === o.key ? ' cb-chart-toggle__btn--active' : ''}`}
          aria-pressed={value === o.key}
          onClick={() => onChange(o.key)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function TokenTrendChart({
  trend,
  meta,
  placeholderField = 'points',
  height = 260,
  metric,
  onMetricChange,
}: TokenTrendChartProps): ReactElement {
  const showToggle = metric !== undefined && onMetricChange !== undefined;

  function body(): ReactElement {
    // 1. 加载中
    if (trend == null) return <ChartSkeleton height={height} label="趋势加载中" />;
    // 2. usage 占位（后端 placeholders 标注该字段）
    if (isPlaceholder(meta, placeholderField)) {
      return <ChartPlaceholder field={placeholderField} meta={meta} height={height} />;
    }
    // 3. 空区间 / 全无数据 → 空态（不误标峰值、不画 0 线）
    if (trend.empty || trend.points.length === 0 || isAllNull(trend.points)) {
      return <ChartEmpty text="暂无消耗" height={height} />;
    }
    // 4. 真实数据
    return (
      <EChart
        option={buildTokenTrendOption(trend)}
        height={height}
        ariaLabel={`${metricLabel(trend.metric)}趋势图`}
      />
    );
  }

  return (
    <div className="cb-token-trend">
      {showToggle && (
        <div className="cb-token-trend__head">
          <MetricToggle value={metric} onChange={onMetricChange} />
        </div>
      )}
      {body()}
    </div>
  );
}

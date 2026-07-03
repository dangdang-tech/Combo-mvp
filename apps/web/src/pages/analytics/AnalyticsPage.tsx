// 数据分析（F-07，接 GET /api/v1/dashboard/metrics + /token-trend，60 §1.2 / §1.3）。
//
// 运营数据页。合规要点：
//   - 复用工作台共享取数层 dashboard/api.ts（fetchMetrics / fetchTokenTrend），不另造 fetch。
//   - usage 维度本期占位（累计调用 / 本月消耗 / 活跃消费者 / token 趋势）：UsagePlaceholder + 图占位态。
//   - 真实维度（已发布能力体数 + 真实环比）正常显示，不占位、不显 0 误导。
//   - metrics 与 token-trend 各自独立加载/各自失败重试（局部失败不连坐，60 §1.6）。
//   - range 三档可切，当前档有选中标识（切换不报错）；token 趋势双口径 metric 切换。
//   - 加载用 4A 加载件（Skeleton / ChartSkeleton），错误用 ErrorState；渲染在 4A Shell 主区。
import { useState, type ReactElement } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Range } from '@cb/shared';
import {
  ErrorState,
  LoadingState,
  TokenTrendChart,
  type TrendMetric,
} from '../../components/index.js';
import { fetchMetrics, fetchTokenTrend } from '../dashboard/api.js';
import { MetricCardsBand } from './MetricCardsBand.js';

const RANGE_OPTIONS: ReadonlyArray<{ key: Range; label: string }> = [
  { key: '7d', label: '近 7 天' },
  { key: '30d', label: '近 30 天' },
  { key: 'all', label: '全部' },
];

export function AnalyticsPage(): ReactElement {
  const [range, setRange] = useState<Range>('30d');
  const [metric, setMetric] = useState<TrendMetric>('tokens');

  const metricsQuery = useQuery({
    queryKey: ['dashboard', 'metrics', range],
    queryFn: ({ signal }) => fetchMetrics(range, { signal }),
  });

  const trendQuery = useQuery({
    queryKey: ['dashboard', 'token-trend', range, metric],
    queryFn: ({ signal }) => fetchTokenTrend(range, metric, { signal }),
  });

  return (
    <section className="cb-page cb-analytics" aria-labelledby="cb-analytics-title">
      <header className="cb-page__head">
        <h2 className="cb-page__title" id="cb-analytics-title">
          数据分析
        </h2>
        <p className="cb-page__lead">
          调用量、token 消耗等运营数据。部分指标本期为占位，上线后填充真实数据。
        </p>
        {/* range 三档切换（当前档有选中标识；切换不报错）。 */}
        <div className="cb-range-toggle" role="group" aria-label="选择时间范围">
          {RANGE_OPTIONS.map((o) => (
            <button
              key={o.key}
              type="button"
              className={`cb-filter-chip${range === o.key ? ' cb-filter-chip--active' : ''}`}
              aria-pressed={range === o.key}
              onClick={() => setRange(o.key)}
            >
              {o.label}
            </button>
          ))}
        </div>
      </header>

      {/* 指标卡区（独立加载/失败/重试）。 */}
      <div className="cb-analytics__section" aria-label="关键指标">
        {metricsQuery.isPending ? (
          <LoadingState skeletonRows={2} label="指标加载中" />
        ) : metricsQuery.isError ? (
          <ErrorState error={metricsQuery.error} onRetry={() => void metricsQuery.refetch()} />
        ) : (
          <MetricCardsBand metrics={metricsQuery.data.data} meta={metricsQuery.data.meta} />
        )}
      </div>

      {/* token 趋势区（独立加载/失败/重试；usage 全占位）。 */}
      <div className="cb-analytics__section" aria-label="消耗趋势">
        <h3 className="cb-analytics__subtitle">消耗趋势</h3>
        {trendQuery.isPending ? (
          <LoadingState label="趋势加载中" />
        ) : trendQuery.isError ? (
          <ErrorState error={trendQuery.error} onRetry={() => void trendQuery.refetch()} />
        ) : (
          <TokenTrendChart
            trend={trendQuery.data.data}
            meta={trendQuery.data.meta}
            metric={metric}
            onMetricChange={setMetric}
          />
        )}
      </div>
    </section>
  );
}

// 收益（F-07，60 §1.4 revenueMicros 列 + 决策②/③）。
//
// 能力体收益与结算页。诚实范围：本期无独立收益/结算端点（契约仅在 dashboard/capabilities 给
// revenueMicros，usage 占位，决策②）。故本页：
//   - 结算摘要：本期范围外 → 统一占位「上线后填充」（UsagePlaceholder），不显 0、不编假金额。
//   - 按能力体收益明细：复用 GET /dashboard/capabilities，每行收益列占位（UsagePlaceholder）。
//   - 提现/结算动作：本期未开放占位（按钮 aria-disabled，点击落占位）。
//   - 加载用 4A 加载件，错误用 ErrorState；渲染在 4A Shell 主区（侧栏「收益」对应项）。
import { type ReactElement } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { DashboardCapabilityRow, Meta, Range } from '@cb/shared';
import { apiGetEnvelope } from '../../api/index.js';
import { ErrorState, LoadingState, UsagePlaceholder } from '../../components/index.js';

const SETTLEMENT_HINT = '本期未开放';

async function fetchRevenueRows(
  range: Range,
  signal?: AbortSignal,
): Promise<{ rows: DashboardCapabilityRow[]; meta: Meta }> {
  const res = await apiGetEnvelope<DashboardCapabilityRow[]>('/dashboard/capabilities', {
    query: { status: 'published', range, limit: 20 },
    ...(signal !== undefined ? { signal } : {}),
  });
  return { rows: res.data, meta: res.meta ?? {} };
}

export function RevenuePage(): ReactElement {
  const range: Range = '30d';
  const query = useQuery({
    queryKey: ['dashboard', 'revenue', range],
    queryFn: ({ signal }) => fetchRevenueRows(range, signal),
  });

  return (
    <section className="cb-page cb-revenue" aria-labelledby="cb-revenue-title">
      <header className="cb-page__head">
        <h2 className="cb-page__title" id="cb-revenue-title">
          收益
        </h2>
        <p className="cb-page__lead">能力体收益与结算。本期收益数据为占位，上线后填充真实金额。</p>
      </header>

      {/* 结算摘要：本期范围外，统一占位（不显 0、不编金额）。 */}
      <div className="cb-revenue__summary" aria-label="结算摘要">
        <div className="cb-revenue__summary-card">
          <p className="cb-revenue__summary-label">可结算余额</p>
          <UsagePlaceholder field="settlementBalance" meta={query.data?.meta} />
        </div>
        <div className="cb-revenue__summary-card">
          <p className="cb-revenue__summary-label">累计收益</p>
          <UsagePlaceholder field="totalRevenue" meta={query.data?.meta} />
        </div>
        <div className="cb-revenue__summary-card cb-revenue__summary-card--action">
          {/* 提现/结算：本期未开放占位（按钮在、点击不动账）。 */}
          <button
            type="button"
            className="cb-action cb-action--withdraw"
            aria-disabled="true"
            title={SETTLEMENT_HINT}
          >
            提现
          </button>
          <p className="cb-revenue__action-hint">{SETTLEMENT_HINT}</p>
        </div>
      </div>

      {/* 按能力体收益明细（复用 capabilities 端点，收益列占位）。 */}
      <div className="cb-revenue__section" aria-label="按能力体收益">
        <h3 className="cb-revenue__subtitle">按能力体收益</h3>
        <RevenueRowsBody query={query} />
      </div>
    </section>
  );
}

function RevenueRowsBody({
  query,
}: {
  query: ReturnType<typeof useQuery<{ rows: DashboardCapabilityRow[]; meta: Meta }, Error>>;
}): ReactElement {
  if (query.isPending) {
    return <LoadingState skeletonRows={4} label="收益明细加载中" />;
  }
  if (query.isError) {
    return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  }

  const { rows, meta } = query.data;
  if (rows.length === 0) {
    return (
      <div className="cb-empty" role="status">
        <p className="cb-empty__title">还没有已上架的能力体</p>
        <p className="cb-empty__hint">发布能力体后，这里会按能力体展示收益明细。</p>
      </div>
    );
  }

  return (
    <table className="cb-table cb-revenue__table">
      <thead>
        <tr>
          <th scope="col">能力体</th>
          <th scope="col">状态</th>
          <th scope="col">收益</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.capabilityId} className="cb-revenue__row">
            <td className="cb-revenue__cell-name">
              <div className="cb-revenue__name">{row.name}</div>
              <div className="cb-revenue__tagline">{row.tagline}</div>
            </td>
            <td className="cb-revenue__cell-status">
              <span className="cb-status-badge is-published">{row.statusLabel}</span>
            </td>
            <td className="cb-revenue__cell-usage">
              {/* 收益列：usage 占位（revenueMicros=null + placeholders），不显 0、不算假金额。 */}
              <UsagePlaceholder field="revenueMicros" meta={meta} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

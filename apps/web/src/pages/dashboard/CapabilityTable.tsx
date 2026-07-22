// 我的 Agent 列表（外壳首页-11/14/15/30/35）。
//
// 列：名称 + 一句话简介 / 状态（后端单源 reviewStatus+statusLabel 派生，不前端自造）/
//     本月调用（usage 占位）/ 消耗迷你图（MiniSparkline 占位）/ 收益（usage 占位）/
//     操作（当前公开页真实可达时直接打开）。
// 创建新 Agent 由页面级 CTA 承担，不伪装成与某一行有关的“重新创建”。
// 不展示占位动作，也不使用“更多”收纳不存在的能力：动作必须与当前状态一致。
// 被拒态（review_rejected）继续显示拒绝原因；无真实公开页时操作列明确为空。
import type { ReactElement } from 'react';
import { Link } from 'react-router-dom';
import type { DashboardCapabilityRow, Meta } from '@cb/shared';
import { MiniSparkline, UsagePlaceholder } from '../../components/index.js';

export interface CapabilityTableProps {
  rows: DashboardCapabilityRow[];
  meta: Meta | undefined;
}

/** 状态徽章：颜色档由后端 reviewStatus 单源派生（前端不另判业务态）。 */
const STATUS_TONE: Record<DashboardCapabilityRow['reviewStatus'], string> = {
  published: 'ok',
  alpha_pending: 'pending',
  review_rejected: 'rejected',
  draft: 'neutral',
  unpublished: 'neutral',
};

function StatusBadge({ row }: { row: DashboardCapabilityRow }): ReactElement {
  return (
    <span
      className="cb-cap-status"
      data-status={row.reviewStatus}
      data-tone={STATUS_TONE[row.reviewStatus]}
    >
      {row.statusLabel}
    </span>
  );
}

function CapabilityRow({
  row,
  meta,
}: {
  row: DashboardCapabilityRow;
  meta: Meta | undefined;
}): ReactElement {
  return (
    <tr className="cb-cap-row" data-capability={row.capabilityId}>
      <td className="cb-cap-row__name">
        <span className="cb-cap-row__title">{row.name}</span>
        <span className="cb-cap-row__tagline">{row.tagline}</span>
      </td>
      <td className="cb-cap-row__status">
        <StatusBadge row={row} />
        {row.reviewStatus === 'review_rejected' && row.rejectReason && (
          <span className="cb-cap-row__reject" title={row.rejectReason}>
            {row.rejectReason}
          </span>
        )}
      </td>
      <td className="cb-cap-row__invocations">
        {row.monthlyInvocations === null ? (
          <UsagePlaceholder field="monthlyInvocations" meta={meta} />
        ) : (
          <span>{row.monthlyInvocations}</span>
        )}
      </td>
      <td className="cb-cap-row__spend">
        <MiniSparkline points={row.spendSparkline} meta={meta} placeholderField="spendSparkline" />
      </td>
      <td className="cb-cap-row__revenue">
        {row.revenueMicros === null ? (
          <UsagePlaceholder field="revenueMicros" meta={meta} />
        ) : (
          <span>{(row.revenueMicros / 1_000_000).toFixed(2)}</span>
        )}
      </td>
      <td className="cb-cap-row__actions">
        {row.publicPageAvailable ? (
          <Link
            className="cb-cap-action cb-cap-action--view"
            to={`/a/${encodeURIComponent(row.slug)}`}
            aria-label={`打开「${row.name}」公开页`}
          >
            公开页
          </Link>
        ) : (
          <span className="cb-cap-row__no-action" aria-label="暂无可用操作">
            —
          </span>
        )}
      </td>
    </tr>
  );
}

/** 空态（外壳首页-23 类比）：无能力 → 友好空态，不裸空表。 */
function EmptyRow(): ReactElement {
  return (
    <tr className="cb-cap-row cb-cap-row--empty">
      <td colSpan={6} className="cb-cap-row__empty">
        还没有 Agent，点右上「创建 Agent」开始第一个。
      </td>
    </tr>
  );
}

export function CapabilityTable({ rows, meta }: CapabilityTableProps): ReactElement {
  return (
    <table className="cb-cap-table">
      <thead>
        <tr>
          <th scope="col">Agent</th>
          <th scope="col">状态</th>
          <th scope="col">本月调用</th>
          <th scope="col">消耗趋势</th>
          <th scope="col">收益</th>
          <th scope="col">操作</th>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <EmptyRow />
        ) : (
          rows.map((r) => <CapabilityRow key={r.capabilityId} row={r} meta={meta} />)
        )}
      </tbody>
    </table>
  );
}

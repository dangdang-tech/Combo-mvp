// 我的能力体列表（外壳首页-11/14/15/30/35）。
//
// 列：名称 + 一句话简介 / 状态（后端单源 reviewStatus+statusLabel 派生，不前端自造）/
//     本月调用（usage 占位）/ 消耗迷你图（MiniSparkline 占位）/ 收益（usage 占位）/
//     操作（试用·编辑·更多）。
// 试用恒「本期未开放」占位（决策③，actions.trial.enabled=false）；编辑进草稿/编辑路由；
// 被拒态（review_rejected）显示拒绝原因 + 重试/编辑（B-30 工作台落点）。
import { useState, type ReactElement } from 'react';
import type { DashboardCapabilityRow, Meta } from '@cb/shared';
import { MiniSparkline, UsagePlaceholder } from '../../components/index.js';

export interface CapabilityTableProps {
  rows: DashboardCapabilityRow[];
  meta: Meta | undefined;
  /** 行内「试用」点击 → 落「本期未开放」占位（不进 runtime）。 */
  onTrial: (row: DashboardCapabilityRow) => void;
  /** 「编辑」→ 草稿/编辑路由。 */
  onEdit: (row: DashboardCapabilityRow) => void;
  /** 「更多」菜单（下架/改价/查看，外壳首页-35）；本期占位入口。 */
  onMore: (row: DashboardCapabilityRow) => void;
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
  onTrial,
  onEdit,
  onMore,
}: {
  row: DashboardCapabilityRow;
  meta: Meta | undefined;
  onTrial: (row: DashboardCapabilityRow) => void;
  onEdit: (row: DashboardCapabilityRow) => void;
  onMore: (row: DashboardCapabilityRow) => void;
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
        {/* 试用本期不做（决策③）：按钮在、文案正确，点击落「本期未开放」占位、不进 runtime。 */}
        <button
          type="button"
          className="cb-cap-action cb-cap-action--trial"
          onClick={() => onTrial(row)}
          title={row.actions.trial.hint}
        >
          试用
        </button>
        {row.actions.edit && (
          <button
            type="button"
            className="cb-cap-action cb-cap-action--edit"
            onClick={() => onEdit(row)}
          >
            {row.retryEditable ? '重试 / 编辑' : '编辑'}
          </button>
        )}
        {row.actions.more && (
          <button
            type="button"
            className="cb-cap-action cb-cap-action--more"
            onClick={() => onMore(row)}
            aria-label="更多操作"
          >
            更多
          </button>
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
        还没有能力体，点右上「上传新能力」开始第一个。
      </td>
    </tr>
  );
}

export function CapabilityTable({
  rows,
  meta,
  onTrial,
  onEdit,
  onMore,
}: CapabilityTableProps): ReactElement {
  return (
    <table className="cb-cap-table">
      <thead>
        <tr>
          <th scope="col">能力体</th>
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
          rows.map((r) => (
            <CapabilityRow
              key={r.capabilityId}
              row={r}
              meta={meta}
              onTrial={onTrial}
              onEdit={onEdit}
              onMore={onMore}
            />
          ))
        )}
      </tbody>
    </table>
  );
}

/**
 * 「更多」操作菜单（外壳首页-35）。本期仅入口可达：下架 / 改价 / 查看三项，
 * 其中下架·改价为本期未开放占位（点击落「本期未开放」反馈、不发任何命令），
 * 查看为公开页路由占位（点击触发 onView，由调用方导航到 /a/{slug} 公开页）。
 *
 * 设计取舍：菜单项动作由后端能力/路由决定，本组件只负责展示与点击反馈，
 * 不前端自造业务态、不裸触发未实现命令（铁律：永不裸转圈、对外只读不下钻）。
 */
export type MoreMenuItemKey = 'unpublish' | 'reprice' | 'view';

/** 单条菜单项：本期未开放（占位）或可路由（查看）。 */
interface MoreMenuItemDef {
  key: MoreMenuItemKey;
  label: string;
  /** true = 本期未开放占位（disabled 态 + hint）；false = 可点（如查看走路由）。 */
  pending: boolean;
}

const MORE_MENU_ITEMS: ReadonlyArray<MoreMenuItemDef> = [
  { key: 'unpublish', label: '下架', pending: true },
  { key: 'reprice', label: '改价', pending: true },
  { key: 'view', label: '查看公开页', pending: false },
];

const MORE_PENDING_HINT = '本期未开放';

export interface MoreMenuState {
  /** 当前打开菜单的能力（null = 未打开）。 */
  row: DashboardCapabilityRow | null;
  /** 选中某项后的本期占位反馈文案（null = 无反馈）。 */
  pendingNotice: string | null;
}

export interface MoreMenuProps {
  state: MoreMenuState;
  /** 点「查看公开页」→ 由调用方导航到公开页（对外只读，不进管理）。 */
  onView: (row: DashboardCapabilityRow) => void;
  /** 选了本期未开放项 → 记录占位反馈文案。 */
  onPending: (notice: string) => void;
  /** 关闭菜单。 */
  onClose: () => void;
}

/**
 * 更多菜单浮层（受控 open by state.row）。下架/改价为本期未开放占位项（aria-disabled + hint，
 * 点击给「本期未开放」反馈、不发命令）；查看为路由占位（点击触发 onView）。
 */
export function MoreMenu({
  state,
  onView,
  onPending,
  onClose,
}: MoreMenuProps): ReactElement | null {
  const { row, pendingNotice } = state;
  if (row === null) return null;
  return (
    <div className="cb-more-menu" role="dialog" aria-label={`「${row.name}」更多操作`}>
      <ul className="cb-more-menu__list" role="menu">
        {MORE_MENU_ITEMS.map((item) => (
          <li key={item.key} role="none">
            <button
              type="button"
              role="menuitem"
              className={`cb-more-menu__item${item.pending ? ' cb-more-menu__item--pending' : ''}`}
              data-action={item.key}
              data-pending={item.pending}
              {...(item.pending ? { 'aria-disabled': true, title: MORE_PENDING_HINT } : {})}
              onClick={() => {
                if (item.pending) {
                  onPending(`「${item.label}」${MORE_PENDING_HINT}，敬请期待。`);
                } else {
                  onView(row);
                }
              }}
            >
              <span className="cb-more-menu__label">{item.label}</span>
              {item.pending && <span className="cb-more-menu__hint">{MORE_PENDING_HINT}</span>}
            </button>
          </li>
        ))}
      </ul>
      {pendingNotice !== null && (
        <p className="cb-more-menu__notice" role="status">
          {pendingNotice}
        </p>
      )}
      <button type="button" className="cb-more-menu__close" onClick={onClose}>
        关闭
      </button>
    </div>
  );
}

/**
 * 受控更多菜单 hook：记录点了哪个能力的「更多」、占位项反馈文案。
 * 打开新菜单时清空上一次占位反馈，避免串台。
 */
export function useMoreMenu(): {
  state: MoreMenuState;
  openMore: (row: DashboardCapabilityRow) => void;
  setPending: (notice: string) => void;
  closeMore: () => void;
} {
  const [state, setState] = useState<MoreMenuState>({ row: null, pendingNotice: null });
  return {
    state,
    openMore: (row) => setState({ row, pendingNotice: null }),
    setPending: (notice) => setState((prev) => ({ ...prev, pendingNotice: notice })),
    closeMore: () => setState({ row: null, pendingNotice: null }),
  };
}

/** 「本期未开放」试用占位浮层（行内试用点击后弹出）。受控 open + 关闭。 */
export interface TrialNoticeProps {
  capabilityName: string | null;
  onClose: () => void;
}

export function TrialNotice({ capabilityName, onClose }: TrialNoticeProps): ReactElement | null {
  if (capabilityName === null) return null;
  return (
    <div className="cb-trial-notice" role="dialog" aria-label="试用提示">
      <p className="cb-trial-notice__text">「{capabilityName}」的试用本期未开放，敬请期待。</p>
      <button type="button" className="cb-trial-notice__close" onClick={onClose}>
        知道了
      </button>
    </div>
  );
}

/** 受控试用占位 hook：记录点了哪个能力的试用，弹占位。 */
export function useTrialNotice(): {
  noticeName: string | null;
  openTrial: (row: DashboardCapabilityRow) => void;
  closeTrial: () => void;
} {
  const [noticeName, setNoticeName] = useState<string | null>(null);
  return {
    noticeName,
    openTrial: (row) => setNoticeName(row.name),
    closeTrial: () => setNoticeName(null),
  };
}

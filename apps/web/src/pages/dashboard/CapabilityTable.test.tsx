// CapabilityTable 测试（外壳首页-11/14/15/30/35）：
//   状态单源（reviewStatus+statusLabel）/ usage 列占位 / 试用「本期未开放」/ 编辑·更多入口 / 拒绝原因。
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DashboardCapabilityRow } from '@cb/shared';

// jsdom 无 canvas：MiniSparkline 在有数据时会渲染 echarts；这里行的 spendSparkline=null（占位），
// 不会触达 echarts，但仍 mock 以防回归。
vi.mock('echarts-for-react/lib/core', () => ({
  default: () => <div data-testid="echarts-core" />,
}));

import { CapabilityTable, TrialNotice, MoreMenu, type MoreMenuState } from './CapabilityTable.js';

function row(over: Partial<DashboardCapabilityRow> = {}): DashboardCapabilityRow {
  return {
    capabilityId: 'cap-1',
    versionId: 'ver-1',
    slug: 'my-cap',
    name: '保险方案速算',
    tagline: '一句话算清两全险现金价值',
    reviewStatus: 'published',
    statusLabel: '已上架',
    rejectReason: null,
    retryEditable: false,
    monthlyInvocations: null,
    spendSparkline: null,
    revenueMicros: null,
    actions: { trial: { enabled: false, hint: '本期未开放' }, edit: true, more: true },
    publishedAt: '2026-06-01T00:00:00Z',
    updatedAt: '2026-06-10T00:00:00Z',
    ...over,
  };
}

const noop = (): void => {};

describe('CapabilityTable 列与单源状态', () => {
  it('渲染名称 + 简介；状态徽章用后端 statusLabel（单源派生 tone）', () => {
    const { container } = render(
      <CapabilityTable
        rows={[row()]}
        meta={undefined}
        onTrial={noop}
        onEdit={noop}
        onMore={noop}
      />,
    );
    expect(screen.getByText('保险方案速算')).toBeInTheDocument();
    expect(screen.getByText('一句话算清两全险现金价值')).toBeInTheDocument();
    const badge = container.querySelector('.cb-cap-status') as HTMLElement;
    expect(badge.textContent).toBe('已上架');
    expect(badge.getAttribute('data-status')).toBe('published');
    expect(badge.getAttribute('data-tone')).toBe('ok');
  });

  it('被拒态：statusLabel 已退回 + 拒绝原因 + 重试/编辑', () => {
    render(
      <CapabilityTable
        rows={[
          row({
            reviewStatus: 'review_rejected',
            statusLabel: '已退回',
            rejectReason: '示例字段过少',
            retryEditable: true,
          }),
        ]}
        meta={undefined}
        onTrial={noop}
        onEdit={noop}
        onMore={noop}
      />,
    );
    expect(screen.getByText('已退回')).toBeInTheDocument();
    expect(screen.getByText('示例字段过少')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重试 / 编辑' })).toBeInTheDocument();
  });

  it('usage 列（本月调用 / 收益 / 消耗迷你图）走占位，绝不显 0、不画图', () => {
    const meta = {
      placeholders: {
        monthlyInvocations: '暂无数据 / 上线后填充',
        revenueMicros: '暂无数据 / 上线后填充',
        spendSparkline: '暂无数据 / 上线后填充',
      },
    };
    const { container } = render(
      <CapabilityTable rows={[row()]} meta={meta} onTrial={noop} onEdit={noop} onMore={noop} />,
    );
    // 至少两个 usage 占位（本月调用 + 收益），且不画真图
    expect(container.querySelectorAll('.cb-usage-placeholder').length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByTestId('echarts-core')).toBeNull();
    const invCell = container.querySelector('.cb-cap-row__invocations') as HTMLElement;
    expect(within(invCell).queryByText('0')).not.toBeInTheDocument();
  });
});

describe('CapabilityTable 操作入口', () => {
  it('试用按钮在、文案/hint 正确，点击 → onTrial（占位，不进 runtime）', async () => {
    const onTrial = vi.fn();
    render(
      <CapabilityTable
        rows={[row()]}
        meta={undefined}
        onTrial={onTrial}
        onEdit={noop}
        onMore={noop}
      />,
    );
    const trialBtn = screen.getByRole('button', { name: '试用' });
    expect(trialBtn).toHaveAttribute('title', '本期未开放');
    await userEvent.click(trialBtn);
    expect(onTrial).toHaveBeenCalledOnce();
  });

  it('编辑 / 更多入口可点', async () => {
    const onEdit = vi.fn();
    const onMore = vi.fn();
    render(
      <CapabilityTable
        rows={[row()]}
        meta={undefined}
        onTrial={noop}
        onEdit={onEdit}
        onMore={onMore}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: '编辑' }));
    await userEvent.click(screen.getByRole('button', { name: '更多操作' }));
    expect(onEdit).toHaveBeenCalledOnce();
    expect(onMore).toHaveBeenCalledOnce();
  });

  it('actions.edit=false / more=false → 不渲染对应按钮', () => {
    render(
      <CapabilityTable
        rows={[
          row({
            actions: { trial: { enabled: false, hint: '本期未开放' }, edit: false, more: false },
          }),
        ]}
        meta={undefined}
        onTrial={noop}
        onEdit={noop}
        onMore={noop}
      />,
    );
    expect(screen.queryByRole('button', { name: '编辑' })).toBeNull();
    expect(screen.queryByRole('button', { name: '更多操作' })).toBeNull();
  });

  it('空 rows → 友好空态，不裸空表', () => {
    render(
      <CapabilityTable rows={[]} meta={undefined} onTrial={noop} onEdit={noop} onMore={noop} />,
    );
    expect(screen.getByText(/还没有能力体/)).toBeInTheDocument();
  });
});

describe('MoreMenu 更多菜单（外壳首页-35）', () => {
  const baseState = (over: Partial<MoreMenuState> = {}): MoreMenuState => ({
    row: row(),
    pendingNotice: null,
    ...over,
  });

  it('row=null → 不渲染（菜单未打开）', () => {
    const { container } = render(
      <MoreMenu
        state={{ row: null, pendingNotice: null }}
        onView={noop}
        onPending={noop}
        onClose={noop}
      />,
    );
    expect(container.querySelector('.cb-more-menu')).toBeNull();
  });

  it('打开 → 三项可达：下架 / 改价（本期未开放占位）/ 查看公开页（路由占位）', () => {
    render(<MoreMenu state={baseState()} onView={noop} onPending={noop} onClose={noop} />);
    const menu = screen.getByRole('dialog', { name: /更多操作/ });
    expect(within(menu).getByRole('menuitem', { name: /下架/ })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: /改价/ })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: /查看公开页/ })).toBeInTheDocument();
  });

  it('下架/改价为本期未开放占位：aria-disabled + hint，点击 → onPending 占位反馈（不发命令）', async () => {
    const onPending = vi.fn();
    const onView = vi.fn();
    render(<MoreMenu state={baseState()} onView={onView} onPending={onPending} onClose={noop} />);
    const unpublish = screen.getByRole('menuitem', { name: /下架/ });
    expect(unpublish).toHaveAttribute('aria-disabled', 'true');
    expect(unpublish).toHaveAttribute('title', '本期未开放');
    expect(unpublish).toHaveAttribute('data-pending', 'true');

    await userEvent.click(unpublish);
    expect(onPending).toHaveBeenCalledOnce();
    expect(onPending.mock.calls[0]?.[0]).toMatch(/下架.*本期未开放/);
    // 占位项绝不走 onView（不进任何管理/运行动作）。
    expect(onView).not.toHaveBeenCalled();
  });

  it('查看公开页可点（非占位）→ onView(row)（对外只读路由，不进管理）', async () => {
    const onView = vi.fn();
    const onPending = vi.fn();
    render(<MoreMenu state={baseState()} onView={onView} onPending={onPending} onClose={noop} />);
    const view = screen.getByRole('menuitem', { name: /查看公开页/ });
    expect(view).toHaveAttribute('data-pending', 'false');
    await userEvent.click(view);
    expect(onView).toHaveBeenCalledOnce();
    expect(onPending).not.toHaveBeenCalled();
  });

  it('pendingNotice 有值 → 渲染占位反馈文案（status）', () => {
    render(
      <MoreMenu
        state={baseState({ pendingNotice: '「下架」本期未开放，敬请期待。' })}
        onView={noop}
        onPending={noop}
        onClose={noop}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('「下架」本期未开放，敬请期待。');
  });

  it('关闭按钮 → onClose', async () => {
    const onClose = vi.fn();
    render(<MoreMenu state={baseState()} onView={noop} onPending={noop} onClose={onClose} />);
    await userEvent.click(screen.getByRole('button', { name: '关闭' }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe('TrialNotice', () => {
  it('capabilityName=null → 不渲染', () => {
    const { container } = render(<TrialNotice capabilityName={null} onClose={noop} />);
    expect(container.querySelector('.cb-trial-notice')).toBeNull();
  });

  it('有名字 → 显示「本期未开放」占位，点关闭触发回调', async () => {
    const onClose = vi.fn();
    render(<TrialNotice capabilityName="保险方案速算" onClose={onClose} />);
    expect(screen.getByText(/本期未开放/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '知道了' }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});

// 收益页测试（F-07）：结算摘要占位 / 提现本期未开放 / 按能力体收益列占位 / 空态 / 错误。
import { describe, it, expect, afterEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import type { DashboardCapabilityRow } from '@cb/shared';
import { installFetchMock, type FetchMock } from '../../test/mockFetch.js';
import { renderPage } from '../__testutils__/renderPage.js';
import { RevenuePage } from './RevenuePage.js';

function row(over: Partial<DashboardCapabilityRow> = {}): DashboardCapabilityRow {
  return {
    capabilityId: 'cap-1',
    versionId: 'v-1',
    slug: 'demo',
    name: '保险话术助手',
    tagline: '一句话简介',
    reviewStatus: 'published',
    statusLabel: '已上架',
    rejectReason: null,
    retryEditable: false,
    monthlyInvocations: null,
    spendSparkline: null,
    revenueMicros: null,
    actions: { trial: { enabled: false, hint: '本期未开放' }, edit: true, more: true },
    publishedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    ...over,
  };
}

function pageBody(rows: DashboardCapabilityRow[]): unknown {
  return {
    data: rows,
    meta: {
      traceId: 't',
      page: { nextCursor: null, hasMore: false, limit: 20, order: 'desc' },
      placeholders: { revenueMicros: '暂无数据 / 上线后填充' },
    },
  };
}

let mock: FetchMock | undefined;
afterEach(() => mock?.restore());

describe('收益页', () => {
  it('结算摘要：可结算余额 / 累计收益统一占位，绝不显 0', async () => {
    mock = installFetchMock({ status: 200, json: pageBody([row()]) });
    const { container } = renderPage(<RevenuePage />);

    await screen.findByText('保险话术助手');
    expect(container.querySelector('[data-placeholder="settlementBalance"]')).toBeInTheDocument();
    expect(container.querySelector('[data-placeholder="totalRevenue"]')).toBeInTheDocument();
    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });

  it('提现按钮本期未开放占位（aria-disabled，点击不动账）', async () => {
    mock = installFetchMock({ status: 200, json: pageBody([row()]) });
    renderPage(<RevenuePage />);
    await screen.findByText('保险话术助手');

    const withdraw = screen.getByRole('button', { name: '提现' });
    expect(withdraw).toHaveAttribute('aria-disabled', 'true');
    expect(withdraw).toHaveAttribute('title', '本期未开放');
    expect(screen.getAllByText('本期未开放').length).toBeGreaterThan(0);
  });

  it('按能力体收益明细：收益列占位（revenueMicros=null），名称真实', async () => {
    mock = installFetchMock({ status: 200, json: pageBody([row({ name: '增长黑客助手' })]) });
    const { container } = renderPage(<RevenuePage />);

    expect(await screen.findByText('增长黑客助手')).toBeInTheDocument();
    // 表内收益列占位（至少一处 revenueMicros 占位）。
    expect(
      container.querySelector('.cb-revenue__table [data-placeholder="revenueMicros"]'),
    ).toBeInTheDocument();
  });

  it('只拉已上架能力（status=published）', async () => {
    mock = installFetchMock({ status: 200, json: pageBody([row()]) });
    renderPage(<RevenuePage />);
    await screen.findByText('保险话术助手');
    expect(mock.calls.at(-1)?.url).toContain('status=published');
  });

  it('空态（无已上架能力）→ 友好空态，不裸空表', async () => {
    mock = installFetchMock({ status: 200, json: pageBody([]) });
    renderPage(<RevenuePage />);
    expect(await screen.findByText('还没有已上架的能力体')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('后端失败 → ErrorState（只人话 + 重试，无错误码）', async () => {
    mock = installFetchMock({
      status: 500,
      json: {
        error: {
          userMessage: '经营数据没能加载，请重试。',
          retriable: true,
          action: 'retry',
          traceId: 'tr',
        },
      },
    });
    const { container } = renderPage(<RevenuePage />);

    expect(await screen.findByText('经营数据没能加载，请重试。')).toBeInTheDocument();
    expect(
      within(screen.getByRole('alert')).getByRole('button', { name: '重试' }),
    ).toBeInTheDocument();
    expect(container.innerHTML).not.toMatch(/\b500\b/);
  });
});

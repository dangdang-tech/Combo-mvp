// 我的 Agent 页测试（F-07）：渲染 / 列表管理 / usage 占位口径 / 操作入口 / 空态 / 分页 / 错误。
import { describe, it, expect, afterEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DashboardCapabilityRow } from '@cb/shared';
import { installFetchMock, type FetchMock } from '../../test/mockFetch.js';
import { renderPage } from '../__testutils__/renderPage.js';
import { CapabilitiesPage } from './CapabilitiesPage.js';

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
    publicPageAvailable: true,
    publishedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    ...over,
  };
}

/** Paginated 信封：data + meta.page（+ usage 占位 placeholders）。 */
function pageBody(
  rows: DashboardCapabilityRow[],
  opts: { hasMore?: boolean; nextCursor?: string | null } = {},
): unknown {
  return {
    data: rows,
    meta: {
      traceId: 't',
      page: {
        nextCursor: opts.nextCursor ?? null,
        hasMore: opts.hasMore ?? false,
        limit: 20,
        order: 'desc',
      },
      placeholders: {
        monthlyInvocations: '暂无数据 / 上线后填充',
        spendSparkline: '暂无数据 / 上线后填充',
        revenueMicros: '暂无数据 / 上线后填充',
      },
    },
  };
}

let mock: FetchMock | undefined;
afterEach(() => mock?.restore());

describe('我的 Agent 页', () => {
  it('渲染列表：能力名 + 后端单源状态文案（不前端自造）', async () => {
    mock = installFetchMock({
      status: 200,
      json: pageBody([row({ name: '保险话术助手', statusLabel: '已上架' })]),
    });
    renderPage(<CapabilitiesPage />);

    expect(await screen.findByText('保险话术助手')).toBeInTheDocument();
    // 状态徽章在表内（与同名筛选 chip 区分：scope 到 table）。
    expect(within(screen.getByRole('table')).getByText('已上架')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '我的 Agent' })).toBeInTheDocument();
  });

  it('不重复展示工作台的创作恢复卡，只给明确的创建入口', async () => {
    mock = installFetchMock({ status: 200, json: pageBody([row()]) });
    renderPage(<CapabilitiesPage />);

    await screen.findByText('保险话术助手');
    expect(screen.queryByRole('region', { name: '继续上次创作' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '创建 Agent' })).toBeInTheDocument();
  });

  it('usage 列统一占位（本月调用 / 收益）：显示占位文案、绝不显 0', async () => {
    mock = installFetchMock({ status: 200, json: pageBody([row()]) });
    const { container } = renderPage(<CapabilitiesPage />);

    await screen.findByText('保险话术助手');
    // 占位件渲染（UsagePlaceholder data-placeholder 钩子）。
    expect(container.querySelector('[data-placeholder="monthlyInvocations"]')).toBeInTheDocument();
    expect(container.querySelector('[data-placeholder="revenueMicros"]')).toBeInTheDocument();
    // 占位文案在，绝不出现误导的「0」。
    expect(screen.getAllByText('暂无数据 / 上线后填充').length).toBeGreaterThan(0);
    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });

  it('消耗 sparkline 占位（spendSparkline=null）→ 行内占位，不画图', async () => {
    mock = installFetchMock({ status: 200, json: pageBody([row({ spendSparkline: null })]) });
    const { container } = renderPage(<CapabilitiesPage />);
    await screen.findByText('保险话术助手');
    expect(container.querySelector('.cb-sparkline--placeholder')).toBeInTheDocument();
  });

  it('不展示尚未兑现的行内试用入口', async () => {
    mock = installFetchMock({ status: 200, json: pageBody([row()]) });
    renderPage(<CapabilitiesPage />);
    await screen.findByText('保险话术助手');

    expect(screen.queryByRole('button', { name: '试用' })).not.toBeInTheDocument();
  });

  it('被退回态保留拒绝原因；回退后的公开版真实可达时仍可打开', async () => {
    mock = installFetchMock({
      status: 200,
      json: pageBody([
        row({
          reviewStatus: 'review_rejected',
          statusLabel: '已退回',
          rejectReason: '内容含敏感词',
          retryEditable: true,
          publicPageAvailable: true,
        }),
      ]),
    });
    renderPage(<CapabilitiesPage />);

    await screen.findByText('保险话术助手');
    const table = screen.getByRole('table');
    // 状态徽章「已退回」在表内（与同名筛选 chip 区分）。
    expect(within(table).getByText('已退回')).toBeInTheDocument();
    expect(within(table).getByText('内容含敏感词')).toBeInTheDocument();
    expect(within(table).getByRole('link', { name: /打开.*公开页/ })).toBeInTheDocument();
  });

  it('已上架直接显示公开页；不再渲染“更多”占位菜单', async () => {
    mock = installFetchMock({ status: 200, json: pageBody([row()]) });
    renderPage(<CapabilitiesPage />);
    await screen.findByText('保险话术助手');

    expect(screen.getByRole('link', { name: /打开.*公开页/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '更多操作' })).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('草稿没有公开版：不显示公开页与任何占位操作', async () => {
    mock = installFetchMock({
      status: 200,
      json: pageBody([
        row({
          reviewStatus: 'draft',
          statusLabel: '草稿',
          publishedAt: null,
          publicPageAvailable: false,
        }),
      ]),
    });
    renderPage(<CapabilitiesPage />);
    await screen.findByText('保险话术助手');

    expect(screen.queryByRole('button', { name: '重新创建' })).toBeNull();
    expect(screen.queryByRole('link', { name: /公开页/ })).toBeNull();
    expect(screen.getByLabelText('暂无可用操作')).toHaveTextContent('—');
    expect(screen.queryByText(/下架|改价|本期未开放/)).toBeNull();
  });

  it('空态（无 Agent）→ 友好空态，不裸空表', async () => {
    mock = installFetchMock({ status: 200, json: pageBody([]) });
    renderPage(<CapabilitiesPage />);
    expect(await screen.findByText('还没有 Agent')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('状态筛选切换：当前档高亮 + 重新拉数（cursor 回第一页）', async () => {
    mock = installFetchMock({ status: 200, json: pageBody([row()]) });
    renderPage(<CapabilitiesPage />);
    await screen.findByText('保险话术助手');

    const publishedChip = screen.getByRole('button', { name: '已上架' });
    await userEvent.click(publishedChip);

    await waitFor(() => expect(publishedChip).toHaveAttribute('aria-pressed', 'true'));
    // 第二次请求带 status=published（换筛选回第一页，无 cursor）。
    await waitFor(() => {
      const last = mock?.calls.at(-1);
      expect(last?.url).toContain('status=published');
      expect(last?.url).not.toContain('cursor=');
    });
  });

  it('分页真追加：点「加载更多」后第一页旧行仍在（不被替换），与第二页累积同时呈现', async () => {
    mock = installFetchMock([
      {
        status: 200,
        json: pageBody([row({ capabilityId: 'cap-1', name: '能力 A' })], {
          hasMore: true,
          nextCursor: 'CUR2',
        }),
      },
      {
        status: 200,
        json: pageBody([row({ capabilityId: 'cap-2', name: '能力 B' })], { hasMore: false }),
      },
    ]);
    renderPage(<CapabilitiesPage />);

    await screen.findByText('能力 A');
    await userEvent.click(screen.getByRole('button', { name: '加载更多' }));

    // 关键断言（Codex P1）：第二页到达后，第一页的「能力 A」仍在 DOM（追加，不替换）。
    expect(await screen.findByText('能力 B')).toBeInTheDocument();
    expect(screen.getByText('能力 A')).toBeInTheDocument();
    // 两行同时在表内（累积态）。
    const table = screen.getByRole('table');
    expect(within(table).getByText('能力 A')).toBeInTheDocument();
    expect(within(table).getByText('能力 B')).toBeInTheDocument();
  });

  it('分页累积去重：后页重叠返回同一 capabilityId → 只保留一行（旧行口径不被覆盖）', async () => {
    mock = installFetchMock([
      {
        status: 200,
        json: pageBody([row({ capabilityId: 'cap-1', name: '能力 A' })], {
          hasMore: true,
          nextCursor: 'CUR2',
        }),
      },
      {
        status: 200,
        // 后端重叠返回了 cap-1（边界/并发新增导致游标重叠）+ 新行 cap-2。
        json: pageBody(
          [
            row({ capabilityId: 'cap-1', name: '能力 A 改名了' }),
            row({ capabilityId: 'cap-2', name: '能力 B' }),
          ],
          { hasMore: false },
        ),
      },
    ]);
    renderPage(<CapabilitiesPage />);

    await screen.findByText('能力 A');
    await userEvent.click(screen.getByRole('button', { name: '加载更多' }));
    await screen.findByText('能力 B');

    // cap-1 只出现一行（去重），保留首次出现口径「能力 A」；后页改名版不覆盖。
    expect(screen.getAllByText('能力 A')).toHaveLength(1);
    expect(screen.queryByText('能力 A 改名了')).not.toBeInTheDocument();
    expect(screen.getByText('能力 B')).toBeInTheDocument();
  });

  it('分页：hasMore → 显示「加载更多」，点击带 nextCursor 拉下一页', async () => {
    mock = installFetchMock([
      {
        status: 200,
        json: pageBody([row({ capabilityId: 'cap-1', name: '能力 A' })], {
          hasMore: true,
          nextCursor: 'CUR2',
        }),
      },
      {
        status: 200,
        json: pageBody([row({ capabilityId: 'cap-2', name: '能力 B' })], { hasMore: false }),
      },
    ]);
    renderPage(<CapabilitiesPage />);

    await screen.findByText('能力 A');
    const more = screen.getByRole('button', { name: '加载更多' });
    await userEvent.click(more);

    await waitFor(() => {
      const last = mock?.calls.at(-1);
      expect(last?.url).toContain('cursor=CUR2');
    });
    expect(await screen.findByText('能力 B')).toBeInTheDocument();
  });

  it('无更多页 → 显示「没有更多了」', async () => {
    mock = installFetchMock({ status: 200, json: pageBody([row()], { hasMore: false }) });
    renderPage(<CapabilitiesPage />);
    await screen.findByText('保险话术助手');
    expect(screen.getByText('没有更多了')).toBeInTheDocument();
  });

  it('加载中 → 骨架占位（永不裸转圈），不显错误/数据', () => {
    // 不消费的 promise：保持 pending，断言加载态。
    mock = installFetchMock({ status: 200, json: pageBody([row()]) });
    const { container } = renderPage(<CapabilitiesPage />);
    expect(container.querySelector('.cb-skeleton')).toBeInTheDocument();
  });

  it('后端失败 → ErrorState（只人话 + 重试，无错误码）', async () => {
    mock = installFetchMock([
      {
        status: 500,
        json: {
          error: {
            userMessage: '经营数据没能加载，请重试。',
            retriable: true,
            action: 'retry',
            traceId: 'tr-x',
          },
        },
      },
    ]);
    const { container } = renderPage(<CapabilitiesPage />);

    expect(await screen.findByText('经营数据没能加载，请重试。')).toBeInTheDocument();
    expect(
      within(screen.getByRole('alert')).getByRole('button', { name: '重试' }),
    ).toBeInTheDocument();
    // 绝不裸露错误码 / HTTP 状态。
    expect(container.innerHTML).not.toMatch(/\b500\b/);
  });
});

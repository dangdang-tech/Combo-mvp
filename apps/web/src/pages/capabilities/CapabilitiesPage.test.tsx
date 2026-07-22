// 能力页测试：表格渲染（名称/简介/真实发布状态/指标占位/试用链接）+ 发布/下架交互。
import { describe, it, expect, afterEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { installFetchMock, type FetchMock } from '../../test/mockFetch.js';
import { makeCapability, paginatedBody, envelopeBody } from '../../test/fixtures.js';
import { renderPage } from '../../test/renderWithProviders.js';
import { CapabilitiesPage } from './CapabilitiesPage.js';

let fm: FetchMock | undefined;
afterEach(() => {
  fm?.restore();
  fm = undefined;
});

const DRAFT = makeCapability({ id: 'cap-a', name: '周报整理', kind: 'workflow', published: false });
const PUBLISHED = makeCapability({
  id: 'cap-b',
  name: '代码评审',
  kind: 'review',
  summary: '按团队规范给出评审意见。',
  published: true,
  publishedAt: '2026-07-01T00:00:00.000Z',
  shareToken: 'share-token-b',
});

describe('CapabilitiesPage — 表格渲染', () => {
  it('显示截图式六列表头、名称/简介/真实发布状态与可用操作', async () => {
    fm = installFetchMock({ status: 200, json: paginatedBody([DRAFT, PUBLISHED]) });
    renderPage(<CapabilitiesPage />, { route: '/capabilities' });

    const table = await screen.findByRole('table', { name: '我的能力' });
    expect(within(table).getByRole('columnheader', { name: '能力体' })).toBeInTheDocument();
    expect(within(table).getByRole('columnheader', { name: '本月调用' })).toBeInTheDocument();
    expect(within(table).getByRole('columnheader', { name: '消耗趋势' })).toBeInTheDocument();
    expect(within(table).getByRole('columnheader', { name: '收益' })).toBeInTheDocument();

    const rowA = (await screen.findByText('周报整理')).closest('tr')!;
    const rowACells = within(rowA).getAllByRole('cell');
    expect(rowACells).toHaveLength(6);
    expect(rowACells[5]).toHaveClass('cb-cap-row__actions-cell');
    expect(rowACells[5]?.firstElementChild).toHaveClass('cb-cap-row__actions');
    expect(within(rowA).getByText('未上架')).toBeInTheDocument();
    expect(within(rowA).queryByText('workflow')).toBeNull();
    expect(within(rowA).getByRole('link', { name: '试用' })).toHaveAttribute(
      'href',
      '/try/c/cap-a',
    );
    expect(within(rowA).queryByRole('button', { name: '复制链接' })).toBeNull();

    const rowB = screen.getByText('代码评审').closest('tr')!;
    expect(within(rowB).getByText('已上架')).toBeInTheDocument();
    expect(within(rowB).getByText('按团队规范给出评审意见。')).toBeInTheDocument();
    expect(within(rowB).getByRole('button', { name: '复制链接' })).toBeInTheDocument();
    // 经营指标没有后端数据，必须明确占位，不能显示设计稿模拟数字。
    expect(within(rowB).getAllByText('暂无数据 / 上线后填充')).toHaveLength(2);
    expect(within(rowB).queryByText('1284')).toBeNull();
    expect(within(rowB).queryByText('368.00')).toBeNull();
  });

  it('筛选只提供真实可判定状态：全部 / 已上架 / 未上架', async () => {
    fm = installFetchMock({ status: 200, json: paginatedBody([DRAFT, PUBLISHED]) });
    renderPage(<CapabilitiesPage />, { route: '/capabilities' });
    await screen.findByText('周报整理');

    await userEvent.click(screen.getByRole('button', { name: '已上架' }));
    expect(screen.queryByText('周报整理')).toBeNull();
    expect(screen.getByText('代码评审')).toBeInTheDocument();

    expect(screen.queryByRole('button', { name: 'Alpha·审核中' })).toBeNull();
    expect(screen.queryByRole('button', { name: '已退回' })).toBeNull();
  });

  it('?taskId= 过滤：请求带 taskId', async () => {
    fm = installFetchMock({ status: 200, json: paginatedBody([DRAFT]) });
    renderPage(<CapabilitiesPage />, { route: '/capabilities?taskId=task-1' });
    await screen.findByText('周报整理');
    expect(fm.calls[0]?.url).toContain('taskId=task-1');
  });

  it('空列表 → 市集关闭时只引导上传真实任务', async () => {
    fm = installFetchMock({ status: 200, json: paginatedBody([]) });
    renderPage(<CapabilitiesPage />, { route: '/capabilities' });
    expect(await screen.findByText('还没有能力项')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '去上传任务' })).toHaveAttribute('href', '/tasks');
    expect(screen.queryByRole('link', { name: '先逛能力市集' })).not.toBeInTheDocument();
  });
});

describe('CapabilitiesPage — 发布 / 下架交互', () => {
  it('发布：POST /capabilities/:id/publish → 徽章转已上架 + 显示复制链接', async () => {
    fm = installFetchMock([
      { status: 200, json: paginatedBody([DRAFT]) },
      {
        status: 200,
        json: envelopeBody({
          id: 'cap-a',
          published: true,
          publishedAt: '2026-07-04T12:00:00.000Z',
          shareToken: 'new-share-token',
        }),
      },
    ]);
    renderPage(<CapabilitiesPage />, { route: '/capabilities' });
    const row = (await screen.findByText('周报整理')).closest('tr')!;

    await userEvent.click(within(row).getByRole('button', { name: '发布' }));

    const post = fm.calls.find((c) => c.method === 'POST');
    expect(post?.url).toBe('/api/v1/capabilities/cap-a/publish');
    expect(await within(row).findByText('已上架')).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: '复制链接' })).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: '下架' })).toBeInTheDocument();
  });

  it('下架：POST /capabilities/:id/unpublish → 徽章转未上架（share_token 保留语义由后端定）', async () => {
    fm = installFetchMock([
      { status: 200, json: paginatedBody([PUBLISHED]) },
      {
        status: 200,
        json: envelopeBody({ id: 'cap-b', published: false, shareToken: 'share-token-b' }),
      },
    ]);
    renderPage(<CapabilitiesPage />, { route: '/capabilities' });
    const row = (await screen.findByText('代码评审')).closest('tr')!;

    await userEvent.click(within(row).getByRole('button', { name: '下架' }));

    const post = fm.calls.find((c) => c.method === 'POST');
    expect(post?.url).toBe('/api/v1/capabilities/cap-b/unpublish');
    expect(await within(row).findByText('未上架')).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: '发布' })).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: '复制链接' })).toBeNull();
  });

  it('发布失败 → 人话错误（绝不裸露错误码）', async () => {
    fm = installFetchMock([
      { status: 200, json: paginatedBody([DRAFT]) },
      {
        status: 404,
        json: {
          error: {
            userMessage: '没找到对应内容，可能已被删除。',
            retriable: false,
            action: 'change_input',
            traceId: 'trace-notfound',
          },
        },
      },
    ]);
    renderPage(<CapabilitiesPage />, { route: '/capabilities' });
    const row = (await screen.findByText('周报整理')).closest('tr')!;
    await userEvent.click(within(row).getByRole('button', { name: '发布' }));
    expect(await screen.findByText('没找到对应内容，可能已被删除。')).toBeInTheDocument();
    expect(screen.queryByText(/404/)).toBeNull();
  });
});

// 能力页测试：列表渲染（名称/简介/类型/发布状态/分享令牌/试用链接）+ 发布/下架交互。
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

describe('CapabilitiesPage — 列表渲染', () => {
  it('显示名称/简介/类型/发布状态；已发布的显示分享令牌；每项有试用链接', async () => {
    fm = installFetchMock({ status: 200, json: paginatedBody([DRAFT, PUBLISHED]) });
    renderPage(<CapabilitiesPage />, { route: '/capabilities' });

    const rowA = (await screen.findByText('周报整理')).closest('li')!;
    expect(within(rowA).getByText('未发布')).toBeInTheDocument();
    expect(within(rowA).getByText('workflow')).toBeInTheDocument();
    expect(within(rowA).queryByText(/分享令牌/)).toBeNull();
    expect(within(rowA).getByRole('link', { name: '去试用' })).toHaveAttribute(
      'href',
      '/try/c/cap-a',
    );

    const rowB = screen.getByText('代码评审').closest('li')!;
    expect(within(rowB).getByText('已发布')).toBeInTheDocument();
    expect(within(rowB).getByText('按团队规范给出评审意见。')).toBeInTheDocument();
    // 分享展示的是可用的完整试用链接（裸 shareToken 无路由可消费）。
    expect(
      within(rowB).getByText((text) => text.includes('/try/c/cap-b')),
    ).toBeInTheDocument();
  });

  it('?taskId= 过滤：请求带 taskId，可清除过滤', async () => {
    fm = installFetchMock({ status: 200, json: paginatedBody([DRAFT]) });
    renderPage(<CapabilitiesPage />, { route: '/capabilities?taskId=task-1' });
    await screen.findByText('周报整理');
    expect(fm.calls[0]?.url).toContain('taskId=task-1');
    expect(screen.getByRole('button', { name: /只看单个任务/ })).toBeInTheDocument();
  });

  it('空列表 → 引导去任务页', async () => {
    fm = installFetchMock({ status: 200, json: paginatedBody([]) });
    renderPage(<CapabilitiesPage />, { route: '/capabilities' });
    expect(await screen.findByText('还没有能力项')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '去任务页' })).toHaveAttribute('href', '/tasks');
  });
});

describe('CapabilitiesPage — 发布 / 下架交互', () => {
  it('发布：POST /capabilities/:id/publish → 徽章转已发布 + 显示分享令牌', async () => {
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
    const row = (await screen.findByText('周报整理')).closest('li')!;

    await userEvent.click(within(row).getByRole('button', { name: '发布' }));

    const post = fm.calls.find((c) => c.method === 'POST');
    expect(post?.url).toBe('/api/v1/capabilities/cap-a/publish');
    expect(await within(row).findByText('已发布')).toBeInTheDocument();
    expect(within(row).getByText((text) => text.includes('/try/c/cap-a'))).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: '下架' })).toBeInTheDocument();
  });

  it('下架：POST /capabilities/:id/unpublish → 徽章转未发布（share_token 保留语义由后端定）', async () => {
    fm = installFetchMock([
      { status: 200, json: paginatedBody([PUBLISHED]) },
      {
        status: 200,
        json: envelopeBody({ id: 'cap-b', published: false, shareToken: 'share-token-b' }),
      },
    ]);
    renderPage(<CapabilitiesPage />, { route: '/capabilities' });
    const row = (await screen.findByText('代码评审')).closest('li')!;

    await userEvent.click(within(row).getByRole('button', { name: '下架' }));

    const post = fm.calls.find((c) => c.method === 'POST');
    expect(post?.url).toBe('/api/v1/capabilities/cap-b/unpublish');
    expect(await within(row).findByText('未发布')).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: '发布' })).toBeInTheDocument();
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
    const row = (await screen.findByText('周报整理')).closest('li')!;
    await userEvent.click(within(row).getByRole('button', { name: '发布' }));
    expect(await screen.findByText('没找到对应内容，可能已被删除。')).toBeInTheDocument();
    expect(screen.queryByText(/404/)).toBeNull();
  });
});

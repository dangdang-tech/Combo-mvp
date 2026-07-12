import { afterEach, describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { installFetchMock, type FetchMock } from '../../test/mockFetch.js';
import { makeCapability, paginatedBody } from '../../test/fixtures.js';
import { renderPage } from '../../test/renderWithProviders.js';
import { CapabilitiesPage } from './CapabilitiesPage.js';

let fm: FetchMock | undefined;

afterEach(() => {
  fm?.restore();
  fm = undefined;
});

describe('CapabilitiesPage — Annotation 7 任务结果语境', () => {
  it('保留 taskId 数据范围，但用页面标题说明语境且不再渲染可关闭筛选 chip', async () => {
    fm = installFetchMock({
      status: 200,
      json: paginatedBody([makeCapability({ id: 'cap-task-result', name: '任务产出的能力项' })]),
    });
    renderPage(<CapabilitiesPage />, {
      route: '/capabilities?taskId=task-annotation-7',
    });

    expect(
      await screen.findByRole('heading', { level: 2, name: '本次提取结果' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText('这次上传提取出的能力项：发布拿分享令牌，或先去试用。'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /只看单个任务/ })).toBeNull();
    expect(screen.queryByText(/只看单个任务的能力项/)).toBeNull();
    expect(fm.calls[0]?.url).toContain('taskId=task-annotation-7');
  });

  it('全局能力页继续使用“我的能力”标题且请求不带 taskId', async () => {
    fm = installFetchMock({
      status: 200,
      json: paginatedBody([makeCapability({ id: 'cap-global', name: '全局能力项' })]),
    });
    renderPage(<CapabilitiesPage />, { route: '/capabilities' });

    expect(await screen.findByRole('heading', { level: 2, name: '我的能力' })).toBeInTheDocument();
    expect(fm.calls[0]?.url).not.toContain('taskId=');
  });
});

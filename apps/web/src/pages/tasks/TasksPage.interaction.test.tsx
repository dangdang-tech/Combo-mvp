import { afterEach, describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import { installFetchMock, type FetchMock } from '../../test/mockFetch.js';
import { makeTask, paginatedBody } from '../../test/fixtures.js';
import { renderPage } from '../../test/renderWithProviders.js';
import { TasksPage } from './TasksPage.js';

let fm: FetchMock | undefined;

afterEach(() => {
  fm?.restore();
  fm = undefined;
});

describe('TasksPage — 表格交互语义', () => {
  it('保留两个独立导航入口，并为移动端键值布局提供单元格标签', async () => {
    const task = makeTask({
      id: 'task-ok',
      description: '完成的任务',
      status: 'succeeded',
      currentStep: 'extract',
      capabilityCount: 4,
    });
    fm = installFetchMock({ status: 200, json: paginatedBody([task]) });
    renderPage(<TasksPage />);

    const taskLink = await screen.findByRole('link', { name: '查看任务：完成的任务' });
    expect(taskLink).toHaveAttribute('href', '/tasks/task-ok');
    expect(taskLink).toHaveClass('cb-task-link');
    expect(taskLink.querySelector('.cb-task-time')).not.toBeNull();

    const row = taskLink.closest('tr')!;
    expect(row).toHaveClass('cb-task-row');
    expect(row).not.toHaveAttribute('role', 'link');
    expect(within(row).getAllByRole('cell').map((cell) => cell.getAttribute('data-label'))).toEqual([
      '任务',
      '状态',
      '上传进度',
      '能力项',
      '下一步',
    ]);

    const capabilityLink = within(row).getByRole('link', { name: '查看能力项' });
    expect(capabilityLink).toHaveClass('cb-task-action');
    expect(capabilityLink).toHaveAttribute('href', '/capabilities?taskId=task-ok');
    expect(screen.getByRole('columnheader', { name: '下一步' })).toBeInTheDocument();
  });
});

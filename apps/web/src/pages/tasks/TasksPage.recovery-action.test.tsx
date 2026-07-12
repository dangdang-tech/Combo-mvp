import { afterEach, describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { installFetchMock, type FetchMock } from '../../test/mockFetch.js';
import { envelopeBody, makeTask, paginatedBody } from '../../test/fixtures.js';
import { renderPage } from '../../test/renderWithProviders.js';
import { TasksPage } from './TasksPage.js';

let fm: FetchMock | undefined;

afterEach(() => {
  fm?.restore();
  fm = undefined;
});

describe('TasksPage — Annotation 6 失败恢复动作', () => {
  it('上传超时行提供真正的新建上传动作，并在成功后展示新的配对码', async () => {
    const expired = makeTask({
      id: 'task-expired',
      description: '上传已超时的任务',
      currentStep: 'upload',
      status: 'failed',
      lastError: {
        userMessage: '上传等待已超时，请重新上传。',
        retriable: false,
        action: 'change_input',
        traceId: 'trace-expired',
      },
      upload: {
        status: 'expired',
        partsExpected: 505,
        partsLanded: 322,
        pairingExpiresAt: '2026-07-08T12:00:00.000Z',
      },
    });
    const replacement = makeTask({ id: 'task-replacement', description: '新的上传任务' });

    fm = installFetchMock([
      { status: 200, json: paginatedBody([expired]) },
      {
        status: 201,
        json: envelopeBody({ task: replacement, pairingCode: 'PAIR-REUPLOAD-1' }),
      },
      { status: 200, json: paginatedBody([replacement, expired]) },
      { match: '/tasks/task-replacement', status: 200, json: envelopeBody(replacement) },
    ]);
    renderPage(<TasksPage />);

    const row = (await screen.findByText('上传已超时的任务')).closest('tr')!;
    expect(within(row).getByText('上传等待已超时，请重新上传。')).toBeInTheDocument();

    await userEvent.click(
      within(row).getByRole('button', { name: '为上传已超时的任务新建上传任务' }),
    );

    expect(fm.calls.find((call) => call.method === 'POST')?.url).toBe('/api/v1/tasks');
    expect(await screen.findByText('PAIR-REUPLOAD-1')).toBeInTheDocument();
    expect(screen.getByText('复制命令，在终端运行')).toBeInTheDocument();
  });

  it('提取失败行进入任务详情执行重试，不在列表复制重试接口', async () => {
    const failed = makeTask({
      id: 'task-failed',
      description: '提取失败的任务',
      currentStep: 'extract',
      status: 'failed',
      lastError: {
        userMessage: '模型服务暂时不可用，请稍后重试。',
        retriable: true,
        action: 'retry',
        traceId: 'trace-retry',
      },
    });
    fm = installFetchMock({ status: 200, json: paginatedBody([failed]) });
    renderPage(<TasksPage />);

    const row = (await screen.findByText('提取失败的任务')).closest('tr')!;
    expect(within(row).getByRole('link', { name: '查看并重试' })).toHaveAttribute(
      'href',
      '/tasks/task-failed',
    );
    expect(fm.calls.some((call) => call.method === 'POST')).toBe(false);
  });
});

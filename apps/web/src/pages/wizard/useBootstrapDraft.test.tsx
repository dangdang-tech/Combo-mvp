// useBootstrapDraft 单测（P0-2 草稿 bootstrap）：全新进入建草稿 / 已有 draftId 不建 / needsBootstrap=false 不建 /
//   失败落 error + 重试复用同 key / 只建一次（不重复建行）。
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DraftView } from '@cb/shared';
import { WizardProvider, useWizard } from './WizardContext.js';
import { useBootstrapDraft } from './useBootstrapDraft.js';
import { installFetchMock, type FetchMock } from '../../test/mockFetch.js';

function draftView(over: Partial<DraftView> = {}): DraftView {
  return {
    id: 'draft-1',
    status: 'active',
    currentStep: 'import',
    stepProgress: { percent: 0, phrase: '开始' },
    createdAt: '2026-06-17T00:00:00Z',
    updatedAt: '2026-06-17T00:00:00Z',
    ...over,
  };
}

function Probe({ needsBootstrap }: { needsBootstrap: boolean }) {
  const b = useBootstrapDraft({ needsBootstrap });
  const { draftId } = useWizard();
  return (
    <div>
      <span data-testid="status">{b.status}</span>
      <span data-testid="err">{b.error ? b.error.userMessage : 'none'}</span>
      <span data-testid="ctx-draft">{draftId ?? 'none'}</span>
      <button type="button" onClick={b.retry}>
        重试
      </button>
    </div>
  );
}

function setup(needsBootstrap: boolean, initialDraftId?: string) {
  return render(
    <WizardProvider initialStep="import" initialDraftId={initialDraftId}>
      <Probe needsBootstrap={needsBootstrap} />
    </WizardProvider>,
  );
}

let mock: FetchMock;
afterEach(() => mock?.restore());

describe('useBootstrapDraft（P0-2 草稿 bootstrap）', () => {
  it('全新进入（needsBootstrap=true、无 draftId）→ POST /drafts 建草稿 → ready + draftId 贯穿 context', async () => {
    mock = installFetchMock({ status: 201, json: { data: draftView({ id: 'draft-new' }) } });
    setup(true);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    expect(screen.getByTestId('ctx-draft')).toHaveTextContent('draft-new');
    // 写命令 scope=draft.create + 注入幂等键。
    const call = mock.calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.url).toBe('/api/v1/drafts');
    expect(call.headers['X-Idempotency-Scope']).toBe('draft.create');
    expect(call.headers['Idempotency-Key']).toBeTruthy();
    // 只建一次（不重复建行）。
    expect(mock.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('已有 draftId（续传/已建）→ ready，不再建（不打 POST /drafts）', async () => {
    mock = installFetchMock({ status: 201, json: { data: draftView() } });
    setup(true, 'existing-draft');
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    expect(screen.getByTestId('ctx-draft')).toHaveTextContent('existing-draft');
    expect(mock.fn).not.toHaveBeenCalled();
  });

  it('needsBootstrap=false（续传/回看/深链）→ idle，不空建', async () => {
    mock = installFetchMock({ status: 201, json: { data: draftView() } });
    setup(false);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('idle'));
    expect(mock.fn).not.toHaveBeenCalled();
  });

  it('建失败 → error 落人话退路；重试复用同 Idempotency-Key 回放/补建 → ready', async () => {
    mock = installFetchMock([
      {
        status: 500,
        json: {
          error: {
            userMessage: '新建草稿没成功，请重试。',
            retriable: true,
            action: 'retry',
            traceId: 't',
          },
        },
      },
      { status: 201, json: { data: draftView({ id: 'draft-2' }) } },
    ]);
    setup(true);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('error'));
    expect(screen.getByTestId('err')).toHaveTextContent('新建草稿没成功，请重试。');
    await userEvent.click(screen.getByText('重试'));
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    expect(screen.getByTestId('ctx-draft')).toHaveTextContent('draft-2');
    // 重试复用首次幂等键（回放/补建，不重复建行）。
    expect(mock.calls[0]!.headers['Idempotency-Key']).toBe(
      mock.calls[1]!.headers['Idempotency-Key'],
    );
  });
});

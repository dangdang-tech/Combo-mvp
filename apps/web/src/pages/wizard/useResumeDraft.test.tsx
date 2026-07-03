// useResumeDraft 单测（F-15 深链续传）：恢复 selection / 找不到落退路 / 无 draftId 不续传 / 重试。
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DraftView } from '@cb/shared';
import { WizardProvider, useWizard } from './WizardContext.js';
import { useResumeDraft } from './useResumeDraft.js';
import { installFetchMock, type FetchMock } from '../../test/mockFetch.js';

function draftView(over: Partial<DraftView> = {}): DraftView {
  return {
    id: 'd1',
    status: 'active',
    currentStep: 'select',
    stepProgress: { percent: 30, phrase: '选择中' },
    selection: { mode: 'all', candidateIds: ['c1', 'c2'] },
    createdAt: '2026-06-10T00:00:00Z',
    updatedAt: '2026-06-11T00:00:00Z',
    ...over,
  };
}

function Probe({ draftId }: { draftId: string | undefined }) {
  const resume = useResumeDraft(draftId);
  const {
    selection,
    draftId: ctxDraftId,
    snapshotId,
    extractJobId,
    versionId,
    batchId,
  } = useWizard();
  return (
    <div>
      <span data-testid="status">{resume.status}</span>
      <span data-testid="err">{resume.error ? resume.error.userMessage : 'none'}</span>
      <span data-testid="sel">{selection ? selection.mode : 'none'}</span>
      <span data-testid="ctxDraft">{ctxDraftId ?? 'none'}</span>
      <span data-testid="snap">{snapshotId ?? 'none'}</span>
      <span data-testid="extract">{extractJobId ?? 'none'}</span>
      <span data-testid="version">{versionId ?? 'none'}</span>
      <span data-testid="batch">{batchId ?? 'none'}</span>
      <button type="button" onClick={resume.retry}>
        重试
      </button>
    </div>
  );
}

function setup(draftId: string | undefined) {
  return render(
    <WizardProvider initialStep="select">
      <Probe draftId={draftId} />
    </WizardProvider>,
  );
}

let mock: FetchMock;
afterEach(() => mock?.restore());

describe('useResumeDraft', () => {
  it('无 draftId → idle，不续传、不打后端', async () => {
    mock = installFetchMock({ status: 200, json: { data: [] } });
    setup(undefined);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('idle'));
    expect(mock.fn).not.toHaveBeenCalled();
  });

  it('命中草稿 → done，恢复 draftId + selection（贯穿-15，单条 GET /drafts/{id}）', async () => {
    // 单条 GET 返回单个 DraftView（{ data: DraftView }，非列表）。
    mock = installFetchMock({ status: 200, json: { data: draftView() } });
    setup('d1');
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('done'));
    expect(screen.getByTestId('ctxDraft')).toHaveTextContent('d1');
    expect(screen.getByTestId('sel')).toHaveTextContent('all');
    // 首选单条端点（不再翻列表）。
    expect(mock.calls[0]!.url).toBe('/api/v1/drafts/d1');
  });

  it('命中草稿 → 恢复全字段引用 snapshot/extract/version/batch（Codex P0-2，各步据引用续接不重建）', async () => {
    mock = installFetchMock({
      status: 200,
      json: {
        data: draftView({
          currentStep: 'structure',
          snapshotId: 'snap1',
          extractJobId: 'ej1',
          versionId: 'ver1',
          batchId: 'bat1',
        }),
      },
    });
    setup('d1');
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('done'));
    expect(screen.getByTestId('snap')).toHaveTextContent('snap1');
    expect(screen.getByTestId('extract')).toHaveTextContent('ej1');
    expect(screen.getByTestId('version')).toHaveTextContent('ver1');
    expect(screen.getByTestId('batch')).toHaveTextContent('bat1');
  });

  it('找不到草稿（GET 404）→ error 落「可能已删除」退路（change_input，不裸崩、不徒劳翻列表）', async () => {
    // 单条 GET 404：action=change_input + 不可重试 → findDraftById 直接 undefined（不再翻列表）。
    mock = installFetchMock({
      status: 404,
      json: {
        error: {
          userMessage: '没找到这条草稿，可能已被放弃或不存在。',
          retriable: false,
          action: 'change_input',
          traceId: 't',
        },
      },
    });
    setup('d1');
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('error'));
    expect(screen.getByTestId('err')).toHaveTextContent(/已被删除/);
    // 只打了单条 GET，没回落列表（404 是确定性找不到）。
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]!.url).toBe('/api/v1/drafts/d1');
  });

  it('单条 GET 瞬时 500 → 回落 /dashboard/drafts 列表查找（找不到落退路）', async () => {
    // 非 404 瞬时错误（500）：回落列表扫描兜底（健壮性）；列表也没有 → undefined → error。
    mock = installFetchMock([
      {
        status: 500,
        json: {
          error: {
            userMessage: '读取草稿没成功，请重试。',
            retriable: true,
            action: 'retry',
            traceId: 't',
          },
        },
      },
      {
        status: 200,
        json: {
          data: [draftView({ id: 'other' })],
          meta: { page: { hasMore: false, nextCursor: null, limit: 20, order: 'desc' } },
        },
      },
    ]);
    setup('d1');
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('error'));
    expect(screen.getByTestId('err')).toHaveTextContent(/已被删除/);
    // 先单条 GET（500），再回落列表。
    expect(mock.calls[0]!.url).toBe('/api/v1/drafts/d1');
    expect(mock.calls[1]!.url).toContain('/dashboard/drafts');
  });

  it('重试 → 再拉一次（找到则恢复）', async () => {
    mock = installFetchMock([
      {
        status: 404,
        json: {
          error: {
            userMessage: '没找到这条草稿，可能已被放弃或不存在。',
            retriable: false,
            action: 'change_input',
            traceId: 't',
          },
        },
      },
      { status: 200, json: { data: draftView() } },
    ]);
    setup('d1');
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('error'));
    await userEvent.click(screen.getByText('重试'));
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('done'));
    expect(screen.getByTestId('sel')).toHaveTextContent('all');
  });
});

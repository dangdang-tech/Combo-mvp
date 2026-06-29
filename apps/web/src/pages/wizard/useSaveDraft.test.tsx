// useSaveDraft 单测（F-12 / F-15）——存草稿诚实落库语义（Codex P0-1 修复后）：
//   - STEP③ select + 有 selection + draftId → patchSelection 真落库（端点 G）。
//   - 非 select 步 + 有 draftId（后端建产物时已落 drafts 行）→ 不打后端、退出即真草稿，诚实成功。
//   - 任一步【无 draftId】（尚无已落库草稿）→ 不谎报成功、不空退出：返回 false + 人话退路（绝不固化「假成功」）。
//   - 失败落 error（人话 + 退路，不裸崩、无 code）。
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DraftStep, SelectionDraft } from '@cb/shared';
import { WizardProvider, useWizard } from './WizardContext.js';
import { useSaveDraft } from './useSaveDraft.js';
import { installFetchMock, type FetchMock } from '../../test/mockFetch.js';

/** 测试探针：注入初始 selection（模拟 STEP③ 已选），点「保存」触发 useSaveDraft.save 并记录返回值。 */
function Probe({ initialSelection }: { initialSelection?: SelectionDraft }) {
  const { setSelection } = useWizard();
  const save = useSaveDraft();
  return (
    <div>
      <button type="button" onClick={() => initialSelection && setSelection(initialSelection)}>
        预置选择
      </button>
      <button
        type="button"
        onClick={() => {
          void save.save().then((ok) => {
            const el = document.querySelector('[data-testid="result"]');
            if (el) el.textContent = ok ? 'ok' : 'false';
          });
        }}
      >
        保存
      </button>
      <span data-testid="saving">{save.saving ? 'saving' : 'idle'}</span>
      <span data-testid="error">{save.error ? save.error.userMessage : 'none'}</span>
      <span data-testid="result">pending</span>
    </div>
  );
}

function setup(step: DraftStep, draftId: string | undefined, initialSelection?: SelectionDraft) {
  return render(
    <WizardProvider initialStep={step} initialDraftId={draftId}>
      <Probe {...(initialSelection ? { initialSelection } : {})} />
    </WizardProvider>,
  );
}

let mock: FetchMock;
afterEach(() => mock?.restore());

describe('useSaveDraft', () => {
  it('STEP③ + 有 selection + draftId → PATCH selection（端点 G）', async () => {
    mock = installFetchMock({ status: 200, json: { data: {} } });
    setup('select', 'd1', { mode: 'single', candidateId: 'c1' });
    await userEvent.click(screen.getByText('预置选择'));
    await userEvent.click(screen.getByText('保存'));
    await waitFor(() => {
      expect(
        mock.calls.some((c) => c.url === '/api/v1/drafts/d1/selection' && c.method === 'PATCH'),
      ).toBe(true);
    });
    expect(mock.calls[0]!.headers['X-Idempotency-Scope']).toBe('draft.selection.patch');
  });

  it('非 select 步 + 有 draftId（后端建产物已落 drafts 行）→ 不打后端、诚实成功退出', async () => {
    mock = installFetchMock({ status: 200, json: { data: {} } });
    setup('import', 'd1');
    await userEvent.click(screen.getByText('保存'));
    await waitFor(() => expect(screen.getByTestId('result')).toHaveTextContent('ok'));
    // 已有 draftId = 草稿真已落库，退出是诚实成功；无独立写端点故不打后端。
    expect(mock.fn).not.toHaveBeenCalled();
    expect(screen.getByTestId('error')).toHaveTextContent('none');
  });

  it('非 select 步 + 无 draftId（尚无已落库草稿）→ 不谎报成功：返回 false + 人话退路（Codex P0-1）', async () => {
    mock = installFetchMock({ status: 200, json: { data: {} } });
    setup('import', undefined);
    await userEvent.click(screen.getByText('保存'));
    // 绝不假成功、绝不空退出：返回 false，落「先完成当前步骤」人话退路。
    await waitFor(() => expect(screen.getByTestId('result')).toHaveTextContent('false'));
    expect(mock.fn).not.toHaveBeenCalled();
    expect(screen.getByTestId('error')).toHaveTextContent(/还没生成可保存的内容/);
  });

  it('STEP③ 无 draftId → 无草稿行可写：返回 false + 人话退路（不谎报成功）', async () => {
    mock = installFetchMock({ status: 200, json: { data: {} } });
    setup('select', undefined, { mode: 'single', candidateId: 'c1' });
    await userEvent.click(screen.getByText('预置选择'));
    await userEvent.click(screen.getByText('保存'));
    await waitFor(() => expect(screen.getByTestId('result')).toHaveTextContent('false'));
    expect(mock.fn).not.toHaveBeenCalled();
    expect(screen.getByTestId('error')).toHaveTextContent(/还没生成可保存的内容/);
  });

  it('STEP③ 有 draftId 无 selection → 不空打后端、诚实成功（草稿行已存在，空选非合法草稿）', async () => {
    mock = installFetchMock({ status: 200, json: { data: {} } });
    setup('select', 'd1');
    await userEvent.click(screen.getByText('保存'));
    await waitFor(() => expect(screen.getByTestId('result')).toHaveTextContent('ok'));
    expect(mock.fn).not.toHaveBeenCalled();
    expect(screen.getByTestId('error')).toHaveTextContent('none');
  });

  it('保存失败 → error 落人话（不裸崩、不裸露 code）', async () => {
    mock = installFetchMock({
      status: 400,
      json: {
        error: {
          userMessage: '选择内容格式不对，重选一下再保存。',
          retriable: false,
          action: 'change_input',
          traceId: 't',
        },
      },
    });
    setup('select', 'd1', { mode: 'single', candidateId: 'c1' });
    await userEvent.click(screen.getByText('预置选择'));
    await userEvent.click(screen.getByText('保存'));
    await waitFor(() =>
      expect(screen.getByTestId('error')).toHaveTextContent('选择内容格式不对，重选一下再保存。'),
    );
  });
});

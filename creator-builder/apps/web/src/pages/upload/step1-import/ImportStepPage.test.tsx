// F-10 STEP① 容器集成测试（mock fetch + SSE）：空态→铸码→配对；深链 ?jobId= → SSE 加载→完成；
// 取消回空态；底栏注册「下一步：提取能力项 →」带 snapshotId；两次失败 markStepError('import')。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { WizardProvider, useWizard, WizardFooter } from '../../wizard/index.js';
import { ImportStepPage } from './ImportStepPage.js';
import { installFetchMock, type FetchMock } from '../../../test/mockFetch.js';
import { __setFetchEventSourceForTests } from '../../../api/useSSE.js';
import {
  MockFetchEventSource,
  type MockSSEConnection,
} from '../../../test/mockFetchEventSource.js';

function PathProbe() {
  const loc = useLocation();
  return <span data-testid="path">{`${loc.pathname}${loc.search}`}</span>;
}

/** 底栏探针：容器自身不渲染底栏（在 WizardShell 内），测试补一个以点「下一步」主按钮 + 验摘要前缀（导入-17）。 */
function FooterProbe() {
  const { currentStep, primaryAction, summaryPrefix } = useWizard();
  return (
    <WizardFooter
      currentStep={currentStep}
      primaryAction={primaryAction}
      summaryPrefix={summaryPrefix}
    />
  );
}

/** 步骤异常态探针（断 markStepError('import')）。 */
function StepErrorProbe() {
  const { stepErrors } = useWizard();
  return <span data-testid="import-err">{stepErrors.import ? 'yes' : 'no'}</span>;
}

/** 当前 draftId 探针（断 bootstrap 后 draftId 贯穿进 WizardContext）。 */
function DraftIdProbe() {
  const { draftId } = useWizard();
  return <span data-testid="ctx-draft">{draftId ?? 'none'}</span>;
}

function renderPage(initialPath: string, draftId?: string | undefined) {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <WizardProvider initialStep="import" initialDraftId={draftId ?? undefined}>
        <Routes>
          <Route
            path="/create/import"
            element={
              <>
                <PathProbe />
                <StepErrorProbe />
                <DraftIdProbe />
                <ImportStepPage />
                <FooterProbe />
              </>
            }
          />
          <Route path="/create/extract" element={<PathProbe />} />
        </Routes>
      </WizardProvider>
    </MemoryRouter>,
  );
}

function conn(): MockSSEConnection {
  const c = MockFetchEventSource.last;
  if (!c) throw new Error('no SSE connection');
  return c;
}

let mock: FetchMock;
let restoreFes: () => void;
beforeEach(() => {
  MockFetchEventSource.reset();
  restoreFes = __setFetchEventSourceForTests(MockFetchEventSource.impl);
});
afterEach(() => {
  restoreFes();
  mock?.restore();
  vi.restoreAllMocks();
});

describe('ImportStepPage', () => {
  it('空态 → 点「开始导入」铸码 → 进配对态展示命令框', async () => {
    mock = installFetchMock([
      // createPair
      {
        status: 200,
        json: {
          data: {
            pairId: 'p1',
            pairingCode: '123456',
            command: 'cmd',
            curlOneLiner: 'curl -fsSL agora.app/import | sh',
            expiresAt: '2026-06-17T01:00:00Z',
          },
        },
      },
      // 轮询：waiting（保持配对态）
      { status: 200, json: { data: { pairId: 'p1', phase: 'waiting' } } },
    ]);
    // 已有 draftId（续传/已 bootstrap）：不再建草稿，直接测铸码→配对。
    renderPage('/create/import', 'd1');
    await userEvent.click(screen.getByRole('button', { name: '开始导入 →' }));
    await waitFor(() =>
      expect(screen.getByText('在你电脑的终端里运行这行命令')).toBeInTheDocument(),
    );
    // 铸码用写命令 scope。
    const pairCall = mock.calls.find(
      (c) => c.url.includes('/import/connect/pair') && c.method === 'POST',
    );
    expect(pairCall?.headers['X-Idempotency-Scope']).toBe('import.connect.pair');
  });

  it('深链 ?jobId= → SSE 加载（进度量化文案）→ done → 完成态（统计四格）', async () => {
    mock = installFetchMock([
      // fetchSnapshot
      {
        status: 200,
        json: {
          data: {
            id: 'snap1',
            ownerUserId: 'u1',
            source: 'mixed',
            sources: ['claude', 'codex'],
            stats: {
              segmentCount: 215,
              messageCount: 8420,
              timeSpan: { from: '2026.03', to: '2026.06' },
              projectCount: 14,
            },
            redaction: { applied: true, totalRedactions: 0, byCategory: [], rulesetVersion: 'v1' },
            createdAt: '2026-06-17T00:00:00Z',
          },
        },
      },
      // fetchSnapshotSegments
      {
        status: 200,
        json: {
          data: [
            {
              segmentId: 's1',
              dateLabel: '03-20',
              title: '保单条款梳理',
              messageCount: 42,
              readOnly: true,
            },
          ],
          meta: { page: { hasMore: false, nextCursor: null, limit: 30, order: 'desc' } },
        },
      },
    ]);
    renderPage('/create/import?jobId=job1');
    // SSE 建流 → open → progress 帧
    act(() => conn().open());
    act(() =>
      conn().emit(
        'progress',
        { percent: 50, phrase: '50% · 已抓取 100 / 200 段会话' },
        { id: '1-0' },
      ),
    );
    await waitFor(() =>
      expect(screen.getByText(/50% · 已抓取 100 \/ 200 段会话/)).toBeInTheDocument(),
    );
    // done(成功) 带 snapshotId → 取快照进完成态
    act(() =>
      conn().emit('done', { status: 'completed', result: { snapshotId: 'snap1' } }, { id: '2-0' }),
    );
    await waitFor(() =>
      expect(screen.getByText('已导入全部对话历史（Claude + Codex）')).toBeInTheDocument(),
    );
    // §5.1.3 副行 + 重新导入入口（导入-13）。
    expect(screen.getByText('生成了一份原始数据，下一步从中提取能力项')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重新导入' })).toBeInTheDocument();
    expect(screen.getByText('215')).toBeInTheDocument();
    expect(screen.getByText('8,420')).toBeInTheDocument();
  });

  it('完成态 → 底栏「下一步：提取能力项 →」带 snapshotId 进 STEP②', async () => {
    mock = installFetchMock([
      {
        status: 200,
        json: {
          data: {
            id: 'snap1',
            ownerUserId: 'u1',
            source: 'claude',
            sources: ['claude'],
            stats: { segmentCount: 1, messageCount: 1, timeSpan: null, projectCount: 0 },
            redaction: { applied: true, totalRedactions: 0, byCategory: [], rulesetVersion: 'v1' },
            createdAt: '2026-06-17T00:00:00Z',
          },
        },
      },
      {
        status: 200,
        json: {
          data: [],
          meta: { page: { hasMore: false, nextCursor: null, limit: 30, order: 'desc' } },
        },
      },
    ]);
    renderPage('/create/import?jobId=job1', 'd1');
    act(() => conn().open());
    act(() =>
      conn().emit('done', { status: 'completed', result: { snapshotId: 'snap1' } }, { id: '1-0' }),
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '下一步：提取能力项 →' })).toBeInTheDocument(),
    );
    // 导入-17：完成态底栏摘要带「原始数据仅你可见 · 」前缀（Context→Shell→Footer 全链路接通）。
    expect(screen.getByText('原始数据仅你可见 · 第 1 步，共 5 步')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '下一步：提取能力项 →' }));
    await waitFor(() =>
      expect(screen.getByTestId('path')).toHaveTextContent(
        '/create/extract?snapshotId=snap1&draftId=d1',
      ),
    );
  });

  it('加载态点「取消导入」 → 调取消端点 → 回空态', async () => {
    mock = installFetchMock({ status: 204 });
    renderPage('/create/import?jobId=job1');
    act(() => conn().open());
    act(() => conn().emit('progress', { percent: 10, phrase: '10%' }, { id: '1-0' }));
    await userEvent.click(screen.getByRole('button', { name: '取消导入' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '开始导入 →' })).toBeInTheDocument(),
    );
    const cancelCall = mock.calls.find((c) => c.url.includes('/cancel'));
    expect(cancelCall?.headers['X-Idempotency-Scope']).toBe('job.cancel');
  });

  it('SSE 两次失败 → markStepError(import)（步骤条标红，不连坐）', async () => {
    mock = installFetchMock({ status: 204 });
    renderPage('/create/import?jobId=job1');
    // 第一次失败：done 失败终态（携 error envelope）
    act(() => conn().open());
    act(() =>
      conn().emit(
        'done',
        {
          status: 'failed',
          error: {
            error: {
              userMessage: '上传中断了，续传或重新导入。',
              retriable: true,
              action: 'retry',
              traceId: 't',
            },
          },
        },
        { id: '1-0' },
      ),
    );
    await waitFor(() =>
      expect(screen.getByText('上传中断了，续传或重新导入。')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('import-err')).toHaveTextContent('no'); // 一次失败不标红
    // 点重试 → remount 新流；第二次又失败 → 标红
    await userEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(MockFetchEventSource.connections.length).toBeGreaterThan(1));
    act(() => conn().open());
    act(() =>
      conn().emit(
        'done',
        {
          status: 'failed',
          error: {
            error: { userMessage: '又失败了。', retriable: true, action: 'retry', traceId: 't2' },
          },
        },
        { id: '2-0' },
      ),
    );
    await waitFor(() => expect(screen.getByTestId('import-err')).toHaveTextContent('yes'));
  });
});

describe('ImportStepPage 草稿 bootstrap（P0-2，续传基线）', () => {
  it('全新进入（无 draftId / 无深链）→ 先 POST /drafts 建真实草稿 → draftId 贯穿 context + createPair 带上', async () => {
    mock = installFetchMock([
      // 1) bootstrap：POST /drafts → 201 真实草稿
      {
        status: 201,
        json: {
          data: {
            id: 'draft-real',
            status: 'active',
            currentStep: 'import',
            stepProgress: { percent: 0, phrase: '开始' },
            createdAt: '2026-06-17T00:00:00Z',
            updatedAt: '2026-06-17T00:00:00Z',
          },
        },
      },
      // 2) createPair（带 bootstrap 出的 draftId）
      {
        status: 200,
        json: {
          data: {
            pairId: 'p1',
            pairingCode: '123456',
            command: 'cmd',
            curlOneLiner: 'curl -fsSL agora.app/import | sh',
            expiresAt: '2026-06-17T01:00:00Z',
          },
        },
      },
      // 3) 轮询 waiting
      { status: 200, json: { data: { pairId: 'p1', phase: 'waiting' } } },
    ]);
    renderPage('/create/import'); // 无 draftId、无深链 → 应 bootstrap
    // bootstrap 拿到真实 draftId 贯穿 context。
    await waitFor(() => expect(screen.getByTestId('ctx-draft')).toHaveTextContent('draft-real'));
    // 第一次调用是 POST /drafts（scope=draft.create）。
    const draftCall = mock.calls.find((c) => c.url.endsWith('/drafts') && c.method === 'POST');
    expect(draftCall).toBeTruthy();
    expect(draftCall?.headers['X-Idempotency-Scope']).toBe('draft.create');
    // 草稿就绪后点开始导入 → 铸码带 draftId。
    await userEvent.click(screen.getByRole('button', { name: '开始导入 →' }));
    await waitFor(() => {
      const pairCall = mock.calls.find(
        (c) => c.url.includes('/import/connect/pair') && c.method === 'POST',
      );
      expect(pairCall).toBeTruthy();
      expect(pairCall?.body).toEqual({ draftId: 'draft-real' });
    });
  });

  it('深链 ?jobId=（续传/回看）→ 不 bootstrap（不空建草稿、不打 POST /drafts）', async () => {
    mock = installFetchMock({ status: 204 });
    renderPage('/create/import?jobId=job1'); // 有深链 → 续传，不该建草稿
    act(() => conn().open());
    act(() => conn().emit('progress', { percent: 10, phrase: '10%' }, { id: '1-0' }));
    await waitFor(() => expect(screen.getByText(/10%/)).toBeInTheDocument());
    // 未打 POST /drafts。
    expect(mock.calls.some((c) => c.url.endsWith('/drafts') && c.method === 'POST')).toBe(false);
    expect(screen.getByTestId('ctx-draft')).toHaveTextContent('none');
  });

  it('bootstrap 失败 → 就地 ErrorState + 重试（永不裸错；不暴露 code）', async () => {
    mock = installFetchMock([
      // bootstrap 失败
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
      // 重试成功
      {
        status: 201,
        json: {
          data: {
            id: 'draft-2',
            status: 'active',
            currentStep: 'import',
            stepProgress: { percent: 0, phrase: '开始' },
            createdAt: '2026-06-17T00:00:00Z',
            updatedAt: '2026-06-17T00:00:00Z',
          },
        },
      },
    ]);
    renderPage('/create/import');
    await waitFor(() => expect(screen.getByText('新建草稿没成功，请重试。')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(screen.getByTestId('ctx-draft')).toHaveTextContent('draft-2'));
  });
});

// F-11 STEP② 容器集成测试（mock fetch + SSE）：触发→逐个浮现→done→结果批量选择；
// 底栏随勾选数变「下一步：批量处理已选 N 项 →」带 extractJobId 进 STEP③；失败行重试新流回填不阻塞。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { WizardProvider, useWizard, WizardFooter } from '../../wizard/index.js';
import { ExtractStepPage } from './ExtractStepPage.js';
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
function FooterProbe() {
  const { currentStep, primaryAction } = useWizard();
  return <WizardFooter currentStep={currentStep} primaryAction={primaryAction} />;
}
/** 选择态探针：把向导 selection 序列化出来，断言 STEP② 进 STEP③ 写的子集/单选形态（mode + ids）。 */
function SelectionProbe() {
  const { selection } = useWizard();
  return <span data-testid="selection">{selection ? JSON.stringify(selection) : 'none'}</span>;
}

function renderPage(initialPath: string, draftId = 'd1') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <WizardProvider initialStep="extract" initialDraftId={draftId}>
        <Routes>
          <Route
            path="/create/extract"
            element={
              <>
                <PathProbe />
                <ExtractStepPage />
                <FooterProbe />
              </>
            }
          />
          <Route
            path="/create/select"
            element={
              <>
                <PathProbe />
                <SelectionProbe />
              </>
            }
          />
          <Route path="/create/import" element={<PathProbe />} />
        </Routes>
      </WizardProvider>
    </MemoryRouter>,
  );
}

/** 取第 n 条 SSE 连接（萃取流 / 重试流）。 */
function connAt(i: number): MockSSEConnection {
  const c = MockFetchEventSource.connections[i];
  if (!c) throw new Error(`no SSE connection at ${i}`);
  return c;
}
function lastConn(): MockSSEConnection {
  const c = MockFetchEventSource.last;
  if (!c) throw new Error('no SSE connection');
  return c;
}

function candidateJson(over: Record<string, unknown> = {}) {
  return {
    id: 'c1',
    extractJobId: 'j1',
    snapshotId: 's1',
    status: 'ready',
    name: '短视频脚本生成器',
    intent: '按选题生成口播脚本',
    slug: 'svs',
    type: 'recurring',
    confidence: 'high',
    segmentCount: 9,
    frequencyRatio: 0.6,
    reusability: null,
    scopeCoherence: 0.74,
    splitSuggested: null,
    scope: null,
    error: null,
    retryCount: 0,
    createdAt: '2026-06-10T00:00:00Z',
    ...over,
  };
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

describe('ExtractStepPage', () => {
  it('?snapshotId= → 触发萃取(scope=extract.create) → SSE 逐个浮现 → done 拉候选进结果态', async () => {
    mock = installFetchMock([
      // createExtractJob
      {
        status: 202,
        json: {
          data: {
            jobId: 'j1',
            snapshotId: 's1',
            status: 'queued',
            eventsUrl: '/api/v1/jobs/j1/events',
          },
        },
      },
      // done 后 fetchCandidates
      {
        status: 200,
        json: {
          data: [candidateJson()],
          meta: {
            page: { hasMore: false, nextCursor: null, limit: 50, order: 'asc' },
            confidenceSummary: { high: 1, med: 0, low: 0 },
          },
        },
      },
    ]);
    renderPage('/create/extract?snapshotId=s1'); // 向导 draftId=d1（WizardProvider initialDraftId）
    // 触发萃取注入 scope + body 串真实 draftId（端到端：后端据它同事务回填 drafts.extract_job_id，续传回断点，P0）。
    await waitFor(() => {
      const call = mock.calls.find((c) => c.url.includes('/snapshots/s1/extract'));
      expect(call?.headers['X-Idempotency-Scope']).toBe('extract.create');
      // 反向破坏守门：退回「空 body 不传 draftId」即此断言测红（fresh flow 萃取后续传缺 extractJobId）。
      expect(call?.body).toEqual({ draftId: 'd1' });
    });
    // SSE 建流 → open → progress + item-appended 逐个浮现。
    await waitFor(() => expect(MockFetchEventSource.connections.length).toBe(1));
    act(() => lastConn().open());
    act(() =>
      lastConn().emit(
        'progress',
        { percent: 50, phrase: '已识别 1 / 1 能力项…', done: 1, total: 1 },
        { id: '1-0' },
      ),
    );
    act(() =>
      lastConn().emit(
        'item-appended',
        {
          item: {
            id: 'c1',
            status: 'ready',
            isNew: true,
            name: '短视频脚本生成器',
            type: 'recurring',
            confidence: 'high',
            segmentCount: 9,
          },
        },
        { id: '2-0' },
      ),
    );
    await waitFor(() => expect(screen.getByText('短视频脚本生成器')).toBeInTheDocument());
    expect(screen.getByText(/已浮现 1 \/ 1/)).toBeInTheDocument();
    // done → 拉候选进结果态（批量选择列表 + 置信分布）。
    act(() =>
      lastConn().emit(
        'done',
        {
          status: 'completed',
          result: {
            candidateCount: 1,
            readyCount: 1,
            failedCount: 0,
            analyzedSegments: 215,
            degraded: false,
          },
        },
        { id: '3-0' },
      ),
    );
    await waitFor(() => expect(screen.getByText(/已分析 215 段原始数据/)).toBeInTheDocument());
    expect(screen.getByRole('checkbox')).toBeInTheDocument();
  });

  it('结果态勾选 → 底栏「下一步：批量处理已选 N 项 →」带 extractJobId 进 STEP③', async () => {
    mock = installFetchMock([
      {
        status: 202,
        json: { data: { jobId: 'j1', snapshotId: 's1', status: 'queued', eventsUrl: '/x' } },
      },
      {
        status: 200,
        json: {
          data: [candidateJson(), candidateJson({ id: 'c2', name: 'VC 拷打模拟器' })],
          meta: {
            page: { hasMore: false, nextCursor: null, limit: 50, order: 'asc' },
            confidenceSummary: { high: 2, med: 0, low: 0 },
          },
        },
      },
    ]);
    renderPage('/create/extract?snapshotId=s1');
    await waitFor(() => expect(MockFetchEventSource.connections.length).toBe(1));
    act(() => lastConn().open());
    act(() =>
      lastConn().emit(
        'done',
        {
          status: 'completed',
          result: {
            candidateCount: 2,
            readyCount: 2,
            failedCount: 0,
            analyzedSegments: 100,
            degraded: false,
          },
        },
        { id: '1-0' },
      ),
    );
    await waitFor(() => expect(screen.getAllByRole('checkbox')).toHaveLength(2));
    // 未勾选 → 主按钮禁用。
    expect(screen.getByRole('button', { name: /已选 0 项/ })).toBeDisabled();
    // 勾两个 → 文案随勾选数变。
    await userEvent.click(screen.getAllByRole('checkbox')[0]!);
    await userEvent.click(screen.getAllByRole('checkbox')[1]!);
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: '下一步：批量处理已选 2 项 →' }),
      ).toBeInTheDocument(),
    );
    await userEvent.click(screen.getByRole('button', { name: '下一步：批量处理已选 2 项 →' }));
    await waitFor(() =>
      expect(screen.getByTestId('path')).toHaveTextContent(
        '/create/select?extractJobId=j1&draftId=d1',
      ),
    );
    // 反向破坏（Codex r6 P1）：勾 2 项写 mode='subset' candidateIds=[勾选的 2 个]，绝不写成 'all'——
    //   后端子集闸按 subset 校验 ⊆ ready 即过、不再要求 == 全 ready，故 N<total 也不 PATCH 400。
    //   若回退把多选写成 mode:'all' 此断言测红。
    expect(screen.getByTestId('selection')).toHaveTextContent(
      JSON.stringify({ mode: 'subset', candidateIds: ['c1', 'c2'] }),
    );
  });

  it('结果态只勾 1 项 → 写 mode=single（单选精确进结构化，不写子集）', async () => {
    mock = installFetchMock([
      {
        status: 202,
        json: { data: { jobId: 'j1', snapshotId: 's1', status: 'queued', eventsUrl: '/x' } },
      },
      {
        status: 200,
        json: {
          data: [candidateJson(), candidateJson({ id: 'c2', name: 'VC 拷打模拟器' })],
          meta: {
            page: { hasMore: false, nextCursor: null, limit: 50, order: 'asc' },
            confidenceSummary: { high: 2, med: 0, low: 0 },
          },
        },
      },
    ]);
    renderPage('/create/extract?snapshotId=s1');
    await waitFor(() => expect(MockFetchEventSource.connections.length).toBe(1));
    act(() => lastConn().open());
    act(() =>
      lastConn().emit(
        'done',
        {
          status: 'completed',
          result: {
            candidateCount: 2,
            readyCount: 2,
            failedCount: 0,
            analyzedSegments: 100,
            degraded: false,
          },
        },
        { id: '1-0' },
      ),
    );
    await waitFor(() => expect(screen.getAllByRole('checkbox')).toHaveLength(2));
    // 只勾 1 项 → 底栏「批量处理已选 1 项」，进 STEP③ 写 single（不是 subset 单元素）。
    await userEvent.click(screen.getAllByRole('checkbox')[0]!);
    await userEvent.click(screen.getByRole('button', { name: '下一步：批量处理已选 1 项 →' }));
    await waitFor(() =>
      expect(screen.getByTestId('selection')).toHaveTextContent(
        JSON.stringify({ mode: 'single', candidateId: 'c1' }),
      ),
    );
  });

  it('失败行重试 → 新 retryJob 流回填原地替换为正常卡（不阻塞其它，B-23）', async () => {
    mock = installFetchMock([
      // createExtractJob
      {
        status: 202,
        json: { data: { jobId: 'j1', snapshotId: 's1', status: 'queued', eventsUrl: '/x' } },
      },
      // done 后 fetchCandidates：一个 ready + 一个 failed
      {
        status: 200,
        json: {
          data: [
            candidateJson(),
            candidateJson({
              id: 'cf',
              status: 'failed',
              name: '保单条款比对器',
              confidence: null,
              type: null,
              segmentCount: null,
              error: {
                userMessage: '这一项没能识别出来，可点重试。',
                retriable: true,
                action: 'retry',
                traceId: 't',
              },
            }),
          ],
          meta: {
            page: { hasMore: false, nextCursor: null, limit: 50, order: 'asc' },
            confidenceSummary: { high: 1, med: 0, low: 0 },
          },
        },
      },
      // retryCandidate → 新 retryJob
      {
        status: 202,
        json: {
          data: {
            candidateId: 'cf',
            extractJobId: 'j1',
            retryJobId: 'rj1',
            status: 'generating',
            retryCount: 1,
            eventsUrl: '/api/v1/jobs/rj1/events',
          },
        },
      },
    ]);
    renderPage('/create/extract?snapshotId=s1');
    await waitFor(() => expect(MockFetchEventSource.connections.length).toBe(1));
    act(() => connAt(0).open());
    act(() =>
      connAt(0).emit(
        'done',
        {
          status: 'completed',
          result: {
            candidateCount: 2,
            readyCount: 1,
            failedCount: 1,
            analyzedSegments: 100,
            degraded: false,
          },
        },
        { id: '1-0' },
      ),
    );
    await waitFor(() => expect(screen.getByText('保单条款比对器')).toBeInTheDocument());
    expect(screen.getByText(/这一项没能识别出来/)).toBeInTheDocument();
    // 点失败行「重试」→ POST retry（scope=candidate.retry）→ 挂新 retryJob 流。
    await userEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => {
      const retryCall = mock.calls.find((c) => c.url.includes('/candidates/cf/retry'));
      expect(retryCall?.headers['X-Idempotency-Scope']).toBe('candidate.retry');
    });
    // 新 retryJob 流建立（第 2 条连接）。
    await waitFor(() => expect(MockFetchEventSource.connections.length).toBe(2));
    act(() => connAt(1).open());
    // 回填成功帧（同 candidateId，status ready）→ 原地替换为正常卡。
    act(() =>
      connAt(1).emit(
        'item-appended',
        {
          item: {
            id: 'cf',
            status: 'ready',
            isNew: false,
            name: '保单条款比对器',
            type: 'occasional',
            confidence: 'low',
            segmentCount: 6,
            error: null,
          },
        },
        { id: 'r1-0' },
      ),
    );
    await waitFor(() => expect(screen.getByText('置信 低')).toBeInTheDocument());
    // 失败副文消失（已替换为正常卡）。
    expect(screen.queryByText(/这一项没能识别出来/)).not.toBeInTheDocument();
    // 正常候选未受影响（不阻塞其它）。
    expect(screen.getByText('短视频脚本生成器')).toBeInTheDocument();
  });
});

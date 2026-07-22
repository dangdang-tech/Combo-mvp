import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useEffect } from 'react';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { WizardProvider, useWizard } from '../../wizard/index.js';
import { CapabilitiesStepPage } from './CapabilitiesStepPage.js';
import { __setOpenRuntimeTrialForTests, __setOpenTrialLoginForTests } from './trialApi.js';
import { installFetchMock, type FetchMock } from '../../../test/mockFetch.js';
import { __setFetchEventSourceForTests } from '../../../api/useSSE.js';
import {
  MockFetchEventSource,
  type MockSSEConnection,
} from '../../../test/mockFetchEventSource.js';

function renderPage(
  initialPath = '/create/capabilities?snapshotId=s1',
  draftId = 'd1',
  opts: {
    snapshotId?: string;
    extractJobId?: string;
    batchId?: string;
    selectionCandidateId?: string;
    versionId?: string;
    capabilityId?: string;
  } = {},
) {
  function SelectionSeed({ candidateId }: { candidateId: string }) {
    const { setSelection } = useWizard();
    useEffect(() => {
      setSelection({ mode: 'single', candidateId });
    }, [candidateId, setSelection]);
    return null;
  }

  function LocationProbe() {
    const location = useLocation();
    const { selection, agentReady, publishCompleted } = useWizard();
    return (
      <>
        <span data-testid="path">{`${location.pathname}${location.search}`}</span>
        <span data-testid="selection">
          {selection?.mode === 'single' ? selection.candidateId : 'none'}
        </span>
        <span data-testid="agent-ready">{agentReady ? 'ready' : 'pending'}</span>
        <span data-testid="publish-completed">{publishCompleted ? 'done' : 'pending'}</span>
      </>
    );
  }

  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <WizardProvider
        initialStep="capabilities"
        initialDraftId={draftId}
        initialSnapshotId={opts.snapshotId}
        initialExtractJobId={opts.extractJobId}
        initialVersionId={opts.versionId}
        initialCapabilityId={opts.capabilityId}
        initialBatchId={opts.batchId}
      >
        {opts.selectionCandidateId && <SelectionSeed candidateId={opts.selectionCandidateId} />}
        <LocationProbe />
        <Routes>
          <Route path="/create/capabilities" element={<CapabilitiesStepPage />} />
          <Route path="/a/:slug" element={<span data-testid="market">market</span>} />
        </Routes>
      </WizardProvider>
    </MemoryRouter>,
  );
}

function connectionFor(fragment: string): MockSSEConnection {
  const connection = MockFetchEventSource.connections.find((item) => item.url.includes(fragment));
  if (!connection) throw new Error(`no SSE connection containing ${fragment}`);
  return connection;
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
    reusability: 0.82,
    scopeCoherence: 0.74,
    splitSuggested: null,
    scope: null,
    error: null,
    retryCount: 0,
    trialCapability: { capabilityId: 'cap1', versionId: 'v1', slug: 'svs' },
    createdAt: '2026-06-10T00:00:00Z',
    ...over,
  };
}

function candidateResponse(candidates: Record<string, unknown>[]) {
  return {
    status: 200,
    json: {
      data: candidates,
      meta: {
        page: { hasMore: false, nextCursor: null, limit: 50, order: 'asc' },
        confidenceSummary: { high: candidates.length, med: 0, low: 0 },
      },
    },
  };
}

function runtimeDetail(
  over: {
    sessionId?: string;
    sessionCapabilityId?: string;
    viewCapabilityId?: string;
    sessionVersion?: string;
    viewVersion?: string;
    messages?: unknown[];
    artifacts?: unknown[];
  } = {},
) {
  const sessionId = over.sessionId ?? 'rt1';
  const sessionCapabilityId = over.sessionCapabilityId ?? 'cap1';
  const viewCapabilityId = over.viewCapabilityId ?? 'cap1';
  return {
    session: {
      id: sessionId,
      capabilityId: sessionCapabilityId,
      slug: 'svs',
      version: over.sessionVersion ?? '0.1.0',
      mode: 'trial',
      title: '短视频脚本生成器 试用',
      createdAt: '2026-06-10T00:00:00Z',
      updatedAt: '2026-06-10T00:01:00Z',
    },
    capability: {
      capabilityId: viewCapabilityId,
      slug: 'svs',
      version: over.viewVersion ?? '0.1.0',
      status: 'draft',
      name: '短视频脚本生成器',
      tagline: '把选题变成脚本',
      description: '按选题生成口播脚本',
      inputs: { fields: [] },
      output: { type: 'text' },
      boundaries: { riskLevel: 'low', redLines: [] },
      starterPrompts: [],
    },
    messages: over.messages ?? [
      {
        id: 'm1',
        runId: 'run1',
        seq: 1,
        role: 'assistant',
        text: '这是已经完成的真实结果。',
        artifacts: [],
        createdAt: '2026-06-10T00:01:00Z',
      },
    ],
    artifacts: over.artifacts ?? [],
  };
}

function latestTrialResponse(
  detail: ReturnType<typeof runtimeDetail> | null = null,
  verified = false,
) {
  return {
    status: 200,
    json: { session: detail?.session ?? null, verified },
  };
}

function preparedCapabilityResponse(capabilityId = 'cap1', versionId = 'v1', slug = 'svs') {
  return {
    status: 201,
    json: {
      data: {
        capabilityId,
        versionId,
        slug,
        version: '0.1.0',
        manifest: {},
        structureState: { fields: [], totalCount: 0, doneCount: 0 },
      },
    },
  };
}

const extractAccepted = {
  status: 202,
  json: { data: { jobId: 'j1', snapshotId: 's1', status: 'queued', eventsUrl: '/x' } },
};

const extractDone = {
  status: 'completed',
  result: {
    candidateCount: 2,
    readyCount: 2,
    failedCount: 0,
    analyzedSegments: 215,
    degraded: false,
  },
};

async function finishExtract(): Promise<void> {
  await waitFor(() => expect(MockFetchEventSource.connections.length).toBeGreaterThan(0));
  const connection = connectionFor('/jobs/j1/events');
  act(() => connection.open());
  act(() => connection.emit('done', extractDone, { id: '1-0' }));
  await screen.findByRole('heading', { level: 1, name: '第一个 Agent 已经准备好了' });
}

function expectCapabilitiesReturnTo(trialUrl: string, candidateId = 'c1') {
  const returnTo = new URLSearchParams(trialUrl.split('?')[1]).get('returnTo');
  expect(returnTo).toBeTruthy();
  const url = new URL(returnTo!, 'http://combo.local');
  expect(url.pathname).toBe('/create/capabilities');
  expect(url.searchParams.get('snapshotId')).toBe('s1');
  expect(url.searchParams.get('draftId')).toBe('d1');
  expect(url.searchParams.get('extractJobId')).toBe('j1');
  expect(url.searchParams.get('candidateId')).toBe(candidateId);
  expect(url.searchParams.get('trialVersionId')).toBe('v1');
  expect(url.searchParams.get('trialVersion')).toBe('0.1.0');
}

let mock: FetchMock;
let restoreFes: () => void;
let restoreOpenTrial: (() => void) | undefined;
let restoreOpenLogin: (() => void) | undefined;

beforeEach(() => {
  MockFetchEventSource.reset();
  restoreFes = __setFetchEventSourceForTests(MockFetchEventSource.impl);
});

afterEach(() => {
  restoreFes();
  restoreOpenTrial?.();
  restoreOpenTrial = undefined;
  restoreOpenLogin?.();
  restoreOpenLogin = undefined;
  mock?.restore();
  vi.restoreAllMocks();
});

describe('CapabilitiesStepPage — real creation checkpoint', () => {
  it('提取完成后按 reusability → segmentCount → slug 排序，默认只聚焦一个 Agent', async () => {
    mock = installFetchMock([
      extractAccepted,
      candidateResponse([
        candidateJson({ id: 'failed-high', status: 'failed', reusability: 0.99, name: '失败项' }),
        candidateJson({ id: 'null-score', reusability: null, name: '无评分', slug: 'z-null' }),
        candidateJson({
          id: 'tie-z',
          reusability: 0.91,
          segmentCount: 8,
          name: '同分 Z',
          slug: 'z',
        }),
        candidateJson({
          id: 'winner',
          reusability: 0.91,
          segmentCount: 12,
          name: '主结果',
          slug: 'winner',
        }),
        candidateJson({
          id: 'tie-a',
          reusability: 0.91,
          segmentCount: 8,
          name: '同分 A',
          slug: 'a',
        }),
      ]),
      latestTrialResponse(),
    ]);
    renderPage();
    await finishExtract();

    expect(screen.getByTestId('agent-ready')).toHaveTextContent('ready');

    expect(screen.getByRole('heading', { level: 2, name: '主结果' })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByText(/全选/)).toBeNull();
    expect(screen.queryByRole('button', { name: /发布/ })).toBeNull();
    await waitFor(() => expect(screen.getByTestId('selection')).toHaveTextContent('winner'));

    await userEvent.click(screen.getByRole('button', { name: /查看其它 3 个结果/ }));
    const list = screen.getByRole('list', { name: '备选 Agent 列表' });
    const names = within(list)
      .getAllByRole('listitem')
      .map((item) => item.textContent ?? '');
    expect(names[0]).toContain('同分 A');
    expect(names[1]).toContain('同分 Z');
    expect(names[2]).toContain('无评分');
    expect(names[3]).toContain('失败项');
  });

  it('结果页不再重复渲染创作流程条，由 WizardShell 单一承载', async () => {
    mock = installFetchMock([
      extractAccepted,
      candidateResponse([candidateJson()]),
      latestTrialResponse(),
    ]);
    renderPage();
    await finishExtract();

    expect(screen.queryByRole('list', { name: '创作进度' })).toBeNull();
    expect(screen.getByRole('heading', { name: '第一个 Agent 已经准备好了' })).toBeInTheDocument();
  });

  it('从草稿恢复时优先使用已持久化的单选 candidate，并查询该版本的历史试用', async () => {
    const secondSession = runtimeDetail({
      sessionId: 'rt2',
      sessionCapabilityId: 'cap2',
      viewCapabilityId: 'cap2',
    });
    mock = installFetchMock([
      extractAccepted,
      candidateResponse([
        candidateJson({ reusability: 0.95 }),
        candidateJson({
          id: 'c2',
          name: '草稿选择的 Agent',
          slug: 'chosen',
          reusability: 0.4,
          trialCapability: { capabilityId: 'cap2', versionId: 'v2', slug: 'chosen' },
        }),
      ]),
      latestTrialResponse(secondSession, true),
      preparedCapabilityResponse('cap2', 'v2', 'chosen'),
    ]);

    renderPage('/create/capabilities?snapshotId=s1', 'd1', { selectionCandidateId: 'c2' });
    await finishExtract();

    expect(screen.getByRole('heading', { level: 2, name: '草稿选择的 Agent' })).toBeInTheDocument();
    await waitFor(() =>
      expect(
        mock.calls.some((call) => call.url.includes('/trial-chains/cap2/latest-session')),
      ).toBe(true),
    );
    expect(screen.getByRole('button', { name: '发布这个 Agent →' })).toBeEnabled();
  });

  it('真实试用入口保留完整创作上下文并锁定当前 candidate', async () => {
    const openTrial = vi.fn();
    restoreOpenTrial = __setOpenRuntimeTrialForTests(openTrial);
    mock = installFetchMock([
      extractAccepted,
      candidateResponse([candidateJson()]),
      latestTrialResponse(),
      preparedCapabilityResponse(),
      {
        status: 201,
        json: {
          session: runtimeDetail().session,
          capability: runtimeDetail().capability,
        },
      },
    ]);
    renderPage();
    await finishExtract();

    await userEvent.click(screen.getByRole('button', { name: '用真实任务试一次 →' }));

    await waitFor(() => expect(openTrial).toHaveBeenCalledOnce());
    const trialUrl = openTrial.mock.calls[0]![0] as string;
    expect(trialUrl).toContain('/try/session/rt1');
    expectCapabilitiesReturnTo(trialUrl);
    expect(
      mock.calls.find(
        (call) => call.url.includes('/runtime/trial-chains') && call.method === 'POST',
      )?.body,
    ).toEqual({ versionId: 'v1', title: '短视频脚本生成器 试用' });
    expect(mock.calls.find((call) => call.url === '/api/v1/capabilities')?.body).toEqual({
      sourceCandidateId: 'c1',
      draftId: 'd1',
    });
  });

  it('试用时会话过期直接跳登录，并保留 context 里的任务与当前 Agent', async () => {
    const openLogin = vi.fn();
    restoreOpenLogin = __setOpenTrialLoginForTests(openLogin);
    mock = installFetchMock([
      candidateResponse([candidateJson()]),
      latestTrialResponse(),
      preparedCapabilityResponse(),
      {
        status: 401,
        json: {
          error: {
            userMessage: '登录态失效了，请重新登录。',
            retriable: false,
            action: 'escalate',
            traceId: 'auth-trace',
          },
        },
      },
      {
        status: 401,
        json: {
          error: {
            userMessage: '登录态失效了，请重新登录。',
            retriable: false,
            action: 'escalate',
            traceId: 'me-auth-trace',
          },
        },
      },
    ]);
    renderPage('/create/capabilities?snapshotId=s1', 'd1', { extractJobId: 'j1' });
    await finishExtract();

    await userEvent.click(screen.getByRole('button', { name: '用真实任务试一次 →' }));

    await waitFor(() => expect(openLogin).toHaveBeenCalledOnce());
    const loginUrl = new URL(openLogin.mock.calls[0]![0] as string, 'http://combo.local');
    const returnTo = new URL(loginUrl.searchParams.get('returnTo')!, 'http://combo.local');
    expect(loginUrl.pathname).toBe('/api/v1/auth/login');
    expect(returnTo.pathname).toBe('/create/capabilities');
    expect(returnTo.searchParams.get('snapshotId')).toBe('s1');
    expect(returnTo.searchParams.get('draftId')).toBe('d1');
    expect(returnTo.searchParams.get('extractJobId')).toBe('j1');
    expect(returnTo.searchParams.get('candidateId')).toBe('c1');
    expect(returnTo.searchParams.get('trialVersionId')).toBe('v1');
    expect(screen.queryByText('登录态失效了，请重新登录。')).toBeNull();
  });

  it('Runtime 401 但 Authoring 仍已登录时不循环跳登录，显示试用服务异常', async () => {
    const openLogin = vi.fn();
    restoreOpenLogin = __setOpenTrialLoginForTests(openLogin);
    mock = installFetchMock([
      candidateResponse([candidateJson()]),
      latestTrialResponse(),
      preparedCapabilityResponse(),
      {
        status: 401,
        json: {
          error: {
            userMessage: '登录态失效了，请重新登录。',
            retriable: false,
            action: 'escalate',
            traceId: 'runtime-auth-trace',
          },
        },
      },
      {
        status: 200,
        json: {
          data: {
            id: 'user-1',
            logtoUserId: 'sub-1',
            account: 'Wayne',
            email: 'wayne@example.com',
            roles: ['creator'],
            status: 'active',
            hasProfile: true,
            creatorId: 'user-1',
            createdAt: '2026-01-01T00:00:00.000Z',
            lastLoginAt: null,
          },
        },
      },
    ]);
    renderPage('/create/capabilities?snapshotId=s1', 'd1', { extractJobId: 'j1' });
    await finishExtract();

    await userEvent.click(screen.getByRole('button', { name: '用真实任务试一次 →' }));

    expect(
      await screen.findByText('试用服务暂时无法确认登录状态，请稍后重试。'),
    ).toBeInTheDocument();
    expect(openLogin).not.toHaveBeenCalled();
    expect(screen.queryByText('登录态失效了，请重新登录。')).toBeNull();
  });

  it('旧候选先建版并完成 structure SSE 后，再打开真实 runtime session', async () => {
    const openTrial = vi.fn();
    restoreOpenTrial = __setOpenRuntimeTrialForTests(openTrial);
    mock = installFetchMock([
      extractAccepted,
      candidateResponse([candidateJson({ trialCapability: undefined })]),
      {
        status: 201,
        json: {
          data: {
            capabilityId: 'cap1',
            versionId: 'v1',
            slug: 'svs',
            version: '0.1.0',
            manifest: {},
            structureState: { fields: [], totalCount: 0, doneCount: 0 },
          },
        },
      },
      { status: 202, json: { data: { jobId: 'sj1', eventsUrl: '/structure/sj1' } } },
      {
        status: 201,
        json: { session: runtimeDetail().session, capability: runtimeDetail().capability },
      },
    ]);
    renderPage();
    await finishExtract();
    await userEvent.click(screen.getByRole('button', { name: '用真实任务试一次 →' }));

    await waitFor(() => expect(MockFetchEventSource.connections.length).toBe(2));
    const structure = connectionFor('/structure/sj1');
    act(() => structure.open());
    act(() => structure.emit('done', { status: 'completed' }, { id: 's-1' }));

    await waitFor(() => expect(openTrial).toHaveBeenCalledOnce());
    expectCapabilitiesReturnTo(openTrial.mock.calls[0]![0] as string);
  });

  it('回流后仅凭匹配的 trial session + 已落库 assistant 输出解锁发布', async () => {
    mock = installFetchMock([
      extractAccepted,
      candidateResponse([candidateJson()]),
      latestTrialResponse(runtimeDetail(), true),
      preparedCapabilityResponse(),
    ]);
    renderPage(
      '/create/capabilities?snapshotId=s1&draftId=d1&candidateId=c1&trialVersionId=v1&trialVersion=0.1.0&tested=cap1&session=rt1',
    );
    await finishExtract();

    expect(await screen.findByText(/上次试用已保存/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '发布这个 Agent →' })).toBeEnabled();
    expect(
      mock.calls.some(
        (call) =>
          call.url ===
          '/api/v1/runtime/trial-chains/cap1/latest-session?versionId=v1&sessionId=rt1',
      ),
    ).toBe(true);
    expect(mock.calls.find((call) => call.url === '/api/v1/capabilities')?.body).toEqual({
      sourceCandidateId: 'c1',
      draftId: 'd1',
    });
    expect(screen.getByRole('button', { name: '继续试用' })).toBeEnabled();
    expect(screen.getByText('已试用')).toBeInTheDocument();
  });

  it('重开旧草稿时优先使用草稿绑定的精确版本，不被候选的最新 draft 覆盖', async () => {
    mock = installFetchMock([
      extractAccepted,
      candidateResponse([
        candidateJson({
          trialCapability: { capabilityId: 'cap-new', versionId: 'v-new', slug: 'svs' },
        }),
      ]),
      latestTrialResponse(runtimeDetail({ sessionCapabilityId: 'cap-old' }), true),
    ]);
    renderPage('/create/capabilities?snapshotId=s1', 'd1', {
      selectionCandidateId: 'c1',
      capabilityId: 'cap-old',
      versionId: 'v-old',
    });
    await finishExtract();

    expect(await screen.findByText(/上次试用已保存/)).toBeInTheDocument();
    expect(
      mock.calls.some(
        (call) =>
          call.url === '/api/v1/runtime/trial-chains/cap-old/latest-session?versionId=v-old',
      ),
    ).toBe(true);
    expect(mock.calls.some((call) => call.url === '/api/v1/capabilities')).toBe(false);
  });

  it.each([
    ['session capability 不匹配', runtimeDetail({ sessionCapabilityId: 'other' })],
    ['session version 不匹配', runtimeDetail({ sessionVersion: '0.0.9' })],
  ])('%s 时不解锁发布', async (_label, detail) => {
    mock = installFetchMock([
      extractAccepted,
      candidateResponse([candidateJson()]),
      latestTrialResponse(detail, true),
    ]);
    renderPage(
      '/create/capabilities?snapshotId=s1&candidateId=c1&trialVersionId=v1&trialVersion=0.1.0&tested=cap1&session=rt1',
    );
    await finishExtract();

    expect(await screen.findByText(/这次试用与当前 Agent 不匹配/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '发布这个 Agent →' })).toBeNull();
    expect(screen.getByRole('button', { name: '重新试用这个 Agent →' })).toBeEnabled();
  });

  it('带 session 回流却找不到持久记录时明确提示重新试用', async () => {
    mock = installFetchMock([
      extractAccepted,
      candidateResponse([candidateJson()]),
      { status: 200, json: { session: null, verified: false } },
    ]);
    renderPage(
      '/create/capabilities?snapshotId=s1&candidateId=c1&trialVersionId=v1&trialVersion=0.1.0&tested=cap1&session=rt1',
    );
    await finishExtract();

    expect(await screen.findByText('没有找到这次试用记录，请重新试用。')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '发布这个 Agent →' })).toBeNull();
    expect(screen.getByRole('button', { name: '重新试用这个 Agent →' })).toBeEnabled();
  });

  it('服务端未验证完成但 session 已持久化时，只恢复继续试用入口，不解锁发布', async () => {
    const openTrial = vi.fn();
    restoreOpenTrial = __setOpenRuntimeTrialForTests(openTrial);
    mock = installFetchMock([
      extractAccepted,
      candidateResponse([candidateJson()]),
      latestTrialResponse(runtimeDetail(), false),
      preparedCapabilityResponse(),
    ]);
    renderPage('/create/capabilities?snapshotId=s1&draftId=d1');
    await finishExtract();

    expect(await screen.findByText(/上次试用还没有完成/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '发布这个 Agent →' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: '继续试用这个 Agent →' }));
    expect(openTrial).toHaveBeenCalledOnce();
    expect(openTrial.mock.calls[0]?.[0]).toContain('/try/session/rt1');
  });

  it('无回流参数时恢复服务失败，不冒充首次试用，并可原地重新恢复', async () => {
    mock = installFetchMock([
      extractAccepted,
      candidateResponse([candidateJson()]),
      {
        status: 503,
        json: {
          error: {
            userMessage: '试用记录暂时不可用。',
            retriable: true,
            action: 'retry',
            traceId: 'trial-recovery',
          },
        },
      },
      latestTrialResponse(runtimeDetail(), true),
    ]);
    renderPage('/create/capabilities?snapshotId=s1', 'd1', {
      selectionCandidateId: 'c1',
      capabilityId: 'cap1',
      versionId: 'v1',
    });
    await finishExtract();

    expect(await screen.findByText('试用记录暂时不可用。')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '用真实任务试一次 →' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: '重新恢复试用记录 →' }));
    expect(await screen.findByText(/上次试用已保存/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '发布这个 Agent →' })).toBeEnabled();
  });

  it('验证成功后只发布刚试用的 version，并把 batchId 写回续传 URL', async () => {
    mock = installFetchMock([
      extractAccepted,
      candidateResponse([
        candidateJson(),
        candidateJson({
          id: 'c2',
          name: '备选 Agent',
          slug: 'alt',
          reusability: 0.4,
          trialCapability: { capabilityId: 'cap2', versionId: 'v2', slug: 'alt' },
        }),
      ]),
      latestTrialResponse(runtimeDetail(), true),
      preparedCapabilityResponse(),
      {
        status: 202,
        json: {
          data: {
            batchId: 'b1',
            jobId: 'bj1',
            status: 'running',
            total: 1,
            processedCount: 0,
            publishedCount: 0,
            failedCount: 0,
            items: [{ itemId: 'i1', versionId: 'v1', state: 'publishing' }],
          },
        },
      },
    ]);
    renderPage(
      '/create/capabilities?snapshotId=s1&draftId=d1&candidateId=c1&trialVersionId=v1&trialVersion=0.1.0&tested=cap1&session=rt1',
    );
    await finishExtract();
    await screen.findByRole('button', { name: '发布这个 Agent →' });

    await userEvent.click(screen.getByRole('button', { name: '发布这个 Agent →' }));

    await waitFor(() => {
      const call = mock.calls.find(
        (entry) => entry.url.includes('/publish-batches') && entry.method === 'POST',
      );
      expect(call?.headers['X-Idempotency-Scope']).toBe('publish_batch.create');
      const body = call?.body as { items: Record<string, unknown>[]; draftId?: string };
      expect(body.draftId).toBe('d1');
      expect(body.items).toHaveLength(1);
      expect(body.items[0]?.versionId).toBe('v1');
      expect(body.items[0]?.candidateId).toBeUndefined();
      expect(typeof body.items[0]?.idempotencyKey).toBe('string');
    });
    await waitFor(() => expect(screen.getByTestId('path')).toHaveTextContent('batchId=b1'));

    await waitFor(() => expect(MockFetchEventSource.connections.length).toBe(2));
    const publish = connectionFor('/jobs/bj1/events');
    act(() => publish.open());
    act(() =>
      publish.emit(
        'item-appended',
        { item: { itemId: 'i1', versionId: 'v1', state: 'published' } },
        { id: 'b-1' },
      ),
    );
    expect(await screen.findByRole('link', { name: '打开已发布的 Agent →' })).toHaveAttribute(
      'href',
      '/a/svs',
    );
  });

  it('用户明确判定不符合预期后才展开第二个 Agent', async () => {
    mock = installFetchMock([
      extractAccepted,
      candidateResponse([
        candidateJson(),
        candidateJson({
          id: 'c2',
          name: '第二个 Agent',
          slug: 'second',
          reusability: 0.7,
        }),
      ]),
      latestTrialResponse(),
    ]);
    renderPage(
      '/create/capabilities?snapshotId=s1&candidateId=c1&trialVersionId=v1&trialVersion=0.1.0&failed=cap1&session=rt1',
    );
    await finishExtract();

    expect(screen.getByText(/这个结果不符合预期/)).toBeInTheDocument();
    expect(screen.getByText('第二个 Agent')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '发布这个 Agent →' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: '改用这个 →' }));
    expect(
      await screen.findByRole('heading', { level: 2, name: '第二个 Agent' }),
    ).toBeInTheDocument();
    expect(screen.getByTestId('path')).toHaveTextContent('candidateId=c2');
    expect(screen.getByTestId('path')).not.toHaveTextContent('failed=');
    expect(screen.getByTestId('path')).not.toHaveTextContent('session=');
  });

  it('runtime session 创建失败留在当前 Agent 就地重试，不误导成候选质量失败', async () => {
    const openTrial = vi.fn();
    restoreOpenTrial = __setOpenRuntimeTrialForTests(openTrial);
    mock = installFetchMock([
      extractAccepted,
      candidateResponse([candidateJson()]),
      latestTrialResponse(),
      preparedCapabilityResponse(),
      {
        status: 503,
        json: {
          error: {
            userMessage: '没能打开试用，请稍后重试。',
            retriable: true,
            action: 'retry',
            traceId: 't1',
          },
        },
      },
    ]);
    renderPage();
    await finishExtract();
    await userEvent.click(screen.getByRole('button', { name: '用真实任务试一次 →' }));

    expect(await screen.findByText('没能打开试用，请稍后重试。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重试试用 →' })).toBeEnabled();
    expect(openTrial).not.toHaveBeenCalled();
  });

  it('batchId 续传恢复精确 version 的已发布状态，不重复提交', async () => {
    mock = installFetchMock([
      {
        status: 200,
        json: {
          data: {
            batchId: 'b1',
            jobId: 'bj1',
            status: 'completed',
            total: 1,
            processedCount: 1,
            publishedCount: 1,
            failedCount: 0,
            items: [{ itemId: 'i1', versionId: 'v1', state: 'published' }],
          },
        },
      },
      // 发布后 candidates 真实查询不再返回 draft trialCapability；恢复依赖草稿精确引用。
      candidateResponse([candidateJson({ trialCapability: undefined })]),
      latestTrialResponse(runtimeDetail(), true),
    ]);
    renderPage('/create/capabilities?snapshotId=s1&extractJobId=j1&batchId=b1', 'd1', {
      selectionCandidateId: 'c1',
      capabilityId: 'cap1',
      versionId: 'v1',
    });

    await waitFor(() => expect(MockFetchEventSource.connections.length).toBeGreaterThan(0));
    const extract = connectionFor('/jobs/j1/events');
    act(() => extract.open());
    act(() => extract.emit('done', extractDone, { id: '1-0' }));

    expect(await screen.findByRole('link', { name: '打开已发布的 Agent →' })).toBeInTheDocument();
    expect(screen.getByTestId('publish-completed')).toHaveTextContent('done');
    expect(screen.getByRole('button', { name: '继续试用' })).toBeEnabled();
    expect(screen.getByText('已发布')).toBeInTheDocument();
    expect(mock.calls.some((call) => call.url.includes('/publish-batches/b1'))).toBe(true);
    expect(
      mock.calls.some((call) => call.url.includes('/publish-batches') && call.method === 'POST'),
    ).toBe(false);
  });

  it('没有可用候选时给真实空态，不展示试用或发布动作', async () => {
    mock = installFetchMock([extractAccepted, candidateResponse([])]);
    renderPage();
    await finishExtract();

    expect(screen.getByText(/没识别出可复用的能力/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /试/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /发布/ })).toBeNull();
  });
});

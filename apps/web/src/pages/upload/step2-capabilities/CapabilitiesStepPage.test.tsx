// 能力页容器集成测试（mock fetch + SSE）：提取过程态 → done 拉候选进 ready（默认全选）；
//   一键发布（每项仅 candidateId + idempotencyKey）→ 批次 SSE 逐项浮现 → 卡片状态槽 已发布 + 市集链接。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { WizardProvider } from '../../wizard/index.js';
import { CapabilitiesStepPage } from './CapabilitiesStepPage.js';
import { __setOpenRuntimeTrialForTests } from './trialApi.js';
import { installFetchMock, type FetchMock } from '../../../test/mockFetch.js';
import { __setFetchEventSourceForTests } from '../../../api/useSSE.js';
import {
  MockFetchEventSource,
  type MockSSEConnection,
} from '../../../test/mockFetchEventSource.js';

function renderPage(
  initialPath = '/create/capabilities?snapshotId=s1',
  draftId = 'd1',
  opts: { snapshotId?: string } = {},
) {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <WizardProvider
        initialStep="capabilities"
        initialDraftId={draftId}
        initialSnapshotId={opts.snapshotId}
      >
        <Routes>
          <Route path="/create/capabilities" element={<CapabilitiesStepPage />} />
          <Route path="/a/:slug" element={<span data-testid="market">market</span>} />
        </Routes>
      </WizardProvider>
    </MemoryRouter>,
  );
}

function connAt(i: number): MockSSEConnection {
  const c = MockFetchEventSource.connections[i];
  if (!c) throw new Error(`no SSE connection at ${i}`);
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
    trialCapability: { capabilityId: 'cap1', versionId: 'v1', slug: 'svs' },
    createdAt: '2026-06-10T00:00:00Z',
    ...over,
  };
}

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

let mock: FetchMock;
let restoreFes: () => void;
let restoreOpenTrial: (() => void) | undefined;
beforeEach(() => {
  MockFetchEventSource.reset();
  restoreFes = __setFetchEventSourceForTests(MockFetchEventSource.impl);
});
afterEach(() => {
  restoreFes();
  restoreOpenTrial?.();
  restoreOpenTrial = undefined;
  mock?.restore();
  vi.restoreAllMocks();
});

describe('CapabilitiesStepPage', () => {
  it('过程态 → 触发萃取(scope=extract.create) → done 拉候选进 ready（默认全选 + 信任背书段数）', async () => {
    mock = installFetchMock([
      // createExtractJob
      {
        status: 202,
        json: { data: { jobId: 'j1', snapshotId: 's1', status: 'queued', eventsUrl: '/x' } },
      },
      // fetchCandidates
      {
        status: 200,
        json: {
          data: [
            candidateJson(),
            candidateJson({ id: 'c2', name: 'VC 拷打模拟器', slug: 'vc', segmentCount: 4 }),
          ],
          meta: {
            page: { hasMore: false, nextCursor: null, limit: 50, order: 'asc' },
            confidenceSummary: { high: 2, med: 0, low: 0 },
          },
        },
      },
    ]);
    renderPage();
    // 触发萃取带 scope + draftId（后端据它同事务回填 drafts.extract_job_id）。
    await waitFor(() => {
      const call = mock.calls.find((c) => c.url.includes('/snapshots/s1/extract'));
      expect(call?.headers['X-Idempotency-Scope']).toBe('extract.create');
      expect(call?.headers['Idempotency-Key']).toBe('extract:session-mock-v1:d1:s1');
      expect(call?.body).toEqual({ draftId: 'd1' });
    });
    // 萃取 SSE（connection[0]）：open → done → 拉候选进 ready。
    await waitFor(() => expect(MockFetchEventSource.connections.length).toBe(1));
    act(() => connAt(0).open());
    act(() => connAt(0).emit('done', extractDone, { id: '1-0' }));

    await waitFor(() => expect(screen.getByText('短视频脚本生成器')).toBeInTheDocument());
    expect(screen.getByText('VC 拷打模拟器')).toBeInTheDocument();
    expect(screen.getByText('第二步 · 能力')).toBeInTheDocument();
    expect(screen.getByText('你的能力，挑选后一键发布')).toBeInTheDocument();
    expect(screen.queryByText('已入')).toBeNull();
    // 信任背书：来源 session 段数。
    expect(screen.getByText('来自 9 段 session')).toBeInTheDocument();
    expect(screen.getByText(/已分析 215 段 session/)).toBeInTheDocument();
    // 默认全选（两张卡的复选框都勾上）。
    const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
    expect(boxes).toHaveLength(2);
    expect(boxes.every((b) => b.checked)).toBe(true);
    // 一键发布可点（已选 2 项）。
    expect(screen.getByRole('button', { name: /一键发布到市集 · 2 项/ })).toBeEnabled();

    await userEvent.click(screen.getByRole('button', { name: '取消全选' }));
    expect(screen.getByRole('button', { name: /一键发布到市集 · 0 项/ })).toBeDisabled();
    expect((screen.getAllByRole('checkbox') as HTMLInputElement[]).every((b) => !b.checked)).toBe(
      true,
    );

    await userEvent.click(screen.getByRole('button', { name: '全选' }));
    expect(screen.getByRole('button', { name: /一键发布到市集 · 2 项/ })).toBeEnabled();
  });

  it('试用按钮 → 使用预准备 trialCapability 直接开 runtime trial session 并跳转', async () => {
    const openTrial = vi.fn();
    restoreOpenTrial = __setOpenRuntimeTrialForTests(openTrial);
    mock = installFetchMock([
      {
        status: 202,
        json: { data: { jobId: 'j1', snapshotId: 's1', status: 'queued', eventsUrl: '/x' } },
      },
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
      {
        status: 201,
        json: {
          session: {
            id: 'rt1',
            capabilityId: 'cap1',
            slug: 'svs',
            version: '0.1.0',
            mode: 'trial',
            title: '短视频脚本生成器 试用',
            createdAt: '2026-06-10T00:00:00Z',
            updatedAt: '2026-06-10T00:00:00Z',
          },
          capability: { capabilityId: 'cap1', slug: 'svs', version: '0.1.0' },
        },
      },
    ]);
    renderPage();
    await waitFor(() => expect(MockFetchEventSource.connections.length).toBe(1));
    act(() => connAt(0).open());
    act(() => connAt(0).emit('done', extractDone, { id: '1-0' }));
    await waitFor(() => expect(screen.getByText('短视频脚本生成器')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: '试用 →' }));

    await waitFor(() =>
      expect(
        mock.calls.some((c) => c.url === '/api/v1/runtime/trial-chains/cap1/sessions'),
      ).toBe(true),
    );
    expect(mock.calls.some((c) => c.url === '/api/v1/capabilities')).toBe(false);
    expect(mock.calls.some((c) => c.url.includes('/versions/v1/structure'))).toBe(false);
    expect(mock.calls.find((c) => c.url.includes('/runtime/trial-chains'))?.body).toEqual({
      versionId: 'v1',
      title: '短视频脚本生成器 试用',
    });
    await waitFor(() => expect(openTrial).toHaveBeenCalledOnce());
    const trialUrl = openTrial.mock.calls[0]![0] as string;
    expect(trialUrl).toContain('/try/session/rt1');
    expect(new URLSearchParams(trialUrl.split('?')[1]).get('returnTo')).toBe(
      '/create/capabilities?snapshotId=s1&draftId=d1',
    );
  });

  it('试用回跳地址补齐向导上下文里的 snapshotId/draftId，避免回到裸能力页丢数据', async () => {
    const openTrial = vi.fn();
    restoreOpenTrial = __setOpenRuntimeTrialForTests(openTrial);
    mock = installFetchMock([
      {
        status: 202,
        json: { data: { jobId: 'j1', snapshotId: 's1', status: 'queued', eventsUrl: '/x' } },
      },
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
      {
        status: 201,
        json: {
          session: {
            id: 'rt1',
            capabilityId: 'cap1',
            slug: 'svs',
            version: '0.1.0',
            mode: 'trial',
            title: '短视频脚本生成器 试用',
            createdAt: '2026-06-10T00:00:00Z',
            updatedAt: '2026-06-10T00:00:00Z',
          },
          capability: { capabilityId: 'cap1', slug: 'svs', version: '0.1.0' },
        },
      },
    ]);
    renderPage('/create/capabilities', 'd1', { snapshotId: 's1' });
    await waitFor(() => expect(MockFetchEventSource.connections.length).toBe(1));
    act(() => connAt(0).open());
    act(() => connAt(0).emit('done', extractDone, { id: '1-0' }));
    await waitFor(() => expect(screen.getByText('短视频脚本生成器')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: '试用 →' }));

    await waitFor(() => expect(openTrial).toHaveBeenCalledOnce());
    const trialUrl = openTrial.mock.calls[0]![0] as string;
    expect(new URLSearchParams(trialUrl.split('?')[1]).get('returnTo')).toBe(
      '/create/capabilities?snapshotId=s1&draftId=d1',
    );
  });

  it('试用建版失败 → 卡片内显示错误且不跳转', async () => {
    const openTrial = vi.fn();
    restoreOpenTrial = __setOpenRuntimeTrialForTests(openTrial);
    mock = installFetchMock([
      {
        status: 202,
        json: { data: { jobId: 'j1', snapshotId: 's1', status: 'queued', eventsUrl: '/x' } },
      },
      {
        status: 200,
        json: {
          data: [candidateJson({ trialCapability: undefined })],
          meta: {
            page: { hasMore: false, nextCursor: null, limit: 50, order: 'asc' },
            confidenceSummary: { high: 1, med: 0, low: 0 },
          },
        },
      },
      {
        status: 503,
        json: {
          error: {
            userMessage: '没能准备试用，请稍后重试。',
            retriable: true,
            action: 'retry',
            traceId: 't1',
          },
        },
      },
    ]);
    renderPage();
    await waitFor(() => expect(MockFetchEventSource.connections.length).toBe(1));
    act(() => connAt(0).open());
    act(() => connAt(0).emit('done', extractDone, { id: '1-0' }));
    await waitFor(() => expect(screen.getByText('短视频脚本生成器')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: '试用 →' }));

    expect(await screen.findByText('没能准备试用，请稍后重试。')).toBeInTheDocument();
    expect(openTrial).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '重试试用 →' })).toBeEnabled();
  });

  it('试用结构化启动失败 → 卡片内显示错误且不跳转', async () => {
    const openTrial = vi.fn();
    restoreOpenTrial = __setOpenRuntimeTrialForTests(openTrial);
    mock = installFetchMock([
      {
        status: 202,
        json: { data: { jobId: 'j1', snapshotId: 's1', status: 'queued', eventsUrl: '/x' } },
      },
      {
        status: 200,
        json: {
          data: [candidateJson({ trialCapability: undefined })],
          meta: {
            page: { hasMore: false, nextCursor: null, limit: 50, order: 'asc' },
            confidenceSummary: { high: 1, med: 0, low: 0 },
          },
        },
      },
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
      {
        status: 503,
        json: {
          error: {
            userMessage: '生成试用能力失败，请稍后重试。',
            retriable: true,
            action: 'retry',
            traceId: 't1',
          },
        },
      },
    ]);
    renderPage();
    await waitFor(() => expect(MockFetchEventSource.connections.length).toBe(1));
    act(() => connAt(0).open());
    act(() => connAt(0).emit('done', extractDone, { id: '1-0' }));
    await waitFor(() => expect(screen.getByText('短视频脚本生成器')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: '试用 →' }));

    expect(await screen.findByText('生成试用能力失败，请稍后重试。')).toBeInTheDocument();
    expect(openTrial).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '重试试用 →' })).toBeEnabled();
  });

  it('runtime trial session 创建失败 → 卡片内显示错误且不跳转', async () => {
    const openTrial = vi.fn();
    restoreOpenTrial = __setOpenRuntimeTrialForTests(openTrial);
    mock = installFetchMock([
      {
        status: 202,
        json: { data: { jobId: 'j1', snapshotId: 's1', status: 'queued', eventsUrl: '/x' } },
      },
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
    await waitFor(() => expect(MockFetchEventSource.connections.length).toBe(1));
    act(() => connAt(0).open());
    act(() => connAt(0).emit('done', extractDone, { id: '1-0' }));
    await waitFor(() => expect(screen.getByText('短视频脚本生成器')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: '试用 →' }));

    expect(await screen.findByText('没能打开试用，请稍后重试。')).toBeInTheDocument();
    expect(openTrial).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '重试试用 →' })).toBeEnabled();
  });

  it('一键发布 → createPublishBatch(每项仅 candidateId+idempotencyKey) → 批次 SSE published → 卡片 已发布 + 市集链接', async () => {
    mock = installFetchMock([
      // createExtractJob
      {
        status: 202,
        json: { data: { jobId: 'j1', snapshotId: 's1', status: 'queued', eventsUrl: '/x' } },
      },
      // fetchCandidates
      {
        status: 200,
        json: {
          data: [candidateJson(), candidateJson({ id: 'c2', name: 'VC 拷打模拟器', slug: 'vc' })],
          meta: {
            page: { hasMore: false, nextCursor: null, limit: 50, order: 'asc' },
            confidenceSummary: { high: 2, med: 0, low: 0 },
          },
        },
      },
      // createPublishBatch（202 受理，含初始 items）。
      {
        status: 202,
        json: {
          data: {
            batchId: 'b1',
            jobId: 'bj1',
            status: 'running',
            total: 2,
            processedCount: 0,
            publishedCount: 0,
            failedCount: 0,
            items: [
              { itemId: 'i1', candidateId: 'c1', state: 'structuring' },
              { itemId: 'i2', candidateId: 'c2', state: 'structuring' },
            ],
          },
        },
      },
    ]);
    renderPage();
    await waitFor(() => expect(MockFetchEventSource.connections.length).toBe(1));
    act(() => connAt(0).open());
    act(() => connAt(0).emit('done', extractDone, { id: '1-0' }));
    await waitFor(() => expect(screen.getByText('短视频脚本生成器')).toBeInTheDocument());

    // 一键发布（默认全选两项）。
    await userEvent.click(screen.getByRole('button', { name: /一键发布到市集 · 2 项/ }));

    // 发布请求：每项仅 candidateId + idempotencyKey（无 visibility/cover/tiers）；批次级 scope。
    await waitFor(() => {
      const call = mock.calls.find(
        (c) => c.url.includes('/publish-batches') && c.method === 'POST',
      );
      expect(call).toBeTruthy();
      expect(call?.headers['X-Idempotency-Scope']).toBe('publish_batch.create');
      const body = call?.body as { items: Record<string, unknown>[]; draftId?: string };
      expect(body.draftId).toBe('d1');
      expect(body.items).toHaveLength(2);
      for (const it of body.items) {
        expect(Object.keys(it).sort()).toEqual(['candidateId', 'idempotencyKey']);
        expect(typeof it.idempotencyKey).toBe('string');
      }
      expect(body.items.map((it) => it.candidateId).sort()).toEqual(['c1', 'c2']);
    });

    // 批次 SSE（connection[1]）：open → 逐项 published。
    await waitFor(() => expect(MockFetchEventSource.connections.length).toBe(2));
    act(() => connAt(1).open());
    // 发布中态（初始 items structuring）先反映。
    expect(screen.getAllByText('发布中…').length).toBeGreaterThan(0);
    act(() =>
      connAt(1).emit(
        'item-appended',
        { item: { itemId: 'i1', candidateId: 'c1', state: 'published' } },
        { id: 'b-0' },
      ),
    );
    act(() =>
      connAt(1).emit(
        'item-appended',
        { item: { itemId: 'i2', candidateId: 'c2', state: 'published' } },
        { id: 'b-1' },
      ),
    );

    // 两卡状态槽转「已发布」+ 市集链接。
    await waitFor(() => expect(screen.getAllByText('已发布')).toHaveLength(2));
    const marketLinks = screen.getAllByRole('link', { name: '市集链接' });
    expect(marketLinks).toHaveLength(2);
    expect(marketLinks[0]).toHaveAttribute('href', '/a/svs');
    expect(marketLinks[1]).toHaveAttribute('href', '/a/vc');
    // 完成汇总。
    await waitFor(() => expect(screen.getByText(/已发布 2 \/ 2 个能力/)).toBeInTheDocument());
  });

  it('提取完成但 0 候选 → 诚实空态，无发布区（永不裸转圈）', async () => {
    mock = installFetchMock([
      {
        status: 202,
        json: { data: { jobId: 'j1', snapshotId: 's1', status: 'queued', eventsUrl: '/x' } },
      },
      {
        status: 200,
        json: {
          data: [],
          meta: {
            page: { hasMore: false, nextCursor: null, limit: 50, order: 'asc' },
            confidenceSummary: { high: 0, med: 0, low: 0 },
          },
        },
      },
    ]);
    renderPage();
    await waitFor(() => expect(MockFetchEventSource.connections.length).toBe(1));
    act(() => connAt(0).open());
    act(() =>
      connAt(0).emit(
        'done',
        {
          status: 'completed',
          result: {
            candidateCount: 0,
            readyCount: 0,
            failedCount: 0,
            analyzedSegments: 100,
            degraded: false,
          },
        },
        { id: '1-0' },
      ),
    );
    await waitFor(() => expect(screen.getByText(/没识别出可复用的能力/)).toBeInTheDocument());
    // readyCount=0 → 底部动作区不渲染，无「一键发布」按钮。
    expect(screen.queryByRole('button', { name: /一键发布/ })).toBeNull();
  });

  it('一键发布起批失败（后端 5xx）→ 人话错误 + 重试入口（不静默、不卡住）', async () => {
    mock = installFetchMock([
      {
        status: 202,
        json: { data: { jobId: 'j1', snapshotId: 's1', status: 'queued', eventsUrl: '/x' } },
      },
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
      // createPublishBatch → 5xx（apiPost 归一 ApiError，取 userMessage）。
      {
        status: 502,
        json: {
          error: {
            userMessage: '发布服务开小差了',
            retriable: true,
            action: 'retry',
            traceId: 't1',
          },
        },
      },
    ]);
    renderPage();
    await waitFor(() => expect(MockFetchEventSource.connections.length).toBe(1));
    act(() => connAt(0).open());
    act(() => connAt(0).emit('done', extractDone, { id: '1-0' }));
    await waitFor(() => expect(screen.getByText('短视频脚本生成器')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /一键发布/ }));
    await waitFor(() => expect(screen.getByText('发布服务开小差了')).toBeInTheDocument());
  });

  it('部分失败（无连坐）→ 成功卡已发布、失败卡出人话错误 + 单项重试；汇总含（失败 N）', async () => {
    mock = installFetchMock([
      {
        status: 202,
        json: { data: { jobId: 'j1', snapshotId: 's1', status: 'queued', eventsUrl: '/x' } },
      },
      {
        status: 200,
        json: {
          data: [candidateJson(), candidateJson({ id: 'c2', name: 'VC 拷打模拟器', slug: 'vc' })],
          meta: {
            page: { hasMore: false, nextCursor: null, limit: 50, order: 'asc' },
            confidenceSummary: { high: 2, med: 0, low: 0 },
          },
        },
      },
      {
        status: 202,
        json: {
          data: {
            batchId: 'b1',
            jobId: 'bj1',
            status: 'running',
            total: 2,
            processedCount: 0,
            publishedCount: 0,
            failedCount: 0,
            items: [
              { itemId: 'i1', candidateId: 'c1', state: 'structuring' },
              { itemId: 'i2', candidateId: 'c2', state: 'structuring' },
            ],
          },
        },
      },
      // 单项重试响应（点「重试」后：retryBatchItem → refreshBatch=fetchPublishBatch）。
      { status: 200, json: { data: { itemId: 'i2', candidateId: 'c2', state: 'pending' } } },
      {
        status: 200,
        json: {
          data: {
            batchId: 'b1',
            jobId: 'bj1',
            status: 'running',
            total: 2,
            processedCount: 1,
            publishedCount: 1,
            failedCount: 0,
            items: [
              { itemId: 'i1', candidateId: 'c1', state: 'published' },
              { itemId: 'i2', candidateId: 'c2', state: 'structuring' },
            ],
          },
        },
      },
    ]);
    renderPage();
    await waitFor(() => expect(MockFetchEventSource.connections.length).toBe(1));
    act(() => connAt(0).open());
    act(() => connAt(0).emit('done', extractDone, { id: '1-0' }));
    await waitFor(() => expect(screen.getByText('短视频脚本生成器')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /一键发布/ }));
    await waitFor(() => expect(MockFetchEventSource.connections.length).toBe(2));
    act(() => connAt(1).open());
    act(() =>
      connAt(1).emit(
        'item-appended',
        { item: { itemId: 'i1', candidateId: 'c1', state: 'published' } },
        { id: 'b-0' },
      ),
    );
    act(() =>
      connAt(1).emit(
        'item-appended',
        {
          item: {
            itemId: 'i2',
            candidateId: 'c2',
            state: 'failed',
            error: {
              userMessage: '这一项还差几个字段',
              retriable: false,
              action: 'change_input',
              traceId: 't2',
            },
          },
        },
        { id: 'b-1' },
      ),
    );
    // 成功卡已发布、失败卡出人话错误 + 重试按钮。
    await waitFor(() => expect(screen.getByText('已发布')).toBeInTheDocument());
    expect(screen.getByText('这一项还差几个字段')).toBeInTheDocument();
    const retryBtn = screen.getByRole('button', { name: '重试' });
    // 汇总含（失败 1）。
    await waitFor(() =>
      expect(screen.getByText(/已发布 1 \/ 2 个能力（失败 1）/)).toBeInTheDocument(),
    );
    // 点单项重试 → 打到 /publish-batches/b1/items/i2/retry。
    await userEvent.click(retryBtn);
    await waitFor(() => {
      const call = mock.calls.find(
        (c) => c.url.includes('/publish-batches/b1/items/i2/retry') && c.method === 'POST',
      );
      expect(call).toBeTruthy();
      expect(call?.headers['X-Idempotency-Scope']).toBe('publish_batch.item.retry');
    });
  });

  it('增量帧省略可选 candidateId 时，卡片发布状态不丢（identity 保留，回归 #2）', async () => {
    mock = installFetchMock([
      {
        status: 202,
        json: { data: { jobId: 'j1', snapshotId: 's1', status: 'queued', eventsUrl: '/x' } },
      },
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
            items: [{ itemId: 'i1', candidateId: 'c1', state: 'structuring' }],
          },
        },
      },
    ]);
    renderPage();
    await waitFor(() => expect(MockFetchEventSource.connections.length).toBe(1));
    act(() => connAt(0).open());
    act(() => connAt(0).emit('done', extractDone, { id: '1-0' }));
    await waitFor(() => expect(screen.getByText('短视频脚本生成器')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /一键发布/ }));
    await waitFor(() => expect(MockFetchEventSource.connections.length).toBe(2));
    act(() => connAt(1).open());
    // 增量帧【不带 candidateId】（契约里 candidateId 可选）。
    act(() =>
      connAt(1).emit(
        'item-appended',
        { item: { itemId: 'i1', state: 'published' } },
        { id: 'b-0' },
      ),
    );
    // 卡片仍映射到该项 → 已发布 + 市集链接（candidateId 由初始批响应保留）。
    await waitFor(() => expect(screen.getByText('已发布')).toBeInTheDocument());
    expect(screen.getByRole('link', { name: '市集链接' })).toHaveAttribute('href', '/a/svs');
  });

  it('续传带 ?batchId= → 拉回已发起批，不再显示「一键发布」（防重复上架，回归 #3）', async () => {
    mock = installFetchMock([
      // 续传 effect：fetchPublishBatch(b1)（已完成批，含已发布项）。
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
            items: [{ itemId: 'i1', candidateId: 'c1', state: 'published' }],
          },
        },
      },
      // extract SSE done → fetchCandidates(j1)。
      {
        status: 200,
        json: {
          data: [candidateJson({ id: 'c1' })],
          meta: {
            page: { hasMore: false, nextCursor: null, limit: 50, order: 'asc' },
            confidenceSummary: { high: 1, med: 0, low: 0 },
          },
        },
      },
    ]);
    // 带 extractJobId（候选从已完成萃取任务拉）+ batchId（续传已发起批）。
    renderPage('/create/capabilities?snapshotId=s1&extractJobId=j1&batchId=b1', 'd1');
    // extract SSE（conn[0]）done → 候选进 ready。
    await waitFor(() => expect(MockFetchEventSource.connections.length).toBeGreaterThanOrEqual(1));
    act(() => connAt(0).open());
    act(() => connAt(0).emit('done', extractDone, { id: '1-0' }));
    await waitFor(() => expect(screen.getByText('短视频脚本生成器')).toBeInTheDocument());
    // 续传批已置 batchView → 卡片直接「已发布」，且【绝不再出现「一键发布」按钮】（不重复建版重复发布）。
    await waitFor(() => expect(screen.getByText('已发布')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /一键发布/ })).toBeNull();
    // 确有拉批请求（续传语义）。
    expect(
      mock.calls.some((c) => c.url.includes('/publish-batches/b1') && c.method === 'GET'),
    ).toBe(true);
  });
});

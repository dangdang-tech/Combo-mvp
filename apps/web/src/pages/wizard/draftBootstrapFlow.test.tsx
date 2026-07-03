// 草稿 bootstrap 端到端贯穿（Codex phase4c P0-2）——mock 全链路，无运行后端。PRD 2 步坍缩版。
//
// 验证（开工总纲 §5.0「每步可存草稿 + 断点续传」 / 脊柱 §8）：
//   正向贯穿：无 draftId 从 /create/import 全新进入 → 先 POST /drafts 建真实草稿 → draftId 写进 WizardContext
//     + 续传 URL（?draftId=）→ 铸码带 draftId → SSE 导入完成后【自动进入能力页】/create/capabilities，
//     带真实 draftId + snapshotId（各步据它回填同一 draft、不冒充；PRD：传完无需手动点下一步）。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import type { DraftView } from '@cb/shared';
import { WizardLayout } from './WizardLayout.js';
import { ImportStepPage, CapabilitiesStepPage } from '../index.js';
import { installRoutedFetchMock, type RoutedFetchMock } from '../__testutils__/routedFetchMock.js';
import { __setFetchEventSourceForTests } from '../../api/useSSE.js';
import { MockFetchEventSource, type MockSSEConnection } from '../../test/mockFetchEventSource.js';

function PathProbe() {
  const loc = useLocation();
  return <span data-testid="path">{`${loc.pathname}${loc.search}`}</span>;
}

function renderWizard(initialPath: string) {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/creator" element={<div>工作台首页</div>} />
        <Route path="/create" element={<WizardLayout />}>
          <Route index element={<Navigate to="/create/import" replace />} />
          <Route path="import" element={<ImportStepPage />} />
          <Route path="capabilities" element={<CapabilitiesStepPage />} />
        </Route>
      </Routes>
      <PathProbe />
    </MemoryRouter>,
  );
}

function conn(): MockSSEConnection {
  const c = MockFetchEventSource.last;
  if (!c) throw new Error('no SSE connection');
  return c;
}

function draftView(over: Partial<DraftView> = {}): DraftView {
  return {
    id: 'd1',
    status: 'active',
    currentStep: 'import',
    stepProgress: { percent: 0, phrase: '开始' },
    createdAt: '2026-06-17T00:00:00Z',
    updatedAt: '2026-06-17T00:00:00Z',
    ...over,
  };
}

let mock: RoutedFetchMock;
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

const snapshotResponse = {
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
};

describe('草稿 bootstrap 端到端贯穿（P0-2，PRD 2 步）', () => {
  it('无 draftId 从 /create/import 新建 → 建真实 draft → draftId 写续传 URL → 铸码带 draftId → 导入完成自动进能力页带 draftId+snapshotId', async () => {
    mock = installRoutedFetchMock([
      // 轮询（更具体的 pairId 子串先放）→ 直接回 job_created（带 jobId）。
      {
        match: '/import/connect/pair/p1',
        response: {
          status: 200,
          json: {
            data: {
              pairId: 'p1',
              phase: 'job_created',
              jobId: 'job1',
              eventsUrl: '/api/v1/jobs/job1/events',
            },
          },
        },
      },
      // 铸码。
      {
        match: '/import/connect/pair',
        response: {
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
      },
      // 完成态快照（segments 先于 snapshot；extract 先于 snapshot 基串）。
      {
        match: '/snapshots/snap1/segments',
        response: {
          status: 200,
          json: {
            data: [],
            meta: { page: { hasMore: false, nextCursor: null, limit: 30, order: 'desc' } },
          },
        },
      },
      // 能力页进入即触发萃取（自动过程态）——回 jobId，不深驱。
      {
        match: '/snapshots/snap1/extract',
        response: {
          status: 202,
          json: {
            data: { jobId: 'ej1', snapshotId: 'snap1', status: 'queued', eventsUrl: '/x' },
          },
        },
      },
      { match: '/snapshots/snap1', response: snapshotResponse },
      // bootstrap：POST /drafts（也兜续传单条 GET /drafts/draft-real）。
      {
        match: '/drafts',
        response: { status: 201, json: { data: draftView({ id: 'draft-real' }) } },
      },
    ]);
    renderWizard('/create/import');

    // ① bootstrap 写续传 URL：?draftId=draft-real。
    await waitFor(() =>
      expect(screen.getByTestId('path')).toHaveTextContent('/create/import?draftId=draft-real'),
    );
    const draftCall = mock.calls.find((c) => c.url.endsWith('/drafts') && c.method === 'POST');
    expect(draftCall?.headers['X-Idempotency-Scope']).toBe('draft.create');

    // ② 点开始导入 → 铸码带 draftId → 轮询拿 jobId → SSE 加载态。
    await userEvent.click(screen.getByRole('button', { name: '开始导入 →' }));
    await waitFor(() => {
      const pairCall = mock.calls.find(
        (c) => c.url.includes('/import/connect/pair') && c.method === 'POST',
      );
      expect(pairCall).toBeTruthy();
    });
    await waitFor(() => expect(MockFetchEventSource.last).toBeTruthy());

    // ③ SSE 导入完成 → 取快照 → 自动进入能力页（带 snapshotId + draftId）。
    act(() => conn().open());
    act(() =>
      conn().emit('done', { status: 'completed', result: { snapshotId: 'snap1' } }, { id: '1-0' }),
    );
    await waitFor(() =>
      expect(screen.getByTestId('path')).toHaveTextContent(
        '/create/capabilities?snapshotId=snap1&draftId=draft-real',
      ),
    );
  });
});

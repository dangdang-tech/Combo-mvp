// 草稿 bootstrap 端到端贯穿 + 反向破坏（Codex phase4c P0-2）——mock 全链路，无运行后端。
//
// 验证（开工总纲 §5.0「每步可存草稿 + 断点续传」 / 脊柱 §8）：
//   ① 正向贯穿：无 draftId 从 /create/import 全新进入 → 先 POST /drafts 建真实草稿 → draftId 写进 WizardContext
//      + 续传 URL（?draftId=）→ STEP① 完成后「下一步」带 draftId 进 STEP②（各步据它回填同一 draft，不冒充）。
//   ② STEP③ 不再因「fresh flow 无 draftId」硬挡：有真实 draftId → patchSelection 真落库再进下一步（draftId 贯穿）。
//   ③ 续传：工作台草稿条点「去上传流程」直接带整条 DraftView → 落点即精确断点（这里测深链 ?draftId= → 单条 GET 恢复）。
//   ④ 反向破坏：STEP① 不 bootstrap（draftId 缺失）→ STEP③ 进入下一步被挡（人话退路、不静默吞、不进下一步）——
//      退回旧「用 capabilityId 冒充 draftId / 无 draftId 硬挡」即测红。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import type {
  CandidateView,
  DraftView,
  Manifest,
  CreateCapabilityResult,
  ManifestView,
  StructureState,
} from '@cb/shared';
import { WizardLayout } from './WizardLayout.js';
import { SelectStepPage } from './SelectStepPage.js';
import { ImportStepPage, ExtractStepPage, StructureStepPage, PublishStepPage } from '../index.js';
import { installRoutedFetchMock, type RoutedFetchMock } from '../__testutils__/routedFetchMock.js';
import { __setFetchEventSourceForTests } from '../../api/useSSE.js';
import { MockFetchEventSource, type MockSSEConnection } from '../../test/mockFetchEventSource.js';
import { useWizard } from './WizardContext.js';

function PathProbe() {
  const loc = useLocation();
  return <span data-testid="path">{`${loc.pathname}${loc.search}`}</span>;
}

/** 上下文探针：暴露 draftId / capabilityId（断「绝不拿 capabilityId 冒充 draftId」）。 */
function CtxProbe() {
  const { draftId, capabilityId } = useWizard();
  return (
    <>
      <span data-testid="ctx-draft">{draftId ?? 'none'}</span>
      <span data-testid="ctx-cap">{capabilityId ?? 'none'}</span>
    </>
  );
}

/** 7 软字段全填的 manifest（结合空 structureState → buildSoftFields 全 done → 不起 SSE，直达 ready）。 */
function fullManifest(over: Partial<Manifest> = {}): Manifest {
  return {
    id: 'cap-real',
    version: '0.1.0',
    status: 'draft',
    inputs: { fields: [] },
    output: { type: 'text' },
    boundaries: { riskLevel: 'low', redLines: [] },
    name: '资格打分器',
    tagline: '一句话卖点',
    role: '它扮演的角色',
    goal: '它要达成的目标',
    instructions: '工作步骤',
    skill_set: ['本事 A'],
    starter_prompts: ['起手 1'],
    ...over,
  };
}

function emptyStructureState(versionId: string): StructureState {
  return { versionId, fields: [], doneCount: 0, totalCount: 0 };
}

function createCapabilityResult(): CreateCapabilityResult {
  return {
    capabilityId: 'cap-real',
    versionId: 'ver-real',
    slug: 'scorer',
    version: '0.1.0',
    manifest: fullManifest(),
    structureState: emptyStructureState('ver-real'),
  };
}

function manifestView(): ManifestView {
  return {
    versionId: 'ver-real',
    capabilityId: 'cap-real',
    slug: 'scorer',
    manifest: fullManifest(),
    locked: ['id', 'version', 'status', 'inputs', 'output', 'boundaries'],
    structureState: emptyStructureState('ver-real'),
  };
}

function renderWizard(initialPath: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route path="/creator" element={<div>工作台首页</div>} />
          <Route path="/create" element={<WizardLayout />}>
            <Route index element={<Navigate to="/create/import" replace />} />
            <Route path="import" element={<ImportStepPage />} />
            <Route path="extract" element={<ExtractStepPage />} />
            <Route path="select" element={<SelectStepPage />} />
            <Route
              path="structure"
              element={
                <>
                  <CtxProbe />
                  <StructureStepPage />
                </>
              }
            />
            <Route path="publish" element={<PublishStepPage />} />
          </Route>
        </Routes>
        <PathProbe />
      </MemoryRouter>
    </QueryClientProvider>,
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

function candidate(over: Partial<CandidateView> = {}): CandidateView {
  return {
    id: 'c1',
    extractJobId: 'ej1',
    snapshotId: 'snap1',
    status: 'ready',
    name: '资格打分器',
    intent: null,
    slug: 'scorer',
    type: 'core-workflow',
    confidence: 'high',
    segmentCount: 17,
    frequencyRatio: null,
    reusability: null,
    scopeCoherence: 0.86,
    splitSuggested: null,
    scope: null,
    error: null,
    retryCount: 0,
    createdAt: '2026-06-10T00:00:00Z',
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

describe('草稿 bootstrap 端到端贯穿（P0-2）', () => {
  it('无 draftId 从 /create/import 新建 → 建真实 draft → draftId 写续传 URL → 铸码带 draftId → STEP① 完成后带 draftId 进 STEP②', async () => {
    mock = installRoutedFetchMock([
      // 铸码（POST /import/connect/pair）+ 轮询（GET /import/connect/pair/{id}）。注意：更具体的子串先放，
      //   但本 mock 按「首个命中的 match 子串」选——铸码与轮询都含 '/import/connect/pair'，故用 phase 区分响应即可：
      //   POST 与 GET 同路由，这里铸码与轮询合用一个路由，轮询直接回 job_created（带 jobId）。
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
      // 完成态快照（更具体的 segments 先于 snapshot）。
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
      { match: '/snapshots/snap1', response: snapshotResponse },
      // bootstrap：POST /drafts → 真实草稿（放最后，避免与 /import 路由抢；/drafts 唯一含 'drafts'）。
      {
        match: '/drafts',
        response: { status: 201, json: { data: draftView({ id: 'draft-real' }) } },
      },
    ]);
    renderWizard('/create/import');

    // ① bootstrap 写续传 URL：?draftId=draft-real（刷新/分享即精确续传基线）。
    await waitFor(() =>
      expect(screen.getByTestId('path')).toHaveTextContent('/create/import?draftId=draft-real'),
    );
    // 第一个写请求是 POST /drafts（scope=draft.create）。
    const draftCall = mock.calls.find((c) => c.url.endsWith('/drafts') && c.method === 'POST');
    expect(draftCall?.headers['X-Idempotency-Scope']).toBe('draft.create');

    // ② 草稿就绪 → 点开始导入（命令行优先：主卡入口，无需展开）→
    //    铸码带 draftId → 轮询拿 jobId → SSE 加载态。
    await userEvent.click(screen.getByRole('button', { name: '开始导入 →' }));
    await waitFor(() => {
      const pairCall = mock.calls.find(
        (c) => c.url.includes('/import/connect/pair') && c.method === 'POST',
      );
      expect(pairCall).toBeTruthy();
    });
    // 轮询拿 job_created → SSE 建流。
    await waitFor(() => expect(MockFetchEventSource.last).toBeTruthy());

    // ③ SSE 导入完成 → 完成态 → 底栏「下一步：提取能力项 →」带 draftId 进 STEP②。
    act(() => conn().open());
    act(() =>
      conn().emit('done', { status: 'completed', result: { snapshotId: 'snap1' } }, { id: '1-0' }),
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '下一步：提取能力项 →' })).toBeInTheDocument(),
    );
    await userEvent.click(screen.getByRole('button', { name: '下一步：提取能力项 →' }));
    // STEP② URL 带真实 draftId（贯穿，不丢、不冒充）。
    await waitFor(() =>
      expect(screen.getByTestId('path')).toHaveTextContent(
        '/create/extract?snapshotId=snap1&draftId=draft-real',
      ),
    );
  });

  it('STEP③（有真实 draftId）→ 选中进下一步：patchSelection 真落库 + 带 draftId 进 STEP④（不被硬挡）', async () => {
    mock = installRoutedFetchMock([
      {
        match: '/extract-jobs/ej1/candidates',
        response: {
          status: 200,
          json: {
            data: [candidate()],
            meta: { page: { hasMore: false, nextCursor: null, limit: 20, order: 'desc' } },
          },
        },
      },
      // 深链 ?draftId= 续传：单条 GET /drafts/draft-real
      {
        match: '/drafts/draft-real',
        response: {
          status: 200,
          json: { data: draftView({ id: 'draft-real', currentStep: 'select' }) },
        },
      },
      { match: '/drafts', response: { status: 200, json: { data: {} } } }, // patchSelection
    ]);
    renderWizard('/create/select?draftId=draft-real&extractJobId=ej1');

    await waitFor(() => expect(screen.getByText('资格打分器')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('radio'));
    await userEvent.click(screen.getByRole('button', { name: /结构化/ }));

    // patchSelection 真落库（PATCH + scope）。
    await waitFor(() => {
      const patch = mock.calls.find((c) => c.method === 'PATCH');
      expect(patch?.url).toContain('/drafts/draft-real/selection');
      expect(patch?.headers['X-Idempotency-Scope']).toBe('draft.selection.patch');
    });
    // 进 STEP④ 带真实 draftId。
    await waitFor(() =>
      expect(screen.getByTestId('path')).toHaveTextContent('/create/structure?draftId=draft-real'),
    );
  });

  it('续传：深链 ?draftId= → 单条 GET 恢复草稿（落点步态对得上，不重建任务）', async () => {
    mock = installRoutedFetchMock([
      {
        match: '/extract-jobs/ej1/candidates',
        response: {
          status: 200,
          json: {
            data: [candidate()],
            meta: { page: { hasMore: false, nextCursor: null, limit: 20, order: 'desc' } },
          },
        },
      },
      {
        match: '/drafts/draft-real',
        response: {
          status: 200,
          json: {
            data: draftView({
              id: 'draft-real',
              currentStep: 'select',
              snapshotId: 'snap1',
              extractJobId: 'ej1',
              selection: { mode: 'single', candidateId: 'c1' },
            }),
          },
        },
      },
    ]);
    renderWizard('/create/select?draftId=draft-real');
    // 续传经单条 GET 恢复 extractJobId → 取候选渲染（不重建萃取）。
    await waitFor(() => expect(screen.getByText('资格打分器')).toBeInTheDocument());
    const getCall = mock.calls.find(
      (c) => c.url.includes('/drafts/draft-real') && c.method === 'GET',
    );
    expect(getCall).toBeTruthy();
  });
});

describe('STEP④ 删除「capabilityId 冒充 draftId」hack（P0-2 反向破坏守门）', () => {
  it('建版回填真实 capabilityId，但 draftId 仍是 bootstrap 的真实草稿（绝不被 capabilityId 覆盖）', async () => {
    mock = installRoutedFetchMock([
      // 续传：单条 GET 恢复 selection（single → 据 candidateId 建版）。
      {
        match: '/drafts/draft-real',
        response: {
          status: 200,
          json: {
            data: draftView({
              id: 'draft-real',
              currentStep: 'structure',
              selection: { mode: 'single', candidateId: 'c1' },
            }),
          },
        },
      },
      // 建版（POST /capabilities）→ 真实 capabilityId（≠ draftId）。
      {
        match: '/capabilities',
        response: { status: 200, json: { data: createCapabilityResult() } },
      },
      // 读 manifest（全软字段已填 → 全 done，不起 SSE，直达 ready）。
      {
        match: '/versions/ver-real/manifest',
        response: { status: 200, json: { data: manifestView() } },
      },
    ]);
    renderWizard('/create/structure?draftId=draft-real');

    // 建版完成 → 回填真实 capabilityId。
    await waitFor(() => expect(screen.getByTestId('ctx-cap')).toHaveTextContent('cap-real'));
    // draftId 仍是 bootstrap 的真实草稿 id（绝不被 capabilityId 冒充覆盖）——删 hack 守门。
    //   退回旧 `setDraftId(created.capabilityId)` 即此处变红（ctx-draft 会变成 cap-real）。
    expect(screen.getByTestId('ctx-draft')).toHaveTextContent('draft-real');
    expect(screen.getByTestId('ctx-draft')).not.toHaveTextContent('cap-real');
    // 建版请求确实打了 POST /capabilities（据 selection.candidateId 建版）。
    const capCall = mock.calls.find((c) => c.url.includes('/capabilities') && c.method === 'POST');
    expect(capCall).toBeTruthy();
  });
});

describe('反向破坏：STEP① 不 bootstrap → STEP③ 进入下一步被挡（测红守门）', () => {
  it('无 draftId 进 STEP③ → 选中点下一步 → 落人话退路、不进 STEP④（不静默吞、不冒充）', async () => {
    mock = installRoutedFetchMock([
      {
        match: '/extract-jobs/ej1/candidates',
        response: {
          status: 200,
          json: {
            data: [candidate()],
            meta: { page: { hasMore: false, nextCursor: null, limit: 20, order: 'desc' } },
          },
        },
      },
      // 若错误地仍调 patchSelection，这里返回 200 也不该被命中（断言无 PATCH）。
      { match: '/drafts', response: { status: 200, json: { data: {} } } },
    ]);
    // 没有 ?draftId=（模拟 STEP① 未 bootstrap 的退化态）；带 extractJobId 让候选可渲染。
    renderWizard('/create/select?extractJobId=ej1');

    await waitFor(() => expect(screen.getByText('资格打分器')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('radio'));
    await userEvent.click(screen.getByRole('button', { name: /结构化/ }));

    // 落「草稿还没准备好」人话退路（无 code）。
    await waitFor(() => expect(screen.getByText(/草稿还没准备好/)).toBeInTheDocument());
    // 没有 PATCH（不空打后端）、没进 STEP④（不冒充前进）。
    expect(mock.calls.some((c) => c.method === 'PATCH')).toBe(false);
    expect(screen.getByTestId('path')).toHaveTextContent('/create/select');
    expect(screen.getByTestId('path')).not.toHaveTextContent('/create/structure');
  });
});

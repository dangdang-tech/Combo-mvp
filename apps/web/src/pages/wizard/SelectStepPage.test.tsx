// SelectStepPage 容器单测（F-12）：取候选（加载/错误/重试）+ 进入下一步先 persist selection 再路由。
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import type { CandidateView } from '@cb/shared';
import { WizardProvider, useWizard } from './WizardContext.js';
import { SelectStepPage } from './SelectStepPage.js';
import { WizardFooter } from './WizardFooter.js';
import { installFetchMock, type FetchMock } from '../../test/mockFetch.js';

function candidate(over: Partial<CandidateView> = {}): CandidateView {
  return {
    id: 'c1',
    extractJobId: 'ej1',
    snapshotId: 's1',
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

function PathProbe() {
  const loc = useLocation();
  return <span data-testid="path">{`${loc.pathname}${loc.search}`}</span>;
}

/** 底栏探针：SelectStepPage 自身不渲染底栏（在 WizardShell 内），测试里补一个以点「下一步」主按钮。 */
function FooterProbe() {
  const { currentStep, primaryAction } = useWizard();
  return <WizardFooter currentStep={currentStep} primaryAction={primaryAction} />;
}

/** 子集预置探针：点按钮把向导 selection 设为 subset(c1,c2)（模拟 STEP② 勾选 2/3 带入 STEP③）。 */
function SubsetPreset() {
  const { setSelection } = useWizard();
  return (
    <button
      type="button"
      onClick={() => setSelection({ mode: 'subset', candidateIds: ['c1', 'c2'] })}
    >
      预置子集2/3
    </button>
  );
}

/** 子集预置探针（跨页边界）：把 selection 设为 subset(c1, c21)——c21 落在后端默认 20 分页之外，
 *  用于验证 STEP③ 取候选必须 limit=100 全量加载、子集 id 不被截断丢弃（BUG-020）。 */
function SubsetPresetAcrossPage() {
  const { setSelection } = useWizard();
  return (
    <button
      type="button"
      onClick={() => setSelection({ mode: 'subset', candidateIds: ['c1', 'c21'] })}
    >
      预置子集c1c21
    </button>
  );
}

function renderPage(initialPath: string, draftId = 'd1', extractJobId?: string) {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <WizardProvider
        initialStep="select"
        initialDraftId={draftId}
        {...(extractJobId ? { initialExtractJobId: extractJobId } : {})}
      >
        <Routes>
          <Route
            path="/create/select"
            element={
              <>
                <PathProbe />
                <SelectStepPage />
                <FooterProbe />
              </>
            }
          />
          <Route path="/create/structure" element={<PathProbe />} />
          <Route path="/create/publish" element={<PathProbe />} />
        </Routes>
      </WizardProvider>
    </MemoryRouter>,
  );
}

let mock: FetchMock;
afterEach(() => mock?.restore());

describe('SelectStepPage', () => {
  it('有 extractJobId → 取候选并渲染单选列表', async () => {
    mock = installFetchMock({
      status: 200,
      json: {
        data: [candidate()],
        meta: { page: { hasMore: false, nextCursor: null, limit: 20, order: 'desc' } },
      },
    });
    renderPage('/create/select', 'd1', 'ej1');
    await waitFor(() => expect(screen.getByText('资格打分器')).toBeInTheDocument());
    // 取候选用提取域端点（只读 ready）。
    expect(mock.calls.some((c) => c.url.includes('/extract-jobs/ej1/candidates'))).toBe(true);
    expect(mock.calls[0]!.url).toContain('status=ready');
    // 守门（BUG-020）：必须显式带 limit=MAX_PAGE_LIMIT（100），取齐全量 ready 候选；
    //   回退到后端默认 20 分页会让 STEP② 子集落 20 名外时被截断丢弃 → 此断言会红。
    expect(mock.calls[0]!.url).toContain('limit=100');
  });

  it('无 extractJobId → 空态引导（不空打后端）', async () => {
    mock = installFetchMock({ status: 200, json: { data: [] } });
    renderPage('/create/select', 'd1');
    await waitFor(() => expect(screen.getByText(/没有可选的能力/)).toBeInTheDocument());
    expect(mock.fn).not.toHaveBeenCalled();
  });

  it('候选加载失败 → ErrorState（人话 + 重试，无 code）', async () => {
    mock = installFetchMock({
      status: 500,
      json: {
        error: {
          userMessage: '候选加载失败，请稍后重试。',
          retriable: true,
          action: 'retry',
          traceId: 't',
        },
      },
    });
    renderPage('/create/select', 'd1', 'ej1');
    await waitFor(() => expect(screen.getByText('候选加载失败，请稍后重试。')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument();
  });

  it('选中 + 进入下一步 → 先 PATCH selection（端点 G）再进 structure 步', async () => {
    mock = installFetchMock([
      // 取候选
      {
        status: 200,
        json: {
          data: [candidate()],
          meta: { page: { hasMore: false, nextCursor: null, limit: 20, order: 'desc' } },
        },
      },
      // patchSelection
      { status: 200, json: { data: {} } },
    ]);
    renderPage('/create/select', 'd1', 'ej1');
    await waitFor(() => expect(screen.getByText('资格打分器')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('radio'));
    await userEvent.click(screen.getByRole('button', { name: /结构化/ }));
    // 先持久化 selection（PATCH + scope）。
    await waitFor(() => {
      const patch = mock.calls.find((c) => c.method === 'PATCH');
      expect(patch?.url).toBe('/api/v1/drafts/d1/selection');
      expect(patch?.headers['X-Idempotency-Scope']).toBe('draft.selection.patch');
    });
    // 再进 structure 步（带 draftId 续传上下文）。
    await waitFor(() =>
      expect(screen.getByTestId('path')).toHaveTextContent('/create/structure?draftId=d1'),
    );
  });

  it('PATCH 保存选择失败 → 主按钮不卡忙态、可再次触发（再点会再次尝试保存），ErrorState 有退路', async () => {
    // 候选 OK；首次 PATCH 500（保存选择失败），第二次 PATCH 200（再次触发成功前进）。
    mock = installFetchMock([
      {
        status: 200,
        json: {
          data: [candidate()],
          meta: { page: { hasMore: false, nextCursor: null, limit: 20, order: 'desc' } },
        },
      },
      // 首次 patchSelection 失败（500）。
      {
        status: 500,
        json: {
          error: {
            userMessage: '进入下一步没成功，请稍后重试。',
            retriable: true,
            action: 'retry',
            traceId: 't',
          },
        },
      },
      // 第二次 patchSelection 成功（再次触发）。
      { status: 200, json: { data: {} } },
    ]);
    renderPage('/create/select', 'd1', 'ej1');
    await waitFor(() => expect(screen.getByText('资格打分器')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('radio'));

    const primary = () => screen.getByRole('button', { name: /结构化|处理中/ });
    await userEvent.click(primary());

    // 失败落 ErrorState（人话 + 退路，无 code）。
    await waitFor(() =>
      expect(screen.getByText('进入下一步没成功，请稍后重试。')).toBeInTheDocument(),
    );
    // 关键反向断言：失败后主按钮恢复可点、不保持忙态/禁用（不卡死）——退路有效。
    await waitFor(() => {
      const btn = primary();
      expect(btn).toBeEnabled();
      expect(btn).not.toHaveTextContent('处理中…');
    });
    const patchCountAfterFirst = mock.calls.filter((c) => c.method === 'PATCH').length;
    expect(patchCountAfterFirst).toBe(1);

    // 再次点击 → 再次尝试保存（第二次 PATCH），成功后正常前进。
    await userEvent.click(primary());
    await waitFor(() => expect(mock.calls.filter((c) => c.method === 'PATCH').length).toBe(2));
    await waitFor(() =>
      expect(screen.getByTestId('path')).toHaveTextContent('/create/structure?draftId=d1'),
    );
  });

  it('全部发布 + 进入下一步 → PATCH selection(subset 全 ready) 再进 publish 步', async () => {
    mock = installFetchMock([
      {
        status: 200,
        json: {
          data: [candidate(), candidate({ id: 'c2', name: 'VC 拷打模拟器' })],
          meta: { page: { hasMore: false, nextCursor: null, limit: 20, order: 'desc' } },
        },
      },
      { status: 200, json: { data: {} } },
    ]);
    renderPage('/create/select', 'd1', 'ej1');
    await waitFor(() => expect(screen.getByText('资格打分器')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /全部发布（不逐个选）/ }));
    await userEvent.click(screen.getByRole('button', { name: '下一步：全部发布 2 项 →' }));
    await waitFor(() => {
      const patch = mock.calls.find((c) => c.method === 'PATCH');
      // 反向破坏：回退把全部发布写成 mode:'all' 此处测红——新规范一律 subset（后端按子集闸校验）。
      expect(patch?.body).toEqual({ selection: { mode: 'subset', candidateIds: ['c1', 'c2'] } });
    });
    // subset → 进发布步（isSubsetSelection 判分流）。
    await waitFor(() =>
      expect(screen.getByTestId('path')).toHaveTextContent('/create/publish?draftId=d1'),
    );
  });

  it('STEP② 子集 2/3 进来 + 全部发布 → PATCH subset(子集 N<total) 不 400、进 publish（Codex r6 P1 核心放开）', async () => {
    // 候选 3 个，向导预置 subset(c1,c2)（STEP② 勾 2/3）；PATCH mock 200（后端子集闸已放开 == 全 ready 要求）。
    mock = installFetchMock([
      {
        status: 200,
        json: {
          data: [
            candidate(),
            candidate({ id: 'c2', name: 'VC 拷打模拟器' }),
            candidate({ id: 'c3', name: '保单条款比对器' }),
          ],
          meta: { page: { hasMore: false, nextCursor: null, limit: 20, order: 'desc' } },
        },
      },
      { status: 200, json: { data: {} } },
    ]);
    render(
      <MemoryRouter initialEntries={['/create/select']}>
        <WizardProvider initialStep="select" initialDraftId="d1" initialExtractJobId="ej1">
          <Routes>
            <Route
              path="/create/select"
              element={
                <>
                  <PathProbe />
                  <SubsetPreset />
                  <SelectStepPage />
                  <FooterProbe />
                </>
              }
            />
            <Route path="/create/structure" element={<PathProbe />} />
            <Route path="/create/publish" element={<PathProbe />} />
          </Routes>
        </WizardProvider>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText('资格打分器')).toBeInTheDocument());
    // 预置 STEP② 子集 2/3。
    await userEvent.click(screen.getByRole('button', { name: '预置子集2/3' }));
    // 全部发布 = 发布【这 2 项】（真子集文案），进下一步。
    await userEvent.click(screen.getByRole('button', { name: '下一步：全部发布这 2 项 →' }));
    // PATCH 持久化的是子集（N<total），不再被误写成 all、不 400 卡死（核心放开验证）。
    await waitFor(() => {
      const patch = mock.calls.find((c) => c.method === 'PATCH');
      expect(patch?.url).toBe('/api/v1/drafts/d1/selection');
      expect(patch?.body).toEqual({ selection: { mode: 'subset', candidateIds: ['c1', 'c2'] } });
    });
    // 子集照样进发布步建批（不漏进结构化）。
    await waitFor(() =>
      expect(screen.getByTestId('path')).toHaveTextContent('/create/publish?draftId=d1'),
    );
  });

  it('候选 >20 且子集含第 21 项 → limit=100 全量取候选，子集承接不被分页截断（BUG-020）', async () => {
    // 21 个 ready 候选（c1..c21）；STEP② 子集勾了 c1+c21（c21 落在后端默认 20 分页之外）。
    //   关键：取候选必须 limit=100 把 c21 也加载进来，SelectStep 的「过滤仍在候选内的子集 id」才不会丢 c21，
    //   否则子集收缩 → 「全部发布这 N 项」退化成「发布全部 ready」。
    const many = Array.from({ length: 21 }, (_, i) =>
      candidate({ id: `c${i + 1}`, name: `能力${i + 1}` }),
    );
    mock = installFetchMock([
      {
        status: 200,
        json: {
          data: many,
          meta: { page: { hasMore: false, nextCursor: null, limit: 100, order: 'asc' } },
        },
      },
      { status: 200, json: { data: {} } },
    ]);
    render(
      <MemoryRouter initialEntries={['/create/select']}>
        <WizardProvider initialStep="select" initialDraftId="d1" initialExtractJobId="ej1">
          <Routes>
            <Route
              path="/create/select"
              element={
                <>
                  <PathProbe />
                  <SubsetPresetAcrossPage />
                  <SelectStepPage />
                  <FooterProbe />
                </>
              }
            />
            <Route path="/create/structure" element={<PathProbe />} />
            <Route path="/create/publish" element={<PathProbe />} />
          </Routes>
        </WizardProvider>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText('能力21')).toBeInTheDocument());
    // 守门：取候选带 limit=100（回退默认 20 会让 c21 不在候选集 → 子集被截断 → 此用例及文案断言全红）。
    expect(mock.calls[0]!.url).toContain('limit=100');
    // 预置 STEP② 子集（c1, c21）。
    await userEvent.click(screen.getByRole('button', { name: '预置子集c1c21' }));
    // 子集 2 项 < 全 21 项 → 真子集文案「这 2 项」（c21 未被丢弃才会是 2 项；被截断会变「全部 21 项」）。
    await userEvent.click(screen.getByRole('button', { name: '下一步：全部发布这 2 项 →' }));
    // PATCH 持久化的正是 STEP② 的精确子集（含落在 20 名外的 c21）。
    await waitFor(() => {
      const patch = mock.calls.find((c) => c.method === 'PATCH');
      expect(patch?.body).toEqual({ selection: { mode: 'subset', candidateIds: ['c1', 'c21'] } });
    });
    await waitFor(() =>
      expect(screen.getByTestId('path')).toHaveTextContent('/create/publish?draftId=d1'),
    );
  });
});

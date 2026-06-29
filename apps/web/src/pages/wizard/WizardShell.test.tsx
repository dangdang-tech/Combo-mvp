// WizardShell 集成单测（F-09 / F-15）：
//   步骤条随路由步态变 / 顶栏「保存草稿」/ 底栏摘要随步变 / 续传 ?draftId= 恢复 selection /
//   已完成步可点回看 / 外壳头条+步骤条+底栏五步常驻（D14：换步不改本壳结构）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import type { DraftView } from '@cb/shared';
import { WizardLayout } from './WizardLayout.js';
import { SelectStep } from './SelectStep.js';
import { useWizard } from './WizardContext.js';
import { TopbarSlotProvider, TopbarActionSlot } from '../../shell/topbarSlot.js';
import { installFetchMock, type FetchMock } from '../../test/mockFetch.js';

function draftView(over: Partial<DraftView> = {}): DraftView {
  return {
    id: 'd1',
    status: 'active',
    currentStep: 'select',
    stepProgress: { percent: 30, phrase: '选择中' },
    selection: { mode: 'single', candidateId: 'c1' },
    createdAt: '2026-06-10T00:00:00Z',
    updatedAt: '2026-06-11T00:00:00Z',
    ...over,
  };
}

/** 暴露当前路由 + wizard 选择态，供断言续传恢复。 */
function StepProbe() {
  const loc = useLocation();
  const { selection, currentStep } = useWizard();
  return (
    <div>
      <span data-testid="path">{loc.pathname}</span>
      <span data-testid="step">{currentStep}</span>
      <span data-testid="selection">{selection ? selection.mode : 'none'}</span>
    </div>
  );
}

function renderWizard(initialPath: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  // TopbarSlotProvider + TopbarActionSlot 复刻生产装配（ProtectedLayout 提供插槽、Shell 顶栏渲染「保存草稿」）：
  // 「保存草稿」已上抬到 4A Shell 顶栏，单测用同一插槽口径让按钮可见可点。
  return render(
    <QueryClientProvider client={client}>
      <TopbarSlotProvider>
        <MemoryRouter initialEntries={[initialPath]}>
          <TopbarActionSlot />
          <Routes>
            <Route path="/creator" element={<div>工作台首页</div>} />
            <Route path="/create" element={<WizardLayout />}>
              <Route index element={<Navigate to="/create/import" replace />} />
              <Route path="import" element={<StepProbe />} />
              <Route path="extract" element={<StepProbe />} />
              <Route
                path="select"
                element={
                  <>
                    <StepProbe />
                    <SelectStep candidates={[]} />
                  </>
                }
              />
              <Route path="structure" element={<StepProbe />} />
              <Route path="publish" element={<StepProbe />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </TopbarSlotProvider>
    </QueryClientProvider>,
  );
}

let mock: FetchMock;
beforeEach(() => {
  // 默认：drafts 列表空（避免续传 effect 真打）；按需在用例内覆盖。
  mock = installFetchMock({
    status: 200,
    json: {
      data: [],
      meta: { page: { hasMore: false, nextCursor: null, limit: 20, order: 'desc' } },
    },
  });
});
afterEach(() => mock.restore());

describe('WizardShell（F-09 向导壳）', () => {
  it('渲染头条「保存草稿」+ 步骤条五段 + 底栏（页名移至 4A 顶栏面包屑，content 头条不重复）', () => {
    renderWizard('/create/import');
    expect(screen.getByRole('button', { name: '保存草稿' })).toBeInTheDocument();
    // 步骤条五段。
    const bar = screen.getByRole('list', { name: '上传五步进度' });
    expect(within(bar).getAllByRole('listitem')).toHaveLength(5);
    // 底栏摘要。
    expect(screen.getByText('第 1 步，共 5 步')).toBeInTheDocument();
  });

  it('步骤条随当前步：import 进行时第1段 current、其余 todo', () => {
    renderWizard('/create/import');
    const bar = screen.getByRole('list', { name: '上传五步进度' });
    expect(bar.querySelector('[data-step="import"]')).toHaveAttribute('aria-current', 'step');
    expect(bar.querySelector('[data-step="select"]')?.getAttribute('data-status')).toBe('todo');
  });

  it('select 步（有草稿续传）：hydrate 后前两步 done（可回看）、第3段 current；底栏摘要「第 3 步」', async () => {
    // BUG-009：步骤条 done 须基于 draft 真实产物。续传单条 GET 命中草稿（snapshot+extract+selection 齐），
    //   hydrate 回填后产物锚点把进度前沿推到 structure，prior 两步（import/extract）确实做过 → done。
    mock.restore();
    mock = installFetchMock({
      status: 200,
      json: {
        data: draftView({
          id: 'd1',
          currentStep: 'select',
          snapshotId: 'snap1',
          extractJobId: 'job1',
        }),
      },
    });
    renderWizard('/create/select?draftId=d1');
    expect(screen.getByTestId('step')).toHaveTextContent('select');
    const bar = screen.getByRole('list', { name: '上传五步进度' });
    // hydrate 落库后前序据真实产物转 done（恢复中短暂 todo 是诚实的，不抢标）。
    await waitFor(() =>
      expect(bar.querySelector('[data-step="import"]')?.getAttribute('data-status')).toBe('done'),
    );
    expect(bar.querySelector('[data-step="extract"]')?.getAttribute('data-status')).toBe('done');
    expect(bar.querySelector('[data-step="select"]')).toHaveAttribute('aria-current', 'step');
    expect(screen.getByText('第 3 步，共 5 步')).toBeInTheDocument();
  });

  it('BUG-009：无锚点中后段深链 → 不伪造前序 done（前序 todo，反映真实未开始）', () => {
    // 直接深链到 /create/select 但无 draftId / snapshot / extract / version 等任一锚点：
    //   用户没做过前序、也无草稿数据 → 步骤条绝不把 import/extract 标成已完成。
    renderWizard('/create/select');
    expect(screen.getByTestId('step')).toHaveTextContent('select');
    const bar = screen.getByRole('list', { name: '上传五步进度' });
    // 无锚点 → 前序 todo（真实「未开始」），不是伪造的 done。
    expect(bar.querySelector('[data-step="import"]')?.getAttribute('data-status')).toBe('todo');
    expect(bar.querySelector('[data-step="extract"]')?.getAttribute('data-status')).toBe('todo');
    // 当前 URL 步仍是 current（用户正看这一步）；其后仍 todo。
    expect(bar.querySelector('[data-step="select"]')).toHaveAttribute('aria-current', 'step');
    expect(bar.querySelector('[data-step="structure"]')?.getAttribute('data-status')).toBe('todo');
    // 前序未做 → 不可点回看（不是 button，没有伪造的「点击回看」退路）。
    expect(bar.querySelector('[data-step="import"]')?.querySelector('button')).toBeNull();
    expect(screen.queryByRole('button', { name: /第 1 步.*点击回看/ })).toBeNull();
  });

  it('BUG-009：仅 draftId 的深链（草稿无产物）→ 不因 draftId 存在就伪造前序 done', async () => {
    // 测试员 BUG-009 复测要旨：?draftId= 到中后段，但草稿只 bootstrap 过、无 snapshot/候选/选择/版本。
    //   续传 hydrate 后上下文仍无任何产物锚点 → 进度前沿退首步 import，前序按 todo，绝不因「有 draftId」标 done。
    mock.restore();
    mock = installFetchMock({
      status: 200,
      json: { data: draftView({ id: 'd1', currentStep: 'import', selection: undefined }) },
    });
    renderWizard('/create/publish?draftId=d1');
    expect(screen.getByTestId('step')).toHaveTextContent('publish');
    // 等续传 hydrate 完成（selection=none 确认草稿已恢复且无选择产物）。
    await waitFor(() => expect(screen.getByTestId('selection')).toHaveTextContent('none'));
    const bar = screen.getByRole('list', { name: '上传五步进度' });
    // 草稿无任何产物 → 前序 import~structure 全 todo（不伪造）；publish 是 URL 落点 current。
    expect(bar.querySelector('[data-step="import"]')?.getAttribute('data-status')).toBe('todo');
    expect(bar.querySelector('[data-step="extract"]')?.getAttribute('data-status')).toBe('todo');
    expect(bar.querySelector('[data-step="select"]')?.getAttribute('data-status')).toBe('todo');
    expect(bar.querySelector('[data-step="structure"]')?.getAttribute('data-status')).toBe('todo');
    expect(bar.querySelector('[data-step="publish"]')).toHaveAttribute('aria-current', 'step');
    // 前序未做 → 无伪造的「点击回看」退路。
    expect(screen.queryByRole('button', { name: /点击回看/ })).toBeNull();
  });

  it('BUG-009：snapshotId 锚点 → 仅 import 标 done，extract 不被一并伪造（精确前沿）', () => {
    // ?snapshotId= 经 WizardLayout 同步播种到上下文：导入做完（snapshot 存在）→ 进度前沿 = extract。
    //   URL 落点 select 远超前沿 → done 前沿取 min(select=3, extract=2)=2：仅 import(1<2) done；
    //   extract 是前沿但还没做完、URL 又跳过了它 → todo（不因「有 snapshot」就把 extract 也标 done）。
    renderWizard('/create/select?snapshotId=snap1');
    const bar = screen.getByRole('list', { name: '上传五步进度' });
    expect(bar.querySelector('[data-step="import"]')?.getAttribute('data-status')).toBe('done');
    expect(bar.querySelector('[data-step="extract"]')?.getAttribute('data-status')).toBe('todo');
    expect(bar.querySelector('[data-step="select"]')).toHaveAttribute('aria-current', 'step');
  });

  it('点已完成步 → 路由跳该步回看（贯穿-16），保留 ?draftId', async () => {
    // 续传命中真实草稿（产物齐到 structure）：hydrate 后 import 据真实产物 done → 可点回看。
    mock.restore();
    mock = installFetchMock({
      status: 200,
      json: {
        data: draftView({
          id: 'd1',
          currentStep: 'structure',
          snapshotId: 'snap1',
          extractJobId: 'job1',
        }),
      },
    });
    renderWizard('/create/structure?draftId=d1');
    // structure 步：hydrate 后 import done 可点（恢复中短暂不可点是诚实的）。
    const importBtn = await screen.findByRole('button', { name: /第 1 步.*点击回看/ });
    await userEvent.click(importBtn);
    await waitFor(() => expect(screen.getByTestId('path')).toHaveTextContent('/create/import'));
  });

  it('「保存草稿」非 select 步 + 有 draftId（草稿已落库）→ 退出回工作台（§5.0 每步可存草稿退出）', async () => {
    // import 步带 ?draftId=：后端建产物时已落 drafts 行，保存草稿 = 诚实退出（无独立写端点，§1.1(b)）。
    //   续传 hook 经单条 GET /drafts/d1 拉回草稿（返回单个 DraftView，非列表）。
    mock.restore();
    mock = installFetchMock({
      status: 200,
      json: { data: draftView({ id: 'd1', currentStep: 'import' }) },
    });
    renderWizard('/create/import?draftId=d1');
    await userEvent.click(screen.getByRole('button', { name: '保存草稿' }));
    await waitFor(() => expect(screen.getByText('工作台首页')).toBeInTheDocument());
  });

  it('「保存草稿」非 select 步 + 无 draftId（尚无已落库草稿）→ 不谎报成功：留在原步 + 人话退路（Codex P0-1）', async () => {
    // import 步无 draftId：没有任何已落库草稿可存，绝不空退出，落「先完成当前步骤」人话退路。
    renderWizard('/create/import');
    await userEvent.click(screen.getByRole('button', { name: '保存草稿' }));
    await waitFor(() => expect(screen.getByText(/还没生成可保存的内容/)).toBeInTheDocument());
    // 仍在 import 步，未跳工作台（不假成功离开）。
    expect(screen.getByTestId('path')).toHaveTextContent('/create/import');
    expect(screen.queryByText('工作台首页')).not.toBeInTheDocument();
  });

  it('F-15 续传：?draftId= → 拉草稿恢复 selection（落点步态对得上，贯穿-15）', async () => {
    // 续传 hook 经单条 GET /drafts/d1 拉回草稿（返回单个 DraftView）。
    mock.restore();
    mock = installFetchMock({
      status: 200,
      json: {
        data: draftView({ id: 'd1', selection: { mode: 'all', candidateIds: ['c1', 'c2'] } }),
      },
    });
    renderWizard('/create/select?draftId=d1');
    // 续传恢复后 selection = all（来自 draft.selection）。
    await waitFor(() => expect(screen.getByTestId('selection')).toHaveTextContent('all'));
    // 落点步 = select（URL 决定，与草稿 currentStep 对齐）。
    expect(screen.getByTestId('step')).toHaveTextContent('select');
  });

  it('外壳头条/步骤条/底栏五步常驻（D14：换步不改本壳结构）', async () => {
    // 带 ?draftId= 续传：前序确有进度（done 可回看），才能点「第 1 步」回看（BUG-009 后 done 须有锚点托底）。
    mock.restore();
    mock = installFetchMock({
      status: 200,
      json: { data: draftView({ id: 'd1', currentStep: 'select' }) },
    });
    renderWizard('/create/select?draftId=d1');
    // select 步具备外壳常驻件（步骤条 + 保存草稿；页名已移至 4A 顶栏面包屑）。
    expect(screen.getByRole('list', { name: '上传五步进度' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '保存草稿' })).toBeInTheDocument();
    // 跳到 import 步（点回看），常驻件仍在、结构不变。续传 hydrate 后 import 据真实产物 done 才可点。
    await userEvent.click(await screen.findByRole('button', { name: /第 1 步.*点击回看/ }));
    await waitFor(() => expect(screen.getByTestId('path')).toHaveTextContent('/create/import'));
    expect(screen.getByRole('list', { name: '上传五步进度' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '保存草稿' })).toBeInTheDocument();
  });
});

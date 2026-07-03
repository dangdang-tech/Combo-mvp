// WizardShell 集成单测（F-09 / F-15；PRD 2 步坍缩后）：
//   顶栏「保存草稿」/ 续传 ?draftId= 恢复 selection / 保存退出回工作台 / 无 draftId 存草稿人话退路 / 换步壳结构不变。
//   步骤条（StepBar）+ 恒定底栏（WizardFooter）已随 2 步坍缩下线，不再断言。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import type { DraftView } from '@cb/shared';
import { WizardLayout } from './WizardLayout.js';
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
  return render(
    <TopbarSlotProvider>
      <MemoryRouter initialEntries={[initialPath]}>
        <TopbarActionSlot />
        <Routes>
          <Route path="/creator" element={<div>工作台首页</div>} />
          <Route path="/create" element={<WizardLayout />}>
            <Route index element={<Navigate to="/create/import" replace />} />
            <Route path="import" element={<StepProbe />} />
            <Route path="capabilities" element={<StepProbe />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </TopbarSlotProvider>,
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

describe('WizardShell（F-09 向导壳，2 步）', () => {
  it('渲染顶栏「保存草稿」+ Outlet 当前步内容（无步骤条/底栏）', () => {
    renderWizard('/create/import');
    expect(screen.getByRole('button', { name: '保存草稿' })).toBeInTheDocument();
    expect(screen.getByTestId('step')).toHaveTextContent('import');
    // 步骤条已下线：不再有「上传五步进度」列表。
    expect(screen.queryByRole('list', { name: '上传五步进度' })).not.toBeInTheDocument();
  });

  it('F-15 续传：?draftId= → 拉草稿恢复 selection（落点步态对得上，贯穿-15）', async () => {
    mock.restore();
    mock = installFetchMock({
      status: 200,
      json: {
        data: draftView({ id: 'd1', selection: { mode: 'all', candidateIds: ['c1', 'c2'] } }),
      },
    });
    renderWizard('/create/capabilities?draftId=d1');
    // 续传恢复后 selection = all（来自 draft.selection）。
    await waitFor(() => expect(screen.getByTestId('selection')).toHaveTextContent('all'));
    // 落点步 = capabilities（URL 决定）。
    expect(screen.getByTestId('step')).toHaveTextContent('capabilities');
  });

  it('「保存草稿」有 draftId（草稿已落库）→ 退出回工作台（§5.0 每步可存草稿退出）', async () => {
    mock.restore();
    mock = installFetchMock({
      status: 200,
      json: { data: draftView({ id: 'd1', currentStep: 'import' }) },
    });
    renderWizard('/create/import?draftId=d1');
    await userEvent.click(screen.getByRole('button', { name: '保存草稿' }));
    await waitFor(() => expect(screen.getByText('工作台首页')).toBeInTheDocument());
  });

  it('「保存草稿」无 draftId（尚无已落库草稿）→ 不谎报成功：留在原步 + 人话退路（Codex P0-1）', async () => {
    renderWizard('/create/import');
    await userEvent.click(screen.getByRole('button', { name: '保存草稿' }));
    await waitFor(() => expect(screen.getByText(/还没生成可保存的内容/)).toBeInTheDocument());
    // 仍在 import 步，未跳工作台（不假成功离开）。
    expect(screen.getByTestId('path')).toHaveTextContent('/create/import');
    expect(screen.queryByText('工作台首页')).not.toBeInTheDocument();
  });
});

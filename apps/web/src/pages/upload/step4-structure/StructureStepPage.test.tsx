// STEP④ 结构化容器单测（F-13，P1-2）——聚焦【建版稳定幂等键】：
//   createCapability 传从 draftId + sourceCandidateId/fromVersionId 派生的稳定 Idempotency-Key；
//   首建 + 响应失败重试用同一 key（后端 ON CONFLICT 命中、不重复建 capability/version）。
//   反向破坏：随机 key（client 自动生成）→ 两次请求两 key、后端会重复建版（此处断言「同 key」锁死该行为）。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { CreateCapabilityResult, Manifest, ManifestView, StructureState } from '@cb/shared';
import { WizardProvider, useWizard } from '../../wizard/index.js';
import { StructureStepPage } from './StructureStepPage.js';
import { installFetchMock, type FetchMock } from '../../../test/mockFetch.js';
import { __setFetchEventSourceForTests } from '../../../api/useSSE.js';
import { MockFetchEventSource } from '../../../test/mockFetchEventSource.js';

const SOFT = [
  'name',
  'tagline',
  'role',
  'goal',
  'instructions',
  'skill_set',
  'starter_prompts',
] as const;

/** 全软字段已填的 manifest（allSoftReady=true → setup 不调 startStructure，测试聚焦建版 key）。 */
function fullManifest(): Manifest {
  return {
    id: 'cap1',
    version: '0.1.0',
    status: 'draft',
    inputs: { fields: [] },
    output: { type: 'text' },
    boundaries: { riskLevel: 'low', redLines: [] },
    name: '需求炼金师',
    tagline: '把杂乱想法炼成 PRD',
    role: '产品助手',
    goal: '产出结构化 PRD',
    instructions: '第一步…第二步…',
    skill_set: ['拆解需求'],
    starter_prompts: ['帮我写 PRD'],
  };
}

/** 全 done 的 structure_state（含硬字段 locked），SSE state_snapshot 用。 */
function doneState(): StructureState {
  return {
    versionId: 'v1',
    fields: [
      ...SOFT.map((field) => ({ field, status: 'done' as const, value: 'x', attempts: 0 })),
      { field: 'id', status: 'locked' as const, value: 'cap1', attempts: 0 },
    ],
    doneCount: 7,
    totalCount: 7,
  };
}

function manifestView(): ManifestView {
  return {
    versionId: 'v1',
    capabilityId: 'cap1',
    slug: 'demand-alchemist',
    manifest: fullManifest(),
    locked: ['id', 'version', 'status', 'inputs', 'output', 'boundaries'],
    structureState: doneState(),
  };
}

function createResult(): CreateCapabilityResult {
  return {
    capabilityId: 'cap1',
    versionId: 'v1',
    slug: 'demand-alchemist',
    version: '0.1.0',
    manifest: fullManifest(),
    structureState: doneState(),
  };
}

/** 把 selection 预置为 single(c1)（模拟 STEP③ 逐个选定一个进 STEP④ 建版）。 */
function SelectionPreset({ candidateId = 'c1' }: { candidateId?: string }) {
  const { setSelection } = useWizard();
  // 进来即写（StructureStepPage 据 selection.mode==='single' 取 sourceCandidateId 建版）。
  return (
    <button
      type="button"
      data-testid="preset"
      onClick={() => setSelection({ mode: 'single', candidateId })}
    >
      preset
    </button>
  );
}

function renderPage(draftId = 'd1') {
  return render(
    <MemoryRouter initialEntries={['/create/structure']}>
      <WizardProvider initialStep="structure" initialDraftId={draftId}>
        <Routes>
          <Route
            path="/create/structure"
            element={
              <>
                <SelectionPreset />
                <StructureStepPage />
              </>
            }
          />
        </Routes>
      </WizardProvider>
    </MemoryRouter>,
  );
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

/** POST /capabilities 的请求（建版）。 */
function createCalls() {
  return mock.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/capabilities'));
}

describe('StructureStepPage 建版稳定幂等键（P1-2）', () => {
  it('据 selection.single 建版 → createCapability 带稳定 key（从 draftId+sourceCandidateId 派生），scope=capability.create', async () => {
    mock = installFetchMock([
      { status: 201, json: { data: createResult() } }, // createCapability
      { status: 200, json: { data: manifestView() } }, // fetchManifest
    ]);
    const { rerender } = renderPage('d1');
    // 预置 single(c1) → 触发 setup 建版。
    await act(async () => {
      screen.getByTestId('preset').click();
    });
    void rerender;
    await waitFor(() => expect(createCalls().length).toBe(1));
    const call = createCalls()[0]!;
    expect(call.headers['X-Idempotency-Scope']).toBe('capability.create');
    // 稳定 key = capability.create:{draftId}:cand:{sourceCandidateId}（首建即用，绝非 client 随机 key）。
    expect(call.headers['Idempotency-Key']).toBe('capability.create:d1:cand:c1');
    // body 只带 sourceCandidateId（恰好三选一）+ draftId 续传衔接。
    expect(call.body).toEqual({ sourceCandidateId: 'c1', draftId: 'd1' });
  });

  it('建版响应失败 → 重试用【同一】稳定 key（不重复建版；反向破坏：随机 key 会两 key 重复建版，被此断言锁死）', async () => {
    mock = installFetchMock([
      // 首建：响应失败（500，模拟「已建版但响应丢失」的可重试态）。
      {
        status: 500,
        json: {
          error: {
            userMessage: '这一步没能开始，请重试。',
            retriable: true,
            action: 'retry',
            traceId: 't',
          },
        },
      },
      // 重试建版：成功（后端按同 key ON CONFLICT 回放首次，不建第二条）。
      { status: 201, json: { data: createResult() } },
      // 重试后读 manifest。
      { status: 200, json: { data: manifestView() } },
    ]);
    renderPage('d1');
    await act(async () => {
      screen.getByTestId('preset').click();
    });
    // 首建失败 → ErrorState（人话 + 重试退路，无 code）。
    await waitFor(() => expect(screen.getByText('这一步没能开始，请重试。')).toBeInTheDocument());
    expect(createCalls().length).toBe(1);
    const firstKey = createCalls()[0]!.headers['Idempotency-Key'];
    expect(firstKey).toBe('capability.create:d1:cand:c1');

    // 点重试 → 再次建版。
    await act(async () => {
      screen.getByRole('button', { name: '重试' }).click();
    });
    await waitFor(() => expect(createCalls().length).toBe(2));
    const secondKey = createCalls()[1]!.headers['Idempotency-Key'];
    // 核心：两次建版用【同一】key → 后端幂等回放、不重复建 capability/version（重试续结构化不重复建版）。
    //   反向破坏：若回退成 createCapability(undefined)（client 每次随机 key），firstKey !== secondKey，此断言测红。
    expect(secondKey).toBe(firstKey);
    expect(secondKey).toBe('capability.create:d1:cand:c1');
  });

  it('被拒重发 fromVersionId 建版 → key 从 draftId+fromVersionId 派生（与候选建版键区分）', async () => {
    mock = installFetchMock([
      { status: 201, json: { data: createResult() } },
      { status: 200, json: { data: manifestView() } },
    ]);
    render(
      <MemoryRouter initialEntries={['/create/structure?fromVersionId=rej1']}>
        <WizardProvider initialStep="structure" initialDraftId="d1">
          <Routes>
            <Route path="/create/structure" element={<StructureStepPage />} />
          </Routes>
        </WizardProvider>
      </MemoryRouter>,
    );
    await waitFor(() => expect(createCalls().length).toBe(1));
    const call = createCalls()[0]!;
    expect(call.headers['Idempotency-Key']).toBe('capability.create:d1:from:rej1');
    expect(call.body).toEqual({ fromVersionId: 'rej1', draftId: 'd1' });
  });
});

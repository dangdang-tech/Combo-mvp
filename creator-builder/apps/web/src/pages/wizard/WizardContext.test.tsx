// WizardContext 单测（F-09 / F-15）：选择即时态 / 步骤异常覆写与清除 / 续传 hydrate 窄化 selection /
//   primaryAction 注册。
import { describe, it, expect } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { useEffect } from 'react';
import type { DraftView } from '@cb/shared';
import { WizardProvider, useWizard, type WizardContextValue } from './WizardContext.js';

let captured: WizardContextValue;
function Capture() {
  const w = useWizard();
  useEffect(() => {
    captured = w;
  });
  captured = w;
  return (
    <div>
      <span data-testid="sel">{captured.selection ? captured.selection.mode : 'none'}</span>
      <span data-testid="draftId">{captured.draftId ?? 'none'}</span>
      <span data-testid="capabilityId">{captured.capabilityId ?? 'none'}</span>
      <span data-testid="errors">{Object.keys(captured.stepErrors).join(',') || 'none'}</span>
      <span data-testid="summaryPrefix">{captured.summaryPrefix ?? 'none'}</span>
    </div>
  );
}

function setup(initialDraftId?: string) {
  return render(
    <WizardProvider initialStep="select" initialDraftId={initialDraftId}>
      <Capture />
    </WizardProvider>,
  );
}

describe('WizardContext', () => {
  it('useWizard 在 Provider 外抛错', () => {
    function Bare() {
      useWizard();
      return null;
    }
    expect(() => render(<Bare />)).toThrow(/WizardProvider/);
  });

  it('setSelection 即时写选择态（纯前端）', () => {
    setup();
    act(() => captured.setSelection({ mode: 'all', candidateIds: ['c1'] }));
    expect(screen.getByTestId('sel')).toHaveTextContent('all');
    act(() => captured.setSelection(null));
    expect(screen.getByTestId('sel')).toHaveTextContent('none');
  });

  it('markStepError / clearStepError 覆写与清除', () => {
    setup();
    act(() => captured.markStepError('extract'));
    expect(screen.getByTestId('errors')).toHaveTextContent('extract');
    act(() => captured.clearStepError('extract'));
    expect(screen.getByTestId('errors')).toHaveTextContent('none');
  });

  it('hydrateFromDraft 恢复 draftId + capabilityId + selection（capabilityId ≠ draftId，P1-5 拒绝态闭环）', () => {
    setup();
    const draft: DraftView = {
      id: 'd9',
      status: 'active',
      currentStep: 'select',
      stepProgress: { percent: 30, phrase: '选择中' },
      selection: { mode: 'single', candidateId: 'c1' },
      versionId: 'cv9',
      capabilityId: 'cap9',
      createdAt: '2026-06-10T00:00:00Z',
      updatedAt: '2026-06-11T00:00:00Z',
    };
    act(() => captured.hydrateFromDraft(draft));
    expect(screen.getByTestId('draftId')).toHaveTextContent('d9');
    // 真实 capabilityId 续传带出（drafts.id ≠ capabilities.id，供 STEP⑤ 读 publication，P1-5）。
    expect(screen.getByTestId('capabilityId')).toHaveTextContent('cap9');
    expect(screen.getByTestId('sel')).toHaveTextContent('single');
  });

  it('setCapabilityId 写真实能力体 id（STEP④ 建版回填，P1-5）', () => {
    setup();
    act(() => captured.setCapabilityId('cap-new'));
    expect(screen.getByTestId('capabilityId')).toHaveTextContent('cap-new');
  });

  it('hydrateFromDraft 非法 selection 形态 → 窄化为 null（不污染选择态）', () => {
    setup();
    const draft = {
      id: 'd9',
      status: 'active',
      currentStep: 'select',
      stepProgress: { percent: 0, phrase: '' },
      selection: { mode: 'bogus' }, // 非法 mode
      createdAt: '2026-06-10T00:00:00Z',
      updatedAt: '2026-06-11T00:00:00Z',
    } as unknown as DraftView;
    act(() => captured.hydrateFromDraft(draft));
    expect(screen.getByTestId('sel')).toHaveTextContent('none');
  });

  it('setPrimaryAction 注册/清空', () => {
    setup();
    act(() => captured.setPrimaryAction({ label: 'X', onNext: () => {} }));
    expect(captured.primaryAction?.label).toBe('X');
    act(() => captured.setPrimaryAction(null));
    expect(captured.primaryAction).toBeNull();
  });

  it('setSummaryPrefix 注入/清空底栏摘要前缀（导入-17，STEP① 完成态「原始数据仅你可见 · 」）', () => {
    setup();
    expect(screen.getByTestId('summaryPrefix')).toHaveTextContent('none');
    act(() => captured.setSummaryPrefix('原始数据仅你可见 · '));
    expect(screen.getByTestId('summaryPrefix')).toHaveTextContent('原始数据仅你可见 ·');
    act(() => captured.setSummaryPrefix(undefined));
    expect(screen.getByTestId('summaryPrefix')).toHaveTextContent('none');
  });
});

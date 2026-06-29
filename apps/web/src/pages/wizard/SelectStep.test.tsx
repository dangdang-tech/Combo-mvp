// SelectStep 单测（F-12，§5.3 / 选择结构化-01~06/25/30）：
//   全部发布 vs 逐个选 / 单选互斥 / 选中改底栏主按钮 / 四项信息齐全 / 切换纯前端不打后端。
import { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CandidateView, SelectionDraft } from '@cb/shared';
import { WizardProvider, useWizard } from './WizardContext.js';
import { SelectStep } from './SelectStep.js';
import { WizardFooter } from './WizardFooter.js';
import { installFetchMock } from '../../test/mockFetch.js';

function candidate(over: Partial<CandidateView> = {}): CandidateView {
  return {
    id: 'c1',
    extractJobId: 'ej1',
    snapshotId: 's1',
    status: 'ready',
    name: '面向大厂 PM 的资格打分器',
    intent: '给 PM 候选人打分',
    slug: 'pm-scorer',
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

/** 把 SelectStep 接到底栏（验证主按钮随选择态变）+ 暴露当前 selection 以断言纯前端态。 */
function Harness({
  candidates,
  onNext,
  busy,
}: {
  candidates: CandidateView[];
  onNext?: (s: SelectionDraft) => void;
  busy?: boolean;
}) {
  return (
    <WizardProvider initialStep="select" initialDraftId="d1">
      <SelectStep
        candidates={candidates}
        {...(onNext ? { onNext } : {})}
        {...(busy !== undefined ? { busy } : {})}
      />
      <FooterProbe />
    </WizardProvider>
  );
}

function FooterProbe() {
  const { currentStep, primaryAction } = useWizard();
  return <WizardFooter currentStep={currentStep} primaryAction={primaryAction} />;
}

describe('SelectStep（STEP③ 选择）', () => {
  it('首屏：整体选项「全部发布」+「或逐个选定一个」列表，无加载态（选择结构化-01）', () => {
    render(<Harness candidates={[candidate(), candidate({ id: 'c2', name: 'VC 拷打模拟器' })]} />);
    expect(screen.getByText('全部发布（不逐个选）')).toBeInTheDocument();
    expect(screen.getByText('或逐个选定一个')).toBeInTheDocument();
    expect(screen.getByRole('radiogroup')).toBeInTheDocument();
    // 进来即最终内容：无 progressbar / 骨架。
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('每行四项齐全：名称/类型/段数/置信度（选择结构化-02）', () => {
    render(<Harness candidates={[candidate()]} />);
    const row = screen.getByRole('radio').closest('.cb-select__row') as HTMLElement;
    const u = within(row);
    expect(u.getByText('面向大厂 PM 的资格打分器')).toBeInTheDocument();
    expect(u.getByText('核心工作流')).toBeInTheDocument(); // 一句话类型
    expect(u.getByText('17 段')).toBeInTheDocument(); // 支撑段数
    expect(u.getByText('置信 86%')).toBeInTheDocument(); // scopeCoherence 0.86 → 86%
  });

  it('缺字段不显 undefined/空白，落人话兜底（选择结构化-02）', () => {
    render(
      <Harness
        candidates={[
          candidate({
            name: null,
            type: null,
            segmentCount: null,
            confidence: null,
            scopeCoherence: null,
          }),
        ]}
      />,
    );
    expect(screen.getByText('未命名能力')).toBeInTheDocument();
    expect(screen.getByText('— 段')).toBeInTheDocument();
    expect(screen.getByText('置信 —')).toBeInTheDocument();
    expect(screen.queryByText(/undefined/)).toBeNull();
  });

  it('置信度无 scopeCoherence 时退化为枚举「置信 高」', () => {
    render(<Harness candidates={[candidate({ scopeCoherence: null, confidence: 'high' })]} />);
    expect(screen.getByText('置信 高')).toBeInTheDocument();
  });

  it('选中单个 → 底栏主按钮变「下一步：结构化『X』→」（选择结构化-03）', async () => {
    render(<Harness candidates={[candidate()]} onNext={() => {}} />);
    await userEvent.click(screen.getByRole('radio'));
    expect(
      screen.getByRole('button', { name: /结构化『面向大厂 PM 的资格打分器』/ }),
    ).toBeInTheDocument();
  });

  it('单选互斥：选 B 自动取消 A（选择结构化-04）', async () => {
    render(
      <Harness
        candidates={[candidate(), candidate({ id: 'c2', name: 'VC 拷打模拟器' })]}
        onNext={() => {}}
      />,
    );
    const radios = screen.getAllByRole('radio');
    await userEvent.click(radios[0]!);
    await userEvent.click(radios[1]!);
    // 任意时刻只有一个选中。
    expect(radios.filter((r) => r.getAttribute('aria-checked') === 'true')).toHaveLength(1);
    expect(radios[1]).toHaveAttribute('aria-checked', 'true');
    expect(radios[0]).toHaveAttribute('aria-checked', 'false');
    // 主按钮名同步为 B。
    expect(screen.getByRole('button', { name: /结构化『VC 拷打模拟器』/ })).toBeInTheDocument();
  });

  it('全部发布：点整体选项 → 主按钮变「下一步：全部发布 N 项 →」（选择结构化-06，无子集时发布全部 ready）', async () => {
    render(<Harness candidates={[candidate(), candidate({ id: 'c2' })]} onNext={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: /全部发布（不逐个选）/ }));
    // 无子集进来 → 发布全部 ready 2 项，文案「全部发布 2 项」（非「这 N 项」，与真子集区分）。
    expect(screen.getByRole('button', { name: '下一步：全部发布 2 项 →' })).toBeInTheDocument();
    // 整体选项标选中。
    expect(screen.getByRole('button', { name: /全部发布（不逐个选）/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('全部发布 ↔ 逐个选 可来回切（选择结构化-05）', async () => {
    render(<Harness candidates={[candidate(), candidate({ id: 'c2' })]} onNext={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: /全部发布（不逐个选）/ }));
    expect(screen.getByRole('button', { name: '下一步：全部发布 2 项 →' })).toBeInTheDocument();
    // 切回逐个选：选一个，整体选项取消选中。
    await userEvent.click(screen.getAllByRole('radio')[0]!);
    expect(screen.getByRole('button', { name: /全部发布（不逐个选）/ })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('未选时主按钮禁用（既未选单个也未全选不可前进）', () => {
    render(<Harness candidates={[candidate()]} onNext={() => {}} />);
    expect(screen.getByRole('button', { name: /下一步/ })).toBeDisabled();
  });

  it('选择切换全程不打后端（纯前端即时，选择结构化-30）', async () => {
    const mock = installFetchMock({ status: 200, json: { data: {} } });
    try {
      render(<Harness candidates={[candidate(), candidate({ id: 'c2' })]} onNext={() => {}} />);
      await userEvent.click(screen.getAllByRole('radio')[0]!);
      await userEvent.click(screen.getByRole('button', { name: /全部发布（不逐个选）/ }));
      await userEvent.click(screen.getAllByRole('radio')[1]!);
      // 选择切换不触发任何 fetch（持久化只在「保存草稿」/进入下一步，本组件不打）。
      expect(mock.fn).not.toHaveBeenCalled();
    } finally {
      mock.restore();
    }
  });

  it('点主按钮 → onNext(当前 selection)；single 形态对', async () => {
    const onNext = vi.fn();
    render(<Harness candidates={[candidate()]} onNext={onNext} />);
    await userEvent.click(screen.getByRole('radio'));
    await userEvent.click(screen.getByRole('button', { name: /结构化/ }));
    expect(onNext).toHaveBeenCalledWith({ mode: 'single', candidateId: 'c1' });
  });

  it('全部发布 onNext → subset 形态带全部候选 id（新规范模式，绝不写 all，Codex r6 P1）', async () => {
    const onNext = vi.fn();
    render(<Harness candidates={[candidate(), candidate({ id: 'c2' })]} onNext={onNext} />);
    await userEvent.click(screen.getByRole('button', { name: /全部发布（不逐个选）/ }));
    await userEvent.click(screen.getByRole('button', { name: '下一步：全部发布 2 项 →' }));
    // 反向破坏：若回退把全部发布写成 mode:'all'，此断言测红（subset 才是新规范，后端按子集闸校验）。
    expect(onNext).toHaveBeenCalledWith({ mode: 'subset', candidateIds: ['c1', 'c2'] });
  });

  it('busy=true：主按钮显「处理中…」并禁用（推进在途防重复点）', () => {
    render(<Harness candidates={[candidate()]} onNext={() => {}} busy />);
    const btn = screen.getByRole('button', { name: '处理中…' });
    expect(btn).toBeInTheDocument();
    expect(btn).toBeDisabled();
  });

  it('busy 由 true → false（推进结束）→ 主按钮按当前选择恢复可点，不卡死', () => {
    // 已选中单个 + busy；推进结束（busy=false）后按钮必须恢复为可点的「下一步：结构化『X』」，不残留忙态。
    function ToggleHarness() {
      const { setSelection, primaryAction, currentStep } = useWizard();
      const [busy, setBusy] = useState(true);
      return (
        <>
          <button type="button" onClick={() => setSelection({ mode: 'single', candidateId: 'c1' })}>
            选中c1
          </button>
          <button type="button" onClick={() => setBusy(false)}>
            结束推进
          </button>
          <SelectStep candidates={[candidate()]} onNext={() => {}} busy={busy} />
          <WizardFooter currentStep={currentStep} primaryAction={primaryAction} />
        </>
      );
    }
    render(
      <WizardProvider initialStep="select" initialDraftId="d1">
        <ToggleHarness />
      </WizardProvider>,
    );
    // 推进在途：底栏主按钮忙态禁用。
    expect(screen.getByRole('button', { name: '处理中…' })).toBeDisabled();
    // 先选中（busy 仍 true 时选择态已写）。
    fireEvent.click(screen.getByRole('button', { name: '选中c1' }));
    // 推进结束（busy=false）→ 注册 effect 重跑，按当前选择恢复可点按钮（反向破坏：若 busy 单写不复位则此处仍忙态/禁用，测红）。
    fireEvent.click(screen.getByRole('button', { name: '结束推进' }));
    const restored = screen.getByRole('button', { name: /结构化『面向大厂 PM 的资格打分器』/ });
    expect(restored).toBeEnabled();
    expect(screen.queryByRole('button', { name: '处理中…' })).toBeNull();
  });

  it('无候选：空态引导 + 全部发布禁用（空子集非法）', () => {
    render(<Harness candidates={[]} onNext={() => {}} />);
    expect(screen.getByText(/没有可选的能力/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /全部发布（不逐个选）/ })).toBeDisabled();
  });

  it('STEP② 带子集进来（subset 2/3，N<total）→ 全部发布 = 发布【这 2 项】、文案带 N 与「全部」区分（§5.2）', async () => {
    // 进来即 subset(c1,c2)（STEP② 勾 2/9 的缩样：3 个候选里勾 2 个）。
    const onNext = vi.fn();
    function Wrap() {
      const { setSelection, primaryAction, currentStep } = useWizard();
      return (
        <>
          <SelectStep
            candidates={[
              candidate(),
              candidate({ id: 'c2', name: 'VC 拷打模拟器' }),
              candidate({ id: 'c3', name: '保单条款比对器' }),
            ]}
            onNext={onNext}
          />
          <button
            type="button"
            onClick={() => setSelection({ mode: 'subset', candidateIds: ['c1', 'c2'] })}
          >
            预置子集
          </button>
          <WizardFooter currentStep={currentStep} primaryAction={primaryAction} />
        </>
      );
    }
    render(
      <WizardProvider initialStep="select" initialDraftId="d1">
        <Wrap />
      </WizardProvider>,
    );
    // 预置 STEP② 子集 2/3（c1,c2）。
    await userEvent.click(screen.getByRole('button', { name: '预置子集' }));
    // 顶部整体选项标选中（subset 即批量态），副文显「已勾选的 2 项」。
    expect(screen.getByRole('button', { name: /全部发布（不逐个选）/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByText(/已勾选的 2 项/)).toBeInTheDocument();
    // 底栏文案区分真子集：「全部发布这 2 项」（非「全部发布 N 项」、非歧义「全部发布」）。
    expect(screen.getByRole('button', { name: '下一步：全部发布这 2 项 →' })).toBeInTheDocument();
    // 进下一步 → onNext 拿到 subset(c1,c2) 原样（一对一建批由发布模块据它做，§2.3）。
    await userEvent.click(screen.getByRole('button', { name: '下一步：全部发布这 2 项 →' }));
    expect(onNext).toHaveBeenCalledWith({ mode: 'subset', candidateIds: ['c1', 'c2'] });
  });

  it('旧草稿续传带兼容别名 all 进来 → 仍识别为批量态（向后兼容，§4.G）', async () => {
    function Wrap() {
      const { setSelection, primaryAction, currentStep } = useWizard();
      return (
        <>
          <SelectStep candidates={[candidate(), candidate({ id: 'c2' })]} onNext={() => {}} />
          <button
            type="button"
            onClick={() => setSelection({ mode: 'all', candidateIds: ['c1', 'c2'] })}
          >
            预置all
          </button>
          <WizardFooter currentStep={currentStep} primaryAction={primaryAction} />
        </>
      );
    }
    render(
      <WizardProvider initialStep="select" initialDraftId="d1">
        <Wrap />
      </WizardProvider>,
    );
    await userEvent.click(screen.getByRole('button', { name: '预置all' }));
    // all 别名 = 全 ready 2 项 → 非真子集，文案「全部发布 2 项」，整体选项选中。
    expect(screen.getByRole('button', { name: /全部发布（不逐个选）/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: '下一步：全部发布 2 项 →' })).toBeInTheDocument();
  });
});

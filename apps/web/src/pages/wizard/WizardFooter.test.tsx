// WizardFooter 单测（F-09 底栏恒定）：左步骤摘要 + 右动态主按钮（默认/注册/禁用/busy/末步/前缀）。
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WizardFooter } from './WizardFooter.js';

describe('WizardFooter', () => {
  it('左摘要「第 X 步，共 5 步」', () => {
    render(<WizardFooter currentStep="import" primaryAction={null} />);
    expect(screen.getByText('第 1 步，共 5 步')).toBeInTheDocument();
  });

  it('摘要前缀可注入（如「原始数据仅你可见 · 」5.1.3）', () => {
    render(
      <WizardFooter
        currentStep="import"
        primaryAction={null}
        summaryPrefix="原始数据仅你可见 · "
      />,
    );
    expect(screen.getByText('原始数据仅你可见 · 第 1 步，共 5 步')).toBeInTheDocument();
  });

  it('未注册主按钮 → 用机器默认文案「下一步：（动态步骤名）→」且禁用', () => {
    render(<WizardFooter currentStep="import" primaryAction={null} />);
    const btn = screen.getByRole('button');
    expect(btn).toHaveTextContent('下一步：提取能力项 →');
    expect(btn).toBeDisabled();
  });

  it('注册 onNext + label → 显注册文案、可点、触发 onNext', async () => {
    const onNext = vi.fn();
    render(
      <WizardFooter
        currentStep="select"
        primaryAction={{ label: '下一步：结构化『资格打分器』 →', onNext }}
      />,
    );
    const btn = screen.getByRole('button', { name: /结构化『资格打分器』/ });
    expect(btn).toBeEnabled();
    await userEvent.click(btn);
    expect(onNext).toHaveBeenCalledOnce();
  });

  it('enabled=false → 主按钮禁用（该步未就绪）', () => {
    render(<WizardFooter currentStep="select" primaryAction={{ enabled: false }} />);
    expect(screen.getByRole('button')).toBeDisabled();
  });

  it('busy → 显「处理中…」并禁用（防重复点）', () => {
    const onNext = vi.fn();
    render(<WizardFooter currentStep="select" primaryAction={{ onNext, busy: true }} />);
    const btn = screen.getByRole('button');
    expect(btn).toHaveTextContent('处理中…');
    expect(btn).toBeDisabled();
  });

  it('末步主按钮默认「完成发布」（非「下一步」）', () => {
    const onNext = vi.fn();
    render(<WizardFooter currentStep="publish" primaryAction={{ onNext }} />);
    expect(screen.getByRole('button')).toHaveTextContent('完成发布');
  });
});

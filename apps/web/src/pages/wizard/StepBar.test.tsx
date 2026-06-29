// StepBar 单测（F-09 步骤条五态）：四态渲染 + 已完成/异常可点回看 + 待办/进行中不可点 + aria-current。
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StepBar } from './StepBar.js';
import { buildStepNodes } from './wizardMachine.js';

describe('StepBar', () => {
  it('渲染五段，状态文案齐全（已完成/进行中/待办/异常）', () => {
    const nodes = buildStepNodes('structure', { extract: true });
    render(<StepBar nodes={nodes} onNavigate={() => {}} />);
    // import=done, extract=error(覆写), select=done, structure=current, publish=todo
    expect(screen.getAllByText('已完成').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('进行中')).toBeInTheDocument();
    expect(screen.getByText('待办')).toBeInTheDocument();
    expect(screen.getByText('异常')).toBeInTheDocument();
  });

  it('进行中段标 aria-current="step"', () => {
    const nodes = buildStepNodes('select');
    const { container } = render(<StepBar nodes={nodes} onNavigate={() => {}} />);
    const current = container.querySelector('[data-step="select"]');
    expect(current).toHaveAttribute('aria-current', 'step');
  });

  it('点已完成步 → onNavigate(该步)（回看，贯穿-16）', async () => {
    const onNavigate = vi.fn();
    const nodes = buildStepNodes('select'); // import/extract done
    render(<StepBar nodes={nodes} onNavigate={onNavigate} />);
    await userEvent.click(screen.getByRole('button', { name: /第 1 步.*点击回看/ }));
    expect(onNavigate).toHaveBeenCalledWith('import');
  });

  it('待办步不可点（不是 button，无回看）', () => {
    const nodes = buildStepNodes('import'); // publish=todo
    const { container } = render(<StepBar nodes={nodes} onNavigate={() => {}} />);
    const publishSeg = container.querySelector('[data-step="publish"]');
    expect(publishSeg?.querySelector('button')).toBeNull();
  });

  it('异常步可点（进去重试，带退路）', async () => {
    const onNavigate = vi.fn();
    const nodes = buildStepNodes('structure', { extract: true });
    render(<StepBar nodes={nodes} onNavigate={onNavigate} />);
    const errBtn = screen.getAllByRole('button').find((b) => b.closest('[data-step="extract"]'));
    expect(errBtn).toBeDefined();
    await userEvent.click(errBtn!);
    expect(onNavigate).toHaveBeenCalledWith('extract');
  });

  it('已完成段记号 = 对勾、异常段 = ✕', () => {
    const nodes = buildStepNodes('structure', { extract: true });
    const { container } = render(<StepBar nodes={nodes} onNavigate={() => {}} />);
    expect(container.querySelector('[data-step="import"] .cb-stepbar__mark')?.textContent).toBe(
      '✓',
    );
    expect(container.querySelector('[data-step="extract"] .cb-stepbar__mark')?.textContent).toBe(
      '✕',
    );
    // 待办段记号 = 序号数字。
    expect(container.querySelector('[data-step="publish"] .cb-stepbar__mark')?.textContent).toBe(
      '5',
    );
  });
});

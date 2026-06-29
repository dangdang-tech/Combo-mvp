// SlowHint 测试：slow_hint 安抚 + field_stuck 三退路（continue/regen/wait），二者皆非错误。
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SlowHint } from './SlowHint.js';

describe('SlowHint', () => {
  it('无 slowHint 且无 stuck → 不渲染', () => {
    const { container } = render(<SlowHint />);
    expect(container.firstChild).toBeNull();
  });

  it('slow_hint → 显示安抚文案 + 等待时长（非错误，无退路按钮）', () => {
    render(<SlowHint slowHint={{ phrase: '内容较多，正在认真生成…', elapsedMs: 12000 }} />);
    expect(screen.getByText(/内容较多，正在认真生成…/)).toBeInTheDocument();
    expect(screen.getByText(/已等待约 12 秒/)).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('elapsedMs 超过 1 分钟 → 文案改用「分钟」', () => {
    render(<SlowHint slowHint={{ phrase: 'x', elapsedMs: 120000 }} />);
    expect(screen.getByText(/已等待约 2 分钟/)).toBeInTheDocument();
  });

  it('field_stuck → 渲染三退路按钮（人话标签）', () => {
    render(
      <SlowHint
        stuck={{ field: 'tagline', elapsedMs: 30000, options: ['continue', 'regen', 'wait'] }}
      />,
    );
    expect(screen.getByRole('button', { name: '继续用已生成' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重新生成' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '再等等' })).toBeInTheDocument();
  });

  it('点退路按钮回传被选 option', async () => {
    const onStuckChoice = vi.fn();
    render(
      <SlowHint
        stuck={{ field: 'tagline', elapsedMs: 30000, options: ['continue', 'regen', 'wait'] }}
        onStuckChoice={onStuckChoice}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: '重新生成' }));
    expect(onStuckChoice).toHaveBeenCalledWith('regen');
  });

  it('field_stuck 只给后端列出的 options（不臆造退路）', () => {
    render(<SlowHint stuck={{ field: 'goal', elapsedMs: 5000, options: ['wait'] }} />);
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.getByRole('button', { name: '再等等' })).toBeInTheDocument();
  });
});

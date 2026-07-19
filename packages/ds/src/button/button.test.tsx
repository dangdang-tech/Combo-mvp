import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Button, type ButtonProps } from './button';

describe('Button', () => {
  afterEach(cleanup);

  it('纯 JSON props（不含任何函数）即可渲染出正确内容与变体', () => {
    const props: ButtonProps = {
      variant: 'primary',
      size: 'lg',
      type: 'submit',
      children: '发布经验体',
    };
    render(<Button {...props} />);
    const btn = screen.getByRole('button', { name: '发布经验体' });
    expect(btn).toBeInTheDocument();
    expect(btn).toHaveAttribute('type', 'submit');
    expect(btn.className).toContain('cb-btn--primary');
    expect(btn.className).toContain('cb-btn--lg');
  });

  it('默认渲染为 secondary 中号、type=button 且可用', () => {
    const props: ButtonProps = { children: '保存' };
    render(<Button {...props} />);
    const btn = screen.getByRole('button', { name: '保存' });
    expect(btn).toHaveAttribute('type', 'button');
    expect(btn.className).toContain('cb-btn--secondary');
    expect(btn.className).toContain('cb-btn--md');
    expect(btn).toBeEnabled();
  });

  it('loading 为纯 JSON 状态：渲染 spinner、标记 aria-busy 并禁用按钮', () => {
    const props: ButtonProps = { variant: 'primary', loading: true, children: '正在发布' };
    const { container } = render(<Button {...props} />);
    const btn = screen.getByRole('button', { name: '正在发布' });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('aria-busy', 'true');
    expect(container.querySelector('.cb-btn-spinner')).not.toBeNull();
  });

  it('disabled 为纯 JSON 状态且不渲染 spinner', () => {
    const props: ButtonProps = { disabled: true, children: '发布' };
    const { container } = render(<Button {...props} />);
    expect(screen.getByRole('button', { name: '发布' })).toBeDisabled();
    expect(container.querySelector('.cb-btn-spinner')).toBeNull();
  });

  it('onClick 是可选行为增强：点击时触发一次', () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>保存</Button>);
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('disabled 或 loading 时点击不触发 onClick', () => {
    const onClick = vi.fn();
    render(
      <div>
        <Button disabled onClick={onClick}>
          禁用
        </Button>
        <Button loading onClick={onClick}>
          加载
        </Button>
      </div>,
    );
    fireEvent.click(screen.getByRole('button', { name: '禁用' }));
    fireEvent.click(screen.getByRole('button', { name: '加载' }));
    expect(onClick).not.toHaveBeenCalled();
  });
});

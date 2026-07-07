import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Input } from './input';

// vitest 未开启 globals，@testing-library/react 的自动清理不会注册，需手动清理。
afterEach(cleanup);

describe('Input', () => {
  it('纯 JSON props（不含任何函数）即可渲染出 label 关联、当前值与校验失败态', () => {
    const props = {
      label: '店铺名称',
      value: '女装主推款',
      invalid: true,
      placeholder: '请输入',
    };
    render(<Input {...props} />);
    const input = screen.getByLabelText('店铺名称');
    expect(input).toHaveValue('女装主推款');
    expect(input).toHaveAttribute('aria-invalid', 'true');
  });

  it('search 型渲染内嵌放大镜图标，且不传 label 时不渲染 label 元素', () => {
    const { container } = render(<Input type="search" placeholder="搜索经验体" />);
    expect(container.querySelector('.cb-input-icon')).toBeInTheDocument();
    expect(container.querySelector('label')).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText('搜索经验体')).toHaveAttribute('type', 'search');
  });

  it('传入 id 时 label 通过该 id 关联输入框', () => {
    render(<Input label="邮箱" id="email-input" />);
    expect(screen.getByLabelText('邮箱')).toHaveAttribute('id', 'email-input');
  });

  it('onChange 作为可选行为增强：输入时以字符串值回调', () => {
    const onChange = vi.fn();
    render(<Input label="标签" onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('标签'), { target: { value: 'ctr-判断' } });
    expect(onChange).toHaveBeenCalledWith('ctr-判断');
  });

  it('disabled 时输入框处于禁用状态', () => {
    render(<Input label="编号" disabled />);
    expect(screen.getByLabelText('编号')).toBeDisabled();
  });
});

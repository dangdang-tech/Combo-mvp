import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ListItem, type ListItemProps } from './list-item';

describe('ListItem', () => {
  it('纯 JSON props（不含任何函数）即可渲染完整视觉状态，且渲染为 div', () => {
    const props: ListItemProps = {
      title: '会话标题',
      description: '一段描述文字',
      leading: 'L',
      trailing: '09:41',
      selected: true,
    };
    const { container } = render(<ListItem {...props} />);
    expect(screen.getByText('会话标题')).toBeInTheDocument();
    expect(screen.getByText('一段描述文字')).toBeInTheDocument();
    expect(screen.getByText('L')).toBeInTheDocument();
    expect(screen.getByText('09:41')).toBeInTheDocument();
    const el = container.querySelector('.cb-list-item');
    expect(el?.tagName).toBe('DIV');
    expect(el).toHaveClass('cb-list-item--selected');
    expect(el).not.toHaveClass('cb-list-item--interactive');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('只传 title 也能渲染，不产出空的 leading、description、trailing 节点', () => {
    const { container } = render(<ListItem title="仅标题" />);
    expect(screen.getByText('仅标题')).toBeInTheDocument();
    expect(container.querySelector('.cb-list-item-leading')).toBeNull();
    expect(container.querySelector('.cb-list-item-description')).toBeNull();
    expect(container.querySelector('.cb-list-item-trailing')).toBeNull();
  });

  it('提供 onClick 时渲染为原生 button（键盘可达）并可点击触发', () => {
    const onClick = vi.fn();
    render(<ListItem title="可点击行" onClick={onClick} />);
    const button = screen.getByRole('button', { name: '可点击行' });
    expect(button.tagName).toBe('BUTTON');
    expect(button).toHaveClass('cb-list-item--interactive');
    button.focus();
    expect(button).toHaveFocus();
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('选中且可点击时同时带 selected 类与 aria-current', () => {
    const onClick = vi.fn();
    render(<ListItem title="当前条目" selected={true} onClick={onClick} />);
    const button = screen.getByRole('button', { name: '当前条目' });
    expect(button).toHaveClass('cb-list-item--selected');
    expect(button).toHaveAttribute('aria-current', 'true');
  });
});

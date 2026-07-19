import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { EmptyState } from './empty-state';

describe('EmptyState', () => {
  it('纯 JSON props（只有字符串）即可渲染出标题与描述', () => {
    const props = {
      title: '还没有经验体',
      description: '从一段真实会话历史开始沉淀。',
    };
    render(<EmptyState {...props} />);
    expect(screen.getByRole('heading', { name: '还没有经验体' })).toBeInTheDocument();
    expect(screen.getByText('从一段真实会话历史开始沉淀。')).toBeInTheDocument();
  });

  it('不传 icon 与 description 时对应区域不渲染', () => {
    const { container } = render(<EmptyState title="空空如也" />);
    expect(container.querySelector('.cb-empty-state-icon')).toBeNull();
    expect(container.querySelector('.cb-empty-state-description')).toBeNull();
    expect(container.querySelector('.cb-empty-state-action')).toBeNull();
    expect(screen.getByRole('heading', { name: '空空如也' })).toBeInTheDocument();
  });

  it('icon 与 action 插槽内容渲染到对应区域', () => {
    const { container } = render(
      <EmptyState
        title="收件箱是空的"
        icon={<svg data-testid="icon" />}
        action={<button type="button">导入会话历史</button>}
      />,
    );
    expect(container.querySelector('.cb-empty-state-icon [data-testid="icon"]')).not.toBeNull();
    const action = screen.getByRole('button', { name: '导入会话历史' });
    expect(action.closest('.cb-empty-state-action')).not.toBeNull();
  });

  it('根节点使用 cb-empty-state 类名', () => {
    const { container } = render(<EmptyState title="标题" />);
    expect(container.querySelector('.cb-empty-state')).not.toBeNull();
  });
});

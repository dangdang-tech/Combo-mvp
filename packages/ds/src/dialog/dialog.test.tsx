import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Dialog } from './dialog';

// vitest 未开启 globals，@testing-library/react 的自动清理不会注册，
// 而 Radix 的 portal 挂在 document.body 上，不手动清理会串到下一个用例。
afterEach(cleanup);

describe('Dialog', () => {
  it('open 为 true 且 props 不含任何函数时渲染标题、描述、正文与底部操作区', () => {
    const props = {
      open: true,
      title: '发布经验体',
      description: '发布后其他店铺可以订阅使用。',
      footer: <span>底部操作区</span>,
    };
    render(
      <Dialog {...props}>
        <p>正文内容</p>
      </Dialog>,
    );
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('发布经验体')).toBeInTheDocument();
    expect(screen.getByText('发布后其他店铺可以订阅使用。')).toBeInTheDocument();
    expect(screen.getByText('正文内容')).toBeInTheDocument();
    expect(screen.getByText('底部操作区')).toBeInTheDocument();
  });

  it('open 为 false 时不渲染对话框', () => {
    render(<Dialog open={false} title="不该出现" />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByText('不该出现')).not.toBeInTheDocument();
  });

  it('description 与 footer 缺省时只渲染标题与关闭钮', () => {
    render(<Dialog open title="最小形态" />);
    expect(screen.getByText('最小形态')).toBeInTheDocument();
    expect(document.querySelector('.cb-dialog-description')).not.toBeInTheDocument();
    expect(document.querySelector('.cb-dialog-footer')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '关闭' })).toBeInTheDocument();
  });

  it('点击右上关闭钮时以 false 回调 onOpenChange', () => {
    const onOpenChange = vi.fn();
    render(<Dialog open onOpenChange={onOpenChange} title="可关闭" />);
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('按 Esc 时以 false 回调 onOpenChange', () => {
    const onOpenChange = vi.fn();
    render(<Dialog open onOpenChange={onOpenChange} title="可关闭" />);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

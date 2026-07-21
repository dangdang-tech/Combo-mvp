import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CloudReviewBar } from './CloudReviewBar.js';

describe('CloudReviewBar', () => {
  it('正式环境不渲染预览标识', () => {
    render(<CloudReviewBar environment="production" build="abcdef123456" />);
    expect(screen.queryByLabelText('预览环境')).toBeNull();
  });

  it('预览环境默认只显示胶囊，点击后才展开详情', async () => {
    const user = userEvent.setup();
    render(<CloudReviewBar environment="preview" build="abcdef123456" />);

    const trigger = screen.getByRole('button', { name: '预览环境' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('region', { name: '预览环境详情' })).toBeNull();

    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('region', { name: '预览环境详情' })).toHaveTextContent(
      '这里的数据与正式环境隔离',
    );
    expect(screen.getByText('版本 abcdef12')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '打开正式环境 ↗' })).toHaveAttribute(
      'target',
      '_blank',
    );
  });

  it('Escape 收起详情并把焦点交还胶囊', async () => {
    const user = userEvent.setup();
    render(<CloudReviewBar environment="preview" build="abcdef123456" />);

    const trigger = screen.getByRole('button', { name: '预览环境' });
    await user.click(trigger);
    await user.keyboard('{Escape}');

    expect(screen.queryByRole('region', { name: '预览环境详情' })).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it('点击胶囊之外会收起详情', async () => {
    const user = userEvent.setup();
    render(
      <div>
        <CloudReviewBar environment="preview" build="abcdef123456" />
        <button type="button">页面内容</button>
      </div>,
    );

    await user.click(screen.getByRole('button', { name: '预览环境' }));
    await user.click(screen.getByRole('button', { name: '页面内容' }));

    expect(screen.queryByRole('region', { name: '预览环境详情' })).toBeNull();
  });
});

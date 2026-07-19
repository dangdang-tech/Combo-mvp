import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { MiniAppShell, type MiniAppShellProps } from './mini-app-shell';

afterEach(cleanup);

describe('MiniAppShell', () => {
  it('纯 JSON props（不含任何函数）即可渲染出标题、副标题、状态、actions、内容与 footer', () => {
    const props: MiniAppShellProps = {
      title: '主推款 CTR 判断',
      subtitle: 'exp-0042 · v3',
      status: 'ok',
      actions: '导出',
      footer: '来自 12 条会话沉淀',
      children: '本周主推款建议选 A 款。',
    };
    render(<MiniAppShell {...props} />);
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('主推款 CTR 判断');
    expect(screen.getByText('exp-0042 · v3')).toBeInTheDocument();
    expect(screen.getByText('ok')).toBeInTheDocument();
    expect(screen.getByText('导出')).toBeInTheDocument();
    expect(screen.getByText('来自 12 条会话沉淀')).toBeInTheDocument();
    expect(screen.getByText('本周主推款建议选 A 款。')).toBeInTheDocument();
  });

  it('只传必填 props 时不渲染副标题、状态、actions 与 footer', () => {
    const { container } = render(<MiniAppShell title="最小形态">内容</MiniAppShell>);
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('最小形态');
    expect(container.querySelector('.cb-mini-app-shell-subtitle')).toBeNull();
    expect(container.querySelector('.cb-mini-app-shell-status')).toBeNull();
    expect(container.querySelector('.cb-mini-app-shell-actions')).toBeNull();
    expect(container.querySelector('.cb-mini-app-shell-footer')).toBeNull();
  });

  it('status 三个枚举值分别渲染对应的状态类名与等宽状态词', () => {
    const statuses: MiniAppShellProps['status'][] = ['running', 'ok', 'error'];
    for (const status of statuses) {
      const { container, unmount } = render(
        <MiniAppShell title="状态" status={status}>
          内容
        </MiniAppShell>,
      );
      const el = container.querySelector(`.cb-mini-app-shell-status--${status}`);
      expect(el).not.toBeNull();
      expect(el).toHaveTextContent(String(status));
      expect(container.querySelector('.cb-mini-app-shell-dot')).not.toBeNull();
      unmount();
    }
  });

  it('容器带 cb-mini-app-shell 类，内容渲染在 body 区、footer 渲染在分隔区', () => {
    const { container } = render(
      <MiniAppShell title="结构" footer="页脚">
        正文
      </MiniAppShell>,
    );
    expect(container.querySelector('.cb-mini-app-shell')).not.toBeNull();
    expect(container.querySelector('.cb-mini-app-shell-body')).toHaveTextContent('正文');
    expect(container.querySelector('.cb-mini-app-shell-footer')).toHaveTextContent('页脚');
  });
});

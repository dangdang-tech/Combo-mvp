import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Citation, type CitationProps } from './citation';

// vitest 未开启 globals，@testing-library/react 不会自动清理，需要显式 cleanup。
afterEach(cleanup);

describe('Citation', () => {
  it('纯 JSON props（不含任何函数）即可渲染出序号徽标、链接与引文块', () => {
    const props: CitationProps = {
      label: '复盘会话 6-12',
      href: 'https://example.com/a',
      quote: '投放前 48 小时的自然流量爬坡曲线是最强的先验信号。',
      index: 2,
    };
    expect(Object.values(props).some((v) => typeof v === 'function')).toBe(false);
    const { container } = render(<Citation {...props} />);

    expect(screen.getByText('[2]')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: '复盘会话 6-12' });
    expect(link).toHaveAttribute('href', 'https://example.com/a');
    expect(link).toHaveClass('cb-citation-link');
    expect(screen.getByText('投放前 48 小时的自然流量爬坡曲线是最强的先验信号。')).toHaveClass(
      'cb-citation-quote',
    );
    expect(container.querySelector('.cb-citation')).not.toBeNull();
  });

  it('没有 href 时 label 渲染为普通文字而不是链接', () => {
    render(<Citation label="2026-06-12 会话记录" />);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('2026-06-12 会话记录')).toHaveClass('cb-citation-label');
  });

  it('没有 quote 时不渲染引文块，没有 index 时不渲染序号徽标', () => {
    const { container } = render(<Citation label="投放笔记" />);
    expect(container.querySelector('.cb-citation-quote')).toBeNull();
    expect(container.querySelector('.cb-citation-index')).toBeNull();
  });

  it('index 为 0 时仍渲染 [0] 徽标（不因 falsy 被吞掉）', () => {
    render(<Citation label="来源" index={0} />);
    expect(screen.getByText('[0]')).toBeInTheDocument();
  });
});

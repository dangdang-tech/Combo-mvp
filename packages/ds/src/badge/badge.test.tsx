import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Badge, type BadgeProps } from './badge';

describe('Badge', () => {
  afterEach(cleanup);

  it('纯 JSON props（不含任何函数）即可渲染出正确内容与变体', () => {
    const props: BadgeProps = { variant: 'ok', children: '已发布' };
    render(<Badge {...props} />);
    const badge = screen.getByText('已发布');
    expect(badge).toBeInTheDocument();
    expect(badge.className).toContain('cb-badge--ok');
  });

  it('默认渲染为 neutral 变体', () => {
    const props: BadgeProps = { children: 'DRAFT' };
    render(<Badge {...props} />);
    expect(screen.getByText('DRAFT').className).toContain('cb-badge--neutral');
  });

  it('五种变体都渲染对应类名', () => {
    const variants = ['neutral', 'ok', 'warn', 'danger', 'accent'] as const;
    render(
      <div>
        {variants.map((variant) => (
          <Badge key={variant} variant={variant}>
            {`标签-${variant}`}
          </Badge>
        ))}
      </div>,
    );
    for (const variant of variants) {
      expect(screen.getByText(`标签-${variant}`).className).toContain(`cb-badge--${variant}`);
    }
  });

  it('超长文本内容照常渲染，不丢字符', () => {
    const long = '这是一个来自上游数据未经截断的特别长的状态标签文本';
    const props: BadgeProps = { variant: 'warn', children: long };
    render(<Badge {...props} />);
    expect(screen.getByText(long)).toBeInTheDocument();
  });
});

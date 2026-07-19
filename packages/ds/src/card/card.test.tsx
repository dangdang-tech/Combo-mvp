import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Card, type CardProps } from './card';

describe('Card', () => {
  it('纯 JSON props（不含任何函数）即可渲染出内容与变体类名', () => {
    const props: CardProps = { variant: 'hero', padding: 'lg', children: '经验体首屏' };
    const { container } = render(<Card {...props} />);
    expect(screen.getByText('经验体首屏')).toBeInTheDocument();
    const el = container.querySelector('.cb-card');
    expect(el).not.toBeNull();
    expect(el).toHaveClass('cb-card--hero');
    expect(el).toHaveClass('cb-card--pad-lg');
  });

  it('默认变体是 surface，默认内边距是 md', () => {
    const { container } = render(<Card>默认卡片</Card>);
    const el = container.querySelector('.cb-card');
    expect(el).toHaveClass('cb-card--surface');
    expect(el).toHaveClass('cb-card--pad-md');
  });

  it('三种 variant 与 none 内边距分别产出对应类名', () => {
    const { container } = render(
      <Card variant="raised" padding="none">
        抬升卡片
      </Card>,
    );
    const el = container.querySelector('.cb-card');
    expect(el).toHaveClass('cb-card--raised');
    expect(el).toHaveClass('cb-card--pad-none');
    expect(el).not.toHaveClass('cb-card--surface');
  });

  it('children 可以是任意 ReactNode，嵌套结构原样渲染', () => {
    render(
      <Card>
        <h3>标题</h3>
        <p>正文</p>
      </Card>,
    );
    expect(screen.getByRole('heading', { name: '标题' })).toBeInTheDocument();
    expect(screen.getByText('正文')).toBeInTheDocument();
  });
});

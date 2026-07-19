import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Heading, Text, type HeadingProps, type TextProps } from './text';

afterEach(cleanup);

describe('Text', () => {
  it('纯 JSON props（不含任何函数）即可渲染出正文内容', () => {
    const props: TextProps = { variant: 'body', as: 'p', children: '纯数据渲染' };
    expect(Object.values(props).some((v) => typeof v === 'function')).toBe(false);
    render(<Text {...props} />);
    const el = screen.getByText('纯数据渲染');
    expect(el.tagName).toBe('P');
    expect(el).toHaveClass('cb-text', 'cb-text--body');
  });

  it('默认 variant 为 body、默认标签为 p', () => {
    render(<Text>默认形态</Text>);
    const el = screen.getByText('默认形态');
    expect(el.tagName).toBe('P');
    expect(el).toHaveClass('cb-text--body');
  });

  it('variant 映射为对应的修饰 class', () => {
    render(
      <>
        <Text variant="muted">弱化</Text>
        <Text variant="caption">注脚</Text>
        <Text variant="label">标签</Text>
      </>,
    );
    expect(screen.getByText('弱化')).toHaveClass('cb-text--muted');
    expect(screen.getByText('注脚')).toHaveClass('cb-text--caption');
    expect(screen.getByText('标签')).toHaveClass('cb-text--label');
  });

  it('as 决定渲染标签', () => {
    render(
      <>
        <Text as="span">行内</Text>
        <Text as="div">块级</Text>
      </>,
    );
    expect(screen.getByText('行内').tagName).toBe('SPAN');
    expect(screen.getByText('块级').tagName).toBe('DIV');
  });
});

describe('Heading', () => {
  it('纯 JSON props 渲染出对应层级的标题标签', () => {
    const props: HeadingProps = { level: 2, children: '二级标题' };
    expect(Object.values(props).some((v) => typeof v === 'function')).toBe(false);
    render(<Heading {...props} />);
    const el = screen.getByRole('heading', { level: 2, name: '二级标题' });
    expect(el.tagName).toBe('H2');
    expect(el).toHaveClass('cb-heading', 'cb-heading--2');
  });

  it('level 1 到 4 分别渲染 h1 到 h4', () => {
    render(
      <>
        <Heading level={1}>一</Heading>
        <Heading level={2}>二</Heading>
        <Heading level={3}>三</Heading>
        <Heading level={4}>四</Heading>
      </>,
    );
    expect(screen.getByRole('heading', { level: 1 }).tagName).toBe('H1');
    expect(screen.getByRole('heading', { level: 2 }).tagName).toBe('H2');
    expect(screen.getByRole('heading', { level: 3 }).tagName).toBe('H3');
    expect(screen.getByRole('heading', { level: 4 }).tagName).toBe('H4');
  });
});

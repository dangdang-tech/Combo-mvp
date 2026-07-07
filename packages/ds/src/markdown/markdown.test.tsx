import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Markdown, type MarkdownProps } from './markdown';

afterEach(cleanup);

describe('Markdown', () => {
  it('纯 JSON props（不含任何函数）即可渲染出标题、正文与列表', () => {
    const props: MarkdownProps = {
      content: '# 复盘要点\n\n这是正文段落。\n\n- 第一条\n- 第二条',
    };
    render(<Markdown {...props} />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('复盘要点');
    expect(screen.getByText('这是正文段落。')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  it('注入的 <script> 标签会被整体剥掉', () => {
    const { container } = render(
      <Markdown content={'正常文字\n\n<script>window.alert("xss")</script>'} />,
    );
    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).toContain('正常文字');
    expect(container.innerHTML).not.toContain('alert');
  });

  it('img 上注入的 onerror 事件属性会被剥掉', () => {
    const { container } = render(
      <Markdown content={'<img src="x" onerror="window.alert(1)" alt="头像" />'} />,
    );
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img).not.toHaveAttribute('onerror');
    expect(container.innerHTML).not.toContain('onerror');
  });

  it('svg 与 mathml 标签会被剥掉（USE_PROFILES 只放行常规 HTML）', () => {
    const { container } = render(
      <Markdown content={'<svg><circle r="1" /></svg><math><mi>x</mi></math>文字保留'} />,
    );
    expect(container.querySelector('svg')).toBeNull();
    expect(container.querySelector('math')).toBeNull();
    expect(container.textContent).toContain('文字保留');
  });

  it('渲染行内代码、代码块、链接、引用与表格', () => {
    const content = [
      '用 `pnpm build` 构建。',
      '',
      '```',
      'const a = 1;',
      '```',
      '',
      '> 引用一句话',
      '',
      '[文档](https://example.com)',
      '',
      '| 指标 | 值 |',
      '| --- | --- |',
      '| CTR | 3.2% |',
    ].join('\n');
    const { container } = render(<Markdown content={content} />);
    expect(container.querySelector('code')).toHaveTextContent('pnpm build');
    expect(container.querySelector('pre')).toHaveTextContent('const a = 1;');
    expect(container.querySelector('blockquote')).toHaveTextContent('引用一句话');
    expect(screen.getByRole('link', { name: '文档' })).toHaveAttribute(
      'href',
      'https://example.com',
    );
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: '指标' })).toBeInTheDocument();
  });

  it('空字符串内容渲染为空容器而不报错', () => {
    const { container } = render(<Markdown content="" />);
    const root = container.querySelector('.cb-markdown');
    expect(root).not.toBeNull();
    expect(root).toBeEmptyDOMElement();
  });
});

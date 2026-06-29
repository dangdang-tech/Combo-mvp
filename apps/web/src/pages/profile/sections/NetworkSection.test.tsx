// ⑤ 能力网络缩略测试（主页-10）——节点/边渲染、中心节点标记、仅缩略无展开入口、空态。
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NetworkSection } from './NetworkSection.js';
import { makeNetwork } from '../fixtures.js';

describe('NetworkSection ⑤ 能力网络缩略', () => {
  it('渲染缩略 SVG：节点数 + 边数（aria-label 含计数）', () => {
    render(<NetworkSection network={makeNetwork()} />);
    expect(
      screen.getByRole('img', { name: '能力网络缩略，3 个能力、2 条关系' }),
    ).toBeInTheDocument();
  });

  it('节点/边按数量渲染', () => {
    const { container } = render(<NetworkSection network={makeNetwork()} />);
    expect(container.querySelectorAll('circle').length).toBe(3);
    expect(container.querySelectorAll('line').length).toBe(2);
  });

  it('中心节点带 data-center 标记', () => {
    const { container } = render(<NetworkSection network={makeNetwork()} />);
    expect(container.querySelectorAll('[data-center="true"]').length).toBe(1);
  });

  it('仅缩略无展开：不渲染任何「展开图谱/查看完整图谱」入口（主页-10）', () => {
    render(<NetworkSection network={makeNetwork()} />);
    expect(screen.queryByText(/展开图谱|查看完整图谱|进入图谱|完整图谱/)).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
    // 缩略图本身只读、无交互按钮。
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('thumbnailOnly 硬约束标在 svg 上', () => {
    const { container } = render(<NetworkSection network={makeNetwork()} />);
    expect(container.querySelector('[data-thumbnail-only="true"]')).toBeInTheDocument();
  });

  it('空（无能力）→ 友好空态，不崩', () => {
    render(<NetworkSection network={makeNetwork({ nodes: [], edges: [] })} />);
    expect(screen.getByText('暂无能力网络')).toBeInTheDocument();
  });
});

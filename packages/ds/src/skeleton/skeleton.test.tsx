import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Skeleton } from './skeleton';

describe('Skeleton', () => {
  it('空 props（纯 JSON）即可渲染，默认 text 变体', () => {
    const props = {};
    const { container } = render(<Skeleton {...props} />);
    const el = container.querySelector('.cb-skeleton');
    expect(el).not.toBeNull();
    expect(el).toHaveClass('cb-skeleton--text');
  });

  it('variant 联合枚举映射到对应类名', () => {
    const { container } = render(
      <div>
        <Skeleton variant="text" />
        <Skeleton variant="block" />
        <Skeleton variant="circle" />
      </div>,
    );
    expect(container.querySelector('.cb-skeleton--text')).not.toBeNull();
    expect(container.querySelector('.cb-skeleton--block')).not.toBeNull();
    expect(container.querySelector('.cb-skeleton--circle')).not.toBeNull();
  });

  it('width 与 height 自由字符串写入行内样式', () => {
    const props = { variant: 'block' as const, width: '240px', height: '120px' };
    const { container } = render(<Skeleton {...props} />);
    const el = container.querySelector<HTMLElement>('.cb-skeleton--block');
    expect(el).not.toBeNull();
    expect(el?.style.width).toBe('240px');
    expect(el?.style.height).toBe('120px');
  });

  it('对辅助技术隐藏（aria-hidden）', () => {
    const { container } = render(<Skeleton />);
    expect(container.querySelector('.cb-skeleton')).toHaveAttribute('aria-hidden', 'true');
  });
});

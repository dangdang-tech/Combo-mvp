// ItemStream 测试（边生成边显示）：已到达项逐条渲染 + 尾部骨架（生成中）+ 空态骨架（绝不空白）。
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ItemStream } from './ItemStream.js';

interface Cand {
  id: string;
  title: string;
}
const renderItem = (c: Cand) => <span>{c.title}</span>;

describe('ItemStream 逐个浮现', () => {
  it('已到达项逐条渲染', () => {
    const items: Cand[] = [
      { id: 'c1', title: '候选1' },
      { id: 'c2', title: '候选2' },
    ];
    render(<ItemStream items={items} renderItem={renderItem} itemKey={(c) => c.id} />);
    expect(screen.getByText('候选1')).toBeInTheDocument();
    expect(screen.getByText('候选2')).toBeInTheDocument();
  });

  it('生成中（pendingSkeletons>0）→ 已到项 + 尾部骨架卡', () => {
    const { container } = render(
      <ItemStream
        items={[{ id: 'c1', title: '候选1' }]}
        renderItem={renderItem}
        pendingSkeletons={2}
      />,
    );
    expect(screen.getByText('候选1')).toBeInTheDocument();
    expect(container.querySelectorAll('.cb-skeleton').length).toBe(2);
  });

  it('一条未到 → 显示骨架而非空白（绝不裸转圈）', () => {
    const { container } = render(
      <ItemStream items={[]} renderItem={renderItem} emptyLabel="正在识别候选…" />,
    );
    expect(container.querySelectorAll('.cb-skeleton').length).toBeGreaterThan(0);
    expect(screen.getAllByLabelText('正在识别候选…').length).toBeGreaterThan(0);
  });

  it('全部到齐（pendingSkeletons=0 且有项）→ 无骨架', () => {
    const { container } = render(
      <ItemStream
        items={[{ id: 'c1', title: '候选1' }]}
        renderItem={renderItem}
        pendingSkeletons={0}
      />,
    );
    expect(container.querySelectorAll('.cb-skeleton').length).toBe(0);
  });
});

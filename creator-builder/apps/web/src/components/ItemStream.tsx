// ItemStream（脊柱 §5.3 item-appended / §7「边生成边显示」）——逐个浮现项容器。
//
// 把 useSSE 累积的 items（item-appended 帧）逐条渲染：
//   - 已到达的项立即显示（边生成边显示，不等全部完成）。
//   - 还在生成中（pendingSkeletons>0）时尾部补几张骨架卡，暗示「后面还有，正在来」。
//   - 一条都还没来时只显示骨架（绝不空白/裸转圈）。
// renderItem 把 unknown 项交给调用方按域 DTO 渲染；本件只管「逐个浮现 + 尾部骨架」编排。
import type { ReactElement, ReactNode } from 'react';
import { Skeleton } from './LoadingState.js';

export interface ItemStreamProps<T = unknown> {
  /** 已到达的项（useSSE state.items）。 */
  items: T[];
  /** 渲染单项（按域 DTO）。 */
  renderItem: (item: T, index: number) => ReactNode;
  /** 取稳定 key（默认用 index，建议传业务 id）。 */
  itemKey?: (item: T, index: number) => string | number;
  /** 尾部补几张骨架卡（仍在生成时 >0；全部到齐传 0）。默认 0。 */
  pendingSkeletons?: number;
  /** 空且无骨架时的占位文案。 */
  emptyLabel?: string;
}

/**
 * 逐个浮现项容器。
 * 永不裸转圈：有项就逐条显示，没到齐就尾部补骨架，一条没有就显示骨架而非空白。
 */
export function ItemStream<T>({
  items,
  renderItem,
  itemKey,
  pendingSkeletons = 0,
  emptyLabel = '正在生成…',
}: ItemStreamProps<T>): ReactElement {
  const showSkeletons = pendingSkeletons > 0 || items.length === 0;
  const skeletonCount = items.length === 0 ? Math.max(1, pendingSkeletons || 3) : pendingSkeletons;

  return (
    <div className="cb-itemstream">
      <ul className="cb-itemstream__list">
        {items.map((item, i) => (
          <li key={itemKey ? itemKey(item, i) : i} className="cb-itemstream__item">
            {renderItem(item, i)}
          </li>
        ))}
      </ul>
      {showSkeletons && (
        <div className="cb-itemstream__pending" aria-label={emptyLabel}>
          {Array.from({ length: skeletonCount }, (_, i) => (
            <Skeleton key={`sk-${i}`} rows={1} label={emptyLabel} />
          ))}
        </div>
      )}
    </div>
  );
}

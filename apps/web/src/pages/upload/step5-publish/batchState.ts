// 批量发布态归并（F-14）——纯函数，把初始 PublishBatchView + SSE job 流（snapshot/item-appended/progress）
// 合成「逐项列表 + 完成度三元」的当前视图。
//
// SSE 形态（50 §3，kind=job）：
//   - state_snapshot：progress.items = 全量 PublishBatchItemView[]（刷新/重连恢复，硬规则③）。
//   - item-appended：{ item: PublishBatchItemView }（单项状态变化逐个浮现；useSSE 已把 payload.item 累积进 state.items）。
//   - progress：{ percent, done=processedCount, total }（进度分子=published+failed，有失败也满进度，Codex#7）。
// 归并口径：以 itemId 为键，后到覆盖先到（item-appended 增量盖 snapshot 初值）；计数从 items 聚合重算（幂等、抗漂移）。
import type { PublishBatchItemView, ProgressView } from '@cb/shared';

export interface BatchViewState {
  total: number;
  processedCount: number;
  publishedCount: number;
  failedCount: number;
  items: PublishBatchItemView[];
}

/** 类型守卫：SSE state.items / snapshot.progress.items 里的元素是否像 PublishBatchItemView。 */
function isBatchItem(x: unknown): x is PublishBatchItemView {
  return (
    typeof x === 'object' &&
    x !== null &&
    typeof (x as { itemId?: unknown }).itemId === 'string' &&
    typeof (x as { state?: unknown }).state === 'string'
  );
}

/** 从 SSE snapshot 的 progress.items 提取批项（全量重置基线）。 */
export function itemsFromSnapshot(progress: ProgressView | undefined): PublishBatchItemView[] {
  const raw = progress?.items ?? [];
  return raw.filter(isBatchItem);
}

/**
 * 合并初始批项（创建批次响应）+ snapshot 全量 + item-appended 增量，按 itemId 去重（增量盖基线）。
 * 计数从合并后 items 聚合重算（不靠递增，幂等、抗漂移）；total 取初始/快照较大值（防增量先到时 total 偏小）。
 */
export function mergeBatchState(
  initial: PublishBatchItemView[],
  snapshotItems: PublishBatchItemView[],
  appendedItems: PublishBatchItemView[],
  totalHint: number,
): BatchViewState {
  const byId = new Map<string, PublishBatchItemView>();
  for (const it of initial) byId.set(it.itemId, it);
  for (const it of snapshotItems) byId.set(it.itemId, it);
  for (const it of appendedItems) byId.set(it.itemId, it); // 增量最后写赢（最新状态）。

  const items = [...byId.values()];
  const publishedCount = items.filter((i) => i.state === 'published').length;
  const failedCount = items.filter((i) => i.state === 'failed').length;
  const processedCount = publishedCount + failedCount;
  const total = Math.max(totalHint, items.length);

  return { total, processedCount, publishedCount, failedCount, items };
}

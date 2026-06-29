// batchState 单测（F-14）：snapshot 提取 + 增量盖基线 + 计数聚合重算（幂等、无连坐计数）。
import { describe, it, expect } from 'vitest';
import type { PublishBatchItemView, ProgressView } from '@cb/shared';
import { itemsFromSnapshot, mergeBatchState } from './batchState.js';

function item(over: Partial<PublishBatchItemView> & { itemId: string }): PublishBatchItemView {
  return { state: 'pending', ...over };
}

describe('itemsFromSnapshot', () => {
  it('从 progress.items 过滤出批项（非批项噪声丢弃）', () => {
    const progress: ProgressView = {
      percent: 50,
      phrase: '已处理 1 / 2',
      subtasks: [],
      items: [item({ itemId: 'i1', state: 'published' }), { notAnItem: true }],
    };
    const got = itemsFromSnapshot(progress);
    expect(got).toHaveLength(1);
    expect(got[0]!.itemId).toBe('i1');
  });

  it('无 progress → 空', () => {
    expect(itemsFromSnapshot(undefined)).toEqual([]);
  });
});

describe('mergeBatchState', () => {
  it('增量盖基线（同 itemId 最新状态赢）+ 计数聚合重算', () => {
    const initial = [item({ itemId: 'i1' }), item({ itemId: 'i2' })];
    const appended = [
      item({ itemId: 'i1', state: 'published' }),
      item({
        itemId: 'i2',
        state: 'failed',
        error: { userMessage: '失败了', retriable: true, action: 'retry', traceId: 't' },
      }),
    ];
    const m = mergeBatchState(initial, [], appended, 2);
    expect(m.total).toBe(2);
    expect(m.publishedCount).toBe(1);
    expect(m.failedCount).toBe(1);
    // 完成度 = published + failed（有失败也满 processed，Codex#7）。
    expect(m.processedCount).toBe(2);
    expect(m.items.find((i) => i.itemId === 'i1')!.state).toBe('published');
  });

  it('snapshot 全量恢复（刷新/重连不丢已发布）', () => {
    const snap = [
      item({ itemId: 'i1', state: 'published' }),
      item({ itemId: 'i2', state: 'structuring' }),
    ];
    const m = mergeBatchState([], snap, [], 2);
    expect(m.items).toHaveLength(2);
    expect(m.publishedCount).toBe(1);
    expect(m.processedCount).toBe(1);
  });

  it('计数幂等：同项重复出现不重复计数', () => {
    const appended = [
      item({ itemId: 'i1', state: 'published' }),
      item({ itemId: 'i1', state: 'published' }), // 重复（重投/双消费）。
    ];
    const m = mergeBatchState([], [], appended, 1);
    expect(m.publishedCount).toBe(1); // 不重复递增。
    expect(m.items).toHaveLength(1);
  });

  it('total 取 hint 与项数较大值（增量先到 total 偏小时不裸缺）', () => {
    const m = mergeBatchState([], [], [item({ itemId: 'i1', state: 'published' })], 0);
    expect(m.total).toBe(1);
  });
});

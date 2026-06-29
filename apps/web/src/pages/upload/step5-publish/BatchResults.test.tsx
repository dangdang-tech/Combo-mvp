// BatchResults 单测（F-14，§5.5）——重点：每行用人话标签「能力 N」，绝不裸露 UUID。
//
// PublishBatchItemView（packages/shared publish.ts）无人话名字段，只有各类 id；P2 不改后端契约，
// 前端按序号给人话标签（与左侧切换列表 PublishStepPage 同口径），真实 id 仅作非可见 key。
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { PublishBatchItemView } from '@cb/shared';
import { BatchResults } from './BatchResults.js';

/** 三条 item，全部只有各类 id、无任何人话名（最易裸露 UUID 的场景）。 */
function allIdItems(): PublishBatchItemView[] {
  return [
    { itemId: '11111111-1111-1111-1111-111111111111', candidateId: 'cand-1', state: 'published' },
    { itemId: '22222222-2222-2222-2222-222222222222', versionId: 'ver-2', state: 'publishing' },
    {
      itemId: '33333333-3333-3333-3333-333333333333',
      capabilityId: '99999999-9999-9999-9999-999999999999',
      state: 'pending',
    },
  ];
}

describe('BatchResults', () => {
  it('每行用「能力 N」人话标签，绝不裸露任何 UUID', () => {
    const { container } = render(
      <BatchResults
        total={3}
        processedCount={1}
        publishedCount={1}
        failedCount={0}
        items={allIdItems()}
        onFixUp={vi.fn()}
        onRetryItem={vi.fn()}
      />,
    );
    // 人话名按序号呈现。
    expect(screen.getByText('能力 1')).toBeInTheDocument();
    expect(screen.getByText('能力 2')).toBeInTheDocument();
    expect(screen.getByText('能力 3')).toBeInTheDocument();
    // 任何 item 的 id 都不作为可见名字渲染（含 capabilityId UUID）。
    const names = container.querySelectorAll('.cb-batch-results__item-name');
    names.forEach((n) => {
      expect(n.textContent).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/i);
      expect(n.textContent).not.toContain('cand-1');
      expect(n.textContent).not.toContain('ver-2');
    });
  });
});

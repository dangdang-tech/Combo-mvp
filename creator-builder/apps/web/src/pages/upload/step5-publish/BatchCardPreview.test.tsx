// BatchCardPreview 单测（F-14，§5.5 / 发布-09）——左侧切换选中哪个能力，中间就预览它的市集卡。
//   核心断言：切换 item（A→B）→ 中间市集卡名称随之换（切换看卡）；版本未就绪给量化占位（永不裸转圈）。
//   fetch 按 URL 路由（preview 路径含 versionId），切换后重取对应能力的卡。
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { MarketCard, PublishBatchItemView } from '@cb/shared';
import { BatchCardPreview } from './BatchCardPreview.js';

function card(name: string, versionId: string): MarketCard {
  return {
    versionId,
    capabilityId: `cap-${versionId}`,
    slug: name,
    cover: { source: 'glyph', url: null },
    typeLabel: '工具',
    name,
    tagline: `${name} 卖点`,
    summary: `${name} 简介`,
    byline: '@me',
    trustBadge: '源自一次真实会话',
    price: { priceMicros: null, display: null },
    trialEnabled: false,
    installs: null,
    rating: null,
  };
}

function item(over: Partial<PublishBatchItemView>): PublishBatchItemView {
  return { itemId: 'i1', candidateId: 'c1', state: 'pending', ...over };
}

/** fetch 按 preview URL 里的 versionId 返回对应能力的卡（切换看卡需按版本路由）。 */
function installRoutedFetch(byVersion: Record<string, MarketCard>) {
  const original = globalThis.fetch;
  const fn = vi.fn(async (url: string) => {
    const m = /\/versions\/([^/]+)\/market-card\/preview/.exec(url);
    const vId = m ? decodeURIComponent(m[1]!) : '';
    const c = byVersion[vId];
    return {
      status: 200,
      ok: true,
      json: async () => ({ data: c }),
    } as unknown as Response;
  });
  globalThis.fetch = fn as unknown as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
  vi.restoreAllMocks();
});

describe('BatchCardPreview（发布-09 切换看卡）', () => {
  it('版本就绪 → 预览该能力市集卡；切换到另一能力 → 中间卡随之换名', async () => {
    restore = installRoutedFetch({
      'cv-A': card('能力甲', 'cv-A'),
      'cv-B': card('能力乙', 'cv-B'),
    });

    const { rerender } = render(
      <BatchCardPreview
        item={item({ itemId: 'iA', candidateId: 'cA', state: 'published', versionId: 'cv-A' })}
      />,
    );
    // 初始：能力甲的市集卡。
    expect(await screen.findByText('能力甲')).toBeInTheDocument();
    expect(screen.queryByText('能力乙')).not.toBeInTheDocument();

    // 切换左侧 → 父层换 item（candidateId/versionId 变）→ 中间卡换成能力乙。
    rerender(
      <BatchCardPreview
        item={item({ itemId: 'iB', candidateId: 'cB', state: 'published', versionId: 'cv-B' })}
      />,
    );
    expect(await screen.findByText('能力乙')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('能力甲')).not.toBeInTheDocument());
  });

  it('版本尚未就绪（structuring，无 versionId）→ 量化占位短语，绝不裸转圈', () => {
    restore = installRoutedFetch({});
    render(<BatchCardPreview item={item({ state: 'structuring' })} />);
    expect(screen.getByText('正在整理这个能力的市集卡…')).toBeInTheDocument();
  });

  it('未选中任何能力（item=null）→ 提示去左侧选一个', () => {
    restore = installRoutedFetch({});
    render(<BatchCardPreview item={null} />);
    expect(screen.getByText('在左侧选一个能力，这里预览它的市集卡。')).toBeInTheDocument();
  });
});

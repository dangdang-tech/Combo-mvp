// ⑥ 作品墙测试（主页-11/12/19/22/23/24）——单源渲染、调用次数 usage 占位、封面缺图兜底、
// 点卡进公开页（slug）、加载更多、空态。
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WorksSection } from './WorksSection.js';
import { makeWorks, makeWorkCard, PLACEHOLDER_META } from '../fixtures.js';

describe('WorksSection ⑥ 作品墙', () => {
  it('单源渲染：后端给的卡原样上墙（前端不二次过滤）', () => {
    render(
      <WorksSection
        works={makeWorks()}
        meta={PLACEHOLDER_META}
        loadingMore={false}
        onLoadMore={() => {}}
      />,
    );
    expect(screen.getByText('作品 cap-1')).toBeInTheDocument();
    expect(screen.getByText('作品 cap-2')).toBeInTheDocument();
  });

  it('调用次数 usage 占位（不显 0）', () => {
    const { container } = render(
      <WorksSection
        works={makeWorks()}
        meta={PLACEHOLDER_META}
        loadingMore={false}
        onLoadMore={() => {}}
      />,
    );
    // 占位键对齐主聚合/契约真键 works.invocations（§2.2，非自造 invocations）。
    expect(
      container.querySelectorAll('[data-placeholder="works.invocations"]').length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });

  it('封面缺图（coverUrl=null）→ 兜底占位（无 img），不破图（主页-22）', () => {
    const { container } = render(
      <WorksSection
        works={makeWorks({
          cards: [makeWorkCard({ capabilityId: 'x', name: 'Zeta' })],
          hasMore: false,
        })}
        meta={PLACEHOLDER_META}
        loadingMore={false}
        onLoadMore={() => {}}
      />,
    );
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('Z')).toBeInTheDocument();
  });

  it('点卡进公开页：链接 href = /a/{slug}（不进编辑/管理，主页-12）', () => {
    render(
      <WorksSection
        works={makeWorks({
          cards: [makeWorkCard({ capabilityId: 'x', slug: 'zeta' })],
          hasMore: false,
        })}
        meta={PLACEHOLDER_META}
        loadingMore={false}
        onLoadMore={() => {}}
      />,
    );
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', '/a/zeta');
  });

  it('封面有图 → 渲染 img', () => {
    render(
      <WorksSection
        works={makeWorks({
          cards: [makeWorkCard({ capabilityId: 'x', name: 'C', coverUrl: 'https://x/c.png' })],
          hasMore: false,
        })}
        meta={PLACEHOLDER_META}
        loadingMore={false}
        onLoadMore={() => {}}
      />,
    );
    expect(screen.getByRole('img', { name: 'C 封面' })).toBeInTheDocument();
  });

  it('hasMore=true → 「加载更多」可点；loadingMore → 禁用', async () => {
    const onLoadMore = vi.fn();
    const { rerender } = render(
      <WorksSection
        works={makeWorks()}
        meta={PLACEHOLDER_META}
        loadingMore={false}
        onLoadMore={onLoadMore}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: '加载更多' }));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
    rerender(
      <WorksSection
        works={makeWorks()}
        meta={PLACEHOLDER_META}
        loadingMore
        onLoadMore={onLoadMore}
      />,
    );
    expect(screen.getByRole('button', { name: '加载中…' })).toBeDisabled();
  });

  it('空（无上墙能力）→ 空态「还没有已发布的能力」', () => {
    render(
      <WorksSection
        works={makeWorks({ cards: [], hasMore: false })}
        meta={PLACEHOLDER_META}
        loadingMore={false}
        onLoadMore={() => {}}
      />,
    );
    expect(screen.getByText('还没有已发布的能力')).toBeInTheDocument();
  });

  it('不渲染收益/成本等经营维度', () => {
    const { container } = render(
      <WorksSection
        works={makeWorks()}
        meta={PLACEHOLDER_META}
        loadingMore={false}
        onLoadMore={() => {}}
      />,
    );
    expect(within(container).queryByText(/收益|成本|￥|¥|\$/)).toBeNull();
  });
});

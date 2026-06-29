// SinglePublish 单测（F-14，P1-5 拒绝态可见 + P1-6 不发半成品封面）。
//   无运行后端：fetch mock 按调用序回响应（fetchPublication → previewMarketCard → publishVersion）。
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import type { MarketCard, PublicationView, PublishResult } from '@cb/shared';
import { installFetchMock, type FetchMock } from '../../../test/mockFetch.js';
import { SinglePublish } from './SinglePublish.js';

const VERSION_ID = 'cv-1';
const CAP_ID = 'cap-1';

function card(): MarketCard {
  return {
    versionId: VERSION_ID,
    capabilityId: CAP_ID,
    slug: 'demo',
    cover: { source: 'glyph', url: null },
    typeLabel: '工具',
    name: '演示能力',
    tagline: '一句话卖点',
    summary: '能力简介',
    byline: '@me',
    trustBadge: '源自一次真实会话',
    price: { priceMicros: null, display: null },
    trialEnabled: false,
    installs: null,
    rating: null,
  };
}

function publication(over: Partial<PublicationView>): PublicationView {
  return {
    capabilityId: CAP_ID,
    currentVersionId: VERSION_ID,
    slug: 'demo',
    shareToken: 'tok',
    visibility: 'public',
    reviewStatus: 'alpha_pending',
    publishedAt: '2026-06-17T00:00:00.000Z',
    ...over,
  };
}

function publishResult(): PublishResult {
  return {
    versionId: VERSION_ID,
    capabilityId: CAP_ID,
    slug: 'demo',
    shareToken: 'tok',
    reviewStatus: 'alpha_pending',
    visibility: 'public',
    publishedVersionId: VERSION_ID,
    marketUrl: 'https://m/demo',
    card: card(),
  };
}

let mock: FetchMock | undefined;
afterEach(() => {
  mock?.restore();
  mock = undefined;
  vi.restoreAllMocks();
});

const noop = (): void => undefined;

describe('SinglePublish（P1-5 拒绝态可见）', () => {
  it('本版恰是最近被拒版 → 出拒绝原因 + 「编辑后重发」（派生新 draft，不预览不发布）', async () => {
    mock = installFetchMock({
      json: {
        data: publication({
          reviewStatus: 'review_rejected',
          rejectedVersionId: VERSION_ID,
          rejectReason: '描述与产物不符',
        }),
      },
    });
    const onEditResubmit = vi.fn();
    render(
      <SinglePublish
        versionId={VERSION_ID}
        capabilityId={CAP_ID}
        registerPublish={noop}
        onDone={noop}
        onEditResubmit={onEditResubmit}
      />,
    );

    expect(await screen.findByText('这次发布被退回了')).toBeInTheDocument();
    expect(screen.getByText(/描述与产物不符/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '编辑后重新发布' }));
    expect(onEditResubmit).toHaveBeenCalledWith(VERSION_ID);

    // 拒绝态不预览、不发布：只读了一次发布态。
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]?.method).toBe('GET');
  });

  it('回退拒绝态（review_status=published 但 displayState.rejected，被拒回退到上一版）→ 仍出拒绝态闭环（拒绝态单一真源，Codex r3）', async () => {
    mock = installFetchMock({
      json: {
        data: publication({
          reviewStatus: 'published', // 对外已回退到上一版，但创作者侧仍是被拒可见态。
          rejectedVersionId: VERSION_ID,
          displayState: {
            badge: 'rejected',
            statusLabel: '未通过',
            rejected: true,
            rejectReason: '回退后仍提示上次被拒',
            retryEditable: true,
          },
        }),
      },
    });
    const onEditResubmit = vi.fn();
    render(
      <SinglePublish
        versionId={VERSION_ID}
        capabilityId={CAP_ID}
        registerPublish={noop}
        onDone={noop}
        onEditResubmit={onEditResubmit}
      />,
    );
    // displayState.rejected 命中拒绝态（不再因 reviewStatus='published' 漏判降级 publishable）。
    expect(await screen.findByText('这次发布被退回了')).toBeInTheDocument();
    expect(screen.getByText(/回退后仍提示上次被拒/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '编辑后重新发布' }));
    expect(onEditResubmit).toHaveBeenCalledWith(VERSION_ID);
  });

  it('其它版被拒（rejectedVersionId 非本版）→ 不挡本版，照常进发布表单', async () => {
    mock = installFetchMock([
      {
        json: {
          data: publication({
            reviewStatus: 'review_rejected',
            rejectedVersionId: 'cv-OTHER',
            rejectReason: '别的版被拒',
          }),
        },
      },
      { json: { data: card() } }, // previewMarketCard
    ]);
    render(
      <SinglePublish
        versionId={VERSION_ID}
        capabilityId={CAP_ID}
        registerPublish={noop}
        onDone={noop}
        onEditResubmit={noop}
      />,
    );

    // 进入可发布表单（出市集卡 + 封面选择），不出拒绝态。
    expect(await screen.findByLabelText('市集卡预览')).toBeInTheDocument();
    expect(screen.queryByText('这次发布被退回了')).not.toBeInTheDocument();
  });
});

describe('SinglePublish（P1-6 不发半成品封面）', () => {
  it('发布 body 的 cover 恒为完整 glyph（封面只放 glyph 可用）', async () => {
    mock = installFetchMock([
      { json: { data: publication({ reviewStatus: 'alpha_pending' }) } }, // fetchPublication
      { json: { data: card() } }, // previewMarketCard
      { json: { data: publishResult() } }, // publishVersion
    ]);

    // 捕获父层注册的发布动作，手动触发（底栏在父层 PublishStepPage）。
    let publishAction: (() => void) | undefined;
    const registerPublish = (a: { onPublish: () => void; enabled: boolean }): void => {
      if (a.enabled) publishAction = a.onPublish;
    };

    render(
      <SinglePublish
        versionId={VERSION_ID}
        capabilityId={CAP_ID}
        registerPublish={registerPublish}
        onDone={noop}
        onEditResubmit={noop}
      />,
    );

    await screen.findByLabelText('市集卡预览');
    await waitFor(() => expect(publishAction).toBeTypeOf('function'));
    publishAction?.();

    // 发布成功 → 显「Alpha·审核中」。
    expect(await screen.findByText('已提交，Alpha 人工评审中')).toBeInTheDocument();

    // 最后一笔是 publishVersion（POST /versions/:id/publish），cover 恒为 { source: 'glyph' }。
    const publishCall = mock.calls.find(
      (c) => c.method === 'POST' && c.url.includes('/publish') && !c.url.includes('preview'),
    );
    expect(publishCall).toBeDefined();
    const body = publishCall?.body as { cover?: unknown };
    expect(body.cover).toEqual({ source: 'glyph' });
  });

  it('预览 body 的 cover 也恒为完整 glyph（不发半成品来源给预览）', async () => {
    mock = installFetchMock([
      { json: { data: publication({ reviewStatus: 'alpha_pending' }) } },
      { json: { data: card() } },
    ]);
    render(
      <SinglePublish
        versionId={VERSION_ID}
        capabilityId={CAP_ID}
        registerPublish={noop}
        onDone={noop}
        onEditResubmit={noop}
      />,
    );
    await screen.findByLabelText('市集卡预览');

    const previewCall = mock.calls.find((c) => c.url.includes('market-card/preview'));
    expect(previewCall).toBeDefined();
    const body = previewCall?.body as { cover?: unknown };
    expect(body.cover).toEqual({ source: 'glyph' });
  });

  it('BUG-022：发布成功 → onPublished(reviewStatus) 被调一次（供父层切底栏「回工作台」+ 步骤条终态）', async () => {
    mock = installFetchMock([
      { json: { data: publication({ reviewStatus: 'alpha_pending' }) } }, // fetchPublication
      { json: { data: card() } }, // previewMarketCard
      { json: { data: publishResult() } }, // publishVersion
    ]);
    let publishAction: (() => void) | undefined;
    const registerPublish = (a: { onPublish: () => void; enabled: boolean }): void => {
      if (a.enabled) publishAction = a.onPublish;
    };
    const onPublished = vi.fn();
    render(
      <SinglePublish
        versionId={VERSION_ID}
        capabilityId={CAP_ID}
        registerPublish={registerPublish}
        onDone={noop}
        onEditResubmit={noop}
        onPublished={onPublished}
      />,
    );
    await screen.findByLabelText('市集卡预览');
    await waitFor(() => expect(publishAction).toBeTypeOf('function'));
    publishAction?.();
    // 发布成功主体进入「Alpha·审核中」终态。
    expect(await screen.findByText('已提交，Alpha 人工评审中')).toBeInTheDocument();
    // 终态上抛恰一次、带真实 reviewStatus（父层据此切底栏「回工作台」+ 步骤条 STEP⑤ 标已完成）。
    await waitFor(() => expect(onPublished).toHaveBeenCalledTimes(1));
    expect(onPublished).toHaveBeenCalledWith('alpha_pending');
  });

  it('无 capabilityId（不可读发布态）→ 直接进发布表单，不读发布态', async () => {
    mock = installFetchMock({ json: { data: card() } }); // 只会被 previewMarketCard 调
    render(
      <SinglePublish
        versionId={VERSION_ID}
        registerPublish={noop}
        onDone={noop}
        onEditResubmit={noop}
      />,
    );
    expect(await screen.findByLabelText('市集卡预览')).toBeInTheDocument();
    // 第一笔即 preview（POST readonly），没有 GET /publications。
    expect(mock.calls.some((c) => c.url.includes('/publications/'))).toBe(false);
  });
});

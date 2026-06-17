// PublishStepPage 集成测试（F-14，§5.5 / 发布-09）——批量发布左侧能力切换换中间市集卡预览。
//
// 核心断言（发布-09）：批量模式下点左侧「能力切换列表」另一项 → 中间市集卡预览换到该能力的卡（切换看卡），
//   同时下方发布结果列表并存（切换看卡 + 发布后看结果）。fetch 按 URL 路由：建批 + 按 versionId 取各卡。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useEffect } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { MarketCard, PublishBatchView } from '@cb/shared';
import { WizardProvider, useWizard } from '../../wizard/index.js';
import { PublishStepPage } from './PublishStepPage.js';
import { __setFetchEventSourceForTests } from '../../../api/useSSE.js';
import { MockFetchEventSource } from '../../../test/mockFetchEventSource.js';

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

/** 建批响应：两候选已整理出版本（published），便于即时预览各自市集卡。 */
function batchView(): PublishBatchView {
  return {
    batchId: 'b1',
    jobId: 'j1',
    status: 'completed',
    total: 2,
    processedCount: 2,
    publishedCount: 2,
    failedCount: 0,
    items: [
      {
        itemId: 'i1',
        candidateId: 'cand-A',
        versionId: 'cv-A',
        capabilityId: 'cap-A',
        state: 'published',
      },
      {
        itemId: 'i2',
        candidateId: 'cand-B',
        versionId: 'cv-B',
        capabilityId: 'cap-B',
        state: 'published',
      },
    ],
  };
}

/** fetch 路由：POST /publish-batches → batchView；preview → 按 versionId 回对应卡。 */
function installRoutedFetch() {
  const byVersion: Record<string, MarketCard> = {
    'cv-A': card('能力甲', 'cv-A'),
    'cv-B': card('能力乙', 'cv-B'),
  };
  const original = globalThis.fetch;
  const fn = vi.fn(async (url: string) => {
    let json: unknown = {};
    if (url.includes('/publish-batches')) {
      // 建批（POST）或续传查批次全量（GET /publish-batches/{id}）都回同一批次视图
      // （onBatchReady → setBatchId → resumeBatchId 触发 BatchPublish 走查批次分支）。
      json = { data: batchView() };
    } else {
      const m = /\/versions\/([^/]+)\/market-card\/preview/.exec(url);
      if (m) json = { data: byVersion[decodeURIComponent(m[1]!)] };
    }
    return { status: 200, ok: true, json: async () => json } as unknown as Response;
  });
  globalThis.fetch = fn as unknown as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

/** 稳定的候选集合（模块常量：array ref 不变，SeedSelection effect 只 seed 一次，无重渲染循环）。 */
const SEED_CANDIDATE_IDS = ['cand-A', 'cand-B'];

/** 在 WizardProvider 里预置一个 subset 选择（两候选），再渲染 PublishStepPage。 */
function SeedSelection({ candidateIds }: { candidateIds: string[] }) {
  const { setSelection } = useWizard();
  // setSelection 是稳定 callback、candidateIds 测试内稳定 → effect 只跑一次 seed（无 disable 注释）。
  useEffect(() => {
    setSelection({ mode: 'subset', candidateIds });
  }, [setSelection, candidateIds]);
  return null;
}

function renderBatch() {
  return render(
    <MemoryRouter initialEntries={['/create/publish']}>
      <WizardProvider initialStep="publish" initialDraftId="d1">
        <SeedSelection candidateIds={SEED_CANDIDATE_IDS} />
        <Routes>
          <Route path="/create/publish" element={<PublishStepPage />} />
          <Route path="/create/select" element={<div>select-page</div>} />
          <Route path="/creator" element={<div>dashboard</div>} />
        </Routes>
      </WizardProvider>
    </MemoryRouter>,
  );
}

let restoreFetch: (() => void) | undefined;
let restoreFes: () => void;
beforeEach(() => {
  MockFetchEventSource.reset();
  restoreFes = __setFetchEventSourceForTests(MockFetchEventSource.impl);
  restoreFetch = installRoutedFetch();
});
afterEach(() => {
  restoreFes();
  restoreFetch?.();
  restoreFetch = undefined;
  vi.restoreAllMocks();
});

describe('PublishStepPage（发布-09 批量左侧切换换中间市集卡）', () => {
  it('左侧能力切换列表点另一项 → 中间市集卡预览随之换；结果列表并存', async () => {
    renderBatch();

    // 左侧能力切换列表渲染两项（§5.5 在这一批能力之间切换）。
    const switcher = await screen.findByRole('navigation', { name: '在这一批能力之间切换' });
    expect(switcher).toBeInTheDocument();
    const buttons = within(switcher).getAllByRole('button');
    expect(buttons).toHaveLength(2);

    // 默认选中首项 → 中间预览能力甲的市集卡。
    expect(await screen.findByText('能力甲')).toBeInTheDocument();
    // 发布结果列表并存（切换看卡 + 发布后看结果）。
    expect(screen.getByLabelText('批量发布结果')).toBeInTheDocument();

    // 点第二项 → 中间市集卡换成能力乙、不再显能力甲（切换看卡，发布-09）。
    await userEvent.click(buttons[1]!);
    expect(await screen.findByText('能力乙')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('能力甲')).not.toBeInTheDocument());
    // 结果列表仍并存（切换看卡 + 发布后看结果）。
    expect(screen.getByLabelText('批量发布结果')).toBeInTheDocument();
  });
});

// DashboardPage 集成测试（F-05）：5 端点拼装 + 局部失败不连坐 + 时间范围切换 + 创建/恢复入口路由。
//
// 用按 URL 路由的 fetch mock（5 端点并发，顺序不定，不能用 queue）；react-query retry:false 防慢/flaky。
// jsdom 无 canvas → mock echarts。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import type { ReactElement } from 'react';

vi.mock('echarts-for-react/lib/core', () => ({
  default: (props: { option: unknown }) => (
    <div data-testid="echarts-core" data-option={JSON.stringify(props.option)} />
  ),
}));

import { DashboardPage } from './DashboardPage.js';

// ---- 各端点典型返回（usage 占位 + 真实字段）----
const SUMMARY = {
  data: {
    title: '创作者中心',
    publishedCount: 8,
    monthlyInvocations: null,
    summaryTemplate: '你发布的 {publishedCount} 个能力体，{monthlyInvocations} 次调用',
  },
  meta: { placeholders: { monthlyInvocations: '暂无数据 / 上线后填充' } },
};

const METRICS = {
  data: {
    range: '30d',
    cards: [
      {
        key: 'published',
        label: '已发布能力体',
        value: 8,
        deltaPercent: 12.5,
        deltaDirection: 'up',
        unit: '个',
      },
      {
        key: 'invocationsTotal',
        label: '累计调用',
        value: null,
        deltaPercent: null,
        deltaDirection: null,
      },
      {
        key: 'spendThisMonth',
        label: '本月消耗',
        value: null,
        deltaPercent: null,
        deltaDirection: null,
      },
      {
        key: 'activeConsumers',
        label: '活跃消费者',
        value: null,
        deltaPercent: null,
        deltaDirection: null,
      },
    ],
  },
  meta: {
    placeholders: {
      invocationsTotal: '暂无数据 / 上线后填充',
      spendThisMonth: '暂无数据 / 上线后填充',
      activeConsumers: '暂无数据 / 上线后填充',
    },
  },
};

const TOKEN_TREND = {
  data: { range: '30d', metric: 'tokens', points: [], peak: null, empty: true },
  meta: { placeholders: { points: '暂无数据 / 上线后填充' } },
};

const CAPABILITIES = {
  data: [
    {
      capabilityId: 'cap-1',
      versionId: 'ver-1',
      slug: 'my-cap',
      name: '保险方案速算',
      tagline: '一句话算清现金价值',
      reviewStatus: 'published',
      statusLabel: '已上架',
      rejectReason: null,
      retryEditable: false,
      monthlyInvocations: null,
      spendSparkline: null,
      revenueMicros: null,
      publicPageAvailable: true,
      publishedAt: '2026-06-01T00:00:00Z',
      updatedAt: '2026-06-10T00:00:00Z',
    },
  ],
  meta: {
    placeholders: {
      monthlyInvocations: '暂无数据 / 上线后填充',
      spendSparkline: '暂无数据 / 上线后填充',
      revenueMicros: '暂无数据 / 上线后填充',
    },
    page: { nextCursor: null, hasMore: false, limit: 20, order: 'desc' },
  },
};

const DRAFTS = {
  data: [
    {
      id: 'draft-1',
      status: 'active',
      currentStep: 'structure',
      stepProgress: { percent: 60, phrase: '结构化中 60%' },
      title: '保险话术草稿',
      createdAt: '2026-06-10T00:00:00Z',
      updatedAt: '2026-06-11T00:00:00Z',
    },
  ],
  meta: { page: { nextCursor: null, hasMore: false, limit: 20, order: 'desc' } },
};

type RouteMap = Record<string, { status?: number; json: unknown }>;

function installRoutedFetch(map: RouteMap, onCall?: (url: string) => void): () => void {
  const original = globalThis.fetch;
  const fn = vi.fn(async (url: string) => {
    onCall?.(url);
    const key = Object.keys(map).find((k) => url.includes(k));
    const spec = key ? map[key] : undefined;
    const status = spec?.status ?? (spec ? 200 : 404);
    return {
      status,
      ok: status >= 200 && status < 300,
      json: async () =>
        spec?.json ?? {
          error: { userMessage: '未匹配端点', retriable: true, action: 'retry', traceId: 't' },
        },
    } as unknown as Response;
  });
  globalThis.fetch = fn as unknown as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

function ok(): RouteMap {
  return {
    '/dashboard/summary': { json: SUMMARY },
    '/dashboard/metrics': { json: METRICS },
    '/dashboard/token-trend': { json: TOKEN_TREND },
    '/dashboard/capabilities': { json: CAPABILITIES },
    '/dashboard/drafts': { json: DRAFTS },
  };
}

function LocationProbe(): ReactElement {
  const location = useLocation();
  return (
    <div data-testid="probe" data-search={location.search}>
      probed
    </div>
  );
}

function renderPage(): { container: HTMLElement } {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { container } = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/creator']}>
        <Routes>
          <Route path="/creator" element={<DashboardPage />} />
          <Route path="/create/import" element={<LocationProbe />} />
          {/* 草稿续传（已过导入的 currentStep）落能力页。 */}
          <Route path="/create/capabilities" element={<LocationProbe />} />
          <Route path="/create/structure" element={<LocationProbe />} />
          <Route path="/capabilities" element={<LocationProbe />} />
          <Route path="/a/:slug" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { container };
}

let restore: () => void = () => {};
afterEach(() => restore());

describe('DashboardPage 拼装', () => {
  beforeEach(() => {
    restore = installRoutedFetch(ok());
  });

  it('页头摘要：真实 publishedCount + monthlyInvocations 占位文案（不裸 0/null）', async () => {
    renderPage();
    const header = await screen.findByRole('heading', { name: '创作者中心' });
    expect(header).toBeInTheDocument();
    // 摘要句把 monthlyInvocations 占位文案代入（不裸 0/null）。
    const summaryLine = header
      .closest('.cb-dash-header')
      ?.querySelector('.cb-dash-header__summary');
    await waitFor(() => {
      expect(summaryLine?.textContent).toContain('暂无数据 / 上线后填充');
      expect(summaryLine?.textContent).not.toContain('null');
    });
  });

  it('指标卡：published 真实大数字 + 3 张 usage 占位', async () => {
    const { container } = renderPage();
    await waitFor(() => {
      expect(container.querySelectorAll('.cb-metric-card').length).toBe(4);
    });
    expect(
      container.querySelector('[data-key="published"][data-placeholder="false"]'),
    ).not.toBeNull();
    expect(container.querySelectorAll('.cb-metric-card[data-placeholder="true"]').length).toBe(3);
  });

  it('趋势：usage 占位（不画真图）+ 双口径切换段控存在', async () => {
    renderPage();
    expect(await screen.findByRole('group', { name: '切换趋势口径' })).toBeInTheDocument();
    // points 占位 → 不渲染真 echarts
    await waitFor(() => {
      expect(screen.queryByTestId('echarts-core')).toBeNull();
    });
  });

  it('能力表：行 + 状态单源 + 草稿条进度，usage 列占位', async () => {
    renderPage();
    expect(await screen.findByText('保险方案速算')).toBeInTheDocument();
    expect(screen.getByText('已上架')).toBeInTheDocument();
    expect(await screen.findByText(/结构化中 60%/)).toBeInTheDocument();
  });
});

describe('DashboardPage 局部失败不连坐（拆 5 端点）', () => {
  it('趋势端点 500 → 仅趋势区出 ErrorState，摘要/指标/能力仍渲染', async () => {
    const map = ok();
    map['/dashboard/token-trend'] = {
      status: 500,
      json: {
        error: {
          userMessage: '经营数据没能加载，请重试。',
          retriable: true,
          action: 'retry',
          traceId: 'tr-1',
        },
      },
    };
    restore = installRoutedFetch(map);
    renderPage();
    // 趋势区局部错误
    expect(await screen.findByText('经营数据没能加载，请重试。')).toBeInTheDocument();
    // 其他区块照常
    expect(await screen.findByRole('heading', { name: '创作者中心' })).toBeInTheDocument();
    expect(await screen.findByText('保险方案速算')).toBeInTheDocument();
  });

  it('错误态只显 userMessage，绝不裸露 code', async () => {
    const map = ok();
    map['/dashboard/metrics'] = {
      status: 500,
      json: {
        error: {
          userMessage: '经营数据没能加载，请重试。',
          retriable: true,
          action: 'retry',
          traceId: 'tr-2',
        },
      },
    };
    restore = installRoutedFetch(map);
    const { container } = renderPage();
    await screen.findByText('经营数据没能加载，请重试。');
    // 不出现任何错误码样式文本
    expect(container.textContent).not.toContain('DASHBOARD_AGGREGATE_FAILED');
    expect(container.textContent).not.toContain('500');
  });
});

describe('DashboardPage 时间范围切换', () => {
  it('切到「近 7 天」→ 重新请求带 range=7d', async () => {
    const urls: string[] = [];
    restore = installRoutedFetch(ok(), (u) => urls.push(u));
    renderPage();
    await screen.findByRole('heading', { name: '创作者中心' });
    await userEvent.click(screen.getByRole('button', { name: '近 7 天' }));
    await waitFor(() => {
      expect(urls.some((u) => u.includes('/dashboard/summary') && u.includes('range=7d'))).toBe(
        true,
      );
    });
  });
});

describe('DashboardPage 操作入口', () => {
  it('不展示尚未兑现的行内试用入口', async () => {
    restore = installRoutedFetch(ok());
    renderPage();
    await screen.findByText('保险方案速算');
    expect(screen.queryByRole('button', { name: '试用' })).not.toBeInTheDocument();
  });

  it('操作列只展示真实动作，不出现“更多”占位菜单', async () => {
    restore = installRoutedFetch(ok());
    renderPage();
    await screen.findByText('保险方案速算');

    expect(screen.getByRole('link', { name: /打开.*公开页/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '重新创建' })).toBeNull();
    expect(screen.queryByRole('button', { name: '更多操作' })).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('行内「公开页」→ 对外只读公开页路由（/a/{slug}），不进管理', async () => {
    restore = installRoutedFetch(ok());
    renderPage();
    await screen.findByText('保险方案速算');

    await userEvent.click(screen.getByRole('link', { name: /打开.*公开页/ }));
    // 导航到公开页路由占位（slug=my-cap → /a/my-cap）。
    expect(await screen.findByTestId('probe')).toBeInTheDocument();
  });

  it('「创建 Agent」→ 进创建流程（/create/import）', async () => {
    restore = installRoutedFetch(ok());
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: '创建 Agent' }));
    expect(await screen.findByTestId('probe')).toBeInTheDocument();
  });

  it('进行中的创作「继续完善」→ 回到 currentStep 断点（已过导入 → 能力页 /create/capabilities）', async () => {
    restore = installRoutedFetch(ok());
    renderPage();
    await screen.findByText(/结构化中 60%/);
    await userEvent.click(screen.getByRole('button', { name: '继续完善：保险话术草稿' }));
    expect(await screen.findByTestId('probe')).toBeInTheDocument();
  });

  it('工作台 Agent 只是概览，「查看全部」进入独立管理页', async () => {
    restore = installRoutedFetch(ok());
    renderPage();
    await screen.findByText('保险方案速算');
    await userEvent.click(screen.getByRole('button', { name: '查看全部' }));
    expect(await screen.findByTestId('probe')).toBeInTheDocument();
  });
});

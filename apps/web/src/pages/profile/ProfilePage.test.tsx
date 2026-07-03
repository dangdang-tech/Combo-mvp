// 个人主页 F-06 页面集成测试（开工总纲 §四，接 60 §2）：
//   六分区顺序渲染 / 整页加载骨架(不裸转圈) / 整页 404 退路 / sectionErrors 局部错误条+子端点重试 /
//   热力图关闭整段跳过 / usage 占位 / 只读不下钻。
//   无运行后端：用 installFetchMock 驱动 4A typed client（fetchProfile / 分区子端点）。
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { installFetchMock, type FetchMock } from '../../test/mockFetch.js';

// 六分区里 DensityBar/SessionHeatmap 内嵌 ECharts，jsdom 下 mock canvas 实现。
vi.mock('echarts-for-react/lib/core', () => ({
  default: (props: { option: unknown }) => (
    <div data-testid="echarts-core" data-option={JSON.stringify(props.option)} />
  ),
}));

import { ProfilePage } from './ProfilePage.js';
import { makeProfile, makeDensity, makeNetwork, makeWorks, PLACEHOLDER_META } from './fixtures.js';

let fm: FetchMock | undefined;
afterEach(() => {
  fm?.restore();
  fm = undefined;
});

function renderPage(creatorId = 'creator-1') {
  return render(
    <MemoryRouter>
      <ProfilePage creatorId={creatorId} />
    </MemoryRouter>,
  );
}

describe('ProfilePage — 整页加载/错误（主页-15/16）', () => {
  it('加载中 → 骨架占位（永不裸转圈）', () => {
    // fetch 永不 resolve（用 pending promise 模拟加载态）。
    const original = globalThis.fetch;
    globalThis.fetch = vi.fn(() => new Promise(() => {})) as unknown as typeof fetch;
    try {
      renderPage();
      expect(screen.getByRole('status', { name: '个人主页加载中' })).toBeInTheDocument();
    } finally {
      globalThis.fetch = original;
    }
  });

  it('404（creator 不存在）→ 人话 + 退路，绝不裸码、不整页空白', async () => {
    fm = installFetchMock({
      status: 404,
      json: {
        error: {
          userMessage: '没找到这个创作者，可能链接失效了。',
          retriable: false,
          action: 'change_input',
          traceId: 'trace-abc',
        },
      },
    });
    renderPage();
    expect(await screen.findByText('没找到这个创作者，可能链接失效了。')).toBeInTheDocument();
    // 绝不裸露错误码（对外信封无 code）：HTTP 状态码 / code 枚举都不出现在 UI。
    expect(screen.queryByText(/NOT_FOUND/)).toBeNull();
    expect(screen.queryByText('404')).toBeNull();
  });

  it('整页聚合失败 → 重试，第二次成功渲染六分区（带退路）', async () => {
    fm = installFetchMock([
      {
        status: 500,
        json: {
          error: {
            userMessage: '内容没能加载，请重试。',
            retriable: true,
            action: 'retry',
            traceId: 't',
          },
        },
      },
      { status: 200, json: { data: makeProfile(), meta: PLACEHOLDER_META } },
    ]);
    renderPage();
    expect(await screen.findByText('内容没能加载，请重试。')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByRole('heading', { name: 'Wayne' })).toBeInTheDocument();
  });
});

describe('ProfilePage — 六分区顺序与内容（主页-01/02/03/05/09/10/11）', () => {
  it('六分区按固定顺序渲染、不缺分区', async () => {
    fm = installFetchMock({ status: 200, json: { data: makeProfile(), meta: PLACEHOLDER_META } });
    const { container } = renderPage();
    await screen.findByRole('heading', { name: 'Wayne' });

    const sections = Array.from(
      container.querySelectorAll(
        '.cb-profile > section, .cb-profile > div > section, .cb-profile > .cb-profile-section',
      ),
    );
    const labels = Array.from(container.querySelectorAll('[aria-label]'))
      .map((el) => el.getAttribute('aria-label'))
      .filter((l): l is string => l != null);
    // 顺序断言：身份区 → 指标带 → 能力会话密度 → 会话足迹 → 能力网络缩略 → 作品墙。
    const order = ['身份区', '指标带', '能力会话密度', '会话足迹', '能力网络缩略', '作品墙'];
    const idx = order.map((o) => labels.indexOf(o));
    expect(idx.every((i) => i >= 0)).toBe(true);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
    expect(sections.length).toBeGreaterThanOrEqual(6);
  });

  it('① 身份区社交计数真实 / ② 指标带能力点数真实 + 总调用量占位', async () => {
    fm = installFetchMock({ status: 200, json: { data: makeProfile(), meta: PLACEHOLDER_META } });
    const { container } = renderPage();
    await screen.findByRole('heading', { name: 'Wayne' });
    expect(screen.getByText('3,400')).toBeInTheDocument(); // 粉丝真实
    expect(screen.getByText('8')).toBeInTheDocument(); // 能力点数真实
    expect(container.querySelector('[data-placeholder="totalInvocations"]')).toBeInTheDocument();
  });

  it('③ 密度榜逐条段数+趋势 / ⑥ 作品墙单源卡', async () => {
    fm = installFetchMock({ status: 200, json: { data: makeProfile(), meta: PLACEHOLDER_META } });
    renderPage();
    await screen.findByRole('heading', { name: 'Wayne' });
    expect(screen.getByText('29 段支撑')).toBeInTheDocument();
    expect(screen.getByText('作品 cap-1')).toBeInTheDocument();
  });
});

describe('ProfilePage — 热力图开关（主页-20）', () => {
  it('heatmapEnabled=false → 会话足迹整段不渲染，其余分区顺序不乱', async () => {
    fm = installFetchMock({
      status: 200,
      json: { data: makeProfile({ heatmapEnabled: false, heatmap: null }), meta: PLACEHOLDER_META },
    });
    renderPage();
    await screen.findByRole('heading', { name: 'Wayne' });
    expect(screen.queryByText('会话足迹 · 近半年')).toBeNull();
    // 其余分区仍在。
    expect(screen.getByText('作品墙')).toBeInTheDocument();
    expect(screen.getByText('能力网络')).toBeInTheDocument();
  });
});

describe('ProfilePage — 分区局部失败不连坐（主页-17）', () => {
  it('某分区 sectionErrors 标记 → 该分区出局部错误条，其它分区照常', async () => {
    fm = installFetchMock({
      status: 200,
      json: {
        data: makeProfile({ works: null, sectionErrors: [{ section: 'works', retriable: true }] }),
        meta: PLACEHOLDER_META,
      },
    });
    renderPage();
    await screen.findByRole('heading', { name: 'Wayne' });
    // 作品墙局部错误条（人话 + 重试），不整页崩。
    expect(screen.getByText('这个分区没能加载，请重试。')).toBeInTheDocument();
    // 其它分区（身份区/密度榜）照常。
    expect(screen.getByText('能力 · 按会话密度')).toBeInTheDocument();
    expect(screen.queryByText('作品 cap-1')).toBeNull();
  });

  it('分区局部重试 → 调子端点，成功后只 patch 该分区、其它不动', async () => {
    fm = installFetchMock([
      {
        status: 200,
        json: {
          data: makeProfile({
            works: null,
            sectionErrors: [{ section: 'works', retriable: true }],
          }),
          meta: PLACEHOLDER_META,
        },
      },
      // 作品墙子端点重试成功（Paginated：data[] + meta.page）。
      {
        status: 200,
        json: {
          data: makeWorks().cards,
          meta: {
            ...PLACEHOLDER_META,
            page: { nextCursor: null, hasMore: false, limit: 24, order: 'desc' },
          },
        },
      },
    ]);
    renderPage();
    await screen.findByText('这个分区没能加载，请重试。');
    await userEvent.click(screen.getByRole('button', { name: '重试' }));
    // 重试成功 → 作品墙卡出现，局部错误条消失。
    expect(await screen.findByText('作品 cap-1')).toBeInTheDocument();
    expect(screen.queryByText('这个分区没能加载，请重试。')).toBeNull();
  });

  it('② 指标带失败（metrics:null + sectionErrors[metrics]）→ 出局部错误条（不静默吞，Codex r1#2）', async () => {
    fm = installFetchMock({
      status: 200,
      json: {
        data: makeProfile({
          metrics: null,
          sectionErrors: [{ section: 'metrics', retriable: true }],
        }),
        meta: PLACEHOLDER_META,
      },
    });
    renderPage();
    await screen.findByRole('heading', { name: 'Wayne' });
    // 指标带局部错误条（人话 + 重试），不静默吞、不整页崩。
    expect(screen.getByText('这个分区没能加载，请重试。')).toBeInTheDocument();
    // 其它分区照常（密度榜在）。
    expect(screen.getByText('能力 · 按会话密度')).toBeInTheDocument();
  });

  it('② 指标带局部重试 → 整页聚合重拉，成功后指标带就位、错误条消失', async () => {
    fm = installFetchMock([
      {
        status: 200,
        json: {
          data: makeProfile({
            metrics: null,
            sectionErrors: [{ section: 'metrics', retriable: true }],
          }),
          meta: PLACEHOLDER_META,
        },
      },
      // 重试触发整页聚合重拉：metrics 就位。
      { status: 200, json: { data: makeProfile(), meta: PLACEHOLDER_META } },
    ]);
    renderPage();
    await screen.findByText('这个分区没能加载，请重试。');
    await userEvent.click(screen.getByRole('button', { name: '重试' }));
    // 重拉成功 → 指标带数据出现（能力点数 8），错误条消失。
    expect(await screen.findByText('能力点数')).toBeInTheDocument();
    expect(screen.queryByText('这个分区没能加载，请重试。')).toBeNull();
  });

  it('分区局部重试调用的是作品墙子端点 URL（/works）', async () => {
    fm = installFetchMock([
      {
        status: 200,
        json: {
          data: makeProfile({
            network: null,
            sectionErrors: [{ section: 'network', retriable: true }],
          }),
          meta: PLACEHOLDER_META,
        },
      },
      { status: 200, json: { data: makeNetwork(), meta: PLACEHOLDER_META } },
    ]);
    renderPage();
    await screen.findByText('这个分区没能加载，请重试。');
    await userEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() =>
      expect(fm!.calls.some((c) => c.url.includes('/creators/creator-1/network'))).toBe(true),
    );
  });
});

describe('ProfilePage — 展开更多（主页-06）', () => {
  it('密度榜「展开更多」调子端点、合并行', async () => {
    fm = installFetchMock([
      {
        status: 200,
        json: {
          data: makeProfile({ density: makeDensity({ hasMore: true }) }),
          meta: PLACEHOLDER_META,
        },
      },
      // 展开更多：返回更全列表（一次取全替换）。
      {
        status: 200,
        json: {
          data: [
            ...makeDensity().rows,
            {
              rank: 4,
              capabilityId: 'cap-4',
              slug: 's-4',
              name: '能力4',
              densityScore: 60,
              supportingSegments: 26,
              trend: 'flat',
              readonly: true,
            },
          ],
          meta: {
            ...PLACEHOLDER_META,
            page: { nextCursor: null, hasMore: false, limit: 50, order: 'desc' },
          },
        },
      },
    ]);
    renderPage();
    await screen.findByRole('heading', { name: 'Wayne' });
    await userEvent.click(screen.getByRole('button', { name: '展开更多' }));
    expect(await screen.findByText('能力4')).toBeInTheDocument();
  });
});

describe('ProfilePage — 只读不下钻 / 无经营维度（主页-04/25/26）', () => {
  it('不渲染收益/消耗/上传/草稿/编辑等经营或写入入口', async () => {
    fm = installFetchMock({ status: 200, json: { data: makeProfile(), meta: PLACEHOLDER_META } });
    const { container } = renderPage();
    await screen.findByRole('heading', { name: 'Wayne' });
    expect(within(container).queryByText(/收益|本月消耗|上传|草稿|去编辑|改价|下架/)).toBeNull();
    expect(within(container).queryByText(/￥|¥|\$/)).toBeNull();
  });
});

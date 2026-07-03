// useProfile 数据层测试（F-06）——displayState 从后端单源 sectionErrors 派生（不前端自造）、
// 整页 loading/error/ready 状态机、分区局部重试 retrying→ok、子端点 URL/query 正确（byDensity）。
import { describe, it, expect, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { installFetchMock, type FetchMock } from '../../test/mockFetch.js';
import { useProfile } from './useProfile.js';
import { makeProfile, makeWorks, PLACEHOLDER_META } from './fixtures.js';

let fm: FetchMock | undefined;
afterEach(() => {
  fm?.restore();
  fm = undefined;
});

describe('useProfile — 状态机与单源派生', () => {
  it('ready：主聚合成功 → profile/meta 就位，sectionState 全 ok（无 sectionErrors）', async () => {
    fm = installFetchMock({ status: 200, json: { data: makeProfile(), meta: PLACEHOLDER_META } });
    const { result } = renderHook(() => useProfile('c1'));
    await waitFor(() => expect(result.current.phase).toBe('ready'));
    expect(result.current.profile?.hero.displayName).toBe('Wayne');
    expect(result.current.sectionState).toEqual({
      metrics: 'ok',
      density: 'ok',
      heatmap: 'ok',
      network: 'ok',
      works: 'ok',
    });
  });

  it('displayState 从后端单源 sectionErrors 派生（works 标记失败 → works:error，其余 ok）', async () => {
    fm = installFetchMock({
      status: 200,
      json: {
        data: makeProfile({ works: null, sectionErrors: [{ section: 'works', retriable: true }] }),
        meta: PLACEHOLDER_META,
      },
    });
    const { result } = renderHook(() => useProfile('c1'));
    await waitFor(() => expect(result.current.phase).toBe('ready'));
    expect(result.current.sectionState.works).toBe('error');
    expect(result.current.sectionState.density).toBe('ok');
  });

  it('整页 404 → phase=error，error 为 ApiError（人话可读）', async () => {
    fm = installFetchMock({
      status: 404,
      json: {
        error: {
          userMessage: '没找到这个创作者，可能链接失效了。',
          retriable: false,
          action: 'change_input',
          traceId: 'x',
        },
      },
    });
    const { result } = renderHook(() => useProfile('missing'));
    await waitFor(() => expect(result.current.phase).toBe('error'));
    expect(result.current.profile).toBeNull();
  });

  it('分区局部重试：retrying → ok，成功后从 sectionErrors 摘除该分区', async () => {
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
    const { result } = renderHook(() => useProfile('c1'));
    await waitFor(() => expect(result.current.phase).toBe('ready'));
    expect(result.current.sectionState.works).toBe('error');

    act(() => result.current.retrySection('works'));
    await waitFor(() => expect(result.current.sectionState.works).toBe('ok'));
    expect(result.current.profile?.works?.cards.length).toBeGreaterThan(0);
    expect(
      result.current.profile?.sectionErrors.find((e) => e.section === 'works'),
    ).toBeUndefined();
  });

  it('密度榜子端点带 byDensity=true query（§2.3）', async () => {
    fm = installFetchMock([
      {
        status: 200,
        json: {
          data: makeProfile({
            density: null,
            sectionErrors: [{ section: 'density', retriable: true }],
          }),
          meta: PLACEHOLDER_META,
        },
      },
      {
        status: 200,
        json: {
          data: makeProfile().density?.rows ?? [],
          meta: {
            ...PLACEHOLDER_META,
            page: { nextCursor: null, hasMore: false, limit: 50, order: 'desc' },
          },
        },
      },
    ]);
    const { result } = renderHook(() => useProfile('c1'));
    await waitFor(() => expect(result.current.phase).toBe('ready'));
    act(() => result.current.retrySection('density'));
    await waitFor(() =>
      expect(
        fm!.calls.some(
          (c) => c.url.includes('/creators/c1/capabilities') && c.url.includes('byDensity=true'),
        ),
      ).toBe(true),
    );
  });

  it('主聚合请求命中正确 URL（GET /creators/{id}/profile）', async () => {
    fm = installFetchMock({ status: 200, json: { data: makeProfile(), meta: PLACEHOLDER_META } });
    const { result } = renderHook(() => useProfile('creator-xyz'));
    await waitFor(() => expect(result.current.phase).toBe('ready'));
    expect(fm.calls[0]?.url).toContain('/api/v1/creators/creator-xyz/profile');
    expect(fm.calls[0]?.method).toBe('GET');
  });

  // —— metrics 纳入 sectionErrors（Codex r1#2）：不静默吞，出错+可重试（重试走整页聚合） ——
  it('metrics 失败 → sectionState.metrics=error（不静默吞）', async () => {
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
    const { result } = renderHook(() => useProfile('c1'));
    await waitFor(() => expect(result.current.phase).toBe('ready'));
    expect(result.current.sectionState.metrics).toBe('error');
  });

  it('metrics 局部重试走整页聚合重拉：retrying → ok（第二次聚合成功带 metrics）', async () => {
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
      // 重试触发整页聚合重拉：这次 metrics 就位、无 sectionErrors。
      { status: 200, json: { data: makeProfile(), meta: PLACEHOLDER_META } },
    ]);
    const { result } = renderHook(() => useProfile('c1'));
    await waitFor(() => expect(result.current.phase).toBe('ready'));
    expect(result.current.sectionState.metrics).toBe('error');

    const before = fm.calls.filter((c) => c.url.includes('/profile')).length;
    act(() => result.current.retrySection('metrics'));
    await waitFor(() => expect(result.current.sectionState.metrics).toBe('ok'));
    // 重试确实重拉了整页聚合（profile 端点被再次请求）。
    const after = fm.calls.filter((c) => c.url.includes('/profile')).length;
    expect(after).toBe(before + 1);
    expect(result.current.profile?.metrics).toBeTruthy();
  });

  // —— 作品墙翻页（Codex r1#5）：首屏切片带后端 cursor → 「加载更多」真追加（按 cursor，不重拉首页替换） ——
  it('作品墙加载更多：带首屏切片的后端 cursor 续翻，新卡追加不替换、按 capabilityId 去重', async () => {
    fm = installFetchMock([
      // 主聚合：首屏 2 卡 + hasMore + nextCursor（后端铸造）。
      {
        status: 200,
        json: {
          data: makeProfile({
            works: {
              cards: [
                makeWorks().cards[0]!, // cap-1
                makeWorks().cards[1]!, // cap-2
              ],
              hasMore: true,
              nextCursor: 'cursor-p1',
            },
          }),
          meta: PLACEHOLDER_META,
        },
      },
      // 第二页：cap-2（重叠，应被去重）+ cap-3（新），无更多。
      {
        status: 200,
        json: {
          data: [
            { ...makeWorks().cards[1]! }, // cap-2 重叠
            { ...makeWorks().cards[0]!, capabilityId: 'cap-3', name: '作品 cap-3' },
          ],
          meta: {
            ...PLACEHOLDER_META,
            page: { nextCursor: null, hasMore: false, limit: 24, order: 'desc' },
          },
        },
      },
    ]);
    const { result } = renderHook(() => useProfile('c1'));
    await waitFor(() => expect(result.current.phase).toBe('ready'));
    expect(result.current.profile?.works?.cards.map((c) => c.capabilityId)).toEqual([
      'cap-1',
      'cap-2',
    ]);

    act(() => result.current.loadMoreWorks());
    await waitFor(() => expect(result.current.worksLoadingMore).toBe(false));

    // 第二页请求带的是后端铸造的首屏 cursor（真追加，非重拉首页 limit）。
    const worksCall = fm.calls.find((c) => c.url.includes('/works'));
    expect(worksCall?.url).toContain('cursor=cursor-p1');
    // 追加去重：cap-2 不重复，cap-3 新增 → [cap-1, cap-2, cap-3]。
    expect(result.current.profile?.works?.cards.map((c) => c.capabilityId)).toEqual([
      'cap-1',
      'cap-2',
      'cap-3',
    ]);
    expect(result.current.profile?.works?.hasMore).toBe(false);
  });
});

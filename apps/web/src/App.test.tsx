// 路由分组 × 会话探针耦合回归（BUG-010）——AuthProvider 已下移到只包受保护子树：
//   公开页（/a /c /creators/:id/profile）、登录页（/login）、404 在未登录时绝不发 GET /api/v1/me（消 401 console 噪声）。
//   受保护路由（/creator 等）仍由 AuthProvider→RequireAuth 闸门拦截：必发 /me、未登录显示裸登录闸门、不泄漏后台外壳。
//
// 用 App 真组件（含 BrowserRouter）跑：测前用 window.history.pushState 设路径，BrowserRouter 读 window.location。
// fetch 全 mock 并捕获每次调用 url，断言「/me 出现 / 不出现」分流。
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { installFetchMock, type FetchMock } from './test/mockFetch.js';
import { App } from './App.js';

let fm: FetchMock | undefined;
afterEach(() => {
  fm?.restore();
  fm = undefined;
  vi.restoreAllMocks();
  window.history.pushState({}, '', '/');
});

/** 把 App 挂在指定路径下渲染（BrowserRouter 读 window.location）。每用例新 QueryClient（禁 retry/缓存串味）。 */
function renderAppAt(path: string) {
  window.history.pushState({}, '', path);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={qc}>
      <App />
    </QueryClientProvider>,
  );
}

/** 本测试文件捕获到的所有 fetch 是否打过 /me 探针。 */
function meWasFetched(): boolean {
  return (fm?.calls ?? []).some((c) => c.url === '/api/v1/me');
}

describe('App 路由分组 × /me 探针（BUG-010：公开/登录/404 不发 me）', () => {
  it('/login（登录页）：未登录不发 GET /api/v1/me，且诚实渲染登录引导', async () => {
    // 任意调用都给 401（若真发了 /me 会被捕获）；登录页本身不发任何请求。
    fm = installFetchMock({ status: 401, json: { error: { userMessage: 'x' } } });
    renderAppAt('/login');
    expect(await screen.findByText('登录后进入创作者中心')).toBeInTheDocument();
    // 关键断言：公开组在 AuthProvider 之外，匿名访问绝不触发 /me。
    expect(meWasFetched()).toBe(false);
  });

  it('未知路径（404 兜底）：未登录不发 GET /api/v1/me，渲染人话 404', async () => {
    fm = installFetchMock({ status: 401, json: { error: { userMessage: 'x' } } });
    renderAppAt('/this-route-does-not-exist');
    expect(await screen.findByText('页面不存在或已失效')).toBeInTheDocument();
    expect(meWasFetched()).toBe(false);
  });

  it('/a/:slug（公开能力页）：未登录不发 GET /api/v1/me，渲染裸壳公开页', async () => {
    // 公开页本期是诚实占位（不拉数据），关键是绝不被 AuthProvider 拖去发 /me。
    fm = installFetchMock({ status: 401, json: { error: { userMessage: 'x' } } });
    renderAppAt('/a/some-slug');
    expect(await screen.findByText('公开能力页即将上线')).toBeInTheDocument();
    expect(meWasFetched()).toBe(false);
  });

  it('/c/:slug（公开创作者主页）：未登录不发 GET /api/v1/me，渲染裸壳公开页', async () => {
    fm = installFetchMock({ status: 401, json: { error: { userMessage: 'x' } } });
    renderAppAt('/c/some-slug');
    expect(await screen.findByText('公开创作者主页即将上线')).toBeInTheDocument();
    expect(meWasFetched()).toBe(false);
  });

  it('/creators/:id/profile（公开名片，走 optionalAuth 拉自身数据）：仍不发 GET /api/v1/me', async () => {
    // 此页确实会拉公开名片数据（匿名可读），但绝不该出现 /me 探针调用。
    fm = installFetchMock({ status: 200, json: { data: {} } });
    renderAppAt('/creators/creator-1/profile');
    await waitFor(() => expect(fm?.calls.length ?? 0).toBeGreaterThan(0));
    expect(meWasFetched()).toBe(false);
  });
});

describe('App 受保护组守卫未回归（BUG-001/002/003/004/007/008）', () => {
  it('/creator（受保护）：未登录必发 /me，被 RequireAuth 拦成裸登录闸门，不泄漏后台外壳/Wayne', async () => {
    fm = installFetchMock({ status: 401, json: { error: { userMessage: '请先登录' } } });
    renderAppAt('/creator');
    // 守卫必须把 anon 收敛成裸登录闸门（去登录 CTA）。
    expect(await screen.findByText('请先登录后进入创作者中心。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '去登录' })).toBeInTheDocument();
    // 受保护子树（仪表盘 / 侧栏 / persona Wayne）绝不渲染。
    expect(screen.queryByText(/Wayne/)).toBeNull();
    expect(screen.queryByText('工作台')).toBeNull();
    // 受保护组确实发了 /me（与公开组分流，证明探针仍在受保护子树触发）。
    expect(meWasFetched()).toBe(true);
  });

  it('/profile（受保护 self 视图）：未登录被守卫拦成登录闸门（去登录 CTA），发 /me', async () => {
    fm = installFetchMock({ status: 401, json: { error: { userMessage: '请先登录' } } });
    renderAppAt('/profile');
    expect(await screen.findByText('请先登录后进入创作者中心。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '去登录' })).toBeInTheDocument();
    expect(meWasFetched()).toBe(true);
  });
});

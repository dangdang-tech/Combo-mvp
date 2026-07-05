// 页面组件测试的统一挂载：QueryClient（retry:false，禁缓存串味）+ MemoryRouter。
import type { ReactElement } from 'react';
import { render, type RenderResult } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
}

export interface RenderPageOptions {
  /** 初始路由（如 '/tasks/t-1'）。 */
  route?: string;
  /** 路由 path 模板（如 '/tasks/:taskId'）；缺省 '*' 直接渲染。 */
  path?: string;
}

export function renderPage(ui: ReactElement, opts: RenderPageOptions = {}): RenderResult {
  const qc = createTestQueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[opts.route ?? '/']}>
        <Routes>
          <Route path={opts.path ?? '*'} element={ui} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

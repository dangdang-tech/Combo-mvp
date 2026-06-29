// F-07 页面组件测试公用渲染器（mock API/SSE，无运行后端）。
//
// 用 QueryClientProvider（关重试，错误态可即时断言）+ MemoryRouter（路由依赖的页面可渲染）包裹。
// 仅供本目录页面测试复用，不动全站共享 test 基建。
import type { ReactElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { render, type RenderResult } from '@testing-library/react';

/** 新建一个「测试用」QueryClient：关重试 / 关缓存，让 loading→error/success 即时落定。 */
export function makeTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
      mutations: { retry: false },
    },
  });
}

/** 渲染页面：QueryClientProvider + MemoryRouter 包裹（initialPath 可选）。 */
export function renderPage(ui: ReactElement, initialPath = '/'): RenderResult {
  const client = makeTestQueryClient();
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialPath]}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

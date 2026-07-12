import { afterEach, describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { installFetchMock, type FetchMock } from '../test/mockFetch.js';
import { AuthProvider, RequireAuth } from './auth.js';

let fetchMock: FetchMock | undefined;

afterEach(() => {
  fetchMock?.restore();
  fetchMock = undefined;
});

function renderAnonymousGate(): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <MemoryRouter initialEntries={['/tasks']}>
          <Routes>
            <Route element={<RequireAuth />}>
              <Route path="*" element={<p>受保护内容</p>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

describe('anonymous creator gate design', () => {
  it('explains the creator flow, publishing boundary and return path before login', async () => {
    fetchMock = installFetchMock({
      status: 401,
      json: { error: { userMessage: '请先登录' } },
    });

    renderAnonymousGate();

    const heading = await screen.findByRole('heading', {
      level: 1,
      name: '继续创建你的能力',
    });
    const gate = screen.getByRole('alert', { name: '继续创建你的能力' });
    const flow = within(gate).getByRole('list', { name: '创作者中心流程' });

    expect(heading).toBeInTheDocument();
    expect(gate.querySelector('.cb-auth-gate__panel--login')).not.toBeNull();
    expect(
      within(flow)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['上传会话', '提取能力', '确认发布']);
    expect(
      within(gate).getByText('只有你确认发布的能力会出现在试用页，原始会话不会进入试用页。'),
    ).toBeInTheDocument();
    expect(within(gate).getByText('登录完成后，将回到你刚才访问的页面。')).toBeInTheDocument();
    expect(within(gate).getByRole('button', { name: '去登录' })).toBeInTheDocument();
    expect(screen.queryByText('受保护内容')).toBeNull();
  });
});

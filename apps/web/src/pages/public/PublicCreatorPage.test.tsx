// 公开创作者主页 /c/:slug 测试：匿名只读拉 by-slug profile，不发 /me，不伪造作品墙。
import { afterEach, describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { PublicCreatorPage, NotFoundPage } from '../index.js';
import { installFetchMock, type FetchMock } from '../../test/mockFetch.js';
import { makeProfile, makeWorks, makeWorkCard, PLACEHOLDER_META } from '../profile/fixtures.js';

let fm: FetchMock | undefined;
afterEach(() => {
  fm?.restore();
  fm = undefined;
});

function renderAt(path: string): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/c/:slug" element={<PublicCreatorPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('公开创作者主页 /c/:slug', () => {
  it('路由可达：拉取 by-slug profile 并渲染真实公开作品墙', async () => {
    fm = installFetchMock({
      json: {
        data: makeProfile({
          creatorId: 'creator-real',
          slug: 'gw61jgf0fij4',
          hero: {
            avatarUrl: null,
            displayName: 'gw61jgf0fij4',
            identityTags: ['创作者'],
            bio: '',
            social: { following: 0, followers: 0, likes: 0, viewerIsFollowing: null },
          },
          works: makeWorks({
            cards: [
              makeWorkCard({
                capabilityId: 'cap-doc',
                slug: 'cap-wskatc',
                name: '文档与代码一致性核查',
              }),
              makeWorkCard({
                capabilityId: 'cap-fund',
                slug: 'cap-1wyyplq',
                name: '融资材料深度审查',
              }),
            ],
            hasMore: false,
            nextCursor: null,
          }),
        }),
        meta: { ...PLACEHOLDER_META, traceId: 'tr-public-creator' },
      },
    });

    renderAt('/c/gw61jgf0fij4');

    expect(await screen.findByRole('heading', { name: 'gw61jgf0fij4' })).toBeInTheDocument();
    expect(screen.getByText('文档与代码一致性核查')).toBeInTheDocument();
    expect(screen.getByText('融资材料深度审查')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /文档与代码一致性核查/ })).toHaveAttribute(
      'href',
      '/a/cap-wskatc',
    );
    expect(screen.getByRole('link', { name: /融资材料深度审查/ })).toHaveAttribute(
      'href',
      '/a/cap-1wyyplq',
    );
    expect(fm.calls.map((c) => c.url)).toEqual(['/api/v1/creators/by-slug/gw61jgf0fij4/profile']);
  });

  it('加载失败时出人话错误态，不把 slug 当创作者名伪造', async () => {
    fm = installFetchMock({
      status: 404,
      json: {
        error: {
          userMessage: '没找到这个创作者，可能链接失效了。',
          retriable: false,
          action: 'change_input',
          traceId: 'tr-public-creator-404',
        },
      },
    });

    renderAt('/c/gw61jgf0fij4');

    expect(await screen.findByText('没找到这个创作者，可能链接失效了。')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'gw61jgf0fij4' })).not.toBeInTheDocument();
    expect(screen.queryByText('文档与代码一致性核查')).not.toBeInTheDocument();
  });
});

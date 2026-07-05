// 公开能力页 /a/:slug 测试：匿名只读拉 runtime 公开视图，不发 /me，不伪造卡片。
import { afterEach, describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { PublicCapabilityPage, NotFoundPage } from '../index.js';
import { installFetchMock, type FetchMock } from '../../test/mockFetch.js';

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
          <Route path="/a/:slug" element={<PublicCapabilityPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('公开能力页 /a/:slug', () => {
  it('路由可达：拉取公开能力视图并渲染真实只读内容', async () => {
    fm = installFetchMock({
      json: {
        capabilityId: 'cap-1',
        slug: 'doc-check',
        version: '0.1.0',
        status: 'published',
        name: '文档与代码一致性核查',
        tagline: '对照真实代码逐条验证技术文档',
        description: '找出缺失、含糊或不符之处。',
        inputs: {
          fields: [
            {
              key: 'doc_content',
              label: '把要核查的技术文档全文粘贴在这里',
              type: 'string',
              required: true,
            },
          ],
        },
        output: { type: 'score' },
        boundaries: { riskLevel: 'low', redLines: ['不泄露使用者的隐私信息'] },
        starterPrompts: ['把这份 API 文档和源码一起粘进来。'],
      },
    });

    renderAt('/a/doc-check');

    expect(
      await screen.findByRole('heading', { name: '文档与代码一致性核查' }),
    ).toBeInTheDocument();
    expect(screen.getByText('对照真实代码逐条验证技术文档')).toBeInTheDocument();
    expect(screen.getByText('把要核查的技术文档全文粘贴在这里')).toBeInTheDocument();
    expect(screen.getByText('把这份 API 文档和源码一起粘进来。')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '开始使用' })).toHaveAttribute(
      'href',
      '/try/c/doc-check',
    );
    // 不是 NotFound 兜底页。
    expect(screen.queryByText('页面不存在或已失效')).not.toBeInTheDocument();
    expect(fm.calls.map((c) => c.url)).toEqual(['/api/v1/runtime/capabilities/doc-check']);
  });

  it('加载失败时出人话错误态，不把 slug 当标题伪造', async () => {
    fm = installFetchMock({
      status: 404,
      json: {
        error: {
          userMessage: '没找到对应内容，可能已被删除或链接失效。',
          retriable: false,
          action: 'change_input',
          traceId: 'tr-public',
        },
      },
    });

    renderAt('/a/insurance-helper');

    expect(await screen.findByText('没找到对应内容，可能已被删除或链接失效。')).toBeInTheDocument();
    // slug 不得作为标题/内容回显。
    expect(screen.queryByRole('heading', { name: 'insurance-helper' })).not.toBeInTheDocument();
    expect(screen.queryByText('insurance-helper')).not.toBeInTheDocument();
  });
});

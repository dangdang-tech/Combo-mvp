// 公开能力页 /a/:slug 测试——诚实「即将上线」态（公开 by-slug 端点本期范围外、契约冻结、不造）。
//
// 历史缺陷（BUG-005）：此前从 slug 伪造一张「源自一次真实会话」假卡、把 slug 当标题回显、号称
// 「公开只读页」，且渲染在创作者外壳内。修复后：不伪造、不回显 slug、诚实告知即将上线，且不裸 404。
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { PublicCapabilityPage, NotFoundPage } from '../index.js';

function renderAt(path: string): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/a/:slug" element={<PublicCapabilityPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('公开能力页 /a/:slug', () => {
  it('路由可达：命中公开页（非 NotFound），渲染诚实「即将上线」态', () => {
    renderAt('/a/my-cap');
    expect(screen.getByRole('heading', { name: '公开能力页即将上线' })).toBeInTheDocument();
    // 不是 NotFound 兜底页。
    expect(screen.queryByText('页面不存在或已失效')).not.toBeInTheDocument();
  });

  it('不伪造卡片、不把 slug 当标题回显（BUG-005 反向破坏）', () => {
    renderAt('/a/insurance-helper');
    // slug 不得作为标题/内容回显。
    expect(screen.queryByRole('heading', { name: 'insurance-helper' })).not.toBeInTheDocument();
    expect(screen.queryByText('insurance-helper')).not.toBeInTheDocument();
    // 不得出现伪造的「源自一次真实会话」假卡 / 「公开只读页」措辞。
    expect(screen.queryByText(/源自一次真实会话/)).not.toBeInTheDocument();
    expect(screen.queryByText(/公开只读页/)).not.toBeInTheDocument();
  });
});

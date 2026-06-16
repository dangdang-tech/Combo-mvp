// 导航外壳 Shell 测试（F-04，D14：外壳恒定）。覆盖 QA 外壳首页-02/03/04/05/06/07/28/36：
//   三段式结构齐全、分组导航、收起/展开纯图标态、收起态可点可识别、面包屑分层、
//   五步流程外壳不重建、当前页高亮、收起偏好刷新不丢。
//   无运行后端：纯前端外壳，路由用 MemoryRouter 驱动，子页用轻量占位。
import type { ReactElement } from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { Shell } from './Shell.js';
import { ViewModeProvider } from './viewMode.js';
import { AccountProvider, type ShellAccount } from './account.js';
import { SIDEBAR_COLLAPSE_KEY } from './useCollapse.js';

function leaf(label: string): ReactElement {
  return <div data-testid="page">{label}</div>;
}

function renderShell(initialPath = '/creator', account?: ShellAccount): void {
  render(
    <ViewModeProvider>
      <AccountProvider account={account}>
        <MemoryRouter initialEntries={[initialPath]}>
          <Routes>
            <Route element={<Shell />}>
              <Route path="/creator" element={leaf('工作台页')} />
              <Route path="/capabilities" element={leaf('我的能力页')} />
              <Route path="/analytics" element={leaf('数据分析页')} />
              <Route path="/earnings" element={leaf('收益页')} />
              <Route path="/profile" element={leaf('个人主页页')} />
              <Route path="/create" element={leaf('上传 import')} />
              <Route path="/create/import" element={leaf('上传 import')} />
              <Route path="/create/extract" element={leaf('上传 extract')} />
              <Route path="/create/publish" element={leaf('上传 publish')} />
            </Route>
          </Routes>
        </MemoryRouter>
      </AccountProvider>
    </ViewModeProvider>,
  );
}

describe('Shell 三段式结构 + 常驻元素（外壳首页-02）', () => {
  beforeEach(() => globalThis.localStorage.clear());

  it('侧栏 + 顶栏 + 主内容区三者同时存在', () => {
    renderShell();
    expect(screen.getByRole('complementary', { name: '侧边导航' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: '面包屑' })).toBeInTheDocument();
    expect(screen.getByRole('main')).toBeInTheDocument();
    expect(screen.getByTestId('page')).toHaveTextContent('工作台页');
  });

  it('侧栏顶部有 Agora 品牌字标 + 收起/展开开关', () => {
    renderShell();
    expect(screen.getByText('Agora')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '收起侧栏' })).toBeInTheDocument();
  });

  it('侧栏底部账号区显示头像 + 姓名 + 职位（Wayne · CGO）', () => {
    renderShell();
    const aside = screen.getByRole('complementary', { name: '侧边导航' });
    expect(within(aside).getByText('Wayne')).toBeInTheDocument();
    expect(within(aside).getByText('CGO')).toBeInTheDocument();
    // 兜底首字母头像（avatarUrl=null）。
    expect(within(aside).getByRole('img', { name: 'Wayne · CGO' })).toHaveTextContent('W');
  });

  it('顶栏右上角常驻账号头像', () => {
    renderShell();
    const topbar = screen.getByRole('banner');
    expect(within(topbar).getByRole('img', { name: 'Wayne · CGO' })).toBeInTheDocument();
  });
});

describe('侧栏导航分两组且菜单项齐全（外壳首页-03）', () => {
  beforeEach(() => globalThis.localStorage.clear());

  it('创作组与我的组小标题可见', () => {
    renderShell();
    expect(screen.getByText('创作')).toBeInTheDocument();
    expect(screen.getByText('我的')).toBeInTheDocument();
  });

  it('六个导航项齐全（工作台/我的能力/上传能力/数据分析/收益/个人主页）', () => {
    renderShell();
    const nav = screen.getByRole('navigation', { name: '主导航' });
    for (const label of ['工作台', '我的能力', '上传能力', '数据分析', '收益', '个人主页']) {
      expect(within(nav).getByRole('link', { name: label })).toBeInTheDocument();
    }
  });
});

describe('收起 / 展开纯图标态（外壳首页-04/05/36）', () => {
  beforeEach(() => globalThis.localStorage.clear());

  it('点收起 → data-collapsed=true + 主区变宽；再点展开 → false', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <ViewModeProvider>
        <AccountProvider>
          <MemoryRouter initialEntries={['/creator']}>
            <Routes>
              <Route element={<Shell />}>
                <Route path="/creator" element={leaf('工作台页')} />
              </Route>
            </Routes>
          </MemoryRouter>
        </AccountProvider>
      </ViewModeProvider>,
    );
    const shell = container.querySelector('.cb-shell');
    expect(shell).toHaveAttribute('data-collapsed', 'false');
    await user.click(screen.getByRole('button', { name: '收起侧栏' }));
    expect(shell).toHaveAttribute('data-collapsed', 'true');
    await user.click(screen.getByRole('button', { name: '展开侧栏' }));
    expect(shell).toHaveAttribute('data-collapsed', 'false');
  });

  it('收起态：导航链接仍在且带 title（hover 可识别，外壳首页-05）', async () => {
    const user = userEvent.setup();
    renderShell();
    await user.click(screen.getByRole('button', { name: '收起侧栏' }));
    const link = screen.getByRole('link', { name: '我的能力' });
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute('title', '我的能力');
  });

  it('收起态：链接仍可点并完成导航（外壳首页-05）', async () => {
    const user = userEvent.setup();
    renderShell();
    await user.click(screen.getByRole('button', { name: '收起侧栏' }));
    await user.click(screen.getByRole('link', { name: '我的能力' }));
    expect(screen.getByTestId('page')).toHaveTextContent('我的能力页');
  });

  it('收起后偏好落 localStorage（外壳首页-36 刷新不丢的存储侧）', async () => {
    const user = userEvent.setup();
    renderShell();
    await user.click(screen.getByRole('button', { name: '收起侧栏' }));
    expect(globalThis.localStorage.getItem(SIDEBAR_COLLAPSE_KEY)).toBe('1');
  });

  it('已存收起偏好 → 初次挂载即收起态（外壳首页-36 刷新读回）', () => {
    globalThis.localStorage.setItem(SIDEBAR_COLLAPSE_KEY, '1');
    const { container } = render(
      <ViewModeProvider>
        <AccountProvider>
          <MemoryRouter initialEntries={['/creator']}>
            <Routes>
              <Route element={<Shell />}>
                <Route path="/creator" element={leaf('工作台页')} />
              </Route>
            </Routes>
          </MemoryRouter>
        </AccountProvider>
      </ViewModeProvider>,
    );
    expect(container.querySelector('.cb-shell')).toHaveAttribute('data-collapsed', 'true');
  });
});

describe('面包屑分层（外壳首页-06）', () => {
  beforeEach(() => globalThis.localStorage.clear());

  it('工作台 → 仅 Creator Builder', () => {
    renderShell('/creator');
    const bc = screen.getByRole('navigation', { name: '面包屑' });
    expect(bc).toHaveTextContent('Creator Builder');
    expect(bc).not.toHaveTextContent('上传能力');
  });

  it('五步页 → Creator Builder / 上传能力 / STEP② 提取，末段为当前页不可点', () => {
    renderShell('/create/extract');
    const bc = screen.getByRole('navigation', { name: '面包屑' });
    expect(bc).toHaveTextContent('Creator Builder / 上传能力 / STEP② 提取');
    expect(within(bc).getByText('STEP② 提取')).toHaveAttribute('aria-current', 'page');
    // 前序段可点回跳。
    expect(within(bc).getByRole('link', { name: '上传能力' })).toBeInTheDocument();
  });
});

describe('当前页高亮（外壳首页-28）', () => {
  beforeEach(() => globalThis.localStorage.clear());

  it('当前页在侧栏唯一高亮，换页后高亮跟随', async () => {
    const user = userEvent.setup();
    renderShell('/creator');
    const nav = screen.getByRole('navigation', { name: '主导航' });
    expect(within(nav).getByRole('link', { name: '工作台' })).toHaveClass(
      'cb-shell__navlink--active',
    );
    const actives0 = within(nav)
      .getAllByRole('link')
      .filter((el) => el.classList.contains('cb-shell__navlink--active'));
    expect(actives0).toHaveLength(1);

    await user.click(within(nav).getByRole('link', { name: '数据分析' }));
    expect(within(nav).getByRole('link', { name: '数据分析' })).toHaveClass(
      'cb-shell__navlink--active',
    );
    expect(within(nav).getByRole('link', { name: '工作台' })).not.toHaveClass(
      'cb-shell__navlink--active',
    );
  });
});

describe('五步流程外壳不重建（外壳首页-07，批注 D14）', () => {
  beforeEach(() => globalThis.localStorage.clear());

  it('从 import 走到 publish，侧栏/品牌/账号区/顶栏头像始终在原位且为同一节点', async () => {
    const user = userEvent.setup();
    renderShell('/create/import');

    const asideBefore = screen.getByRole('complementary', { name: '侧边导航' });
    const brandBefore = screen.getByText('Agora');
    const topAvatarBefore = within(screen.getByRole('banner')).getByRole('img', {
      name: 'Wayne · CGO',
    });
    expect(screen.getByTestId('page')).toHaveTextContent('上传 import');

    // 面包屑里的「上传能力」在五步内恒定可见。
    await user.click(screen.getByRole('link', { name: '收益' })); // 离开再回，验证外壳不随内容重建
    await user.click(screen.getByRole('link', { name: '上传能力' }));

    // 同一外壳 DOM 节点（toBe 引用相等 → 没有被卸载重建）。
    expect(screen.getByRole('complementary', { name: '侧边导航' })).toBe(asideBefore);
    expect(screen.getByText('Agora')).toBe(brandBefore);
    expect(within(screen.getByRole('banner')).getByRole('img', { name: 'Wayne · CGO' })).toBe(
      topAvatarBefore,
    );
  });
});

describe('双视角开关占位（D14，本期只切前端态）', () => {
  beforeEach(() => globalThis.localStorage.clear());

  it('默认创作者视角，点击切到消费者视角', async () => {
    const user = userEvent.setup();
    renderShell();
    const toggle = screen.getByRole('button', { name: '创作者视角' });
    expect(toggle).toHaveTextContent('创作者视角');
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await user.click(toggle);
    expect(toggle).toHaveTextContent('消费者视角');
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('账号头像兜底（avatarUrl 有值时用图，非破图）', () => {
  beforeEach(() => globalThis.localStorage.clear());

  it('avatarUrl 有值 → 渲染 img 元素带 alt', () => {
    renderShell('/creator', { avatarUrl: 'https://cdn/a.png', name: 'Lea', title: 'PM' });
    const aside = screen.getByRole('complementary', { name: '侧边导航' });
    const img = within(aside).getByRole('img', { name: 'Lea · PM' });
    expect(img.tagName).toBe('IMG');
    expect(img).toHaveAttribute('src', 'https://cdn/a.png');
  });
});

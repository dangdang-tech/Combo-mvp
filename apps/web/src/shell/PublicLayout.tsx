// 对外裸壳 PublicLayout——公开/404 页用：无创作者外壳（侧栏 / 账号 / 视角开关一律不出现）。
//
// Landing、公开能力页 /a/:slug、公开创作者主页 /c/:slug、404 都渲染在这里。只留公开品牌
// 导航，避免创作者后台账号（如 Wayne）/ 侧栏在对外页面渗漏（BUG-005/006）。
import type { ReactElement } from 'react';
import { Link, Outlet, useLocation } from 'react-router-dom';
import { ComboWordmark } from './brand.js';

export function PublicLayout(): ReactElement {
  const { pathname } = useLocation();
  const shellClass =
    pathname === '/' ? 'cb-public-shell cb-public-shell--landing' : 'cb-public-shell';

  return (
    <div className={shellClass}>
      <header className="cb-public-shell__top">
        <Link to="/" className="cb-public-shell__brand" aria-label="Combo 首页">
          <ComboWordmark className="cb-public-shell__brand-word" />
        </Link>
        <nav className="cb-public-shell__nav" aria-label="公开导航">
          <a href="/#how-it-works">如何工作</a>
          <a href="/#product">能力是什么</a>
        </nav>
        <div className="cb-public-shell__actions">
          <Link className="cb-public-shell__login" to="/login">
            登录
          </Link>
          <Link className="cb-public-shell__start" to="/tasks">
            开始创建
          </Link>
        </div>
      </header>
      <main className="cb-public-shell__content">
        <Outlet />
      </main>
    </div>
  );
}

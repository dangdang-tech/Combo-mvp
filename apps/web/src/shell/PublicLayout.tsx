// 对外裸壳 PublicLayout——公开/404 页用：无创作者外壳（侧栏 / 账号 / 视角开关一律不出现）。
//
// 公开能力页 /a/:slug、公开创作者主页 /c/:slug、404 都渲染在这里。只留最小品牌头，避免
// 创作者后台账号（如 Wayne）/ 侧栏在对外页面渗漏（BUG-005/006）。子页经 <Outlet> 渲染。
import type { ReactElement } from 'react';
import { Link, Outlet } from 'react-router-dom';
import { ComboWordmark } from './brand.js';

export function PublicLayout(): ReactElement {
  return (
    <div className="cb-public-shell">
      <header className="cb-public-shell__top">
        <Link to="/" className="cb-public-shell__brand" aria-label="Combo 首页">
          <ComboWordmark className="cb-public-shell__brand-word" />
        </Link>
      </header>
      <main className="cb-public-shell__content">
        <Outlet />
      </main>
    </div>
  );
}

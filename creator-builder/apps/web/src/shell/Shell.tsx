// 导航外壳 Shell（F-04，D14：左侧固定侧栏 + 顶部面包屑栏 + 主内容区，全流程恒定结构）。
//
// 侧栏（开工总纲 §2.1/§2.2）：
//   顶部 — Agora 品牌字标 + 收起/展开开关
//   中段 — 两组导航（创作 / 我的），可收起为纯图标态（收起后只剩图标 + hover tooltip）
//   底部 — 当前账号常驻区（头像 + 姓名 · 职位，如 Wayne · CGO）
// 顶栏（§2.2）：面包屑（如「Creator Builder / 上传能力」）+ 右上角账号头像（+ 视角开关占位）。
// 子页经 <Outlet> 渲染；五步上传流程任何一步都不改外壳结构（批注 D14）。
import type { ReactElement } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { CREATOR_NAV, NAV_GROUPS, breadcrumbFor, type NavItem } from './routes.js';
import { useViewMode } from './viewMode.js';
import { useCollapse } from './useCollapse.js';
import { useAccount, avatarInitial, type ShellAccount } from './account.js';
import { IconChevrons } from './icons.js';

export function Shell(): ReactElement {
  const location = useLocation();
  const { mode, toggle: toggleView } = useViewMode();
  const { collapsed, toggle: toggleCollapse } = useCollapse();
  const account = useAccount();
  const crumbs = breadcrumbFor(location.pathname);

  return (
    <div className="cb-shell" data-view-mode={mode} data-collapsed={collapsed ? 'true' : 'false'}>
      {/* 左侧栏：恒定结构（D14）。收起时整体收窄为纯图标态。 */}
      <aside className="cb-shell__sidebar" aria-label="侧边导航">
        <div className="cb-shell__brand">
          {/* Agora 品牌字标（收起态隐去文字，仅留首字母徽标）。 */}
          <Link to="/creator" className="cb-shell__brand-link" aria-label="Agora 创作者中心 首页">
            <span className="cb-shell__brand-mark" aria-hidden="true">
              A
            </span>
            <span className="cb-shell__brand-word">Agora</span>
          </Link>
          <button
            type="button"
            className="cb-shell__collapse"
            onClick={toggleCollapse}
            aria-pressed={collapsed}
            aria-label={collapsed ? '展开侧栏' : '收起侧栏'}
            title={collapsed ? '展开侧栏' : '收起侧栏'}
          >
            <IconChevrons
              className="cb-shell__collapse-icon"
              style={collapsed ? { transform: 'rotate(180deg)' } : undefined}
            />
          </button>
        </div>

        <nav className="cb-shell__nav" aria-label="主导航">
          {NAV_GROUPS.map((g) => {
            const items = CREATOR_NAV.filter((n) => n.group === g.key);
            if (items.length === 0) return null;
            return (
              <div className="cb-shell__navgroup" key={g.key} data-group={g.key}>
                {/* 分组小标题（展开态可见；收起态用分隔线，靠 CSS 隐藏文字）。 */}
                <p className="cb-shell__navgroup-title" aria-hidden={collapsed}>
                  {g.label}
                </p>
                <ul className="cb-shell__navlist">
                  {items.map((n) => (
                    <NavItemLink key={n.path} item={n} collapsed={collapsed} />
                  ))}
                </ul>
              </div>
            );
          })}
        </nav>

        {/* 侧栏底部：当前账号常驻区（外壳首页-02：头像 + 姓名 · 职位）。 */}
        <div className="cb-shell__account">
          <AccountAvatar account={account} className="cb-shell__account-avatar" />
          <span className="cb-shell__account-meta">
            <span className="cb-shell__account-name">{account.name}</span>
            <span className="cb-shell__account-title">{account.title}</span>
          </span>
        </div>
      </aside>

      {/* 主区：顶栏面包屑 + 视角开关 + 右上头像 + 内容 Outlet。 */}
      <div className="cb-shell__main">
        <header className="cb-shell__topbar">
          <nav className="cb-shell__breadcrumb" aria-label="面包屑">
            {crumbs.map((c, i) => {
              const isLast = i === crumbs.length - 1;
              return (
                <span key={c.path} className="cb-shell__crumb">
                  {i > 0 && (
                    <span className="cb-shell__crumb-sep" aria-hidden="true">
                      {' / '}
                    </span>
                  )}
                  {isLast ? (
                    <span aria-current="page">{c.label}</span>
                  ) : (
                    <Link to={c.path}>{c.label}</Link>
                  )}
                </span>
              );
            })}
          </nav>

          <div className="cb-shell__topbar-right">
            {/* 双视角开关占位（D14）：本期只切前端视角态，不动鉴权/路由。 */}
            <button
              type="button"
              className="cb-shell__viewtoggle"
              onClick={toggleView}
              aria-pressed={mode === 'consumer'}
              title="切换创作者 / 消费者视角（占位）"
            >
              {mode === 'creator' ? '创作者视角' : '消费者视角'}
            </button>
            {/* 顶栏右上角账号头像（§2.2 常驻）。 */}
            <AccountAvatar account={account} className="cb-shell__topbar-avatar" />
          </div>
        </header>

        <main className="cb-shell__content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

/** 单条侧栏导航项：展开显图标+文字；收起仅图标，文字降级为 title tooltip（外壳首页-05）。 */
function NavItemLink({ item, collapsed }: { item: NavItem; collapsed: boolean }): ReactElement {
  const Icon = item.icon;
  return (
    <li>
      <NavLink
        to={item.path}
        className={({ isActive }) =>
          isActive ? 'cb-shell__navlink cb-shell__navlink--active' : 'cb-shell__navlink'
        }
        end={item.path === '/creator'}
        // 收起态文字隐藏，title 提供可识别名（外壳首页-05：hover 可见、可点）。
        title={collapsed ? item.label : undefined}
      >
        <Icon className="cb-shell__navicon" />
        <span className="cb-shell__navlabel">{item.label}</span>
      </NavLink>
    </li>
  );
}

/** 账号头像：有 URL 用图，缺省走首字母兜底（非破图，对齐契约 avatarUrl 兜底口径）。 */
function AccountAvatar({
  account,
  className,
}: {
  account: ShellAccount;
  className?: string;
}): ReactElement {
  const cls = className ? `cb-avatar ${className}` : 'cb-avatar';
  const alt = `${account.name} · ${account.title}`;
  if (account.avatarUrl) {
    return <img className={cls} src={account.avatarUrl} alt={alt} />;
  }
  return (
    <span className={cls} role="img" aria-label={alt}>
      {avatarInitial(account.name)}
    </span>
  );
}

import { type ReactNode } from 'react';
import './mini-app-shell.css';

export type MiniAppShellStatus = 'running' | 'ok' | 'error';

export interface MiniAppShellProps {
  /** 经验体名称，衬线标题。 */
  title: string;
  /** 标题下方的等宽说明文字，例如来源或版本号。 */
  subtitle?: string;
  /** 运行状态：running 显示 warn 色、ok 显示 ok 色、error 显示 danger 色的小圆点加等宽状态词。 */
  status?: MiniAppShellStatus;
  /** 头部右侧的操作插槽，通常放按钮。 */
  actions?: ReactNode;
  /** 底部插槽，与内容区之间有 line-3 分隔线。 */
  footer?: ReactNode;
  /** 内容区，渲染在 surface 底的内衬区域里。 */
  children: ReactNode;
}

/**
 * 经验体（mini-app）容器：paper 底、hero 圆角、hero 阴影的卡片外壳。
 * 头部是衬线标题加等宽副标题，右侧依次是状态点和 actions 插槽；
 * 内容区是 surface 底的内衬区域；footer 存在时与内容区之间有一条 line-3 分隔线。
 */
export function MiniAppShell({
  title,
  subtitle,
  status,
  actions,
  footer,
  children,
}: MiniAppShellProps) {
  return (
    <section className="cb-mini-app-shell">
      <header className="cb-mini-app-shell-head">
        <div className="cb-mini-app-shell-heading">
          <h2 className="cb-mini-app-shell-title">{title}</h2>
          {subtitle !== undefined && <p className="cb-mini-app-shell-subtitle">{subtitle}</p>}
        </div>
        <div className="cb-mini-app-shell-side">
          {status !== undefined && (
            <span className={`cb-mini-app-shell-status cb-mini-app-shell-status--${status}`}>
              <span className="cb-mini-app-shell-dot" aria-hidden="true" />
              {status}
            </span>
          )}
          {actions !== undefined && <div className="cb-mini-app-shell-actions">{actions}</div>}
        </div>
      </header>
      <div className="cb-mini-app-shell-body">{children}</div>
      {footer !== undefined && <footer className="cb-mini-app-shell-footer">{footer}</footer>}
    </section>
  );
}

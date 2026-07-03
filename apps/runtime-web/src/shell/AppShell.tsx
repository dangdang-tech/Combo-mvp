import { Outlet } from 'react-router-dom';

export function AppShell() {
  return (
    <div className="rt-shell">
      <header className="rt-topbar">
        <div className="rt-window-dots" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <span className="rt-topbar__eyebrow">AGORA · CAPABILITY RUNTIME</span>
      </header>
      <main className="rt-shell__main">
        <Outlet />
      </main>
    </div>
  );
}

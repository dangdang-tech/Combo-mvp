import { Outlet } from 'react-router-dom';
import { CloudReviewBar } from './CloudReviewBar.js';

export function AppShell() {
  return (
    <div className="rt-shell">
      <header className="rt-topbar">
        <div className="rt-window-dots" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <span className="rt-topbar__eyebrow">COMBO · CAPABILITY RUNTIME</span>
        <CloudReviewBar />
      </header>
      <main className="rt-shell__main">
        <Outlet />
      </main>
    </div>
  );
}

import { Link, Outlet } from 'react-router-dom';

export function AppShell() {
  return (
    <div className="rt-shell">
      <header className="rt-topbar">
        <Link to="/" className="rt-brand">
          <span className="rt-brand__mark">A</span>
          <span className="rt-brand__word">Agora</span>
          <span className="rt-brand__sub">试用</span>
        </Link>
        <span className="rt-topbar__eyebrow">AGORA · TRY · 对话式能力试用</span>
      </header>
      <main className="rt-shell__main">
        <Outlet />
      </main>
    </div>
  );
}

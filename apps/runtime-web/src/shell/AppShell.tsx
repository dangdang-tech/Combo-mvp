import { Outlet } from 'react-router-dom';

export function AppShell() {
  return (
    <div className="rt-shell">
      <main className="rt-shell__main">
        <Outlet />
      </main>
    </div>
  );
}

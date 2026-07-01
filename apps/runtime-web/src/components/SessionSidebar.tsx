import { Link, useNavigate } from 'react-router-dom';
import { useSessions } from '../api/runtime.js';

export function SessionSidebar({ activeSessionId }: { activeSessionId?: string }) {
  const navigate = useNavigate();
  const sessions = useSessions();

  return (
    <nav className="rt-sidebar">
      <button type="button" className="rt-sidebar__new" onClick={() => navigate('/')}>
        ＋ 新会话
      </button>
      <div className="rt-sidebar__label">最近会话</div>
      <div className="rt-sidebar__list">
        {sessions.data?.items.map((s) => (
          <Link
            key={s.id}
            to={`/session/${s.id}`}
            className={`rt-sidebar__item${s.id === activeSessionId ? ' is-active' : ''}`}
          >
            <span className="rt-sidebar__item-title">{s.title}</span>
            <span className="rt-sidebar__item-cap">{s.capabilityName}</span>
          </Link>
        ))}
        {sessions.data && sessions.data.items.length === 0 && (
          <div className="rt-sidebar__empty">还没有会话</div>
        )}
      </div>
    </nav>
  );
}

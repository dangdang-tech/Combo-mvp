import { useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { RuntimeSessionListItem } from '@cb/shared';
import { useSessions } from '../api/runtime.js';

export function SessionSidebar({
  activeSession,
  activeSessionId,
}: {
  activeSession?: RuntimeSessionListItem;
  activeSessionId?: string;
}) {
  const navigate = useNavigate();
  const sessions = useSessions();
  const visibleSessions = useMemo(() => {
    const items = sessions.data?.items ?? [];
    if (!activeSession) return items;
    const exists = items.some((item) => item.id === activeSession.id);
    if (!exists) return [activeSession, ...items];
    return items.map((item) => (item.id === activeSession.id ? activeSession : item));
  }, [activeSession, sessions.data?.items]);

  return (
    <nav className="rt-sidebar">
      <button type="button" className="rt-sidebar__new" onClick={() => navigate('/market')}>
        ＋ 新会话
      </button>
      <div className="rt-sidebar__label">最近会话</div>
      <div className="rt-sidebar__list">
        {visibleSessions.map((s) => (
          <Link
            key={s.id}
            to={`/session/${s.id}`}
            className={`rt-sidebar__item${s.id === activeSessionId ? ' is-active' : ''}`}
          >
            <span className="rt-sidebar__item-title">{s.title}</span>
            <span className="rt-sidebar__item-cap">{s.capabilityName}</span>
          </Link>
        ))}
        {sessions.data && visibleSessions.length === 0 && (
          <div className="rt-sidebar__empty">还没有会话</div>
        )}
      </div>
    </nav>
  );
}

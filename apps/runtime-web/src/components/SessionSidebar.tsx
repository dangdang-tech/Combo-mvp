import { useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { RuntimeSessionListItem } from '@cb/shared';
import { useSessions } from '../api/runtime.js';

function modeLabel(mode: RuntimeSessionListItem['mode']): string {
  return mode === 'consume' ? '正式' : '试用';
}

function sortLinkedSessions(items: RuntimeSessionListItem[]): RuntimeSessionListItem[] {
  return [...items].sort((a, b) => {
    if (a.mode !== b.mode) return a.mode === 'consume' ? -1 : 1;
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });
}

export function SessionSidebar({
  activeSession,
  activeSessionId,
  capabilitySlug,
}: {
  activeSession?: RuntimeSessionListItem;
  activeSessionId?: string;
  capabilitySlug?: string;
}) {
  const navigate = useNavigate();
  const sessions = useSessions(capabilitySlug);
  const visibleSessions = useMemo(() => {
    const items = (sessions.data?.items ?? []).filter(
      (item) => !capabilitySlug || item.slug === capabilitySlug,
    );
    if (!activeSession) return sortLinkedSessions(items);
    const exists = items.some((item) => item.id === activeSession.id);
    if (!exists) return sortLinkedSessions([activeSession, ...items]);
    return sortLinkedSessions(
      items.map((item) => (item.id === activeSession.id ? activeSession : item)),
    );
  }, [activeSession, capabilitySlug, sessions.data?.items]);

  return (
    <nav className="rt-sidebar">
      <div className="rt-sidebar__head">
        <div className="rt-sidebar__brand">Agora</div>
        <button type="button" className="rt-sidebar__inbox" onClick={() => navigate('/market')}>
          ← Inbox 返回收件箱
        </button>
      </div>
      <div className="rt-sidebar__label">正在运行</div>
      <div className="rt-sidebar__list">
        {visibleSessions.map((s) => (
          <SessionListLink key={s.id} session={s} active={s.id === activeSessionId} />
        ))}
        {sessions.data && visibleSessions.length === 0 && (
          <div className="rt-sidebar__empty">还没有会话</div>
        )}
      </div>
      <div className="rt-sidebar__user">
        <span className="rt-sidebar__user-avatar">W</span>
        <span>Wayne · CGO</span>
      </div>
    </nav>
  );
}

function SessionListLink({
  session,
  active,
}: {
  session: RuntimeSessionListItem;
  active: boolean;
}) {
  const title = session.capabilityName || session.title;
  const secondary = session.title && session.title !== title ? session.title : '';
  const avatar = title.trim().slice(0, 1).toUpperCase() || 'A';

  return (
    <Link to={`/session/${session.id}`} className={`rt-sidebar__item${active ? ' is-active' : ''}`}>
      <span className="rt-sidebar__avatar">{avatar}</span>
      <span className="rt-sidebar__item-copy">
        <span className="rt-sidebar__item-title">{title}</span>
        <span className="rt-sidebar__item-cap">
          <span className={`rt-sidebar__mode rt-sidebar__mode--${session.mode}`}>
            {modeLabel(session.mode)}
          </span>
          {secondary || '当前能力会话'}
        </span>
      </span>
      <span className="rt-sidebar__status" />
    </Link>
  );
}

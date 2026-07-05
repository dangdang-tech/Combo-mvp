// 左侧会话栏：按能力隔离——给了 capabilityId 只列该能力下的会话，「新会话」也在
// 该能力下直接开（GET /runtime/sessions?capabilityId= + POST /runtime/sessions）；
// 换能力走底部的市集入口。头部保留回创作端 / 回入口页按钮。
import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { SessionView } from '@cb/shared';
import { useCreateSession, useSessions } from '../api/runtime.js';
import {
  runtimeBackLabel,
  runtimeBackTarget,
  safeRuntimeReturnTo,
} from '../navigation/runtimeReturn.js';

export function SessionSidebar({
  activeSessionId,
  capabilityId,
  capabilityName,
  returnTo,
}: {
  activeSessionId?: string;
  /** 当前能力：会话列表与「新会话」都限定在它下面；缺省（加载中）时列表为空态。 */
  capabilityId?: string;
  capabilityName?: string;
  returnTo?: string | null;
}) {
  const safeReturnTo = safeRuntimeReturnTo(returnTo);
  const navigate = useNavigate();
  const sessions = useSessions(capabilityId);
  const createSession = useCreateSession();
  const [createError, setCreateError] = useState(false);
  const ordered = useMemo(
    () =>
      [...(sessions.data ?? [])].sort(
        (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      ),
    [sessions.data],
  );

  const startNewSession = () => {
    if (!capabilityId || createSession.isPending) return;
    setCreateError(false);
    createSession.mutate(capabilityId, {
      onSuccess: (session) => navigate(`/session/${session.id}`),
      onError: () => setCreateError(true),
    });
  };

  return (
    <nav className="rt-sidebar">
      <div className="rt-sidebar__head">
        <div className="rt-sidebar__brand">Agora</div>
        <button
          type="button"
          className="rt-sidebar__inbox"
          onClick={() => window.location.assign(runtimeBackTarget(safeReturnTo))}
        >
          {runtimeBackLabel(safeReturnTo)}
        </button>
      </div>
      <div className="rt-sidebar__label">{capabilityName ?? '会话'}</div>
      <div className="rt-sidebar__list">
        {capabilityId && (
          <button
            type="button"
            className="rt-sidebar__item rt-sidebar__item--action"
            disabled={createSession.isPending}
            onClick={startNewSession}
          >
            <span className="rt-sidebar__avatar">＋</span>
            <span className="rt-sidebar__item-copy">
              <span className="rt-sidebar__item-title">
                {createSession.isPending ? '创建中…' : '新会话'}
              </span>
              <span className="rt-sidebar__item-cap">
                {createError ? '没建成，点击重试' : '用这个能力再开一次'}
              </span>
            </span>
          </button>
        )}
        {ordered.map((s) => (
          <SessionListLink key={s.id} session={s} active={s.id === activeSessionId} />
        ))}
        {sessions.data && ordered.length === 0 && (
          <div className="rt-sidebar__empty">这个能力下还没有会话</div>
        )}
      </div>
      <div className="rt-sidebar__foot">
        <Link to="/market" className="rt-sidebar__market">
          换个能力 · 去市集
        </Link>
      </div>
    </nav>
  );
}

function SessionListLink({ session, active }: { session: SessionView; active: boolean }) {
  const title = session.title ?? '未命名会话';
  const avatar = title.trim().slice(0, 1).toUpperCase() || 'A';
  const updated = new Date(session.updatedAt).toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <Link to={`/session/${session.id}`} className={`rt-sidebar__item${active ? ' is-active' : ''}`}>
      <span className="rt-sidebar__avatar">{avatar}</span>
      <span className="rt-sidebar__item-copy">
        <span className="rt-sidebar__item-title">{title}</span>
        <span className="rt-sidebar__item-cap">
          {session.status === 'closed' ? '已结束 · ' : ''}
          {updated}
        </span>
      </span>
      <span className="rt-sidebar__status" />
    </Link>
  );
}

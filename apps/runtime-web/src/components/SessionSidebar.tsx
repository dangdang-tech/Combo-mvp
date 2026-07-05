// 左侧会话栏：按能力隔离——给了 capabilityId 只列该能力下的会话，「新会话」也在
// 该能力下直接开（GET /runtime/sessions?capabilityId= + POST /runtime/sessions）；
// 换能力走底部的市集入口。头部是 Combo 字标 + 返回按钮，底部常驻当前登录账号。
import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { Role, SessionView } from '@cb/shared';
import { useCreateSession, useSessions } from '../api/runtime.js';
import { useRuntimeMe } from '../shell/AuthGate.js';
import { ComboWordmark } from './ComboBrand.js';
import {
  runtimeBackLabel,
  runtimeBackTarget,
  safeRuntimeReturnTo,
} from '../navigation/runtimeReturn.js';

const ROLE_LABEL: Record<Role, string> = {
  creator: '创作者',
};

/** 无角色/未知角色的兜底：消费端绝不把访客标成「创作者」（#27）。 */
const DEFAULT_ROLE_LABEL = '使用者';

function avatarInitial(name: string): string {
  const ch = Array.from(name.trim())[0] ?? '?';
  return ch.toUpperCase();
}

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
  const me = useRuntimeMe();
  const accountName = me?.account ?? '当前账号';
  const role = me?.roles[0];
  const accountTitle = role ? (ROLE_LABEL[role] ?? DEFAULT_ROLE_LABEL) : DEFAULT_ROLE_LABEL;
  const hasCapability = Boolean(capabilityId);
  const sessions = useSessions(capabilityId, { enabled: hasCapability });
  const createSession = useCreateSession();
  const [createError, setCreateError] = useState(false);
  const ordered = useMemo(
    () =>
      [...(hasCapability ? (sessions.data ?? []) : [])].sort(
        (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      ),
    [hasCapability, sessions.data],
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
        {/* 品牌回消费端首页（市集）。/creator 是创作端旧 IA，消费者点 logo 不该被弹进创作端（#27）。 */}
        <Link to="/market" className="rt-sidebar__brand" aria-label="Combo 试用 首页">
          <ComboWordmark className="rt-sidebar__brand-word" />
        </Link>
        {/* 返回发布页只对带 returnTo 进来的创作者渲染；消费者没有「发布流程」可回（#27）。 */}
        {safeReturnTo && (
          <button
            type="button"
            className="rt-sidebar__back"
            aria-label={runtimeBackLabel(safeReturnTo)}
            title={runtimeBackLabel(safeReturnTo)}
            onClick={() => window.location.assign(runtimeBackTarget(safeReturnTo))}
          >
            <span aria-hidden="true">←</span>
          </button>
        )}
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
        {hasCapability && sessions.data && ordered.length === 0 && (
          <div className="rt-sidebar__empty">这个能力下还没有会话</div>
        )}
      </div>
      <div className="rt-sidebar__foot">
        <Link to="/market" className="rt-sidebar__market">
          换个能力 · 去市集
        </Link>
      </div>
      <div className="rt-sidebar__user">
        <span className="rt-sidebar__user-avatar" aria-hidden="true">
          {avatarInitial(accountName)}
        </span>
        <span>
          {accountName} · {accountTitle}
        </span>
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

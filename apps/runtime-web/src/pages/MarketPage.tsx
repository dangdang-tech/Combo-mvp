import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { RuntimeSessionListItem } from '@cb/shared';
import { createProductionSession, useCapabilities, useSessions } from '../api/runtime.js';

interface LinkedSessions {
  trial?: RuntimeSessionListItem;
  consume?: RuntimeSessionListItem;
}

function groupSessionsBySlug(items: RuntimeSessionListItem[]): Map<string, LinkedSessions> {
  const grouped = new Map<string, LinkedSessions>();
  for (const item of items) {
    const linked = grouped.get(item.slug) ?? {};
    if (item.mode === 'consume' && !linked.consume) linked.consume = item;
    if (item.mode === 'trial' && !linked.trial) linked.trial = item;
    grouped.set(item.slug, linked);
  }
  return grouped;
}

function modeLabel(mode: RuntimeSessionListItem['mode']): string {
  return mode === 'consume' ? '正式' : '试用';
}

export function MarketPage() {
  const navigate = useNavigate();
  const caps = useCapabilities();
  const sessions = useSessions();
  const [pendingSlug, setPendingSlug] = useState<string | null>(null);
  const [errorSlug, setErrorSlug] = useState<string | null>(null);
  const sessionsBySlug = useMemo(
    () => groupSessionsBySlug(sessions.data?.items ?? []),
    [sessions.data?.items],
  );

  const enterProduction = async (slug: string, name: string, existing?: RuntimeSessionListItem) => {
    if (existing) {
      navigate(`/session/${existing.id}`);
      return;
    }
    setPendingSlug(slug);
    setErrorSlug(null);
    try {
      const created = await createProductionSession(slug, name);
      navigate(`/session/${created.session.id}`);
    } catch {
      setErrorSlug(slug);
    } finally {
      setPendingSlug(null);
    }
  };

  return (
    <div className="rt-market">
      <section className="rt-market__hero">
        <h1 className="rt-market__title">挑一个能力，直接开聊</h1>
        <p className="rt-market__lede">
          每个能力都从一次真实会话里长出来。选一个，像和它对话一样把活干完——产物会实时生成在右侧。
        </p>
      </section>

      {sessions.data && sessions.data.items.length > 0 && (
        <section className="rt-market__section">
          <h2 className="rt-market__section-title">继续之前的会话</h2>
          <div className="rt-session-chips">
            {sessions.data.items.slice(0, 8).map((s) => (
              <Link key={s.id} to={`/session/${s.id}`} className="rt-session-chip">
                <span className="rt-session-chip__title">{s.title}</span>
                <span className="rt-session-chip__cap">
                  {s.capabilityName} · {modeLabel(s.mode)}
                </span>
              </Link>
            ))}
          </div>
        </section>
      )}

      <section className="rt-market__section">
        <h2 className="rt-market__section-title">能力市集</h2>
        {caps.isLoading && <div className="rt-empty">加载中…</div>}
        {caps.isError && <div className="rt-empty rt-empty--error">能力列表加载失败，请刷新。</div>}
        {caps.data && caps.data.items.length === 0 && (
          <div className="rt-empty">还没有已发布的能力。先在创作者中心发布一个吧。</div>
        )}
        <div className="rt-card-grid">
          {caps.data?.items.map((c) => {
            const linked = sessionsBySlug.get(c.slug);
            const isPending = pendingSlug === c.slug;
            const trialLabel = linked?.trial ? '继续试用' : '试用';
            const productionLabel = linked?.consume ? '继续使用' : '直接使用';

            return (
              <article key={c.capabilityId} className="rt-card">
                <div className="rt-card__type">{c.typeLabel}</div>
                <h3 className="rt-card__name">{c.name}</h3>
                <p className="rt-card__tagline">{c.tagline}</p>
                <div className="rt-card__meta">
                  <span className="rt-card__byline">{c.byline}</span>
                  <span>
                    {linked?.consume ? '已有正式会话' : linked?.trial ? '已有试用会话' : '尚未运行'}
                  </span>
                </div>
                <div className="rt-card__foot">
                  <button
                    type="button"
                    className="rt-btn"
                    onClick={() =>
                      navigate(linked?.trial ? `/session/${linked.trial.id}` : `/c/${c.slug}`)
                    }
                  >
                    {trialLabel}
                  </button>
                  <button
                    type="button"
                    className="rt-btn rt-btn--accent"
                    disabled={isPending}
                    onClick={() => void enterProduction(c.slug, c.name, linked?.consume)}
                  >
                    {isPending ? '创建中…' : productionLabel}
                  </button>
                </div>
                {errorSlug === c.slug && (
                  <div className="rt-card__error">无法进入正式使用，请稍后重试。</div>
                )}
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );
}

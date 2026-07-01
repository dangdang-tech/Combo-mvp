import { Link, useNavigate } from 'react-router-dom';
import { useCapabilities, useSessions } from '../api/runtime.js';

export function MarketPage() {
  const navigate = useNavigate();
  const caps = useCapabilities();
  const sessions = useSessions();

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
                <span className="rt-session-chip__cap">{s.capabilityName}</span>
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
          {caps.data?.items.map((c) => (
            <article key={c.capabilityId} className="rt-card">
              <div className="rt-card__type">{c.typeLabel}</div>
              <h3 className="rt-card__name">{c.name}</h3>
              <p className="rt-card__tagline">{c.tagline}</p>
              <div className="rt-card__foot">
                <span className="rt-card__byline">{c.byline}</span>
                <button
                  type="button"
                  className="rt-btn rt-btn--accent"
                  onClick={() => navigate(`/c/${c.slug}`)}
                >
                  开始试用
                </button>
              </div>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

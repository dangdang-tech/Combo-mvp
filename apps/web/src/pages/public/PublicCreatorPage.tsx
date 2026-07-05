// 公开创作者主页 /c/:slug（对外只读，裸壳 PublicLayout，无创作者外壳）。
// 四段：身份区（封面 + 头像 + 标签 + 社交计数）/ 指标带 / 能力网络缩略（纯 SVG）/
// 作品墙（卡片链去公开能力页）。数据来自前端 mock 层 publicApi。
import type { ReactElement } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { ErrorState, Skeleton } from '../../components/index.js';
import { fetchPublicCreator, type PublicCreatorProfile } from './publicApi.js';

/** 万位收敛的紧凑数字（12500 → 1.3万）。 */
function compactNumber(value: number): string {
  if (value >= 10_000) return `${(value / 10_000).toFixed(1).replace(/\.0$/, '')}万`;
  return String(value);
}

export function PublicCreatorPage(): ReactElement {
  const { slug = '' } = useParams<{ slug?: string }>();
  const query = useQuery({
    queryKey: ['public-creator', slug],
    queryFn: () => fetchPublicCreator(slug),
    enabled: slug.length > 0,
    retry: false,
  });

  if (query.isLoading) {
    return (
      <section className="cb-public cb-profile" aria-busy="true">
        <Skeleton rows={6} label="创作者主页加载中" />
      </section>
    );
  }

  if (query.isError || !query.data) {
    return (
      <section className="cb-public cb-profile">
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      </section>
    );
  }

  const profile = query.data;

  return (
    <section className="cb-public cb-profile" data-creator={profile.slug}>
      <HeroSection hero={profile.hero} />
      <MetricsBandSection metrics={profile.metrics} />
      <NetworkSection network={profile.network} />
      <WorksSection works={profile.works} />
    </section>
  );
}

function avatarFallback(name: string): string {
  const ch = [...name][0];
  return ch ? ch.toUpperCase() : '·';
}

function SocialStat({ label, value }: { label: string; value: number }): ReactElement {
  return (
    <div className="cb-profile-hero__stat" data-stat={label}>
      <span className="cb-profile-hero__stat-value">{compactNumber(value)}</span>
      <span className="cb-profile-hero__stat-label">{label}</span>
    </div>
  );
}

/** ① 身份区：封面横幅 + 头像/昵称/标签/简介 + 三社交计数。 */
function HeroSection({ hero }: { hero: PublicCreatorProfile['hero'] }): ReactElement {
  return (
    <section className="cb-profile-section cb-profile-hero" aria-label="身份区">
      <div className="cb-profile-hero__cover" aria-hidden="true" />
      <div className="cb-profile-hero__body">
        <div className="cb-profile-hero__head">
          {hero.avatarUrl ? (
            <img
              className="cb-profile-hero__avatar"
              src={hero.avatarUrl}
              alt={`${hero.displayName} 头像`}
            />
          ) : (
            <div className="cb-profile-hero__avatar cb-profile-hero__avatar--fallback" aria-hidden>
              {avatarFallback(hero.displayName)}
            </div>
          )}
          <div className="cb-profile-hero__id">
            <h1 className="cb-profile-hero__name">{hero.displayName}</h1>
            {hero.identityTags.length > 0 && (
              <ul className="cb-profile-hero__tags" aria-label="身份标签">
                {hero.identityTags.map((tag) => (
                  <li key={tag} className="cb-profile-hero__tag">
                    {tag}
                  </li>
                ))}
              </ul>
            )}
            {hero.bio && <p className="cb-profile-hero__bio">{hero.bio}</p>}
          </div>
        </div>
        <div className="cb-profile-hero__social" aria-label="社交计数">
          <SocialStat label="关注" value={hero.social.following} />
          <SocialStat label="粉丝" value={hero.social.followers} />
          <SocialStat label="获赞" value={hero.social.likes} />
        </div>
      </div>
    </section>
  );
}

/** ② 指标带：四列等分，大号衬线值 + 等宽大写标签。 */
function MetricsBandSection({
  metrics,
}: {
  metrics: PublicCreatorProfile['metrics'];
}): ReactElement {
  return (
    <section className="cb-profile-section cb-profile-metrics" aria-label="指标带">
      <div className="cb-profile-metric" data-metric="能力点数">
        <span className="cb-profile-metric__value">{compactNumber(metrics.capabilityCount)}</span>
        <span className="cb-profile-metric__label">能力点数</span>
      </div>
      <div className="cb-profile-metric" data-metric="知识领域数">
        <span className="cb-profile-metric__value">{compactNumber(metrics.domainCount)}</span>
        <span className="cb-profile-metric__label">知识领域数</span>
      </div>
      <div className="cb-profile-metric" data-metric="总调用量">
        <span className="cb-profile-metric__value">{compactNumber(metrics.totalInvocations)}</span>
        <span className="cb-profile-metric__label">总调用量</span>
      </div>
      <div className="cb-profile-metric" data-metric="最热主题">
        <span className="cb-profile-metric__value cb-profile-metric__topic">
          {metrics.hottestTopic}
        </span>
        <span className="cb-profile-metric__label">最热主题</span>
      </div>
    </section>
  );
}

/** ③ 能力网络缩略：中心节点 + 环形散布的纯 SVG 预览（只读，无展开入口）。 */
function NetworkSection({
  network,
  size = 180,
}: {
  network: PublicCreatorProfile['network'];
  size?: number;
}): ReactElement {
  const { nodes, edges } = network;
  const cx = size / 2;
  const r = size * 0.36;
  const ring = nodes.filter((n) => !n.isCenter);
  const pos = new Map<string, { x: number; y: number }>();
  const center = nodes.find((n) => n.isCenter) ?? nodes[0];
  if (center) pos.set(center.capabilityId, { x: cx, y: cx });
  ring.forEach((n, i) => {
    const angle = (i / Math.max(1, ring.length)) * Math.PI * 2 - Math.PI / 2;
    pos.set(n.capabilityId, { x: cx + r * Math.cos(angle), y: cx + r * Math.sin(angle) });
  });

  return (
    <section className="cb-profile-section cb-profile-network" aria-label="能力网络缩略">
      <h2 className="cb-profile-section__title">能力网络</h2>
      {nodes.length === 0 ? (
        <p className="cb-profile-network__empty">暂无能力网络</p>
      ) : (
        <svg
          className="cb-profile-network__thumb"
          width={size}
          height={size}
          viewBox={`0 0 ${size} ${size}`}
          role="img"
          aria-label={`能力网络缩略，${nodes.length} 个能力、${edges.length} 条关系`}
        >
          {edges.map((e) => {
            const a = pos.get(e.source);
            const b = pos.get(e.target);
            if (!a || !b) return null;
            return (
              <line
                key={`${e.source}-${e.target}`}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                className="cb-profile-network__edge"
              />
            );
          })}
          {nodes.map((n) => {
            const p = pos.get(n.capabilityId);
            if (!p) return null;
            return (
              <circle
                key={n.capabilityId}
                cx={p.x}
                cy={p.y}
                r={Math.max(4, Math.min(11, 4 + n.size))}
                className="cb-profile-network__node"
                data-center={n.isCenter ? 'true' : undefined}
              >
                <title>{n.name}</title>
              </circle>
            );
          })}
        </svg>
      )}
    </section>
  );
}

/** ④ 作品墙：已发布能力卡（封面占位 + 名称 + 调用数），点卡进公开能力页。 */
function WorksSection({ works }: { works: PublicCreatorProfile['works'] }): ReactElement {
  return (
    <section className="cb-profile-section cb-profile-works" aria-label="作品墙">
      <h2 className="cb-profile-section__title">作品墙</h2>
      {works.length === 0 ? (
        <p className="cb-profile-works__empty">还没有已发布的能力</p>
      ) : (
        <ul className="cb-work-grid">
          {works.map((card) => (
            <li className="cb-work-card" key={card.capabilityId}>
              <a className="cb-work-card__link" href={`/a/${card.slug}`}>
                <div className="cb-work-card__cover cb-work-card__cover--fallback" aria-hidden>
                  {avatarFallback(card.name)}
                </div>
                <span className="cb-work-card__name">{card.name}</span>
                <span className="cb-work-card__invocations">
                  调用 {compactNumber(card.invocations)}
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

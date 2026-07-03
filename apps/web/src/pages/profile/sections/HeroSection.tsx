// ① 身份区（主页-02/13/21）——头像 / 昵称 / 身份标签 pill / 一句话简介 / 三社交计数（关注·粉丝·获赞）。
//
// 社交计数是真实计数（非 usage），契约给精确整数，前端做万-k 规整显示（compactNumber）。
// 公开只读、访客同视图：不渲染任何关注/编辑写入按钮（社交写按钮属 B-34 P1，本页只展示计数）。
// 头像缺图（avatarUrl=null）→ 前端兜底占位（取昵称首字），绝不破图（主页-22 同口径）。
import type { ReactElement } from 'react';
import type { ProfileHero } from '@cb/shared';
import { compactNumber } from '../../../components/index.js';

export interface HeroSectionProps {
  hero: ProfileHero;
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

export function HeroSection({ hero }: HeroSectionProps): ReactElement {
  return (
    <section className="cb-profile-section cb-profile-hero" aria-label="身份区">
      {/* 封面横幅（Figma 1152:65）：暖米渐变 + 底部砖红细线，头像跨线压在其上。 */}
      <div className="cb-profile-hero__cover" aria-hidden="true" />
      {/* 身份主体：左头像+昵称/标签/简介，右三社交计数（同行右对齐，Figma 顶部编排）。 */}
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
                {hero.identityTags.map((tag, i) => (
                  <li key={`${tag}-${i}`} className="cb-profile-hero__tag">
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

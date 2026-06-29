// ⑥ 作品墙（主页-11/12/19/22/23/24）——已发布卡片网格：封面 / 名称 / 调用次数（usage 占位）。
//
// 单源过滤：上墙/回退口径由后端按 B-30 review_status 完成（决策④），前端绝不二次过滤、不自造状态——
//   后端给什么卡就渲染什么卡（被拒下架的不会出现、被拒回退的已是上一 published 版口径）。
// usage 占位：invocations=null + meta.placeholders → 4A UsagePlaceholder，绝不显 0。
// 封面缺图（coverUrl=null）→ 兜底占位底色（取名首字），绝不破图（主页-22）。
// 点卡进公开页（主页-12）：用 slug 拼公开展示路径，只读不进编辑/管理（公开口径）。
import type { ReactElement } from 'react';
import type { ProfileWorksSlice, WorkCard, Meta } from '@cb/shared';
import { UsagePlaceholder } from '../../../components/index.js';

export interface WorksSectionProps {
  works: ProfileWorksSlice;
  meta: Meta | undefined;
  loadingMore: boolean;
  onLoadMore: () => void;
}

function coverFallback(name: string): string {
  const ch = [...name][0];
  return ch ? ch.toUpperCase() : '·';
}

/** 公开页路径（主页-12，只读不下钻管理）。 */
function publicHref(slug: string): string {
  return `/a/${slug}`;
}

function WorkCardView({ card, meta }: { card: WorkCard; meta: Meta | undefined }): ReactElement {
  return (
    <li className="cb-work-card" data-capability={card.capabilityId}>
      <a className="cb-work-card__link" href={publicHref(card.slug)}>
        {card.coverUrl ? (
          <img className="cb-work-card__cover" src={card.coverUrl} alt={`${card.name} 封面`} />
        ) : (
          <div className="cb-work-card__cover cb-work-card__cover--fallback" aria-hidden>
            {coverFallback(card.name)}
          </div>
        )}
        <span className="cb-work-card__name">{card.name}</span>
        {/* 调用次数 usage 占位（绝不显 0） */}
        <span className="cb-work-card__invocations">
          {/* 字段键对齐主聚合 meta.placeholders 真键：works.invocations（§2.2，非自造 invocations）。 */}
          <UsagePlaceholder field="works.invocations" meta={meta} label="调用" />
        </span>
      </a>
    </li>
  );
}

export function WorksSection({
  works,
  meta,
  loadingMore,
  onLoadMore,
}: WorksSectionProps): ReactElement {
  return (
    <section className="cb-profile-section cb-profile-works" aria-label="作品墙">
      <h2 className="cb-profile-section__title">作品墙</h2>
      {works.cards.length === 0 ? (
        <p className="cb-profile-works__empty">还没有已发布的能力</p>
      ) : (
        <>
          <ul className="cb-work-grid">
            {works.cards.map((card) => (
              <WorkCardView key={card.capabilityId} card={card} meta={meta} />
            ))}
          </ul>
          {works.hasMore && (
            <button
              type="button"
              className="cb-profile-works__more"
              onClick={onLoadMore}
              disabled={loadingMore}
            >
              {loadingMore ? '加载中…' : '加载更多'}
            </button>
          )}
        </>
      )}
    </section>
  );
}

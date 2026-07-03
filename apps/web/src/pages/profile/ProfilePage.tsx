// 个人主页 F-06 主链路（开工总纲 §四）——接 3F GET /creators/{creatorId}/profile 六分区主聚合。
//
// 对外信任口径：公开只读、访客同视图、只读不下钻、不显经营维度（收益/消耗）。
// 六分区固定顺序（主页-01）：① Hero → ② 指标带 → ③ 密度榜 → ④ 热力图 → ⑤ 网络缩略 → ⑥ 作品墙。
// 三层状态：
//   - 整页 loading → 4A Skeleton（永不裸转圈）。
//   - 整页 error（404 / 整页聚合失败）→ 4A ErrorState（只 userMessage + action，绝不裸码）。
//   - 分区局部失败 → 用后端 sectionErrors 派生的 sectionState，在该分区位置出局部错误条 + 子端点重试，
//     其它分区照常渲染（主页-17，整页不崩）。
// creatorId 解析：优先 prop（公开路由/测试）→ 路由 param :creatorId → 自身主页用 self 别名 'me'。
//   'me' 是后端鉴权态 self 端点（GET /creators/me/profile，requireAuth 解析为当前登录用户 creatorId，§2.0）：
//   登录态正确返回本人公开名片；未登录 → 后端 401 escalate（前端整页 ErrorState 引导登录），不再是哑兜底。
import type { ReactElement } from 'react';
import { useParams } from 'react-router-dom';
import { ErrorState, Skeleton } from '../../components/index.js';
import { goToLogin } from '../../shell/auth.js';
import { useProfile, type RetriableSection, type SectionDisplayState } from './useProfile.js';
import { SectionError } from './SectionError.js';
import { HeroSection } from './sections/HeroSection.js';
import { MetricsBandSection } from './sections/MetricsBandSection.js';
import { DensitySection } from './sections/DensitySection.js';
import { HeatmapSection } from './sections/HeatmapSection.js';
import { NetworkSection } from './sections/NetworkSection.js';
import { WorksSection } from './sections/WorksSection.js';

export interface ProfilePageProps {
  /** 显式 creatorId（公开页路由 / 测试注入）；不传则取路由 param，再兜底 'me'。 */
  creatorId?: string;
}

const SECTION_LABEL: Record<RetriableSection, string> = {
  metrics: '指标带',
  density: '能力会话密度',
  heatmap: '会话足迹',
  network: '能力网络',
  works: '作品墙',
};

/** 分区渲染壳：error/retrying → 局部错误条；ok → 渲染数据（数据缺失则不渲染该段，不崩）。 */
function SectionSlot({
  section,
  state,
  onRetry,
  children,
}: {
  section: RetriableSection;
  state: SectionDisplayState;
  onRetry: (s: RetriableSection) => void;
  children: ReactElement | null;
}): ReactElement | null {
  if (state === 'error' || state === 'retrying') {
    return (
      <div
        className="cb-profile-section cb-profile-section--failed"
        aria-label={SECTION_LABEL[section]}
      >
        <SectionError
          sectionLabel={SECTION_LABEL[section]}
          retrying={state === 'retrying'}
          onRetry={() => onRetry(section)}
        />
      </div>
    );
  }
  return children;
}

export function ProfilePage({ creatorId: creatorIdProp }: ProfilePageProps = {}): ReactElement {
  const params = useParams<{ creatorId?: string }>();
  const creatorId = creatorIdProp ?? params.creatorId ?? 'me';

  const {
    phase,
    error,
    profile,
    meta,
    sectionState,
    retry,
    retrySection,
    loadMoreDensity,
    densityLoadingMore,
    loadMoreWorks,
    worksLoadingMore,
  } = useProfile(creatorId);

  // 整页加载：骨架占位（永不裸转圈）。
  if (phase === 'loading') {
    return (
      <div className="cb-page cb-profile" aria-busy="true">
        <Skeleton rows={6} label="个人主页加载中" />
      </div>
    );
  }

  // 整页错误（404 / 整页聚合失败 / 会话过期 401-escalate）：人话 + 退路，绝不裸码。
  // 会话过期（self 主页 'me' 未登录 → 后端 401 escalate）给可用「去登录」CTA（整页跳后端登录端点，
  // 带 returnTo=当前位置，登录后回到原页不丢上下文），不再是无动作死页（BUG-007）。
  if (phase === 'error' || !profile) {
    return (
      <div className="cb-page cb-profile">
        <ErrorState
          error={error}
          onRetry={retry}
          onChangeInput={retry}
          onEscalate={() => goToLogin(window.location.pathname + window.location.search)}
          escalateLabel="去登录"
        />
      </div>
    );
  }

  return (
    <div className="cb-page cb-profile" data-creator={profile.creatorId}>
      {/* ① 身份区（恒在，hero 随主聚合 200 必返） */}
      <HeroSection hero={profile.hero} />

      {/* ② 指标带（随主聚合派生）：caps 源失败 → metrics:null + sectionErrors[metrics]，
          出局部错误条 + 重试（重试走整页聚合），绝不静默吞（主页-17，Codex r1#2）。 */}
      <SectionSlot section="metrics" state={sectionState.metrics} onRetry={retrySection}>
        {profile.metrics ? <MetricsBandSection metrics={profile.metrics} meta={meta} /> : null}
      </SectionSlot>

      {/* ③ 能力·按会话密度 */}
      <SectionSlot section="density" state={sectionState.density} onRetry={retrySection}>
        {profile.density ? (
          <DensitySection
            density={profile.density}
            loadingMore={densityLoadingMore}
            onLoadMore={loadMoreDensity}
          />
        ) : null}
      </SectionSlot>

      {/* ④ 会话足迹热力图（关闭 heatmapEnabled → 整段跳过，不留空框，主页-20） */}
      {profile.heatmapEnabled && (
        <SectionSlot section="heatmap" state={sectionState.heatmap} onRetry={retrySection}>
          {profile.heatmap ? <HeatmapSection heatmap={profile.heatmap} /> : null}
        </SectionSlot>
      )}

      {/* ⑤ 能力网络缩略（仅缩略无展开） */}
      <SectionSlot section="network" state={sectionState.network} onRetry={retrySection}>
        {profile.network ? <NetworkSection network={profile.network} /> : null}
      </SectionSlot>

      {/* ⑥ 作品墙（单源过滤由后端完成） */}
      <SectionSlot section="works" state={sectionState.works} onRetry={retrySection}>
        {profile.works ? (
          <WorksSection
            works={profile.works}
            meta={meta}
            loadingMore={worksLoadingMore}
            onLoadMore={loadMoreWorks}
          />
        ) : null}
      </SectionSlot>
    </div>
  );
}

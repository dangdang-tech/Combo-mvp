// 公开创作者主页 /c/:slug（对外只读，裸壳 PublicLayout，无创作者外壳）。
import type { ReactElement } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { ErrorState, Skeleton } from '../../components/index.js';
import { fetchProfileBySlug } from '../profile/api.js';
import { HeroSection } from '../profile/sections/HeroSection.js';
import { MetricsBandSection } from '../profile/sections/MetricsBandSection.js';
import { DensitySection } from '../profile/sections/DensitySection.js';
import { HeatmapSection } from '../profile/sections/HeatmapSection.js';
import { NetworkSection } from '../profile/sections/NetworkSection.js';
import { WorksSection } from '../profile/sections/WorksSection.js';

export function PublicCreatorPage(): ReactElement {
  const { slug = '' } = useParams<{ slug?: string }>();
  const query = useQuery({
    queryKey: ['public-creator', slug],
    queryFn: () => fetchProfileBySlug(slug),
    enabled: slug.length > 0,
  });

  if (query.isLoading) {
    return (
      <section className="cb-page cb-profile" aria-busy="true">
        <Skeleton rows={6} label="创作者主页加载中" />
      </section>
    );
  }

  if (query.isError || !query.data) {
    return (
      <section className="cb-page cb-profile">
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      </section>
    );
  }

  const { data: profile, meta } = query.data;

  return (
    <section className="cb-page cb-profile" data-creator={profile.creatorId}>
      <HeroSection hero={profile.hero} />
      {profile.metrics ? <MetricsBandSection metrics={profile.metrics} meta={meta} /> : null}
      {profile.density ? (
        <DensitySection
          density={profile.density}
          loadingMore={false}
          onLoadMore={() => undefined}
        />
      ) : null}
      {profile.heatmapEnabled && profile.heatmap ? (
        <HeatmapSection heatmap={profile.heatmap} />
      ) : null}
      {profile.network ? <NetworkSection network={profile.network} /> : null}
      {profile.works ? (
        <WorksSection
          works={profile.works}
          meta={meta}
          loadingMore={false}
          onLoadMore={() => undefined}
        />
      ) : null}
    </section>
  );
}

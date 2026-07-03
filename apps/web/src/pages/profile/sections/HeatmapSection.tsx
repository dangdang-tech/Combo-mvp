// ④ 会话足迹·近半年（主页-09/14/20）——4A SessionHeatmap。
//
// 真实数据（按 happened_at 算，不依赖 usage）。隐私：只数量不露原文（option builder 已保证）。
// 创作者关闭热力图（enabled=false / heatmapEnabled=false）→ SessionHeatmap 返回 null，本分区整段不渲染、
//   不留空框（主页-20）；调用方（ProfilePage）据 heatmapEnabled 也会提前跳过这一段标题，双保险。
import type { ReactElement } from 'react';
import type { ProfileHeatmap } from '@cb/shared';
import { SessionHeatmap } from '../../../components/index.js';

export interface HeatmapSectionProps {
  heatmap: ProfileHeatmap;
}

export function HeatmapSection({ heatmap }: HeatmapSectionProps): ReactElement | null {
  // 关闭态：整段（含标题）不渲染、不占版面。
  if (heatmap.enabled === false) return null;
  return (
    <section className="cb-profile-section cb-profile-heatmap" aria-label="会话足迹">
      <h2 className="cb-profile-section__title">会话足迹 · 近半年</h2>
      <SessionHeatmap heatmap={heatmap} />
    </section>
  );
}

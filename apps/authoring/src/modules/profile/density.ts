// 60 · 能力按会话密度榜（B-33 ③，60-dashboard-profile §2.3，主页-05/06/08）。纯逻辑、便于单测。
//   密度/趋势均【真实、不依赖 usage】（§2.3）：
//     - supportingSegments：段级血缘真实段数（candidate_evidence × session_segments，技术方案 §4「N 段会话支撑」信任货币）。
//     - densityScore：0..100 归一（按本创作者名下能力的 supportingSegments 相对最大值归一；最大值=0 → 全 0）。
//     - trend：按会话足迹时间分布算（近半窗 vs 前半窗支撑段数比较；不依赖 usage）。
//   只读（主页-08）：readonly:true，无任何管理动作字段（管理只在工作台 §1.4）。
import type { DensityRankRow } from '@cb/shared';

/** 密度榜原始行（每能力一行，含真实支撑段数 + 趋势所需的近/前半窗段数）。 */
export interface DensityInputRow {
  capabilityId: string;
  slug: string;
  name: string;
  /** 真实支撑会话段数（段级血缘计数，§2.3 信任货币）。 */
  supportingSegments: number;
  /** 近半窗（窗口后半段）支撑段数（趋势用，按 session_segments.happened_at 分布算）。 */
  recentSegments: number;
  /** 前半窗（窗口前半段）支撑段数（趋势用）。 */
  priorSegments: number;
}

/** 趋势箭头（按近/前半窗支撑段数比较，§2.3，不依赖 usage）。 */
export function deriveTrend(recent: number, prior: number): 'up' | 'down' | 'flat' {
  if (recent > prior) return 'up';
  if (recent < prior) return 'down';
  return 'flat';
}

/** 0..100 归一密度分（相对本创作者名下最大支撑段数；max<=0 → 0）。 */
export function densityScore(supportingSegments: number, maxSegments: number): number {
  if (maxSegments <= 0 || supportingSegments <= 0) return 0;
  return Math.round((supportingSegments / maxSegments) * 100);
}

/**
 * 排密度榜（主页-05/06）。按 supportingSegments 降序（同分按 capabilityId 稳定排序），赋 1-based rank +
 *   densityScore（相对最大段数归一）+ trend（近/前半窗比较）。readonly:true（主页-08）。
 *   返回全量排好的行；调用方据 limit 切首屏前 3 + hasMore（§2.3）。
 */
export function rankDensity(rows: DensityInputRow[]): DensityRankRow[] {
  const maxSegments = rows.reduce((m, r) => Math.max(m, r.supportingSegments), 0);
  const sorted = [...rows].sort((a, b) => {
    if (b.supportingSegments !== a.supportingSegments) {
      return b.supportingSegments - a.supportingSegments;
    }
    return a.capabilityId < b.capabilityId ? -1 : a.capabilityId > b.capabilityId ? 1 : 0;
  });
  return sorted.map((r, idx) => ({
    rank: idx + 1,
    capabilityId: r.capabilityId,
    slug: r.slug,
    name: r.name,
    densityScore: densityScore(r.supportingSegments, maxSegments),
    supportingSegments: r.supportingSegments,
    trend: deriveTrend(r.recentSegments, r.priorSegments),
    readonly: true,
  }));
}

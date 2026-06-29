// 能力表分页去重（工作台首页能力表 + 独立「我的能力」页共用同一口径）。
//
// cursor 分页边界处后端可能重叠返回（同一 capabilityId 落在相邻两页），多页累积摊平后须按
// capabilityId 去重，否则同一能力出现两行。保留首次出现（旧行口径不被后页覆盖；翻页只追加新能力）。
import type { DashboardCapabilityRow } from '@cb/shared';

/** 多页累积后按 capabilityId 去重，保留首次出现（旧行不被后页覆盖；翻页只追加新能力）。 */
export function dedupeByCapabilityId(rows: DashboardCapabilityRow[]): DashboardCapabilityRow[] {
  const seen = new Set<string>();
  const out: DashboardCapabilityRow[] = [];
  for (const r of rows) {
    if (seen.has(r.capabilityId)) continue;
    seen.add(r.capabilityId);
    out.push(r);
  }
  return out;
}

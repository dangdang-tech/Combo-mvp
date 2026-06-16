// 60 · 会话足迹热力图聚合（B-33 ④，60-dashboard-profile §2.4，主页-09/20）。纯逻辑、不写库、便于单测。
//   口径（决策⑥，不依赖 usage）：完全按 session_segments.happened_at 按【天】聚合段数；
//     格子只含 date/count/level —— 绝不含会话正文/标题/片段（隐私硬约束，主页-09）。
//   颜色档 level 0..4 按当窗口 maxCount 分位算（服务端算好，前端只渲染色块）。
import type { HeatmapCell, ProfileHeatmap } from '@cb/shared';

/** 窗口天数（半年约 183 天；整年 365 天）。range='half_year' 默认（§2.4）。 */
export const HEATMAP_WINDOW_DAYS: Record<'half_year' | 'year', number> = {
  half_year: 183,
  year: 365,
};

/** 取某 ISO 时刻的 YYYY-MM-DD（按 UTC 日界；happened_at 已是 timestamptz）。 */
export function isoDay(iso: string): string {
  // 取前 10 位（YYYY-MM-DD）；happened_at 形如 2026-06-15T08:00:00.000Z。
  return iso.slice(0, 10);
}

/** 给 today 与窗口算 [start, end]（YYYY-MM-DD，end=今天）。 */
export function heatmapWindow(
  today: Date,
  range: 'half_year' | 'year',
): { start: string; end: string } {
  const end = today.toISOString().slice(0, 10);
  const startDate = new Date(today.getTime());
  startDate.setUTCDate(startDate.getUTCDate() - (HEATMAP_WINDOW_DAYS[range] - 1));
  const start = startDate.toISOString().slice(0, 10);
  return { start, end };
}

/**
 * 颜色档分桶（0..4）：0 = 无活跃；1..4 按 maxCount 四等分（线性分位，服务端算好）。
 *   count=0 → 0；count>0 且 maxCount<=0 兜底 1；否则 ceil(count/maxCount*4) 夹到 1..4。
 */
export function bucketLevel(count: number, maxCount: number): HeatmapCell['level'] {
  if (count <= 0) return 0;
  if (maxCount <= 0) return 1;
  const lvl = Math.ceil((count / maxCount) * 4);
  const clamped = Math.min(4, Math.max(1, lvl));
  return clamped as HeatmapCell['level'];
}

/**
 * 聚合热力图（主页-09/20）。入参：窗口内每个 happened_at（ISO 串，仅时刻、无正文）+ today + range + enabled。
 *   - 按天累加段数 → 每天一个 cell（仅有活跃的天，前端补空格；空窗口 → cells:[]）。
 *   - maxCount = 当窗口单日峰值；level 据它分桶。
 *   - enabled=false（创作者关闭，主页-20）→ 返回 enabled:false + 空 cells（前端不渲染分区）。
 *   - 窗口外的 happened_at 被过滤（不计入；start..end 闭区间）。
 */
export function aggregateHeatmap(input: {
  happenedAt: (string | null)[];
  today: Date;
  range: 'half_year' | 'year';
  enabled: boolean;
}): ProfileHeatmap {
  const { start, end } = heatmapWindow(input.today, input.range);
  if (!input.enabled) {
    return { range: input.range, start, end, cells: [], maxCount: 0, enabled: false };
  }

  const byDay = new Map<string, number>();
  for (const ts of input.happenedAt) {
    if (!ts) continue; // happened_at 可空（未知时刻不计入热力图）。
    const day = isoDay(ts);
    if (day < start || day > end) continue; // 窗口外过滤（闭区间）。
    byDay.set(day, (byDay.get(day) ?? 0) + 1);
  }

  let maxCount = 0;
  for (const c of byDay.values()) if (c > maxCount) maxCount = c;

  const cells: HeatmapCell[] = [...byDay.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([date, count]) => ({ date, count, level: bucketLevel(count, maxCount) }));

  return { range: input.range, start, end, cells, maxCount, enabled: true };
}

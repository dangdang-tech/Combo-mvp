// 图表 option builder 共用纯函数（无 DOM、无 React，可单测）。
import type { TrendPoint } from '@cb/shared';

/** ISO 时间 → 轴标签「MM-DD」（趋势图 X 轴用，避免年份占宽）。 */
export function shortDate(iso: string): string {
  // 容错：非法串原样返回（不抛，画图不崩）。
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${mm}-${dd}`;
}

/** YYYY-MM-DD（热力图格子标签）。 */
export function isoDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(0, 10);
}

/**
 * 趋势点的值数组（null 透传为 null，ECharts 会断线/跳过，不会画成 0——
 * 这点关键：占位/缺测的天不能误成「0 次」）。
 */
export function trendValues(points: TrendPoint[]): Array<number | null> {
  return points.map((p) => p.value);
}

/** 趋势点是否「全空」（无任何非 null 值）——用于判定空态/不误标峰值。 */
export function isAllNull(points: TrendPoint[]): boolean {
  return points.every((p) => p.value === null);
}

/** 大数规整：12345→12,345；1234567→123.5万（轴/tooltip 友好显示）。 */
export function compactNumber(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 10000) {
    const w = n / 10000;
    return `${Number.isInteger(w) ? w : w.toFixed(1)}万`;
  }
  return n.toLocaleString('en-US');
}

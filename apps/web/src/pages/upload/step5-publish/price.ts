// 价格换算（F-14，§5.5）——micros ↔ 元 人话展示。
//
// priceMicros = 微元（1 元 = 1_000_000 micros），发布时冻结真源（50 §1.2/§2.1）。
// 未设价（null）→ 「待定价」提示（发布-25：非 0、不裸露空）。免费（0）→「免费」。

const MICROS_PER_YUAN = 1_000_000;

/** 元 → micros（整数；负数夹到 0）。 */
export function yuanToMicros(yuan: number): number {
  return Math.max(0, Math.round(yuan * MICROS_PER_YUAN));
}

/** micros → 元（两位小数数值，供输入框回填）。 */
export function microsToYuan(micros: number): number {
  return micros / MICROS_PER_YUAN;
}

/** 人话价格展示：null→「待定价」、0→「免费」、其余「¥X.XX」。 */
export function priceDisplay(micros: number | null): string {
  if (micros === null) return '待定价';
  if (micros === 0) return '免费';
  const yuan = microsToYuan(micros);
  return `¥${yuan.toFixed(2)}`;
}

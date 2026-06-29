// price 单测（F-14）：micros ↔ 元换算 + 人话展示（null 待定价 / 0 免费 / 其余 ¥）。
import { describe, it, expect } from 'vitest';
import { yuanToMicros, microsToYuan, priceDisplay } from './price.js';

describe('price', () => {
  it('元 → micros（整数、负数夹 0）', () => {
    expect(yuanToMicros(9.9)).toBe(9_900_000);
    expect(yuanToMicros(0)).toBe(0);
    expect(yuanToMicros(-5)).toBe(0);
  });

  it('micros → 元', () => {
    expect(microsToYuan(9_900_000)).toBe(9.9);
    expect(microsToYuan(0)).toBe(0);
  });

  it('priceDisplay：null=待定价、0=免费、其余 ¥X.XX', () => {
    expect(priceDisplay(null)).toBe('待定价');
    expect(priceDisplay(0)).toBe('免费');
    expect(priceDisplay(9_900_000)).toBe('¥9.90');
    expect(priceDisplay(12_000_000)).toBe('¥12.00');
  });
});

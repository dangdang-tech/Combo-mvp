// charts option util 单测（纯函数）。
import { describe, it, expect } from 'vitest';
import type { TrendPoint } from '@cb/shared';
import { shortDate, isoDay, trendValues, isAllNull, compactNumber } from './util.js';

describe('shortDate', () => {
  it('ISO → MM-DD', () => {
    expect(shortDate('2026-06-15T08:00:00Z')).toMatch(/^06-1[45]$/); // 容时区
  });
  it('非法串原样返回（不抛）', () => {
    expect(shortDate('not-a-date')).toBe('not-a-date');
  });
});

describe('isoDay', () => {
  it('ISO → YYYY-MM-DD', () => {
    expect(isoDay('2026-06-15T08:00:00Z')).toBe('2026-06-15');
  });
  it('非法串原样返回', () => {
    expect(isoDay('xxx')).toBe('xxx');
  });
});

describe('trendValues / isAllNull', () => {
  const pts: TrendPoint[] = [
    { date: 'a', value: 1 },
    { date: 'b', value: null },
    { date: 'c', value: 3 },
  ];
  it('提取值数组，null 透传', () => {
    expect(trendValues(pts)).toEqual([1, null, 3]);
  });
  it('isAllNull：有非 null → false', () => {
    expect(isAllNull(pts)).toBe(false);
  });
  it('isAllNull：全 null → true', () => {
    expect(
      isAllNull([
        { date: 'a', value: null },
        { date: 'b', value: null },
      ]),
    ).toBe(true);
  });
  it('isAllNull：空数组 → true（every 真空真）', () => {
    expect(isAllNull([])).toBe(true);
  });
});

describe('compactNumber', () => {
  it('千分位（< 1 万）', () => {
    expect(compactNumber(1234)).toBe('1,234');
    expect(compactNumber(9999)).toBe('9,999');
  });
  it('万缩写（整数）', () => {
    expect(compactNumber(20000)).toBe('2万');
  });
  it('万缩写（一位小数）', () => {
    expect(compactNumber(12345)).toBe('1.2万');
    expect(compactNumber(1234567)).toBe('123.5万');
  });
  it('负数', () => {
    expect(compactNumber(-500)).toBe('-500');
  });
});

// 60 个人主页 ④ 会话足迹热力图聚合自检（B-33，60-dashboard-profile §2.4，主页-09/14/20）。
//   重点：按 happened_at 按天聚合段数（不依赖 usage）、隐私只数量、颜色分桶、窗口过滤、关闭开关、空态。
import { describe, it, expect } from 'vitest';
import {
  aggregateHeatmap,
  bucketLevel,
  heatmapWindow,
  isoDay,
  HEATMAP_WINDOW_DAYS,
} from '../modules/profile/heatmap.js';
import { ProfileHeatmapSchema } from '@cb/shared';

const TODAY = new Date('2026-06-15T12:00:00.000Z');

describe('热力图窗口/分桶纯函数', () => {
  it('isoDay 取 YYYY-MM-DD', () => {
    expect(isoDay('2026-06-15T08:00:00.000Z')).toBe('2026-06-15');
  });

  it('half_year 窗口 183 天、end=今天', () => {
    const w = heatmapWindow(TODAY, 'half_year');
    expect(w.end).toBe('2026-06-15');
    // start = end - 182 天。
    expect(w.start).toBe('2025-12-15');
    expect(HEATMAP_WINDOW_DAYS.half_year).toBe(183);
  });

  it('bucketLevel：0→0，峰值→4，半量→2', () => {
    expect(bucketLevel(0, 10)).toBe(0);
    expect(bucketLevel(10, 10)).toBe(4);
    expect(bucketLevel(5, 10)).toBe(2);
    expect(bucketLevel(1, 10)).toBe(1);
    // maxCount<=0 但 count>0 兜底 1。
    expect(bucketLevel(3, 0)).toBe(1);
  });
});

describe('aggregateHeatmap（从 happened_at 聚合，不依赖 usage）', () => {
  it('按天聚合段数：同一天多段累加为一个格子的 count', () => {
    const hm = aggregateHeatmap({
      happenedAt: [
        '2026-06-15T01:00:00.000Z',
        '2026-06-15T09:00:00.000Z',
        '2026-06-15T20:00:00.000Z',
        '2026-06-10T00:00:00.000Z',
      ],
      today: TODAY,
      range: 'half_year',
      enabled: true,
    });
    const d15 = hm.cells.find((c) => c.date === '2026-06-15');
    const d10 = hm.cells.find((c) => c.date === '2026-06-10');
    expect(d15?.count).toBe(3);
    expect(d10?.count).toBe(1);
    expect(hm.maxCount).toBe(3);
    // 峰值天（3/3）level 4；单段天（ceil(1/3*4)=2）level 2。
    expect(d15?.level).toBe(4);
    expect(d10?.level).toBe(2);
    expect(ProfileHeatmapSchema.safeParse(hm).success).toBe(true);
  });

  it('格子只含 date/count/level —— 绝不含会话正文/标题（隐私硬约束，主页-09）', () => {
    const hm = aggregateHeatmap({
      happenedAt: ['2026-06-15T01:00:00.000Z'],
      today: TODAY,
      range: 'half_year',
      enabled: true,
    });
    const cell = hm.cells[0]!;
    expect(Object.keys(cell).sort()).toEqual(['count', 'date', 'level']);
  });

  it('窗口外的 happened_at 被过滤（不计入）', () => {
    const hm = aggregateHeatmap({
      happenedAt: [
        '2026-06-15T01:00:00.000Z', // 窗口内
        '2024-01-01T00:00:00.000Z', // 远早于窗口
      ],
      today: TODAY,
      range: 'half_year',
      enabled: true,
    });
    expect(hm.cells).toHaveLength(1);
    expect(hm.cells[0]!.date).toBe('2026-06-15');
  });

  it('happened_at 为 null 不计入热力图（未知时刻）', () => {
    const hm = aggregateHeatmap({
      happenedAt: [null, null, '2026-06-15T01:00:00.000Z'],
      today: TODAY,
      range: 'half_year',
      enabled: true,
    });
    expect(hm.cells).toHaveLength(1);
    expect(hm.cells[0]!.count).toBe(1);
  });

  it('关闭开关（主页-20）→ enabled:false + 空 cells', () => {
    const hm = aggregateHeatmap({
      happenedAt: ['2026-06-15T01:00:00.000Z'],
      today: TODAY,
      range: 'half_year',
      enabled: false,
    });
    expect(hm.enabled).toBe(false);
    expect(hm.cells).toEqual([]);
    expect(hm.maxCount).toBe(0);
  });

  it('空态（新创作者无会话，主页-14）→ cells:[] + maxCount:0', () => {
    const hm = aggregateHeatmap({
      happenedAt: [],
      today: TODAY,
      range: 'half_year',
      enabled: true,
    });
    expect(hm.cells).toEqual([]);
    expect(hm.maxCount).toBe(0);
    expect(hm.enabled).toBe(true);
  });
});

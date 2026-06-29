// 60 个人主页 ③ 密度榜 + ⑥ 作品墙纯逻辑自检（B-33，§2.3/§2.6，主页-05/08/11/19/23/24）。
//   密度：真实支撑段数排序、归一密度分、趋势近/前半窗、readonly。
//   作品墙：单源过滤（被拒下架不上墙）、回退展示上一版（current_version_id 即展示版）、usage 占位、公开口径不带钱/内部码。
import { describe, it, expect } from 'vitest';
import {
  rankDensity,
  deriveTrend,
  densityScore,
  type DensityInputRow,
} from '../profile/density.js';
import { filterWorkCards, isOnWall, rowToWorkCard, type WorkRow } from '../profile/works.js';
import { DensityRankRowSchema, WorkCardSchema } from '@cb/shared';

function dRow(id: string, supporting: number, recent = 0, prior = 0): DensityInputRow {
  return {
    capabilityId: id,
    slug: `slug-${id}`,
    name: id,
    supportingSegments: supporting,
    recentSegments: recent,
    priorSegments: prior,
  };
}

describe('密度榜（真实段数，不依赖 usage，§2.3）', () => {
  it('按支撑段数降序赋 rank，密度分相对最大段数归一', () => {
    const rows = rankDensity([dRow('a', 10), dRow('b', 5), dRow('c', 2)]);
    expect(rows.map((r) => r.capabilityId)).toEqual(['a', 'b', 'c']);
    expect(rows.map((r) => r.rank)).toEqual([1, 2, 3]);
    expect(rows[0]!.densityScore).toBe(100); // 最大段数 → 100
    expect(rows[1]!.densityScore).toBe(50); // 5/10
    expect(rows[2]!.densityScore).toBe(20); // 2/10
    // 支撑段数真实透传（信任货币）。
    expect(rows[0]!.supportingSegments).toBe(10);
    expect(rows[0]!.readonly).toBe(true); // 只读无管理（主页-08）
    expect(DensityRankRowSchema.safeParse(rows[0]).success).toBe(true);
  });

  it('趋势：近半窗 > 前半窗 → up；< → down；= → flat', () => {
    expect(deriveTrend(5, 2)).toBe('up');
    expect(deriveTrend(1, 4)).toBe('down');
    expect(deriveTrend(3, 3)).toBe('flat');
    const rows = rankDensity([dRow('a', 6, 5, 1)]);
    expect(rows[0]!.trend).toBe('up');
  });

  it('全 0 段数 → densityScore 0（max<=0 兜底，不除零）', () => {
    expect(densityScore(0, 0)).toBe(0);
    const rows = rankDensity([dRow('a', 0), dRow('b', 0)]);
    expect(rows.every((r) => r.densityScore === 0)).toBe(true);
  });

  it('同分按 capabilityId 稳定排序（确定性）', () => {
    const rows = rankDensity([dRow('z', 3), dRow('a', 3)]);
    expect(rows.map((r) => r.capabilityId)).toEqual(['a', 'z']);
  });

  it('空（无能力，主页-14）→ []', () => {
    expect(rankDensity([])).toEqual([]);
  });
});

describe('作品墙单源过滤/回退（B-30，§2.6，主页-19/23/24）', () => {
  function wRow(id: string, status: string, name = id, cover: string | null = null): WorkRow {
    return {
      capabilityId: id,
      versionId: `ver-${id}`,
      slug: `slug-${id}`,
      reviewStatus: status,
      name,
      coverUrl: cover,
    };
  }

  it('alpha_pending / published 上墙；review_rejected 不上墙（被拒下架，主页-23）', () => {
    expect(isOnWall('alpha_pending')).toBe(true);
    expect(isOnWall('published')).toBe(true);
    expect(isOnWall('review_rejected')).toBe(false);
    const cards = filterWorkCards([
      wRow('a', 'published'),
      wRow('b', 'alpha_pending'),
      wRow('c', 'review_rejected'), // 被拒下架，剔除
    ]);
    expect(cards.map((c) => c.capabilityId)).toEqual(['a', 'b']);
  });

  it('alpha_pending 上墙但公开口径不暴露内部审核状态码（主页-19）', () => {
    const card = rowToWorkCard(wRow('a', 'alpha_pending', '需求炼金师'));
    // WorkCard 不含 reviewStatus / 钱 / 成本字段（公开口径）。
    expect(Object.keys(card).sort()).toEqual([
      'capabilityId',
      'coverUrl',
      'invocations',
      'name',
      'slug',
      'versionId',
    ]);
    expect((card as Record<string, unknown>)['reviewStatus']).toBeUndefined();
  });

  it('回退展示上一 published 版（current_version_id 即展示版，主页-24）', () => {
    // 评审域已把 current_version_id 回退到上一版、review_status='published'，作品墙读 current 即展示回退版。
    const row: WorkRow = {
      capabilityId: 'a',
      versionId: 'ver-prev-published',
      slug: 'slug-a',
      reviewStatus: 'published',
      name: '回退后的旧版名',
      coverUrl: 'cover-prev.png',
    };
    const cards = filterWorkCards([row]);
    expect(cards).toHaveLength(1);
    expect(cards[0]!.versionId).toBe('ver-prev-published');
    expect(cards[0]!.name).toBe('回退后的旧版名');
    expect(cards[0]!.coverUrl).toBe('cover-prev.png');
  });

  it('调用次数 usage 占位（恒 null，主页-11/19/24）；name/cover 真实', () => {
    const card = rowToWorkCard(wRow('a', 'published', '需求炼金师', 'cover.png'));
    expect(card.invocations).toBeNull(); // usage 占位
    expect(card.name).toBe('需求炼金师'); // 真实
    expect(card.coverUrl).toBe('cover.png'); // 真实
    expect(WorkCardSchema.safeParse(card).success).toBe(true);
  });

  it('缺图 coverUrl:null（前端兜底占位，主页-22）—— 契约只返 null 不返破图', () => {
    const card = rowToWorkCard(wRow('a', 'published', '需求炼金师', null));
    expect(card.coverUrl).toBeNull();
  });

  it('空态（无上墙能力，主页-14）→ []', () => {
    expect(filterWorkCards([wRow('c', 'review_rejected')])).toEqual([]);
  });
});

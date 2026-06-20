// B-22 提取核心算法自检（cluster.ts，纯计算 + mock LLM 命名）：分词、聚类成簇、确定性打分/排序、
//   slug 合法性、置信/类型分档、命名降级兜底、稳定排序（不跳变，提取-30）。
import { describe, it, expect } from 'vitest';
import {
  tokenize,
  slugify,
  clusterSegments,
  scoreCandidates,
  nameOne,
  type ExtractSegment,
} from '../extract/cluster.js';
import { SlugSchema } from '@cb/shared';
import { FakeLlmGateway } from './extract-fakes.js';

function mkSeg(over: Partial<ExtractSegment> & { segmentId: string }): ExtractSegment {
  return {
    snapshotId: 'snap-1',
    title: '工作流',
    source: 'claude',
    project: null,
    happenedAt: '2026-06-10T10:00:00.000Z',
    content: '内容',
    messageCount: 4,
    ...over,
  };
}

describe('tokenize / slugify', () => {
  it('英文/数字成词，CJK 双字滑窗，去停用词', () => {
    const toks = tokenize('请帮我 refactor the module 重构模块');
    expect(toks).toContain('refactor');
    expect(toks).toContain('module');
    expect(toks).toContain('重构'); // CJK 双字
    expect(toks).not.toContain('the'); // 停用词
    expect(toks).not.toContain('请'); // 单字停用词（帮/请）
  });

  it('slugify 产出 SlugSchema 合法 slug（含纯 CJK 走 hash 后缀）', () => {
    const s1 = slugify('Refactor Module', 'seed-1');
    expect(() => SlugSchema.parse(s1)).not.toThrow();
    expect(s1).toBe('refactor-module');
    // 纯 CJK → hash 后缀（仍合法）。
    const s2 = slugify('重构模块', 'seed-2');
    expect(() => SlugSchema.parse(s2)).not.toThrow();
    expect(s2.startsWith('cap-')).toBe(true);
    // 同 seed 同 slug（确定性，幂等/去重友好）。
    expect(slugify('重构模块', 'seed-2')).toBe(s2);
  });
});

describe('clusterSegments — 聚类相似工作流', () => {
  it('按项目分簇：同项目段聚成一簇，不同项目分开', () => {
    const segs = [
      mkSeg({ segmentId: 's1', project: 'alpha', content: 'a 工作 内容' }),
      mkSeg({ segmentId: 's2', project: 'alpha', content: 'a 工作 内容' }),
      mkSeg({ segmentId: 's3', project: 'beta', content: 'b 别的 事情' }),
    ];
    const drafts = clusterSegments(segs);
    expect(drafts.length).toBe(2);
    const sizes = drafts.map((d) => d.segments.length).sort();
    expect(sizes).toEqual([1, 2]);
  });

  it('slug 在结果集内唯一（撞名加序号后缀，叠加 (job,slug) 去重键，提取-32）', () => {
    // 两个无项目但标题词不同 → 不同簇但 slug 可能撞 → 唯一化。
    const segs = [
      mkSeg({ segmentId: 's1', project: null, title: '同名', content: 'x 内容 一' }),
      mkSeg({
        segmentId: 's2',
        project: null,
        title: '同名',
        content: 'y 内容 二 完全 不同 词 集合',
      }),
    ];
    const drafts = clusterSegments(segs, { mergeThreshold: 0.99 }); // 强制不合并
    const slugs = drafts.map((d) => d.slug);
    expect(new Set(slugs).size).toBe(slugs.length); // 全唯一
  });

  it('稳定排序（提取-30 不跳变）：同输入多次运行簇序一致', () => {
    const segs = [
      mkSeg({ segmentId: 's3', project: 'c', content: 'cc' }),
      mkSeg({ segmentId: 's1', project: 'a', content: 'aa' }),
      mkSeg({ segmentId: 's2', project: 'b', content: 'bb' }),
    ];
    const a = clusterSegments(segs).map((d) => d.slug);
    const b = clusterSegments([...segs].reverse()).map((d) => d.slug);
    expect(a).toEqual(b);
  });

  it('BUG-021：跨项目 / 跨标题但内容高度相似的 25 段聚成极少候选（不再一段一候选）', () => {
    // 模拟测试员现场：25 个主题高度相似的 .codex 会话（都围绕「把访谈/运营/增长经验整理成可发布工作流」），
    //   各自来自不同 cwd（project 各异）、标题近重复。旧版「先按 project 硬分桶」→ 25 桶 25 候选；
    //   新版全局词袋 Jaccard 合并 → 应聚成极少簇、segmentCount 表达支撑段数。
    const segs = Array.from({ length: 25 }, (_, i) =>
      mkSeg({
        segmentId: `sim-${String(i).padStart(2, '0')}`,
        project: `proj-${i}`, // 各异 project（不同 cwd）——旧版会因此切碎成 25 桶
        title: i % 2 === 0 ? '创作者经验工作流沉淀' : '创作者经验沉淀工作流', // 近重复标题
        content: `创作者 经验 访谈 运营 增长 整理 发布 工作流 沉淀 复用 m${i}`, // 高度重叠正文 + 唯一标记
      }),
    );
    const drafts = clusterSegments(segs);
    // 25 段相似会话不再一段一候选：聚成极少簇（远小于 25）。
    expect(drafts.length).toBeLessThanOrEqual(3);
    // 最大簇承接绝大多数段（segmentCount 表达支撑段数，契约 30「按频次表达」）。
    const maxSize = Math.max(...drafts.map((d) => d.segments.length));
    expect(maxSize).toBeGreaterThanOrEqual(20);
    // 全部 25 段都被纳入（无丢段，血缘不漏）。
    const total = drafts.reduce((acc, d) => acc + d.segments.length, 0);
    expect(total).toBe(25);
  });

  it('BUG-021 反向：内容不相交、project 各异的两组不被误合（防过度合并）', () => {
    const groupA = Array.from({ length: 3 }, (_, i) =>
      mkSeg({ segmentId: `a-${i}`, project: null, title: '水果', content: '苹果 香蕉 橙子 葡萄 西瓜' }),
    );
    const groupB = Array.from({ length: 3 }, (_, i) =>
      mkSeg({ segmentId: `b-${i}`, project: null, title: '交通', content: '汽车 火车 飞机 轮船 自行' }),
    );
    const drafts = clusterSegments([...groupA, ...groupB]);
    // 词袋零交集 + project 均空（不触发同项目合并）→ 恰好两簇，不被全局合并误并成一簇。
    expect(drafts.length).toBe(2);
    expect(drafts.map((d) => d.segments.length).sort()).toEqual([3, 3]);
  });
});

describe('scoreCandidates — 评估 + 排序', () => {
  it('按 reusability 降序排（提取-08 按成功率排序）；大簇 reusability 不低于小簇', () => {
    const big = Array.from({ length: 6 }, (_, i) =>
      mkSeg({ segmentId: `big-${i}`, project: 'big', content: 'big work refactor 重构 依赖' }),
    );
    const small = Array.from({ length: 2 }, (_, i) =>
      mkSeg({ segmentId: `small-${i}`, project: 'small', content: 'small test 测试 覆盖' }),
    );
    const drafts = clusterSegments([...big, ...small]);
    const scored = scoreCandidates(drafts, Date.parse('2026-06-15T00:00:00Z'));
    // 降序。
    for (let i = 1; i < scored.length; i++) {
      expect(scored[i - 1]!.reusability).toBeGreaterThanOrEqual(scored[i]!.reusability);
    }
    // 大簇排第一。
    expect(scored[0]!.segmentCount).toBe(6);
  });

  it('置信/类型分档：6 段大簇 → core-workflow/recurring + 非 low；2 段小簇 → occasional', () => {
    const big = Array.from({ length: 8 }, (_, i) =>
      mkSeg({ segmentId: `big-${i}`, project: 'big', content: 'refactor 重构 依赖 分析' }),
    );
    const small = Array.from({ length: 1 }, (_, i) =>
      mkSeg({ segmentId: `small-${i}`, project: 'small', content: 'tiny 小' }),
    );
    const scored = scoreCandidates(
      clusterSegments([...big, ...small]),
      Date.parse('2026-06-15T00:00:00Z'),
    );
    const bigC = scored.find((c) => c.segmentCount === 8)!;
    const smallC = scored.find((c) => c.segmentCount === 1)!;
    expect(bigC.type).toBe('core-workflow');
    expect(bigC.confidence).not.toBe('low');
    expect(smallC.type).toBe('occasional');
  });

  it('所有信号 0~1，segmentCount = 支撑段数（频次条口径，提取-11/34）', () => {
    const segs = Array.from({ length: 4 }, (_, i) =>
      mkSeg({ segmentId: `s-${i}`, project: 'p', content: 'work 内容' }),
    );
    const scored = scoreCandidates(clusterSegments(segs), Date.now());
    const c = scored[0]!;
    expect(c.segmentCount).toBe(4);
    for (const v of [c.frequencyRatio, c.reusability, c.scopeCoherence]) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

describe('nameOne — 经 3A LLM 网关命名', () => {
  it('正常：解析 LLM JSON 出 name/intent', async () => {
    const gw = new FakeLlmGateway();
    gw.default = { text: '{"name":"港险打分器","intent":"判断投保资格并打分"}', degraded: false };
    const scored = scoreCandidates(
      clusterSegments([mkSeg({ segmentId: 's1', project: 'p', content: 'x' })]),
      Date.now(),
    );
    const named = await nameOne(gw, scored[0]!, { traceId: 't' });
    expect(named.name).toBe('港险打分器');
    expect(named.intent).toBe('判断投保资格并打分');
    expect(named.degradedNaming).toBe(false);
  });

  it('降级（degraded）→ 兜底名（簇标签）+ degradedNaming=true，不抛（§10）', async () => {
    const gw = new FakeLlmGateway();
    gw.default = { degraded: true };
    const scored = scoreCandidates(
      clusterSegments([mkSeg({ segmentId: 's1', project: 'alpha', content: 'x' })]),
      Date.now(),
    );
    const named = await nameOne(gw, scored[0]!, { traceId: 't' });
    expect(named.degradedNaming).toBe(true);
    expect(named.name.length).toBeGreaterThan(0);
  });

  it('坏 JSON → 兜底名（不抛、不裸错误）', async () => {
    const gw = new FakeLlmGateway();
    gw.default = { text: 'not json at all', degraded: false };
    const scored = scoreCandidates(
      clusterSegments([mkSeg({ segmentId: 's1', project: 'beta', content: 'x' })]),
      Date.now(),
    );
    const named = await nameOne(gw, scored[0]!, { traceId: 't' });
    expect(named.name.length).toBeGreaterThan(0);
    expect(named.intent.length).toBeGreaterThan(0);
  });
});

// B-22 提取核心算法自检（cluster.ts，纯计算 + mock LLM 命名）：分词、聚类成簇、确定性打分/排序、
//   slug 合法性、置信/类型分档、命名降级兜底、稳定排序（不跳变，提取-30）。
import { describe, it, expect } from 'vitest';
import {
  tokenize,
  slugify,
  clusterSegments,
  scoreCandidates,
  selectPublishableCandidates,
  assessCandidatePublishQuality,
  nameOne,
  isEffectiveSessionForMock,
  nameSessionCapability,
  buildSessionMockCandidate,
  type ExtractSegment,
} from '../modules/extract/cluster.js';
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

describe('session-mock helpers — 前 5 个有效 session 生成能力项', () => {
  it('过滤平台噪声和过短寒暄，保留真实任务 session', () => {
    const cases = [
      mkSeg({
        segmentId: 'env',
        title: '<environment_context>',
        content: 'user: <environment_context>\n  <cwd>/x</cwd>\n</environment_context>',
      }),
      mkSeg({
        segmentId: 'agents',
        title: '# AGENTS.md instructions for /x',
        content: 'user: # AGENTS.md instructions for /x',
      }),
      mkSeg({
        segmentId: 'title-gen',
        title: 'Generate a title and a git branch name for a coding agent from the user prompt ...',
        content:
          'user: Generate a title and a git branch name for a coding agent from the user prompt ...',
      }),
      mkSeg({ segmentId: 'hello', title: '你好', content: 'user: 你好', messageCount: 1 }),
    ];
    expect(cases.every((s) => isEffectiveSessionForMock(s) === false)).toBe(true);
    expect(
      isEffectiveSessionForMock(
        mkSeg({
          segmentId: 'docker',
          title: '后台的 Docker Compose 镜像这些都有重新构建并拉起来吗？',
          content: '检查 api worker web compose build up ready health logs',
          messageCount: 30,
        }),
      ),
    ).toBe(true);
  });

  it('LLM JSON 产物用于能力名，候选固定为单 session evidence 口径', async () => {
    const gw = new FakeLlmGateway();
    gw.default = {
      text: '{"name":"Docker部署排障","intent":"检查服务镜像构建、启动和健康状态"}',
      degraded: false,
    };
    const segment = mkSeg({
      segmentId: 'docker',
      title: '后台的 Docker Compose 镜像这些都有重新构建并拉起来吗？',
      content: '检查 api worker web compose build up ready health logs',
      messageCount: 30,
    });
    const summary = await nameSessionCapability(gw, segment, { traceId: 't' });
    const candidate = buildSessionMockCandidate(segment, summary);
    expect(summary.name).toBe('Docker部署排障');
    expect(summary.name).not.toBe(segment.title);
    expect(candidate.segmentCount).toBe(1);
    expect(candidate.segments.map((s) => s.segmentId)).toEqual(['docker']);
    expect(candidate.type).toBe('occasional');
    expect(candidate.confidence).toBe('med');
  });

  it('LLM 降级或坏输出时使用能力口径兜底，不直接复用 session 标题', async () => {
    const gw = new FakeLlmGateway();
    gw.default = { degraded: true };
    const segment = mkSeg({
      segmentId: 'docker',
      title: '后台的 Docker Compose 镜像这些都有重新构建并拉起来吗？',
      content: '检查 api worker web compose build up ready health logs',
      messageCount: 30,
    });
    const summary = await nameSessionCapability(gw, segment, { traceId: 't' });
    expect(summary.degradedNaming).toBe(true);
    expect(summary.name).toBe('Docker部署排障');
    expect(summary.name).not.toBe(segment.title);
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
      mkSeg({
        segmentId: `a-${i}`,
        project: null,
        title: '水果',
        content: '苹果 香蕉 橙子 葡萄 西瓜',
      }),
    );
    const groupB = Array.from({ length: 3 }, (_, i) =>
      mkSeg({
        segmentId: `b-${i}`,
        project: null,
        title: '交通',
        content: '汽车 火车 飞机 轮船 自行',
      }),
    );
    const drafts = clusterSegments([...groupA, ...groupB]);
    // 词袋零交集 + project 均空（不触发同项目合并）→ 恰好两簇，不被全局合并误并成一簇。
    expect(drafts.length).toBe(2);
    expect(drafts.map((d) => d.segments.length).sort()).toEqual([3, 3]);
  });

  it('过滤 Codex 平台噪声段：不把 environment/AGENTS/标题生成提示形成候选', () => {
    const noise = [
      mkSeg({
        segmentId: 'n-env',
        title: '<environment_context>',
        content: 'user: <environment_context>\n  <cwd>/x</cwd>\n</environment_context>',
      }),
      mkSeg({
        segmentId: 'n-agents',
        title: '# AGENTS.md instructions for /x',
        content: 'user: # AGENTS.md instructions for /x\n\n<INSTRUCTIONS>...</INSTRUCTIONS>',
      }),
      mkSeg({
        segmentId: 'n-title',
        title: 'Generate a title and a git branch name for a coding agent from the user prompt ...',
        content:
          'user: Generate a title and a git branch name for a coding agent from the user prompt ...',
      }),
      mkSeg({
        segmentId: 'n-instructions',
        title: '# Instructions (read first)',
        content: 'system: # Instructions (read first)',
      }),
      mkSeg({
        segmentId: 'n-ok',
        title: 'Reply with OK only.',
        content: 'system: Reply with OK only.',
      }),
      mkSeg({
        segmentId: 'n-figma',
        title: 'You are building in a Figma file via the plugin',
        content: 'system: You are building in a Figma file via the plugin',
      }),
      mkSeg({
        segmentId: 'n-status',
        title: '任务怎么样了',
        content: 'user: 任务怎么样了',
        messageCount: 3,
      }),
    ];
    const real = Array.from({ length: 3 }, (_, i) =>
      mkSeg({
        segmentId: `real-${i}`,
        title: '生产链路排障',
        content: '定位 worker 日志 生产链路 上传 萃取 候选 质量',
      }),
    );

    const drafts = clusterSegments([...noise, ...real]);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.clusterLabel).toBe('生产链路排障');
    expect(drafts[0]!.segments.map((s) => s.segmentId).sort()).toEqual([
      'real-0',
      'real-1',
      'real-2',
    ]);
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

describe('selectPublishableCandidates — 发布准备质量门槛', () => {
  it('阻断单段候选和极低内聚大簇，只让可复用且范围清晰的候选进入 trial 准备', () => {
    const publishable = scoreCandidates(
      clusterSegments([
        mkSeg({
          segmentId: 'good-1',
          project: 'good',
          title: '设计评审',
          content: '设计 评审 视觉 层级 间距 修复',
          messageCount: 20,
        }),
        mkSeg({
          segmentId: 'good-2',
          project: 'good',
          title: '设计评审',
          content: '设计 评审 视觉 层级 间距 修复',
          messageCount: 20,
        }),
      ]),
      Date.parse('2026-06-15T00:00:00Z'),
    )[0]!;
    const single = scoreCandidates(
      clusterSegments([
        mkSeg({
          segmentId: 'single',
          project: 'one-off',
          title: '单次查询',
          content: '只执行一次 查询 当前 IP',
          messageCount: 20,
        }),
      ]),
      Date.parse('2026-06-15T00:00:00Z'),
    )[0]!;
    const lowCoherence = {
      ...publishable,
      slug: 'low-coherence',
      segmentCount: 20,
      frequencyRatio: 1,
      reusability: 0.9,
      scopeCoherence: 0.05,
      splitSuggested: true,
    };

    const selected = selectPublishableCandidates([lowCoherence, single, publishable]);
    expect(selected.map((c) => c.slug)).toEqual([publishable.slug]);
  });

  it('最多保留前 12 个候选，避免真实长 session 逐个准备几十个 trial capability', () => {
    const base = scoreCandidates(
      clusterSegments([
        mkSeg({
          segmentId: 'base-1',
          project: 'base',
          title: '文档评审',
          content: '文档 评审 结构 表达 修改 交付',
          messageCount: 20,
        }),
        mkSeg({
          segmentId: 'base-2',
          project: 'base',
          title: '文档评审',
          content: '文档 评审 结构 表达 修改 交付',
          messageCount: 20,
        }),
      ]),
      Date.parse('2026-06-15T00:00:00Z'),
    )[0]!;
    const many = Array.from({ length: 15 }, (_, i) => ({
      ...base,
      slug: `publishable-${String(i).padStart(2, '0')}`,
      reusability: 0.9 - i * 0.01,
    }));

    expect(selectPublishableCandidates(many)).toHaveLength(12);
  });

  it('阻断少证据的一次性查询，但保留绑定 creator context 且有外部价值的候选', () => {
    const founderReview = scoreCandidates(
      clusterSegments([
        mkSeg({
          segmentId: 'goal-1',
          project: 'YC 学习报告',
          title: '融资故事审查',
          content: '飞书 文档 融资 故事 审查 拷打 问题 漏洞 交付 修改建议',
          messageCount: 24,
        }),
        mkSeg({
          segmentId: 'goal-2',
          project: 'YC 学习报告',
          title: '融资故事审查',
          content: 'YC 视频 笔记 融资 叙事 分析 报告 评审 创业者 交付',
          messageCount: 24,
        }),
      ]),
      Date.parse('2026-07-05T00:00:00Z'),
    )[0]!;
    const oneOffFeeQuery = scoreCandidates(
      clusterSegments([
        mkSeg({
          segmentId: 'fa-1',
          project: 'fa',
          title: '中国 FA一般给多少百分比作为服务费',
          content: '中国 FA 一般 给多少 百分比 服务费比例 查询',
          messageCount: 10,
        }),
        mkSeg({
          segmentId: 'fa-2',
          project: 'fa',
          title: '中国 FA一般给多少百分比作为服务费',
          content: '中国 FA 一般 给多少 百分比 服务费比例 查询',
          messageCount: 10,
        }),
      ]),
      Date.parse('2026-07-05T00:00:00Z'),
    )[0]!;

    const founderQuality = assessCandidatePublishQuality(founderReview);
    const feeQuality = assessCandidatePublishQuality(oneOffFeeQuery);
    expect(founderQuality.creatorContext).toBeGreaterThanOrEqual(0.25);
    expect(founderQuality.externalValue).toBeGreaterThanOrEqual(0.25);
    expect(feeQuality.oneOffPenalty).toBeGreaterThan(0);

    expect(selectPublishableCandidates([oneOffFeeQuery, founderReview])).toEqual([founderReview]);
  });

  it('保留高证据的长期维护类 creator 工作流，避免真实长 snapshot 候选归零', () => {
    const base = scoreCandidates(
      clusterSegments([
        mkSeg({
          segmentId: 'maint-1',
          project: 'awesome-weread',
          title: 'Automation: Awesome WeRead maintenance',
          content: 'automation maintenance docs check repair workflow release',
          messageCount: 12,
        }),
        mkSeg({
          segmentId: 'maint-2',
          project: 'awesome-weread',
          title: 'Automation: Awesome WeRead maintenance',
          content: 'automation maintenance docs check repair workflow release',
          messageCount: 12,
        }),
      ]),
      Date.parse('2026-07-05T00:00:00Z'),
    )[0]!;
    const evidenceBacked = {
      ...base,
      slug: 'automation-awesome-weread-maintenance',
      clusterLabel: 'Automation: Awesome WeRead maintenance',
      segmentCount: 87,
      reusability: 0.205,
      scopeCoherence: 0.63,
      splitSuggested: false,
    };
    const weak = {
      ...base,
      slug: 'status-dump',
      clusterLabel: 'status dump',
      segmentCount: 87,
      reusability: 0.205,
      scopeCoherence: 0.63,
      splitSuggested: false,
      segments: base.segments.map((s) => ({
        ...s,
        title: 'status dump',
        project: 'scratchpad',
      })),
    };

    expect(selectPublishableCandidates([weak, evidenceBacked])).toEqual([evidenceBacked]);
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

  it('降级命名只使用清洗后的真实任务标签，不回退到平台噪声', async () => {
    const gw = new FakeLlmGateway();
    gw.default = { degraded: true };
    const scored = scoreCandidates(
      clusterSegments([
        mkSeg({
          segmentId: 'noise',
          title: '<environment_context>',
          content: 'user: <environment_context>\n  <cwd>/x</cwd>\n</environment_context>',
        }),
        mkSeg({
          segmentId: 'real-1',
          title: '代码审计复盘',
          content: '审计 代码 风险 测试 覆盖 回归',
        }),
        mkSeg({
          segmentId: 'real-2',
          title: '代码审计复盘',
          content: '审计 代码 风险 测试 覆盖 回归',
        }),
      ]),
      Date.now(),
    );

    const named = await nameOne(gw, scored[0]!, { traceId: 't' });
    expect(named.name).toBe('代码审计复盘');
    expect(named.name).not.toContain('environment_context');
    expect(named.degradedNaming).toBe(true);
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

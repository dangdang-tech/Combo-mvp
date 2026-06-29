// 路由/导航真源测试（D14 恒定结构）：分组齐全 + 面包屑分层（外壳首页-03/06）。
import { describe, it, expect } from 'vitest';
import { CREATOR_NAV, NAV_GROUPS, CREATE_STEPS, BREADCRUMB_ROOT, breadcrumbFor } from './routes.js';

describe('CREATOR_NAV 分组结构（外壳首页-03）', () => {
  it('创作组含 工作台/我的能力/上传能力/数据分析/收益 五项，顺序对', () => {
    const createLabels = CREATOR_NAV.filter((n) => n.group === 'create').map((n) => n.label);
    expect(createLabels).toEqual(['工作台', '我的能力', '上传能力', '数据分析', '收益']);
  });

  it('我的组含 个人主页 一项', () => {
    const mineLabels = CREATOR_NAV.filter((n) => n.group === 'mine').map((n) => n.label);
    expect(mineLabels).toEqual(['个人主页']);
  });

  it('NAV_GROUPS 两组：创作 / 我的', () => {
    expect(NAV_GROUPS.map((g) => g.label)).toEqual(['创作', '我的']);
  });

  it('每项都带图标组件与唯一 path', () => {
    const paths = CREATOR_NAV.map((n) => n.path);
    expect(new Set(paths).size).toBe(paths.length);
    for (const n of CREATOR_NAV) expect(typeof n.icon).toBe('function');
  });

  it('每个分组键都在 NAV_GROUPS 中有定义（无孤儿组）', () => {
    const known = new Set(NAV_GROUPS.map((g) => g.key));
    for (const n of CREATOR_NAV) expect(known.has(n.group)).toBe(true);
  });
});

describe('CREATE_STEPS 五步映射 DraftStep', () => {
  it('五步顺序 import/extract/select/structure/publish', () => {
    expect(CREATE_STEPS.map((s) => s.step)).toEqual([
      'import',
      'extract',
      'select',
      'structure',
      'publish',
    ]);
  });
});

describe('breadcrumbFor 分层（外壳首页-06）', () => {
  it('工作台 → 只 Creator Builder 根（自身即根，不重复）', () => {
    const c = breadcrumbFor('/creator');
    expect(c.map((x) => x.label)).toEqual([BREADCRUMB_ROOT.label]);
  });

  it('上传能力 → Creator Builder / 上传能力', () => {
    const c = breadcrumbFor('/create');
    expect(c.map((x) => x.label)).toEqual(['Creator Builder', '上传能力']);
  });

  it('五步子页 → Creator Builder / 上传能力 / 提取', () => {
    const c = breadcrumbFor('/create/extract');
    expect(c.map((x) => x.label)).toEqual(['Creator Builder', '上传能力', '提取']);
  });

  it('数据分析 → Creator Builder / 数据分析', () => {
    const c = breadcrumbFor('/analytics');
    expect(c.map((x) => x.label)).toEqual(['Creator Builder', '数据分析']);
  });

  it('个人主页 → Creator Builder / 个人主页', () => {
    const c = breadcrumbFor('/profile');
    expect(c.map((x) => x.label)).toEqual(['Creator Builder', '个人主页']);
  });

  it('未知路径 → 只剩根，不抛错', () => {
    const c = breadcrumbFor('/nope/here');
    expect(c.map((x) => x.label)).toEqual([BREADCRUMB_ROOT.label]);
  });
});

// 路由 / 导航单一真源（D14：恒定结构）。Shell 侧栏、面包屑、<Routes> 都读这里，不各写一套。
//
// 侧栏分两组（开工总纲 §2.1）：
//   「创作」→ 工作台 / 我的能力 / 上传能力 / 数据分析 / 收益
//   「我的」→ 个人主页
// 五步上传流程映射 DraftStep（脊柱 §8.2：import/extract/select/structure/publish），
// 子步不进侧栏（inSidebar=false），只走面包屑 / CreateLayout 步骤条。
// 路由占位页留待 Phase 4 实现（此处只搭外壳骨架，D14：外壳恒定）。
import type { DraftStep } from '@cb/shared';
import type { ComponentType, SVGProps } from 'react';
import {
  IconWorkbench,
  IconCapabilities,
  IconUpload,
  IconAnalytics,
  IconEarnings,
  IconProfile,
} from './icons.js';

/** 侧栏分组键（开工总纲 §2.1：创作 / 我的）。 */
export type NavGroupKey = 'create' | 'mine';

export interface NavItem {
  /** 路由 path（react-router）。 */
  path: string;
  /** 侧栏 / 面包屑展示名（人话）。 */
  label: string;
  /** 所属侧栏分组（决定分组小标题归属）。 */
  group: NavGroupKey;
  /** 纯图标态用的图标（收起后只剩它 + tooltip，外壳首页-05）。 */
  icon: ComponentType<SVGProps<SVGSVGElement>>;
}

/** 分组小标题（展开态显示；收起态以分隔线区分，外壳首页-03/04）。 */
export const NAV_GROUPS: { key: NavGroupKey; label: string }[] = [
  { key: 'create', label: '创作' },
  { key: 'mine', label: '我的' },
];

/** 创作者侧栏主导航（恒定结构，开工总纲 §2.1）。顺序即展示顺序。 */
export const CREATOR_NAV: NavItem[] = [
  { path: '/creator', label: '工作台', group: 'create', icon: IconWorkbench },
  { path: '/capabilities', label: '我的能力', group: 'create', icon: IconCapabilities },
  { path: '/create', label: '上传能力', group: 'create', icon: IconUpload },
  { path: '/analytics', label: '数据分析', group: 'create', icon: IconAnalytics },
  { path: '/earnings', label: '收益', group: 'create', icon: IconEarnings },
  { path: '/profile', label: '个人主页', group: 'mine', icon: IconProfile },
];

/** 上传五步子路由（映射 DraftStep；select 为纯前端步，脊柱 §8.2）。不进侧栏。 */
export const CREATE_STEPS: { step: DraftStep; path: string; label: string }[] = [
  { step: 'import', path: '/create/import', label: 'STEP① 导入' },
  { step: 'extract', path: '/create/extract', label: 'STEP② 提取' },
  { step: 'select', path: '/create/select', label: 'STEP③ 选择' },
  { step: 'structure', path: '/create/structure', label: 'STEP④ 结构化' },
  { step: 'publish', path: '/create/publish', label: 'STEP⑤ 发布' },
];

/** 面包屑根（开工总纲 §2.2：如「上传能力 / Creator Builder」恒以产品域为根）。 */
export const BREADCRUMB_ROOT = { path: '/creator', label: 'Creator Builder' } as const;

export interface Crumb {
  path: string;
  label: string;
}

/**
 * 面包屑：把当前 pathname 拆成可点段（产品域根 → 区段 → 子步）。
 * 例：/create/extract → 「Creator Builder / 上传能力 / STEP② 提取」（外壳首页-06）。
 * 末段为当前页（不可点），其余可点回跳。
 */
export function breadcrumbFor(pathname: string): Crumb[] {
  const crumbs: Crumb[] = [{ ...BREADCRUMB_ROOT }];

  // 命中的侧栏区段（最长前缀，单段；/creator 自身即根，不重复加）。
  const section = CREATOR_NAV.filter(
    (n) =>
      n.path !== BREADCRUMB_ROOT.path && (pathname === n.path || pathname.startsWith(n.path + '/')),
  ).sort((a, b) => b.path.length - a.path.length)[0];
  if (section) crumbs.push({ path: section.path, label: section.label });

  // 命中的五步子步（精确匹配；上传能力下的当前步）。
  const sub = CREATE_STEPS.find((s) => s.path === pathname);
  if (sub) crumbs.push({ path: sub.path, label: sub.label });

  return crumbs;
}

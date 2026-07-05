// 导航单一真源：Shell 侧栏与 <Routes> 都读这里，不各写一套。
// 两页结构：任务（默认页，建任务 + 进度）→ 能力（提取产出的能力项，发布/试用）。
import type { ComponentType, SVGProps } from 'react';
import { IconCapabilities, IconTasks } from './icons.js';

export interface NavItem {
  /** 路由 path（react-router）。 */
  path: string;
  /** 侧栏展示名（人话）。 */
  label: string;
  /** 收起态只剩图标 + tooltip。 */
  icon: ComponentType<SVGProps<SVGSVGElement>>;
}

/** 侧栏主导航。顺序即展示顺序。 */
export const CREATOR_NAV: NavItem[] = [
  { path: '/tasks', label: '上传任务', icon: IconTasks },
  { path: '/capabilities', label: '我的能力', icon: IconCapabilities },
];

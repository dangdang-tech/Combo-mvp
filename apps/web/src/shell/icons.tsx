// 侧栏导航图标（内联 SVG，无第三方图标依赖）。收起态下侧栏只剩图标 + tooltip（外壳首页-05）。
// 均 aria-hidden：图标是装饰，可达名走 NavLink 文本 / title（收起态）。
import type { ReactElement, SVGProps } from 'react';

function base(props: SVGProps<SVGSVGElement>): SVGProps<SVGSVGElement> {
  return {
    width: 18,
    height: 18,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
    focusable: false,
    ...props,
  };
}

/** 工作台：仪表盘格。 */
export function IconWorkbench(props: SVGProps<SVGSVGElement>): ReactElement {
  return (
    <svg {...base(props)}>
      <rect x="3" y="3" width="7" height="9" rx="1" />
      <rect x="14" y="3" width="7" height="5" rx="1" />
      <rect x="14" y="12" width="7" height="9" rx="1" />
      <rect x="3" y="16" width="7" height="5" rx="1" />
    </svg>
  );
}

/** 我的能力：方块堆叠（能力体列表）。 */
export function IconCapabilities(props: SVGProps<SVGSVGElement>): ReactElement {
  return (
    <svg {...base(props)}>
      <rect x="3" y="3" width="8" height="8" rx="1.5" />
      <rect x="13" y="3" width="8" height="8" rx="1.5" />
      <rect x="3" y="13" width="8" height="8" rx="1.5" />
      <rect x="13" y="13" width="8" height="8" rx="1.5" />
    </svg>
  );
}

/** 上传能力：上传箭头。 */
export function IconUpload(props: SVGProps<SVGSVGElement>): ReactElement {
  return (
    <svg {...base(props)}>
      <path d="M12 16V4" />
      <path d="M7 9l5-5 5 5" />
      <path d="M4 20h16" />
    </svg>
  );
}

/** 数据分析：折线趋势。 */
export function IconAnalytics(props: SVGProps<SVGSVGElement>): ReactElement {
  return (
    <svg {...base(props)}>
      <path d="M4 20V4" />
      <path d="M4 20h16" />
      <path d="M7 15l4-5 3 3 4-6" />
    </svg>
  );
}

/** 收益：钱币。 */
export function IconEarnings(props: SVGProps<SVGSVGElement>): ReactElement {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v10" />
      <path d="M9.5 9.5a2.5 2 0 0 1 2.5-1.5c1.4 0 2.5.7 2.5 1.8s-1 1.6-2.5 1.9-2.5.8-2.5 1.9.9 1.9 2.5 1.9a2.5 2 0 0 0 2.5-1.5" />
    </svg>
  );
}

/** 个人主页：人像。 */
export function IconProfile(props: SVGProps<SVGSVGElement>): ReactElement {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21a8 8 0 0 1 16 0" />
    </svg>
  );
}

/** 收起 / 展开开关：双箭头（朝向由调用方旋转）。 */
export function IconChevrons(props: SVGProps<SVGSVGElement>): ReactElement {
  return (
    <svg {...base(props)}>
      <path d="M13 6l-6 6 6 6" />
      <path d="M19 6l-6 6 6 6" />
    </svg>
  );
}

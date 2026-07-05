// 侧栏导航图标（内联 SVG，无第三方图标依赖）。收起态下侧栏只剩图标 + tooltip。
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

/** 任务：清单勾选。 */
export function IconTasks(props: SVGProps<SVGSVGElement>): ReactElement {
  return (
    <svg {...base(props)}>
      <path d="M4 6h2" />
      <path d="M10 6h10" />
      <path d="M4 12h2" />
      <path d="M10 12h10" />
      <path d="M4 18h2" />
      <path d="M10 18h10" />
    </svg>
  );
}

/** 能力：方块堆叠（能力项列表）。 */
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

/** 收起 / 展开开关：双箭头（朝向由调用方旋转）。 */
export function IconChevrons(props: SVGProps<SVGSVGElement>): ReactElement {
  return (
    <svg {...base(props)}>
      <path d="M13 6l-6 6 6 6" />
      <path d="M19 6l-6 6 6 6" />
    </svg>
  );
}

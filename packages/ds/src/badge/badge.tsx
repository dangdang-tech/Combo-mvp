import { type ReactNode } from 'react';
import './badge.css';

export interface BadgeProps {
  /** 语义变体：neutral 中性、ok 正常、warn 提醒、danger 危险、accent 品牌强调，默认 neutral。 */
  variant?: 'neutral' | 'ok' | 'warn' | 'danger' | 'accent';
  children: ReactNode;
}

export function Badge({ variant = 'neutral', children }: BadgeProps) {
  return <span className={`cb-badge cb-badge--${variant}`}>{children}</span>;
}

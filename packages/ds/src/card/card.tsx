import { type ReactNode } from 'react';
import './card.css';

export type CardVariant = 'surface' | 'raised' | 'hero';
export type CardPadding = 'none' | 'md' | 'lg';

export interface CardProps {
  /** 视觉变体：surface 是列表内容器，raised 是纯白抬升容器，hero 是首屏大容器。 */
  variant?: CardVariant;
  /** 内边距档位：none 无内边距，md 常规，lg 宽松。 */
  padding?: CardPadding;
  children?: ReactNode;
}

/** 通用卡片容器，所有视觉状态由 variant 与 padding 两个枚举 prop 决定。 */
export function Card({ variant = 'surface', padding = 'md', children }: CardProps) {
  return <div className={`cb-card cb-card--${variant} cb-card--pad-${padding}`}>{children}</div>;
}

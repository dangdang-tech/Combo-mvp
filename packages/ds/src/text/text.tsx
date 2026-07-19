import { type ReactNode } from 'react';
import './text.css';

export type TextVariant = 'body' | 'muted' | 'caption' | 'label';
export type TextAs = 'p' | 'span' | 'div';

export interface TextProps {
  /** 文本变体：body 正文、muted 弱化说明、caption 小号说明、label 等宽标签。默认 body。 */
  variant?: TextVariant;
  /** 渲染的 HTML 标签，默认 p。 */
  as?: TextAs;
  children: ReactNode;
}

/** 正文文本组件。全部视觉状态由 variant 与 as 两个 JSON 可表达的 prop 决定。 */
export function Text({ variant = 'body', as = 'p', children }: TextProps) {
  const Tag = as;
  return <Tag className={`cb-text cb-text--${variant}`}>{children}</Tag>;
}

export type HeadingLevel = 1 | 2 | 3 | 4;

export interface HeadingProps {
  /** 标题层级，渲染对应的 h1 到 h4 标签，字号按 token 阶梯递减。 */
  level: HeadingLevel;
  children: ReactNode;
}

/** 衬线标题组件。margin 已归零，由使用方负责排版间距。 */
export function Heading({ level, children }: HeadingProps) {
  const Tag = `h${level}` as 'h1' | 'h2' | 'h3' | 'h4';
  return <Tag className={`cb-heading cb-heading--${level}`}>{children}</Tag>;
}

import { type ReactNode } from 'react';
import './empty-state.css';

export interface EmptyStateProps {
  /** 标题，使用衬线字体居中展示。 */
  title: string;
  /** 可选描述文字，使用弱化颜色，解释为什么是空的或下一步能做什么。 */
  description?: string;
  /** 可选图标插槽，不传时整个图标区不渲染。 */
  icon?: ReactNode;
  /** 可选操作插槽，通常放一个引导用户开始的按钮。 */
  action?: ReactNode;
}

/**
 * 空状态占位组件：居中布局，带极淡的网格纸背景。
 * 全部视觉状态由纯 JSON 可表达的 props 决定（icon 与 action 是可选的 ReactNode 插槽）。
 */
export function EmptyState({ title, description, icon, action }: EmptyStateProps) {
  return (
    <div className="cb-empty-state">
      {icon !== undefined && icon !== null ? (
        <div className="cb-empty-state-icon" aria-hidden="true">
          {icon}
        </div>
      ) : null}
      <h3 className="cb-empty-state-title">{title}</h3>
      {description !== undefined ? (
        <p className="cb-empty-state-description">{description}</p>
      ) : null}
      {action !== undefined && action !== null ? (
        <div className="cb-empty-state-action">{action}</div>
      ) : null}
    </div>
  );
}

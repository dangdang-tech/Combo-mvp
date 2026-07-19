import { type ReactNode } from 'react';
import './list-item.css';

export interface ListItemProps {
  /** 主文案，单行截断。 */
  title: ReactNode;
  /** 次级说明，muted 小字，最多两行后截断。 */
  description?: ReactNode;
  /** 行首插槽，例如头像或状态点。 */
  leading?: ReactNode;
  /** 行尾插槽，例如时间戳或徽标。 */
  trailing?: ReactNode;
  /** 选中态：accent-soft 底色加左侧 accent 指示条。 */
  selected?: boolean;
  /** 可选的行为增强：提供后整行渲染为 button（键盘可达），不提供则渲染为 div。 */
  onClick?: () => void;
}

/** 列表行：title 必填，其余全部可选；视觉状态（含 selected）可用纯 JSON props 表达。 */
export function ListItem({
  title,
  description,
  leading,
  trailing,
  selected = false,
  onClick,
}: ListItemProps) {
  const className = [
    'cb-list-item',
    onClick ? 'cb-list-item--interactive' : '',
    selected ? 'cb-list-item--selected' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const content = (
    <>
      {leading != null && <span className="cb-list-item-leading">{leading}</span>}
      <span className="cb-list-item-body">
        <span className="cb-list-item-title">{title}</span>
        {description != null && <span className="cb-list-item-description">{description}</span>}
      </span>
      {trailing != null && <span className="cb-list-item-trailing">{trailing}</span>}
    </>
  );

  if (onClick) {
    return (
      <button
        type="button"
        className={className}
        onClick={onClick}
        aria-current={selected || undefined}
      >
        {content}
      </button>
    );
  }

  return (
    <div className={className} aria-current={selected || undefined}>
      {content}
    </div>
  );
}

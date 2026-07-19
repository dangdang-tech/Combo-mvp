import { type ReactNode } from 'react';
import './button.css';

export interface ButtonProps {
  /** 视觉变体：primary 是砖红主操作，secondary 是描边默认操作，ghost 无底无边，danger 是破坏性操作。 */
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  /** 尺寸档位，默认 md。 */
  size?: 'sm' | 'md' | 'lg';
  /** 禁用态：不可点击并降低透明度。 */
  disabled?: boolean;
  /** 加载态：左侧出现旋转 spinner，同时按钮不可点击。 */
  loading?: boolean;
  /** 原生 button 的 type 属性，默认 'button'。 */
  type?: 'button' | 'submit';
  /** 点击回调，可选的行为增强；不传也能完整渲染所有视觉状态。 */
  onClick?: () => void;
  children: ReactNode;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  disabled = false,
  loading = false,
  type = 'button',
  onClick,
  children,
}: ButtonProps) {
  return (
    <button
      className={`cb-btn cb-btn--${variant} cb-btn--${size}`}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      onClick={onClick}
    >
      {loading ? <span className="cb-btn-spinner" aria-hidden="true" /> : null}
      <span className="cb-btn-label">{children}</span>
    </button>
  );
}

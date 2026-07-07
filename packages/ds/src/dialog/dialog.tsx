import * as RadixDialog from '@radix-ui/react-dialog';
import { type ReactNode } from 'react';
import './dialog.css';

export interface DialogProps {
  /** 是否打开，受控属性。 */
  open: boolean;
  /**
   * 可选的行为增强：打开状态变化回调（点右上关闭钮、按 Esc、点遮罩时以 false 触发）。
   * 不传时对话框仍按 open 的值正确渲染，满足纯 JSON props 可表达全部视觉状态。
   */
  onOpenChange?: (open: boolean) => void;
  /** 对话框标题，衬线字体渲染。 */
  title: string;
  /** 标题下方的辅助描述文字。 */
  description?: string;
  /** 底部操作区，通常放按钮组。 */
  footer?: ReactNode;
  /** 对话框正文内容。 */
  children?: ReactNode;
}

export function Dialog({ open, onOpenChange, title, description, footer, children }: DialogProps) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="cb-dialog-overlay" />
        <RadixDialog.Content
          className="cb-dialog-content"
          {...(description === undefined ? { 'aria-describedby': undefined } : {})}
        >
          <header className="cb-dialog-header">
            <RadixDialog.Title className="cb-dialog-title">{title}</RadixDialog.Title>
            <RadixDialog.Close className="cb-dialog-close" aria-label="关闭">
              <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false">
                <path
                  d="M4 4L12 12M12 4L4 12"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
            </RadixDialog.Close>
          </header>
          {description !== undefined && (
            <RadixDialog.Description className="cb-dialog-description">
              {description}
            </RadixDialog.Description>
          )}
          {children !== undefined && <div className="cb-dialog-body">{children}</div>}
          {footer !== undefined && <footer className="cb-dialog-footer">{footer}</footer>}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

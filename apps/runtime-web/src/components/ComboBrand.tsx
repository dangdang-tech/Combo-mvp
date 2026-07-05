// Combo 品牌元素（试用端）：ComboMark 是墨底 C 徽标（右下角砖红小圆点），
// ComboWordmark 是「Combo.」字标（bo 与句点砖红）。样式前缀 rt-combo-*。
import type { ReactElement } from 'react';

export function ComboMark({ className }: { className?: string }): ReactElement {
  const cls = className ? `rt-combo-mark ${className}` : 'rt-combo-mark';
  return (
    <span className={cls} aria-hidden="true">
      <span className="rt-combo-mark__letter">C</span>
      <span className="rt-combo-mark__dot" />
    </span>
  );
}

export function ComboWordmark({ className }: { className?: string }): ReactElement {
  const cls = className ? `rt-combo-wordmark ${className}` : 'rt-combo-wordmark';
  return (
    <span className={cls} aria-hidden="true">
      <span>Com</span>
      <span className="rt-combo-wordmark__accent">bo</span>
      <span className="rt-combo-wordmark__dot">.</span>
    </span>
  );
}

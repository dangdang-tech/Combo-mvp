// Combo 品牌元素（创作端）：ComboMark 是收起侧栏里的紧凑徽标（右下角砖红小圆点），
// ComboWordmark 是「Combo.」字标（bo 与句点砖红）。样式前缀 cb-brand-*。
import type { ReactElement } from 'react';

export function ComboMark({ className }: { className?: string }): ReactElement {
  const cls = className ? `cb-brand-mark ${className}` : 'cb-brand-mark';
  return (
    <span className={cls} aria-hidden="true">
      <span className="cb-brand-mark__letter">Co</span>
      <span className="cb-brand-mark__dot" />
    </span>
  );
}

export function ComboWordmark({ className }: { className?: string }): ReactElement {
  const cls = className ? `cb-brand-wordmark ${className}` : 'cb-brand-wordmark';
  return (
    <span className={cls} aria-hidden="true">
      <span>Com</span>
      <span className="cb-brand-wordmark__accent">bo</span>
      <span className="cb-brand-wordmark__dot">.</span>
    </span>
  );
}

// 路由占位页（Phase 4 实现真实页面）。统一外观，附契约前缀提示便于联调对齐。
import type { ReactElement, ReactNode } from 'react';
import { API_PREFIX } from '@cb/shared';

export interface PlaceholderProps {
  title: string;
  /** 该页将对接的后端契约提示（人话），帮助 Phase 4 对齐。 */
  hint?: ReactNode;
}

export function Placeholder({ title, hint }: PlaceholderProps): ReactElement {
  return (
    <section className="cb-page cb-page--placeholder">
      <h2 className="cb-page__title">{title}</h2>
      <p className="cb-page__hint">页面骨架，Phase 4 实现。</p>
      {hint && <p className="cb-page__contract">{hint}</p>}
      <p className="cb-page__prefix">
        后端契约前缀：<code>{API_PREFIX}</code>
      </p>
    </section>
  );
}

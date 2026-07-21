import { useEffect, useId, useRef, useState, type ReactElement } from 'react';

const deployEnvironment = import.meta.env.VITE_DEPLOY_ENV?.trim().toLowerCase();
const buildSha = import.meta.env.VITE_BUILD_SHA?.trim() || 'unknown';
const reviewSource = import.meta.env.VITE_REVIEW_SOURCE?.trim() || 'manual';

interface CloudReviewBarProps {
  environment?: string;
  build?: string;
  source?: string;
  placement?: 'page' | 'topbar';
}

export function CloudReviewBar({
  environment = deployEnvironment,
  build = buildSha,
  source = reviewSource,
  placement = 'page',
}: CloudReviewBarProps = {}): ReactElement | null {
  const [expanded, setExpanded] = useState(false);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const rootRef = useRef<HTMLElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const resetTimerRef = useRef<number | null>(null);
  const panelId = useId();

  useEffect(() => {
    if (!expanded) return;

    function closeOnOutsidePointer(event: PointerEvent): void {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) {
        setExpanded(false);
      }
    }

    function closeOnEscape(event: KeyboardEvent): void {
      if (event.key !== 'Escape') return;
      setExpanded(false);
      triggerRef.current?.focus();
    }

    document.addEventListener('pointerdown', closeOnOutsidePointer);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [expanded]);

  useEffect(
    () => () => {
      if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
    },
    [],
  );

  if (environment !== 'preview') return null;

  const shortSha = build === 'unknown' ? '待标记' : build.slice(0, 8);
  const copyLabel =
    copyState === 'copied' ? '已复制' : copyState === 'failed' ? '复制失败' : '复制评审信息';

  async function copyReviewContext(): Promise<void> {
    const context = [
      `Combo Cloud Review`,
      `页面: ${window.location.href}`,
      `构建: ${build}`,
      `来源: ${source}`,
      `视口: ${window.innerWidth}x${window.innerHeight}`,
      `浏览器: ${navigator.userAgent}`,
    ].join('\n');

    try {
      await navigator.clipboard.writeText(context);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
    if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
    resetTimerRef.current = window.setTimeout(() => setCopyState('idle'), 1800);
  }

  return (
    <aside
      ref={rootRef}
      className={`cb-cloud-review cb-cloud-review--${placement}`}
      aria-label="预览环境"
    >
      <button
        ref={triggerRef}
        type="button"
        className="cb-cloud-review__trigger"
        aria-expanded={expanded}
        aria-controls={panelId}
        onClick={() => setExpanded((current) => !current)}
      >
        <span className="cb-cloud-review__mark" aria-hidden="true" />
        <span>预览环境</span>
        <svg
          className="cb-cloud-review__chevron"
          viewBox="0 0 12 12"
          aria-hidden="true"
          data-expanded={expanded ? 'true' : 'false'}
        >
          <path d="M3 4.5 6 7.5l3-3" />
        </svg>
      </button>

      {expanded && (
        <section
          id={panelId}
          className="cb-cloud-review__panel"
          role="region"
          aria-label="预览环境详情"
        >
          <div className="cb-cloud-review__panel-head">
            <strong>预览环境</strong>
            <span>版本 {shortSha}</span>
          </div>
          <p>这里的数据与正式环境隔离，当前操作不会影响线上内容。</p>
          <div className="cb-cloud-review__actions">
            <button type="button" onClick={() => void copyReviewContext()}>
              {copyLabel}
            </button>
            <a href="https://buildwithcombo.com" target="_blank" rel="noreferrer">
              打开正式环境 ↗
            </a>
          </div>
          <span className="cb-cloud-review__status" role="status" aria-live="polite">
            {copyState === 'copied'
              ? '评审信息已复制'
              : copyState === 'failed'
                ? '复制失败，请重试'
                : ''}
          </span>
        </section>
      )}
    </aside>
  );
}

export interface GeneratingPageSkeletonProps {
  showStatus?: boolean;
  onStop?: () => void;
  compact?: boolean;
}

/**
 * A neutral preview of the page that will replace it. It deliberately avoids
 * translating backend work into a made-up percentage or sequence of steps.
 */
export function GeneratingPageSkeleton({
  showStatus = true,
  onStop,
  compact = false,
}: GeneratingPageSkeletonProps) {
  return (
    <section
      className={`rt-page-skeleton${compact ? ' rt-page-skeleton--compact' : ''}`}
      aria-label="页面正在生成"
      aria-busy="true"
    >
      {showStatus && (
        <header className="rt-page-skeleton__status">
          <div role="status" aria-live="polite">
            <span className="rt-page-skeleton__pulse" aria-hidden="true" />
            <span>
              <strong>正在生成页面</strong>
              <small>完成后会自动显示</small>
            </span>
          </div>
          {onStop && (
            <button type="button" onClick={onStop}>
              停止
            </button>
          )}
        </header>
      )}

      <div className="rt-page-skeleton__document" aria-hidden="true">
        <div className="rt-page-skeleton__topbar">
          <span className="rt-page-skeleton__mark" />
          <span className="rt-page-skeleton__nav" />
          <span className="rt-page-skeleton__nav rt-page-skeleton__nav--short" />
          <span className="rt-page-skeleton__action" />
        </div>

        <div className="rt-page-skeleton__body">
          <div className="rt-page-skeleton__intro">
            <span className="rt-page-skeleton__eyebrow" />
            <span className="rt-page-skeleton__title" />
            <span className="rt-page-skeleton__subtitle" />
          </div>

          <div className="rt-page-skeleton__panel">
            <span className="rt-page-skeleton__label" />
            <span className="rt-page-skeleton__field" />
            <span className="rt-page-skeleton__field rt-page-skeleton__field--wide" />
            <span className="rt-page-skeleton__button" />
          </div>

          <div className="rt-page-skeleton__cards">
            <div>
              <span className="rt-page-skeleton__card-icon" />
              <span className="rt-page-skeleton__card-title" />
              <span className="rt-page-skeleton__card-copy" />
              <span className="rt-page-skeleton__card-copy rt-page-skeleton__card-copy--short" />
            </div>
            <div>
              <span className="rt-page-skeleton__card-icon" />
              <span className="rt-page-skeleton__card-title" />
              <span className="rt-page-skeleton__card-copy" />
              <span className="rt-page-skeleton__card-copy rt-page-skeleton__card-copy--short" />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

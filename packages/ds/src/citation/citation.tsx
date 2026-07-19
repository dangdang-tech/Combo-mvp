import './citation.css';

export interface CitationProps {
  /** 来源名称，例如文件名、会话标题或页面标题。 */
  label: string;
  /** 提供后 label 渲染为可点击的链接（虚线下划线，hover 变 accent）。 */
  href?: string;
  /** 被引用的原文片段，存在时渲染为下方带 line-3 左边框的引文块。 */
  quote?: string;
  /** 引用序号，渲染为 [n] 上标风格徽标（accent-soft 底 accent 字）。 */
  index?: number;
}

/**
 * 行内引用：等宽小字标注来源，可选 [n] 序号徽标、来源链接与原文引文块。
 * 全部视觉状态由纯 JSON props 表达，无任何必需回调。
 */
export function Citation({ label, href, quote, index }: CitationProps) {
  return (
    <span className="cb-citation">
      {index !== undefined ? <sup className="cb-citation-index">[{index}]</sup> : null}
      {href ? (
        <a className="cb-citation-link" href={href}>
          {label}
        </a>
      ) : (
        <span className="cb-citation-label">{label}</span>
      )}
      {quote ? <span className="cb-citation-quote">{quote}</span> : null}
    </span>
  );
}

import { useMemo } from 'react';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import './markdown.css';

export interface MarkdownProps {
  /** Markdown 原文字符串。渲染前先经 marked 同步转成 HTML，再经 DOMPurify 消毒。 */
  content: string;
}

/**
 * Markdown 渲染组件：把 Markdown 字符串渲染成受 .cb-markdown 样式约束的 HTML。
 * DOMPurify 只放行常规 HTML 标签（USE_PROFILES.html），svg 与 mathml 标签、
 * script 标签以及 onerror 之类的事件属性都会在消毒阶段被剥除。
 */
export function Markdown({ content }: MarkdownProps) {
  const html = useMemo(() => {
    const raw = marked.parse(content, { async: false, gfm: true });
    return DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } });
  }, [content]);

  return <div className="cb-markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}

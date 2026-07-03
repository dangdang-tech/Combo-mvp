// Markdown 渲染：marked 转 HTML + DOMPurify 消毒（防 XSS）。用于助手消息正文与 markdown 产物。
import DOMPurify from 'dompurify';
import { marked } from 'marked';

export function renderMarkdown(src: string): string {
  // marked.parse 的类型是 string | Promise<string>；默认同步，断言为 string。
  const raw = marked.parse(src, { gfm: true, breaks: true }) as string;
  return DOMPurify.sanitize(raw);
}

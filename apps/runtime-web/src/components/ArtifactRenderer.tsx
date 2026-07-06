// 按 kind 渲染产物内容。html 走【沙箱 iframe】（allow-scripts、无 same-origin，隔离父页）。
import { useMemo, type ReactElement } from 'react';
import { renderMarkdown } from '../lib/markdown.js';

/** kind 误标防御：LLM 产物可能把完整 HTML 文档标成 markdown/structured（实测出现过），
 *  按 markdown 渲染会输出转义汤。内容以 HTML 文档开头时无视 kind、走沙箱 iframe。 */
function looksLikeHtmlDocument(content: string): boolean {
  const head = content.trimStart().slice(0, 64).toLowerCase();
  return head.startsWith('<!doctype html') || head.startsWith('<html');
}

export function ArtifactRenderer({
  kind,
  title,
  content,
}: {
  kind: string;
  title: string;
  content: string;
}) {
  if (kind === 'html' || looksLikeHtmlDocument(content)) {
    return (
      <iframe
        className="rt-artifact__frame"
        title={title}
        sandbox="allow-scripts allow-popups allow-forms"
        srcDoc={content}
      />
    );
  }
  switch (kind) {
    case 'markdown':
      return <MarkdownView content={content} />;
    case 'code':
      return (
        <pre className="rt-artifact__code">
          <code>{content}</code>
        </pre>
      );
    case 'structured':
      return <StructuredView content={content} />;
    default:
      return <pre className="rt-artifact__raw">{content}</pre>;
  }
}

function MarkdownView({ content }: { content: string }) {
  const html = useMemo(() => renderMarkdown(content), [content]);
  return <div className="rt-md rt-artifact__md" dangerouslySetInnerHTML={{ __html: html }} />;
}

/** 结构化产物：渲染成可读的键值/列表卡（#28），不再把裸 JSON 墙塞给用户；原始 JSON 收进折叠。 */
function StructuredView({ content }: { content: string }) {
  const parsed = useMemo(() => {
    try {
      return JSON.parse(content) as unknown;
    } catch {
      return null;
    }
  }, [content]);
  const pretty = useMemo(
    () => (parsed === null ? content : JSON.stringify(parsed, null, 2)),
    [parsed, content],
  );
  if (parsed === null || typeof parsed !== 'object') {
    return (
      <pre className="rt-artifact__code rt-artifact__json">
        <code>{pretty}</code>
      </pre>
    );
  }
  return (
    <div className="rt-structured">
      <StructuredNode value={parsed} depth={0} />
      <details className="rt-structured__raw">
        <summary>查看原始 JSON</summary>
        <pre className="rt-artifact__code rt-artifact__json">
          <code>{pretty}</code>
        </pre>
      </details>
    </div>
  );
}

/** 机器 key 人话化：snake/camel → 空格分词（中文 key 原样保留）。 */
function humanizeKey(key: string): string {
  if (/[一-鿿]/.test(key)) return key;
  return key
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim();
}

function StructuredNode({ value, depth }: { value: unknown; depth: number }): ReactElement {
  if (value === null || value === undefined) return <span className="rt-structured__nil">—</span>;
  if (typeof value !== 'object') return <span>{String(value)}</span>;
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="rt-structured__nil">（空）</span>;
    return (
      <ul className="rt-structured__list">
        {value.map((item, i) => (
          <li key={i}>
            <StructuredNode value={item} depth={depth + 1} />
          </li>
        ))}
      </ul>
    );
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return <span className="rt-structured__nil">（空）</span>;
  // 深层对象降级为紧凑 JSON，避免无限嵌套表格；前两层用键值行。
  if (depth >= 2) {
    return <code className="rt-structured__inline">{JSON.stringify(value)}</code>;
  }
  return (
    <dl className="rt-structured__group">
      {entries.map(([k, v]) => (
        <div className="rt-structured__row" key={k}>
          <dt className="rt-structured__key">{humanizeKey(k)}</dt>
          <dd className="rt-structured__val">
            <StructuredNode value={v} depth={depth + 1} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

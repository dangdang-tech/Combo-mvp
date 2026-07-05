// 按 kind 渲染产物内容。html 走【沙箱 iframe】（allow-scripts、无 same-origin，隔离父页）。
import { useMemo } from 'react';
import { renderMarkdown } from '../lib/markdown.js';

export function ArtifactRenderer({
  kind,
  title,
  content,
}: {
  kind: string;
  title: string;
  content: string;
}) {
  switch (kind) {
    case 'html':
      return (
        <iframe
          className="rt-artifact__frame"
          title={title}
          sandbox="allow-scripts allow-popups allow-forms"
          srcDoc={content}
        />
      );
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

function StructuredView({ content }: { content: string }) {
  const pretty = useMemo(() => {
    try {
      return JSON.stringify(JSON.parse(content), null, 2);
    } catch {
      return content;
    }
  }, [content]);
  return (
    <pre className="rt-artifact__code rt-artifact__json">
      <code>{pretty}</code>
    </pre>
  );
}

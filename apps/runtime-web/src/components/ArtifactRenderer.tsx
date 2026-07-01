import { useMemo } from 'react';
import type { ArtifactVersion } from '@cb/shared';
import { renderMarkdown } from '../lib/markdown.js';

/** 按 kind 渲染一个 artifact 版本。html 走【沙箱 iframe】（allow-scripts、无 same-origin，隔离父页）。 */
export function ArtifactRenderer({ artifact }: { artifact: ArtifactVersion }) {
  switch (artifact.kind) {
    case 'html':
      return (
        <iframe
          className="rt-artifact__frame"
          title={artifact.title}
          sandbox="allow-scripts allow-popups allow-forms"
          srcDoc={artifact.content}
        />
      );
    case 'markdown':
      return <MarkdownView content={artifact.content} />;
    case 'code':
      return <CodeView content={artifact.content} language={artifact.language} />;
    case 'structured':
      return <StructuredView content={artifact.content} />;
    default:
      return <pre className="rt-artifact__raw">{artifact.content}</pre>;
  }
}

function MarkdownView({ content }: { content: string }) {
  const html = useMemo(() => renderMarkdown(content), [content]);
  return <div className="rt-md rt-artifact__md" dangerouslySetInnerHTML={{ __html: html }} />;
}

function CodeView({ content, language }: { content: string; language: string | null }) {
  return (
    <pre className="rt-artifact__code">
      {language && <span className="rt-artifact__code-lang">{language}</span>}
      <code>{content}</code>
    </pre>
  );
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

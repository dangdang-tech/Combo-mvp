import { useEffect, useMemo, useRef } from 'react';
import type { ArtifactRef, RuntimeMessage } from '@cb/shared';
import { renderMarkdown } from '../lib/markdown.js';

const KIND_GLYPH: Record<string, string> = {
  html: '🌐',
  markdown: '📄',
  code: '‹›',
  structured: '▦',
};

export interface ChatThreadProps {
  messages: RuntimeMessage[];
  /** 流式中的助手正文（未落库前的实时显示）。 */
  streamingText: string | null;
  onOpenArtifact: (ref: ArtifactRef) => void;
  assistantLabel?: string;
}

export function ChatThread({
  messages,
  streamingText,
  onOpenArtifact,
  assistantLabel = '能力',
}: ChatThreadProps) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, streamingText]);

  return (
    <div className="rt-thread">
      {messages.map((m) => (
        <MessageBubble
          key={m.id}
          message={m}
          assistantLabel={assistantLabel}
          onOpenArtifact={onOpenArtifact}
        />
      ))}
      {streamingText !== null && (
        <div className="rt-msg rt-msg--assistant">
          <div className="rt-msg__role">{assistantLabel}</div>
          <AssistantBody text={streamingText} streaming />
        </div>
      )}
      <div ref={endRef} />
    </div>
  );
}

function MessageBubble({
  message,
  assistantLabel,
  onOpenArtifact,
}: {
  message: RuntimeMessage;
  assistantLabel: string;
  onOpenArtifact: (ref: ArtifactRef) => void;
}) {
  if (message.role === 'user') {
    return (
      <div className="rt-msg rt-msg--user">
        <div className="rt-msg__bubble">{message.text}</div>
      </div>
    );
  }
  return (
    <div className="rt-msg rt-msg--assistant">
      <div className="rt-msg__role">{assistantLabel}</div>
      <AssistantBody text={message.text} />
      {message.artifacts.length > 0 && (
        <div className="rt-msg__artifacts">
          {message.artifacts.map((a) => (
            <button
              key={`${a.artifactKey}-${a.version}`}
              type="button"
              className="rt-artifact-chip"
              onClick={() => onOpenArtifact(a)}
            >
              <span className="rt-artifact-chip__glyph">{KIND_GLYPH[a.kind] ?? '📄'}</span>
              <span className="rt-artifact-chip__title">{a.title}</span>
              <span className="rt-artifact-chip__ver">v{a.version}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function AssistantBody({ text, streaming }: { text: string; streaming?: boolean }) {
  const html = useMemo(() => (text ? renderMarkdown(text) : ''), [text]);
  return (
    <div className="rt-msg__body rt-md">
      {text ? (
        <div dangerouslySetInnerHTML={{ __html: html }} />
      ) : streaming ? (
        <span className="rt-typing">
          <span></span>
          <span></span>
          <span></span>
        </span>
      ) : null}
      {streaming && text && <span className="rt-caret" />}
    </div>
  );
}

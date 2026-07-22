import { useEffect, useMemo, useRef, useState } from 'react';
import type { ArtifactRef, RuntimeMessage } from '@cb/shared';
import { renderMarkdown } from '../lib/markdown.js';

const KIND_GLYPH: Record<string, string> = {
  html: '🌐',
  markdown: '📄',
  code: '‹›',
  structured: '▦',
};

const ARTIFACT_DETAIL_COLLAPSE_LENGTH = 96;

export type ArtifactPresentation = 'default' | 'event';

type ActiveArtifactRef = Pick<ArtifactRef, 'artifactKey' | 'version'>;

export interface ChatThreadProps {
  messages: RuntimeMessage[];
  /** 流式中的助手正文（未落库前的实时显示）。 */
  streamingText: string | null;
  onOpenArtifact: (ref: ArtifactRef) => void;
  assistantLabel?: string;
  /**
   * Studio 中将 artifact 作为轻量创建/更新事件展示；普通运行聊天沿用原卡片与正文。
   */
  artifactPresentation?: ArtifactPresentation;
  /** Studio 当前已经展示的页面；对应事件只做状态提示，不再提供无效果的“查看”。 */
  activeArtifact?: ActiveArtifactRef;
  /** Studio 有自己的滚动容器，不应在用户阅读历史时强制抢回底部。 */
  autoScroll?: boolean;
}

export function ChatThread({
  messages,
  streamingText,
  onOpenArtifact,
  assistantLabel = '能力',
  artifactPresentation = 'default',
  activeArtifact,
  autoScroll = true,
}: ChatThreadProps) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!autoScroll) return;
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [autoScroll, messages, streamingText]);

  return (
    <div className="rt-thread">
      {messages.map((m) => (
        <MessageBubble
          key={m.id}
          message={m}
          assistantLabel={assistantLabel}
          onOpenArtifact={onOpenArtifact}
          artifactPresentation={artifactPresentation}
          activeArtifact={activeArtifact}
        />
      ))}
      {streamingText !== null && (
        <div className="rt-msg rt-msg--assistant">
          <div className={artifactPresentation === 'event' ? 'rt-sr-only' : 'rt-msg__role'}>
            {assistantLabel}
          </div>
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
  artifactPresentation,
  activeArtifact,
}: {
  message: RuntimeMessage;
  assistantLabel: string;
  onOpenArtifact: (ref: ArtifactRef) => void;
  artifactPresentation: ArtifactPresentation;
  activeArtifact?: ActiveArtifactRef;
}) {
  const useArtifactEvents = artifactPresentation === 'event' && message.artifacts.length > 0;
  const studioResponse = useArtifactEvents ? splitStudioArtifactMessage(message.text) : null;
  const [detailsExpanded, setDetailsExpanded] = useState(false);

  if (message.role === 'user') {
    return (
      <div className="rt-msg rt-msg--user">
        <div className="rt-msg__bubble">{message.text}</div>
      </div>
    );
  }

  return (
    <div className="rt-msg rt-msg--assistant">
      <div className={artifactPresentation === 'event' ? 'rt-sr-only' : 'rt-msg__role'}>
        {assistantLabel}
      </div>
      {studioResponse ? (
        <>
          <AssistantBody text={studioResponse.summary} />
          {studioResponse.details && (
            <div className="rt-msg__artifact-detail">
              <button
                type="button"
                className="rt-msg__artifact-detail-toggle"
                aria-expanded={detailsExpanded}
                onClick={() => setDetailsExpanded((current) => !current)}
              >
                <span aria-hidden="true">{detailsExpanded ? '⌄' : '›'}</span>
                {detailsExpanded ? '收起修改细节' : '展开修改细节'}
              </button>
              {detailsExpanded && <AssistantBody text={studioResponse.details} />}
            </div>
          )}
        </>
      ) : (
        <AssistantBody text={message.text} />
      )}
      {useArtifactEvents && (
        <ArtifactReferences
          artifacts={message.artifacts}
          presentation="event"
          onOpenArtifact={onOpenArtifact}
          activeArtifact={activeArtifact}
        />
      )}
      {message.artifacts.length > 0 && !useArtifactEvents && (
        <ArtifactReferences
          artifacts={message.artifacts}
          presentation="default"
          onOpenArtifact={onOpenArtifact}
          activeArtifact={activeArtifact}
        />
      )}
    </div>
  );
}

function ArtifactReferences({
  artifacts,
  presentation,
  onOpenArtifact,
  activeArtifact,
}: {
  artifacts: ArtifactRef[];
  presentation: ArtifactPresentation;
  onOpenArtifact: (ref: ArtifactRef) => void;
  activeArtifact?: ActiveArtifactRef;
}) {
  return (
    <div className="rt-msg__artifacts">
      {artifacts.map((artifact) => {
        const eventLabel = artifact.version <= 1 ? '已创建页面' : '已更新页面';
        const isActiveEvent =
          presentation === 'event' &&
          activeArtifact?.artifactKey === artifact.artifactKey &&
          activeArtifact.version === artifact.version;
        const content = (
          <>
            {presentation === 'event' ? (
              <span className="rt-artifact-chip__event">{eventLabel}</span>
            ) : (
              <span className="rt-artifact-chip__glyph">{KIND_GLYPH[artifact.kind] ?? '📄'}</span>
            )}
            <span className="rt-artifact-chip__title">{artifact.title}</span>
            <span className="rt-artifact-chip__ver">
              {presentation === 'event'
                ? isActiveEvent
                  ? '当前'
                  : '打开'
                : `v${artifact.version}`}
            </span>
          </>
        );

        if (isActiveEvent) {
          return (
            <div
              key={`${artifact.artifactKey}-${artifact.version}`}
              className="rt-artifact-chip rt-artifact-chip--event"
              aria-label={`${eventLabel} ${artifact.title} 当前页面`}
            >
              {content}
            </div>
          );
        }
        return (
          <button
            key={`${artifact.artifactKey}-${artifact.version}`}
            type="button"
            className={`rt-artifact-chip${presentation === 'event' ? ' rt-artifact-chip--event' : ''}`}
            onClick={() => onOpenArtifact(artifact)}
          >
            {content}
          </button>
        );
      })}
    </div>
  );
}

function splitStudioArtifactMessage(text: string): { summary: string; details: string | null } {
  const normalized = text.trim();
  if (!normalized) return { summary: '', details: null };

  const paragraphs = normalized.split(/\r?\n\s*\r?\n+/).filter((part) => part.trim());
  if (paragraphs.length > 1) {
    return {
      summary: paragraphs[0]!,
      details: paragraphs.slice(1).join('\n\n'),
    };
  }

  if (normalized.length <= ARTIFACT_DETAIL_COLLAPSE_LENGTH) {
    return { summary: normalized, details: null };
  }

  const sentence = normalized.match(/^([\s\S]{80,220}?[。！？.!?])\s*([\s\S]+)$/);
  if (sentence?.[1] && sentence[2]) {
    return { summary: sentence[1], details: sentence[2] };
  }

  const summary = `${normalized.slice(0, 180).trimEnd()}…`;
  return { summary, details: normalized };
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

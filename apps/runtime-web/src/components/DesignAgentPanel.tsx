import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { ArtifactRef, RuntimeMessage, StudioRevision } from '@cb/shared';
import type { ComboElementSelection } from './ArtifactRenderer.js';
import { ChatThread } from './ChatThread.js';

const ROLE_LABELS: Record<string, string> = {
  button: '操作按钮',
  heading: '标题',
  input: '输入区域',
  link: '链接',
  region: '内容区块',
  form: '表单',
};

const RECENT_MESSAGE_LIMIT = 4;

interface QueuedEdit {
  text: string;
  label: string;
  element: ComboElementSelection | null;
}

export interface DesignAgentPanelProps {
  messages: RuntimeMessage[];
  revisions: StudioRevision[];
  selectedRevisionNo?: number;
  isRunning: boolean;
  isBootstrapping: boolean;
  readOnlyHistory: boolean;
  annotationAvailable: boolean;
  annotationEnabled: boolean;
  selectedElement: ComboElementSelection | null;
  error: string | null;
  onSend: (text: string, element?: ComboElementSelection) => boolean;
  onInterrupt: () => void;
  onSelectRevision: (revisionNo: number) => void;
  onOpenArtifact: (ref: ArtifactRef) => void;
  onToggleAnnotation: () => void;
  onClearAnnotation: () => void;
}

function clipped(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}

function elementRole(element: ComboElementSelection): string {
  return (element.role && ROLE_LABELS[element.role]) || element.tagName.toUpperCase();
}

export function DesignAgentPanel({
  messages,
  revisions,
  selectedRevisionNo,
  isRunning,
  isBootstrapping,
  readOnlyHistory,
  annotationAvailable,
  annotationEnabled,
  selectedElement,
  error,
  onSend,
  onInterrupt,
  onOpenArtifact,
  onToggleAnnotation,
  onClearAnnotation,
}: DesignAgentPanelProps) {
  const [text, setText] = useState('');
  const [showEarlierMessages, setShowEarlierMessages] = useState(false);
  const [queued, setQueued] = useState<QueuedEdit[]>([]);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const hiddenMessageCount = Math.max(0, messages.length - RECENT_MESSAGE_LIMIT);
  const visibleMessages =
    hiddenMessageCount > 0 && !showEarlierMessages
      ? messages.slice(-RECENT_MESSAGE_LIMIT)
      : messages;
  const selectedRevision = revisions.find((item) => item.revisionNo === selectedRevisionNo);
  const wasRunningRef = useRef(false);
  const bootstrapFailed = revisions.length === 0 && !isBootstrapping && Boolean(error);

  useEffect(() => {
    if (isRunning || isBootstrapping) {
      wasRunningRef.current = true;
      return;
    }
    if (error) {
      wasRunningRef.current = false;
      return;
    }
    if (!wasRunningRef.current || queued.length === 0 || readOnlyHistory) return;
    wasRunningRef.current = false;
    const [next, ...rest] = queued;
    if (!next) return;
    const accepted = next.element ? onSend(next.text, next.element) : onSend(next.text);
    if (accepted) setQueued(rest);
  }, [error, isBootstrapping, isRunning, onSend, queued, readOnlyHistory]);

  useEffect(() => {
    if (!selectedElement) return;
    window.requestAnimationFrame(() => inputRef.current?.focus());
  }, [selectedElement?.key]);

  const submit = (): void => {
    const trimmed = text.trim();
    if (!trimmed || readOnlyHistory) return;
    const element = selectedElement ? { ...selectedElement } : null;
    const accepted = isRunning || isBootstrapping;
    if (accepted) {
      setQueued((current) => [
        ...current,
        {
          text: trimmed,
          label: element ? `标注「${clipped(element.label, 40)}」：${trimmed}` : trimmed,
          element,
        },
      ]);
    } else {
      const sent = element ? onSend(trimmed, element) : onSend(trimmed);
      if (!sent) return;
    }
    setText('');
    if (element) onClearAnnotation();
  };

  const handleInputKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.nativeEvent.isComposing || event.key !== 'Enter' || event.shiftKey || event.altKey) {
      return;
    }
    event.preventDefault();
    submit();
  };

  return (
    <aside className="rt-design-agent" aria-label="页面修改">
      <div className="rt-design-agent__thread" role="log" aria-label="页面修改记录">
        {hiddenMessageCount > 0 && (
          <button
            type="button"
            className="rt-design-agent__earlier"
            aria-expanded={showEarlierMessages}
            onClick={() => setShowEarlierMessages((current) => !current)}
          >
            {showEarlierMessages ? '收起较早对话' : `查看更早的 ${hiddenMessageCount} 条对话`}
          </button>
        )}
        {messages.length > 0 && (
          <ChatThread
            messages={visibleMessages}
            streamingText={null}
            assistantLabel="Combo"
            artifactPresentation="event"
            activeArtifact={
              selectedRevision
                ? {
                    artifactKey: selectedRevision.artifactKey,
                    version: selectedRevision.artifactVersion,
                  }
                : undefined
            }
            onOpenArtifact={onOpenArtifact}
          />
        )}
        {messages.length === 0 && !isBootstrapping && !bootstrapFailed && (
          <div className="rt-design-agent__empty">描述修改，或从页面中选择一个位置。</div>
        )}
      </div>

      <div className="rt-design-agent__footer">
        {!readOnlyHistory && (isRunning || isBootstrapping) ? (
          <div className="rt-design-agent__running">
            <span aria-hidden="true" />
            <div role="status" aria-live="polite">
              <strong>{isBootstrapping ? '正在生成页面' : '正在应用修改'}</strong>
              <small>可以继续输入下一条修改。</small>
            </div>
            {(isRunning || isBootstrapping) && (
              <button type="button" onClick={onInterrupt}>
                停止
              </button>
            )}
          </div>
        ) : null}

        {queued.length > 0 && (
          <div className="rt-design-agent__queue" aria-live="polite">
            <strong>接下来</strong>
            {queued.map((item, index) => (
              <span key={`${item.label}-${index}`}>{item.label}</span>
            ))}
          </div>
        )}

        {error && (
          <div className="rt-design-agent__error" role="alert">
            <span>{error}</span>
            {bootstrapFailed && (
              <button
                type="button"
                onClick={() =>
                  onSend('请重新生成首版页面，保持 Agent 输入、核心任务和结果区域完整。')
                }
              >
                重试
              </button>
            )}
          </div>
        )}

        <div className="rt-design-agent__composer" role="group" aria-label="页面修改输入">
          {selectedElement && (
            <section className="rt-design-agent__attachment" aria-label="当前页面标注">
              <span aria-hidden="true">⌖</span>
              <div>
                <small>{elementRole(selectedElement)}</small>
                <strong>{clipped(selectedElement.label, 74)}</strong>
              </div>
              <button type="button" onClick={onClearAnnotation} aria-label="移除页面标注">
                ×
              </button>
            </section>
          )}
          {annotationEnabled && !selectedElement && (
            <div className="rt-design-agent__selection-guide" role="status">
              <span>点击右侧页面，选择要修改的位置</span>
              <button type="button" onClick={onToggleAnnotation}>
                取消
              </button>
            </div>
          )}
          <textarea
            ref={inputRef}
            value={text}
            disabled={readOnlyHistory}
            rows={3}
            placeholder={
              readOnlyHistory
                ? '返回当前版本后继续修改'
                : selectedElement
                  ? '告诉我这里要怎么改…'
                  : '描述下一步修改，例如：让输入区更紧凑，把结果作为页面重点…'
            }
            aria-label="描述页面修改"
            onChange={(event) => setText(event.target.value)}
            onKeyDown={handleInputKeyDown}
          />
          <div className="rt-design-agent__composer-actions">
            <div className="rt-design-agent__composer-tools">
              <button
                type="button"
                className="rt-design-agent__annotation-control"
                aria-label={annotationEnabled ? '取消标注页面' : '标注页面'}
                aria-pressed={annotationEnabled}
                title={
                  annotationAvailable
                    ? annotationEnabled
                      ? '取消选择'
                      : '选择页面元素'
                    : '页面准备好后即可选择'
                }
                disabled={(!annotationAvailable && !annotationEnabled) || readOnlyHistory}
                onClick={onToggleAnnotation}
              >
                <span aria-hidden="true">⌖</span>
                选择
              </button>
              <small>{isRunning || isBootstrapping ? '将排在当前修改之后' : 'Enter 发送'}</small>
            </div>
            <button
              type="button"
              className="rt-design-agent__send"
              aria-label={isRunning || isBootstrapping ? '加入修改队列' : '发送修改'}
              disabled={readOnlyHistory || !text.trim()}
              onClick={submit}
            >
              <span aria-hidden="true">↑</span>
            </button>
          </div>
        </div>
      </div>
    </aside>
  );
}

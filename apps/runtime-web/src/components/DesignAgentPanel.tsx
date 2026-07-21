import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { ArtifactRef, RuntimeMessage, StudioRevision } from '@cb/shared';
import type { ComboElementSelection } from './ArtifactRenderer.js';
import { ChatThread } from './ChatThread.js';
import { ComboWordmark } from './ComboBrand.js';

const QUICK_EDITS = [
  '让主任务和主按钮更突出',
  '统一色彩、间距和圆角',
  '优化手机端布局和交互',
  '让结果区更清楚、更容易行动',
] as const;

const ANNOTATION_EDITS = [
  ['突出重点', '提升这里的视觉层级与行动指向，但不要改变功能。'],
  ['收紧间距', '收紧这里的间距和信息密度，让内容更利落、更容易扫读。'],
  ['精简文案', '精简这里的标题和说明，保留原意并让用户更快理解下一步。'],
  ['优化手机端', '只优化这里在手机尺寸下的布局、触控尺寸和阅读顺序。'],
] as const;

const ROLE_LABELS: Record<string, string> = {
  button: '操作按钮',
  heading: '标题',
  input: '输入区域',
  link: '链接',
  region: '内容区块',
  form: '表单',
};

interface QueuedEdit {
  text: string;
  label: string;
  element: ComboElementSelection | null;
}

export interface DesignAgentPanelProps {
  title: string;
  versionLabel: string;
  messages: RuntimeMessage[];
  revisions: StudioRevision[];
  selectedRevisionNo?: number;
  isRunning: boolean;
  isBootstrapping: boolean;
  readOnlyHistory: boolean;
  historyVersion?: number;
  latestVersion?: number;
  revisionNo?: number;
  verified: boolean;
  isTestRunning: boolean;
  reusableTestPrompt: string;
  annotationAvailable: boolean;
  annotationEnabled: boolean;
  selectedElement: ComboElementSelection | null;
  error: string | null;
  onBack: () => void;
  onSend: (text: string, element?: ComboElementSelection) => boolean;
  onInterrupt: () => void;
  onReturnLatest: () => void;
  onSelectRevision: (revisionNo: number) => void;
  onOpenArtifact: (ref: ArtifactRef) => void;
  onToggleAnnotation: () => void;
  onClearAnnotation: () => void;
  onOpenTest: () => void;
  onRerunTest: () => boolean;
}

function revisionTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function clipped(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}

function elementRole(element: ComboElementSelection): string {
  return (element.role && ROLE_LABELS[element.role]) || element.tagName.toUpperCase();
}

export function DesignAgentPanel({
  title,
  versionLabel,
  messages,
  revisions,
  selectedRevisionNo,
  isRunning,
  isBootstrapping,
  readOnlyHistory,
  historyVersion,
  latestVersion,
  revisionNo,
  verified,
  isTestRunning,
  reusableTestPrompt,
  annotationAvailable,
  annotationEnabled,
  selectedElement,
  error,
  onBack,
  onSend,
  onInterrupt,
  onReturnLatest,
  onSelectRevision,
  onOpenArtifact,
  onToggleAnnotation,
  onClearAnnotation,
  onOpenTest,
  onRerunTest,
}: DesignAgentPanelProps) {
  const [text, setText] = useState('');
  const [view, setView] = useState<'conversation' | 'versions'>('conversation');
  const [queued, setQueued] = useState<QueuedEdit[]>([]);
  const inputRef = useRef<HTMLTextAreaElement>(null);
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
    setView('conversation');
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

  const useQuickEdit = (prompt: string): void => {
    setText(prompt);
    window.requestAnimationFrame(() => inputRef.current?.focus());
  };

  const verificationAction = (): void => {
    if (reusableTestPrompt) {
      onRerunTest();
      return;
    }
    onOpenTest();
  };

  return (
    <aside className="rt-design-agent" aria-label="Design Agent 编辑面板">
      <header className="rt-design-agent__chrome">
        <a href="/creator" className="rt-design-agent__brand" aria-label="Combo 创作者中心 首页">
          <ComboWordmark className="rt-design-agent__brand-word" />
        </a>
        <button
          type="button"
          className="rt-design-agent__back"
          onClick={onBack}
          aria-label="返回能力结果"
        >
          <span aria-hidden="true">←</span>
          返回
        </button>
      </header>

      <div className="rt-design-agent__intro">
        <div className="rt-design-agent__eyebrow">DESIGN AGENT</div>
        <h2>{title}</h2>
        <p>持续描述你想改的地方；每次成功修改都会自动保存为新的 UI Revision。</p>
        <div className="rt-design-agent__meta">
          <span>
            {isBootstrapping
              ? '正在准备首版 Miniapp'
              : bootstrapFailed
                ? '首版生成失败，可以直接重试'
                : revisions.length > 0
                  ? '首版已生成，可反复修改'
                  : '正在读取 Studio 状态'}
          </span>
          <span>{versionLabel}</span>
        </div>
      </div>

      <div className="rt-design-agent__tabs" role="tablist" aria-label="Design Agent 面板">
        <button
          type="button"
          role="tab"
          aria-selected={view === 'conversation'}
          onClick={() => setView('conversation')}
        >
          对话修改
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === 'versions'}
          onClick={() => setView('versions')}
        >
          版本历史
          {revisions.length > 0 && <span>{revisions.length}</span>}
        </button>
      </div>

      {view === 'versions' ? (
        <div className="rt-design-agent__versions" role="tabpanel">
          <div className="rt-version-list__head">
            <strong>所有 Revision</strong>
            <span>预览历史不会覆盖后续版本</span>
          </div>
          {revisions.length === 0 ? (
            <div className="rt-version-list__empty">首版完成后，版本会自动出现在这里。</div>
          ) : (
            <ol className="rt-version-list">
              {[...revisions].reverse().map((revision) => {
                const selected = selectedRevisionNo === revision.revisionNo;
                const current = revision.revisionNo === revisions.at(-1)?.revisionNo;
                return (
                  <li key={revision.id}>
                    <button
                      type="button"
                      className={selected ? 'is-selected' : ''}
                      onClick={() => onSelectRevision(revision.revisionNo)}
                    >
                      <span className="rt-version-list__line" aria-hidden="true" />
                      <span className="rt-version-list__body">
                        <span className="rt-version-list__title">
                          <strong>UI R{revision.revisionNo}</strong>
                          {current && <em>当前</em>}
                          {revision.verified && <em className="is-verified">已试用</em>}
                        </span>
                        <span className="rt-version-list__summary">
                          {revision.summary || '页面修改已保存'}
                        </span>
                        <time>{revisionTime(revision.createdAt)}</time>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      ) : (
        <div className="rt-design-agent__thread" role="tabpanel">
          <div className="rt-design-agent__welcome">
            <span aria-hidden="true">✦</span>
            <div>
              <strong>
                {isBootstrapping
                  ? '正在把这个 Agent 包装成首版 Miniapp'
                  : bootstrapFailed
                    ? '首版还没有生成出来'
                    : '首版 Miniapp 已准备好'}
              </strong>
              <p>
                {isBootstrapping
                  ? '你可以现在就描述下一步修改，我会排在首版之后继续执行。'
                  : bootstrapFailed
                    ? '上一版要求没有成功，你可以重试首版，或者直接换一种描述。'
                    : '直接体验右侧页面；可以用文字描述修改，也可以标注页面中的具体位置。'}
              </p>
              {bootstrapFailed && (
                <button
                  type="button"
                  className="rt-design-agent__retry"
                  onClick={() =>
                    onSend('请重新生成首版 Miniapp，保持能力输入、核心任务和结果区域完整。')
                  }
                >
                  重试生成首版
                </button>
              )}
            </div>
          </div>
          {messages.length > 0 && (
            <ChatThread
              messages={messages}
              streamingText={null}
              assistantLabel="Design Agent"
              onOpenArtifact={onOpenArtifact}
            />
          )}
        </div>
      )}

      <div className="rt-design-agent__footer">
        {readOnlyHistory ? (
          <div className="rt-design-agent__history-notice">
            <div>
              <strong>正在预览历史 UI R{historyVersion}</strong>
              <small>返回 UI R{latestVersion} 后继续修改。</small>
            </div>
            <button type="button" onClick={onReturnLatest}>
              返回当前版
            </button>
          </div>
        ) : isRunning || isBootstrapping ? (
          <div className="rt-design-agent__running">
            <span aria-hidden="true" />
            <div>
              <strong>{isBootstrapping ? '正在生成 UI R1' : '正在生成下一个 Revision'}</strong>
              <small>上一成功版本会保持可用；新的要求可以继续排队。</small>
            </div>
            {isRunning && (
              <button type="button" onClick={onInterrupt}>
                停止
              </button>
            )}
          </div>
        ) : !selectedElement && !annotationEnabled ? (
          <div className="rt-design-agent__quick-edits" role="group" aria-label="修改建议">
            {QUICK_EDITS.map((prompt) => (
              <button key={prompt} type="button" onClick={() => useQuickEdit(prompt)}>
                {prompt}
              </button>
            ))}
          </div>
        ) : null}

        {revisionNo && (
          <div
            className="rt-design-agent__revision-status"
            data-status={isTestRunning ? 'running' : verified ? 'verified' : 'saved'}
          >
            <span aria-hidden="true" />
            <div>
              <strong>
                {isTestRunning
                  ? `UI R${revisionNo} 正在执行真实任务`
                  : verified
                    ? `UI R${revisionNo} 已通过真实任务`
                    : `UI R${revisionNo} 修改已保存`}
              </strong>
              <small>
                {verified
                  ? '可以继续修改；新 Revision 会保留复测路径。'
                  : reusableTestPrompt
                    ? '可用上一次真实任务复测当前版本。'
                    : '运行一次真实任务，确认 Miniapp 可以正常工作。'}
              </small>
            </div>
            <button
              type="button"
              disabled={readOnlyHistory || isRunning || isBootstrapping || isTestRunning}
              onClick={verificationAction}
            >
              {isTestRunning
                ? '验证中…'
                : reusableTestPrompt
                  ? verified
                    ? '再测一次'
                    : '用上次任务复测'
                  : '运行真实任务'}
            </button>
          </div>
        )}

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
            {error}
          </div>
        )}

        {selectedElement ? (
          <section className="rt-design-agent__annotation" aria-label="当前页面标注">
            <header>
              <span aria-hidden="true">⌖</span>
              <div>
                <small>已标注 · {elementRole(selectedElement)}</small>
                <strong>{clipped(selectedElement.label, 74)}</strong>
              </div>
              <button type="button" onClick={onClearAnnotation} aria-label="移除页面标注">
                ×
              </button>
            </header>
            {selectedElement.text && selectedElement.text !== selectedElement.label && (
              <p>{clipped(selectedElement.text, 140)}</p>
            )}
            <div className="rt-design-agent__annotation-actions" aria-label="标注修改建议">
              {ANNOTATION_EDITS.map(([label, instruction]) => (
                <button
                  key={label}
                  type="button"
                  disabled={readOnlyHistory}
                  onClick={() => useQuickEdit(instruction)}
                >
                  {label}
                </button>
              ))}
            </div>
          </section>
        ) : annotationEnabled ? (
          <div className="rt-design-agent__annotation-guide" role="status">
            <span aria-hidden="true">⌖</span>
            <div>
              <strong>点击右侧页面中要修改的位置</strong>
              <small>选择后会回到这里，把它作为下一条修改的上下文。</small>
            </div>
            <button type="button" onClick={onToggleAnnotation}>
              取消
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="rt-design-agent__annotation-trigger"
            disabled={!annotationAvailable || readOnlyHistory}
            onClick={onToggleAnnotation}
          >
            <span aria-hidden="true">⌖</span>
            <span>
              <strong>标注页面</strong>
              <small>
                {annotationAvailable ? '点选页面内容，只修改这一处' : '页面准备好后即可标注'}
              </small>
            </span>
            <span aria-hidden="true">→</span>
          </button>
        )}

        <div className="rt-design-agent__composer">
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
            <small>{isRunning || isBootstrapping ? '会排在当前修改之后' : 'Enter 发送'}</small>
            <button
              type="button"
              className="rt-design-agent__send"
              disabled={readOnlyHistory || !text.trim()}
              onClick={submit}
            >
              {isRunning || isBootstrapping
                ? '加入队列 ↑'
                : selectedElement
                  ? '修改这里 ↑'
                  : '应用修改 ↑'}
            </button>
          </div>
        </div>
      </div>
    </aside>
  );
}

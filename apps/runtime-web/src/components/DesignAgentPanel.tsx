import { useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import type { ArtifactRef, RuntimeMessage } from '@cb/shared';
import { ChatThread } from './ChatThread.js';
import { ComboWordmark } from './ComboBrand.js';

const QUICK_EDITS = [
  '调整视觉层级，让主操作更突出',
  '统一页面的色彩、间距和圆角',
  '优化手机端布局和交互',
  '把当前结果包装成完整的可交互页面',
] as const;

export interface DesignAgentPanelProps {
  title: string;
  versionLabel: string;
  started: boolean;
  messages: RuntimeMessage[];
  isRunning: boolean;
  readOnlyHistory: boolean;
  historyVersion?: number;
  latestVersion?: number;
  error: string | null;
  intake: ReactNode;
  onBack: () => void;
  onSend: (text: string) => void;
  onInterrupt: () => void;
  onReturnLatest: () => void;
  onOpenArtifact: (ref: ArtifactRef) => void;
}

export function DesignAgentPanel({
  title,
  versionLabel,
  started,
  messages,
  isRunning,
  readOnlyHistory,
  historyVersion,
  latestVersion,
  error,
  intake,
  onBack,
  onSend,
  onInterrupt,
  onReturnLatest,
  onOpenArtifact,
}: DesignAgentPanelProps) {
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const submit = (): void => {
    const trimmed = text.trim();
    if (!trimmed || isRunning || readOnlyHistory) return;
    onSend(trimmed);
    setText('');
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
        <h2>用对话修改 Miniapp</h2>
        <p>描述你想改的地方，新版本会直接更新到右侧画布。</p>
        <div className="rt-design-agent__meta">
          <span title={title}>{title}</span>
          <span>{versionLabel}</span>
        </div>
      </div>

      {!started ? (
        <div className="rt-design-agent__intake">{intake}</div>
      ) : (
        <>
          <div className="rt-design-agent__thread">
            <ChatThread
              messages={messages}
              streamingText={null}
              assistantLabel="Design Agent"
              onOpenArtifact={onOpenArtifact}
            />
          </div>

          <div className="rt-design-agent__footer">
            {readOnlyHistory ? (
              <div className="rt-design-agent__history-notice">
                <div>
                  <strong>正在查看历史 v{historyVersion}</strong>
                  <small>历史页面只读，修改会始终基于最新 v{latestVersion}。</small>
                </div>
                <button type="button" onClick={onReturnLatest}>
                  返回最新版
                </button>
              </div>
            ) : isRunning ? (
              <div className="rt-design-agent__running">
                <span aria-hidden="true" />
                <div>
                  <strong>正在修改右侧页面</strong>
                  <small>上一个成功版本会保持可用。</small>
                </div>
                <button type="button" onClick={onInterrupt}>
                  停止
                </button>
              </div>
            ) : (
              <div className="rt-design-agent__quick-edits" role="group" aria-label="修改建议">
                {QUICK_EDITS.map((prompt) => (
                  <button key={prompt} type="button" onClick={() => useQuickEdit(prompt)}>
                    {prompt}
                  </button>
                ))}
              </div>
            )}

            {error && (
              <div className="rt-design-agent__error" role="alert">
                {error}
              </div>
            )}

            <div className="rt-design-agent__composer">
              <textarea
                ref={inputRef}
                value={text}
                disabled={isRunning || readOnlyHistory}
                rows={3}
                placeholder={
                  readOnlyHistory
                    ? '返回最新版后可继续修改'
                    : '例如：把主按钮改成暖橙色，并减少卡片间距…'
                }
                aria-label="描述页面修改"
                onChange={(event) => setText(event.target.value)}
                onKeyDown={handleInputKeyDown}
              />
              <div className="rt-design-agent__composer-actions">
                <small>Enter 发送 · Shift+Enter 换行</small>
                <button
                  type="button"
                  className="rt-design-agent__send"
                  disabled={isRunning || readOnlyHistory || !text.trim()}
                  onClick={submit}
                >
                  应用修改 ↑
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </aside>
  );
}

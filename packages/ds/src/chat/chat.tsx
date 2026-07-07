import { type KeyboardEvent, type ReactNode, useCallback, useLayoutEffect, useRef } from 'react';
import { Button } from '../button/button';
import './chat.css';

export interface ThreadProps {
  /** 会话内容，通常是若干 Message，末尾可以跟一个 Composer。 */
  children: ReactNode;
  /** 内容列的最大宽度档位，md 适合窄栏对话，lg 适合整页会话，默认 md。 */
  maxWidth?: 'md' | 'lg';
}

/** 会话流布局容器：消息按垂直方向排列，内容列在容器内居中并限制最大宽度。 */
export function Thread({ children, maxWidth = 'md' }: ThreadProps) {
  return (
    <div className={`cb-thread cb-thread--${maxWidth}`} role="log">
      <div className="cb-thread-col">{children}</div>
    </div>
  );
}

export interface MessageProps {
  /** 消息角色：user 靠右强调底色，assistant 靠左描边卡片，system 居中窄条提示。 */
  role: 'user' | 'assistant' | 'system';
  /** 发言者名称，显示在气泡上方的等宽小字行。 */
  author?: string;
  /** ISO 格式时间字符串，显示为「时:分」，解析失败时原样显示。 */
  timestamp?: string;
  /** 为 true 时内容区显示三个呼吸点，代替 children，表示回复正在生成。 */
  pending?: boolean;
  /** 消息正文内容。 */
  children: ReactNode;
}

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

/** 单条消息：按角色决定对齐方式与气泡样式，可选地在气泡上方显示作者与时间。 */
export function Message({ role, author, timestamp, pending = false, children }: MessageProps) {
  const showMeta = author !== undefined || timestamp !== undefined;
  return (
    <div className={`cb-msg cb-msg--${role}`}>
      {showMeta ? (
        <div className="cb-msg-meta">
          {author !== undefined ? <span className="cb-msg-author">{author}</span> : null}
          {timestamp !== undefined ? (
            <time className="cb-msg-time" dateTime={timestamp}>
              {formatTimestamp(timestamp)}
            </time>
          ) : null}
        </div>
      ) : null}
      <div className="cb-msg-bubble">
        {pending ? (
          <span className="cb-msg-dots" role="status" aria-label="正在生成回复">
            <span className="cb-msg-dot" />
            <span className="cb-msg-dot" />
            <span className="cb-msg-dot" />
          </span>
        ) : (
          children
        )}
      </div>
    </div>
  );
}

export interface ComposerProps {
  /** 输入框占位文案，默认「输入消息，Enter 发送」。 */
  placeholder?: string;
  /** 为 true 时输入框与发送按钮都不可用。 */
  disabled?: boolean;
  /** 为 true 时发送按钮进入 loading 态，期间不会触发提交。 */
  sending?: boolean;
  /** 输入框初始文本（非受控）。 */
  defaultValue?: string;
  /** 提交回调，收到去除首尾空白后的文本；未传时组件仍可正常渲染与输入。 */
  onSubmit?: (text: string) => void;
}

/**
 * 消息输入框：文本域随内容自动增高（一到六行，超出滚动），右侧是发送按钮。
 * Enter 提交，Shift+Enter 换行；文本去除首尾空白后为空时不触发提交。
 */
export function Composer({
  placeholder = '输入消息，Enter 发送',
  disabled = false,
  sending = false,
  defaultValue,
  onSubmit,
}: ComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const resize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) {
      return;
    }
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, []);

  useLayoutEffect(() => {
    resize();
  }, [resize]);

  const submit = () => {
    const el = textareaRef.current;
    if (!el || disabled || sending) {
      return;
    }
    const text = el.value.trim();
    if (text === '') {
      return;
    }
    onSubmit?.(text);
    el.value = '';
    resize();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <div className={disabled ? 'cb-composer cb-composer--disabled' : 'cb-composer'}>
      <textarea
        ref={textareaRef}
        className="cb-composer-input"
        rows={1}
        placeholder={placeholder}
        disabled={disabled}
        defaultValue={defaultValue}
        aria-label="消息输入框"
        onInput={resize}
        onKeyDown={handleKeyDown}
      />
      <Button variant="primary" size="sm" loading={sending} disabled={disabled} onClick={submit}>
        发送
      </Button>
    </div>
  );
}

// 悬浮对话窗：产物画布是主界面，聊天是浮在画布上的伴随窗口——可拖拽、八向缩放、
// 最小化/最大化（Alt+M / Alt+Enter），位置尺寸按会话存 localStorage。
// 窄屏（≤900px）退化为固定布局不启用拖拽。消息渲染复用 ChatThread（落库消息 + 流式打字机）。
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';
import type { MessageView } from '@cb/shared';
import { ChatThread } from './ChatThread.js';

interface ChatRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ViewportOffset {
  left: number;
  top: number;
}

type ChatWindowMode = 'normal' | 'minimized' | 'maximized';
type ResizeDirection = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

const STORAGE_PREFIX = 'agora-runtime-floating-chat';
const MARGIN = 16;
const MIN_WIDTH = 320;
const MIN_HEIGHT = 280;
const MINIMIZED_HEIGHT = 42;
const DEFAULT_WIDTH = 420;
const DEFAULT_HEIGHT = 360;
const RESIZE_DIRECTIONS: ResizeDirection[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function validStoredRect(value: unknown): value is ChatRect {
  if (!value || typeof value !== 'object') return false;
  const rect = value as ChatRect;
  return [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite);
}

function readStoredRect(storageKey: string): ChatRect | null {
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    return validStoredRect(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeStoredRect(storageKey: string, rect: ChatRect): void {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(rect));
  } catch {
    /* 隐私模式等场景 localStorage 可能不可用，静默。 */
  }
}

function constrainRect(rect: ChatRect, container: HTMLElement): ChatRect {
  const bounds = container.getBoundingClientRect();
  const maxWidth = Math.max(260, bounds.width - MARGIN * 2);
  const maxHeight = Math.max(240, bounds.height - MARGIN * 2);
  const width = clamp(rect.width, Math.min(MIN_WIDTH, maxWidth), maxWidth);
  const height = clamp(rect.height, Math.min(MIN_HEIGHT, maxHeight), maxHeight);
  const maxX = Math.max(MARGIN, bounds.width - width - MARGIN);
  const maxY = Math.max(MARGIN, bounds.height - height - MARGIN);
  return { x: clamp(rect.x, MARGIN, maxX), y: clamp(rect.y, MARGIN, maxY), width, height };
}

function defaultRect(container: HTMLElement): ChatRect {
  const bounds = container.getBoundingClientRect();
  const width = Math.min(DEFAULT_WIDTH, Math.max(260, bounds.width - MARGIN * 2));
  const height = Math.min(DEFAULT_HEIGHT, Math.max(240, bounds.height - MARGIN * 2));
  return constrainRect(
    {
      x: Math.max(MARGIN, bounds.width - width - 32),
      y: Math.max(MARGIN, bounds.height - height - 20),
      width,
      height,
    },
    container,
  );
}

function viewportOffsetOf(container: HTMLElement): ViewportOffset {
  const bounds = container.getBoundingClientRect();
  return { left: bounds.left, top: bounds.top };
}

function desktopChatEnabled(): boolean {
  return !window.matchMedia('(max-width: 900px)').matches;
}

function resizeRect(
  rect: ChatRect,
  direction: ResizeDirection,
  deltaX: number,
  deltaY: number,
): ChatRect {
  let { x, y, width, height } = rect;
  if (direction.includes('e')) width += deltaX;
  if (direction.includes('s')) height += deltaY;
  if (direction.includes('w')) {
    x += deltaX;
    width -= deltaX;
  }
  if (direction.includes('n')) {
    y += deltaY;
    height -= deltaY;
  }
  return { x, y, width, height };
}

function maximizedRect(container: HTMLElement): ChatRect {
  const bounds = container.getBoundingClientRect();
  return {
    x: MARGIN,
    y: MARGIN,
    width: Math.max(260, bounds.width - MARGIN * 2),
    height: Math.max(240, bounds.height - MARGIN * 2),
  };
}

function minimizedRect(rect: ChatRect, container: HTMLElement): ChatRect {
  const bounds = container.getBoundingClientRect();
  const maxWidth = Math.max(260, bounds.width - MARGIN * 2);
  const width = clamp(rect.width, Math.min(MIN_WIDTH, maxWidth), maxWidth);
  const maxX = Math.max(MARGIN, bounds.width - width - MARGIN);
  const maxY = Math.max(MARGIN, bounds.height - MINIMIZED_HEIGHT - MARGIN);
  return {
    x: clamp(rect.x, MARGIN, maxX),
    y: clamp(rect.y, MARGIN, maxY),
    width,
    height: MINIMIZED_HEIGHT,
  };
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(target.closest('input, textarea, select, [contenteditable="true"]'));
}

export interface FloatingChatProps {
  /** 画布容器（悬浮窗的活动范围与定位基准）。 */
  containerRef: RefObject<HTMLDivElement>;
  sessionId: string;
  title: string;
  messages: MessageView[];
  /** 流式中的助手正文（打字机）；null = 无进行中文本。 */
  streamingText: string | null;
  isRunning: boolean;
  error: string | null;
  onSend: (text: string) => void;
  onInterrupt: () => void;
}

export function FloatingChat({
  containerRef,
  sessionId,
  title,
  messages,
  streamingText,
  isRunning,
  error,
  onSend,
  onInterrupt,
}: FloatingChatProps) {
  const [text, setText] = useState('');
  const [rect, setRect] = useState<ChatRect | null>(null);
  const [viewportOffset, setViewportOffset] = useState<ViewportOffset>({ left: 0, top: 0 });
  const [windowMode, setWindowMode] = useState<ChatWindowMode>('normal');
  const restoreRectRef = useRef<ChatRect | null>(null);
  const dragRef = useRef<{
    mode: 'move' | 'resize';
    direction?: ResizeDirection;
    startX: number;
    startY: number;
    startRect: ChatRect;
    latestRect: ChatRect;
  } | null>(null);
  const storageKey = `${STORAGE_PREFIX}:${sessionId}`;

  const syncViewportOffset = useCallback((): void => {
    const container = containerRef.current;
    if (!container || !desktopChatEnabled()) return;
    const next = viewportOffsetOf(container);
    setViewportOffset((current) =>
      current.left === next.left && current.top === next.top ? current : next,
    );
  }, [containerRef]);

  const restoreChat = useCallback((): void => {
    const container = containerRef.current;
    if (!container || !desktopChatEnabled()) return;
    syncViewportOffset();
    const next = constrainRect(
      restoreRectRef.current ?? readStoredRect(storageKey) ?? defaultRect(container),
      container,
    );
    restoreRectRef.current = next;
    writeStoredRect(storageKey, next);
    setRect(next);
    setWindowMode('normal');
  }, [containerRef, storageKey, syncViewportOffset]);

  const minimizeChat = useCallback((): void => {
    const container = containerRef.current;
    if (!container || !desktopChatEnabled()) return;
    syncViewportOffset();
    setRect((current) => {
      const base =
        windowMode === 'maximized' && restoreRectRef.current
          ? restoreRectRef.current
          : (current ?? defaultRect(container));
      if (windowMode === 'normal') {
        restoreRectRef.current = constrainRect(base, container);
      }
      return minimizedRect(base, container);
    });
    setWindowMode('minimized');
  }, [containerRef, syncViewportOffset, windowMode]);

  const maximizeChat = useCallback((): void => {
    const container = containerRef.current;
    if (!container || !desktopChatEnabled()) return;
    syncViewportOffset();
    setRect((current) => {
      const base = current ?? defaultRect(container);
      if (windowMode === 'normal') {
        restoreRectRef.current = constrainRect(base, container);
      }
      return maximizedRect(container);
    });
    setWindowMode('maximized');
  }, [containerRef, syncViewportOffset, windowMode]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    syncViewportOffset();
    const stored = readStoredRect(storageKey);
    const next = constrainRect(stored ?? defaultRect(container), container);
    restoreRectRef.current = next;
    setWindowMode('normal');
    setRect(next);
  }, [containerRef, storageKey, syncViewportOffset]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;
    const observer = new ResizeObserver(() => {
      syncViewportOffset();
      setRect((current) => {
        const base = current ?? defaultRect(container);
        if (windowMode === 'maximized') return maximizedRect(container);
        if (windowMode === 'minimized') return minimizedRect(base, container);
        const next = constrainRect(base, container);
        restoreRectRef.current = next;
        writeStoredRect(storageKey, next);
        return next;
      });
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [containerRef, storageKey, syncViewportOffset, windowMode]);

  useEffect(() => {
    const handleViewportChange = (): void => syncViewportOffset();
    window.addEventListener('resize', handleViewportChange);
    window.addEventListener('scroll', handleViewportChange, true);
    return () => {
      window.removeEventListener('resize', handleViewportChange);
      window.removeEventListener('scroll', handleViewportChange, true);
    };
  }, [syncViewportOffset]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (!desktopChatEnabled() || !event.altKey || event.metaKey || event.ctrlKey) {
        return;
      }
      if (isTypingTarget(event.target)) return;

      if (event.key.toLowerCase() === 'm') {
        event.preventDefault();
        if (windowMode === 'minimized') restoreChat();
        else minimizeChat();
      } else if (event.key === 'Enter') {
        event.preventDefault();
        if (windowMode === 'maximized') restoreChat();
        else maximizeChat();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [maximizeChat, minimizeChat, restoreChat, windowMode]);

  const startDrag = (
    mode: 'move' | 'resize',
    event: ReactPointerEvent<HTMLElement>,
    direction?: ResizeDirection,
  ): void => {
    if (event.button !== 0 || !desktopChatEnabled()) return;
    if (mode === 'move' && (event.target as HTMLElement).closest('button')) return;
    if (mode === 'resize' && windowMode !== 'normal') return;
    if (mode === 'move' && windowMode === 'maximized') return;
    const container = containerRef.current;
    if (!container) return;
    syncViewportOffset();
    const startRect = rect ?? defaultRect(container);
    dragRef.current = {
      mode,
      direction,
      startX: event.clientX,
      startY: event.clientY,
      startRect,
      latestRect: startRect,
    };
    event.preventDefault();

    const handleMove = (pointerEvent: PointerEvent): void => {
      const drag = dragRef.current;
      const activeContainer = containerRef.current;
      if (!drag || !activeContainer) return;
      const deltaX = pointerEvent.clientX - drag.startX;
      const deltaY = pointerEvent.clientY - drag.startY;
      const next =
        drag.mode === 'move'
          ? { ...drag.startRect, x: drag.startRect.x + deltaX, y: drag.startRect.y + deltaY }
          : resizeRect(drag.startRect, drag.direction ?? 'se', deltaX, deltaY);
      const constrained =
        windowMode === 'minimized'
          ? minimizedRect(next, activeContainer)
          : constrainRect(next, activeContainer);
      drag.latestRect = constrained;
      setRect(constrained);
    };

    const stopDrag = (): void => {
      const latest = dragRef.current?.latestRect;
      if (latest && windowMode === 'normal') {
        restoreRectRef.current = latest;
        writeStoredRect(storageKey, latest);
      } else if (latest && windowMode === 'minimized' && restoreRectRef.current) {
        restoreRectRef.current = { ...restoreRectRef.current, x: latest.x, y: latest.y };
      }
      dragRef.current = null;
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', stopDrag);
      window.removeEventListener('pointercancel', stopDrag);
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', stopDrag, { once: true });
    window.addEventListener('pointercancel', stopDrag, { once: true });
  };

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed || isRunning) return;
    onSend(trimmed);
    setText('');
  };
  const handleInputKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || event.key !== 'Enter' || event.shiftKey || event.altKey) {
      return;
    }
    event.preventDefault();
    submit();
  };
  const chatStyle = rect
    ? ({
        '--rt-chat-x': `${viewportOffset.left + rect.x}px`,
        '--rt-chat-y': `${viewportOffset.top + rect.y}px`,
        '--rt-chat-w': `${rect.width}px`,
        '--rt-chat-h': `${rect.height}px`,
      } as CSSProperties)
    : undefined;

  return (
    <section
      className={`rt-floating-chat${rect ? ' is-positioned' : ''}${isRunning ? ' is-running' : ''} is-${windowMode}`}
      style={chatStyle}
      aria-label="微调对话"
    >
      <header
        className="rt-floating-chat__head"
        onPointerDown={(event) => startDrag('move', event)}
      >
        <span className="rt-floating-chat__title" title={title}>
          {title}
        </span>
        <div className="rt-floating-chat__window-controls">
          <button
            type="button"
            className="rt-floating-chat__window-btn"
            aria-label={windowMode === 'minimized' ? '还原对话框' : '最小化对话框'}
            title={windowMode === 'minimized' ? '还原对话框 (Alt+M)' : '最小化对话框 (Alt+M)'}
            onClick={windowMode === 'minimized' ? restoreChat : minimizeChat}
          >
            <span
              className={`rt-floating-chat__window-icon rt-floating-chat__window-icon--${
                windowMode === 'minimized' ? 'restore' : 'minimize'
              }`}
              aria-hidden="true"
            />
          </button>
          <button
            type="button"
            className="rt-floating-chat__window-btn"
            aria-label={windowMode === 'maximized' ? '还原对话框' : '最大化对话框'}
            title={
              windowMode === 'maximized' ? '还原对话框 (Alt+Enter)' : '最大化对话框 (Alt+Enter)'
            }
            onClick={windowMode === 'maximized' ? restoreChat : maximizeChat}
          >
            <span
              className={`rt-floating-chat__window-icon rt-floating-chat__window-icon--${
                windowMode === 'maximized' ? 'restore' : 'maximize'
              }`}
              aria-hidden="true"
            />
          </button>
          {isRunning && (
            <button type="button" className="rt-icon-btn" onClick={onInterrupt}>
              打断
            </button>
          )}
        </div>
      </header>
      {windowMode !== 'minimized' && (
        <>
          <ChatThread messages={messages} streamingText={streamingText} />
          {error && <div className="rt-error rt-error--inline">{error}</div>}
          <div className="rt-floating-chat__input">
            <textarea
              value={text}
              disabled={isRunning}
              rows={1}
              placeholder="继续调整这个产物…"
              aria-keyshortcuts="Enter"
              onChange={(event) => setText(event.target.value)}
              onKeyDown={handleInputKeyDown}
            />
            <button
              type="button"
              className="rt-chat-send"
              aria-label="发送"
              title="发送 (Enter)"
              disabled={isRunning || !text.trim()}
              onClick={submit}
            >
              ↑
            </button>
          </div>
        </>
      )}
      {windowMode === 'normal' && (
        <>
          <button
            type="button"
            className="rt-floating-chat__resize rt-floating-chat__resize--se"
            aria-label="从右下角调整对话框大小"
            onPointerDown={(event) => startDrag('resize', event, 'se')}
          />
          {RESIZE_DIRECTIONS.filter((direction) => direction !== 'se').map((direction) => (
            <button
              key={direction}
              type="button"
              className={`rt-floating-chat__resize rt-floating-chat__resize--${direction}`}
              aria-label="调整对话框大小"
              onPointerDown={(event) => startDrag('resize', event, direction)}
            />
          ))}
        </>
      )}
    </section>
  );
}

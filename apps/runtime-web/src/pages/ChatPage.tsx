import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import type {
  InputField,
  PublicCapabilityView,
  RuntimeArtifact,
  RuntimeMessage,
  RuntimeSessionList,
  RuntimeSessionListItem,
  RuntimeSessionMeta,
  TrialProcessState,
} from '@cb/shared';
import { createProductionSession, createTrialSession, useSession } from '../api/runtime.js';
import { useAguiSession } from '../api/useAguiSession.js';
import { ArtifactRenderer } from '../components/ArtifactRenderer.js';
import { ChatThread } from '../components/ChatThread.js';
import { SessionSidebar } from '../components/SessionSidebar.js';

type PreviewMode = 'creator' | 'consumer';

function latestVersion(artifact: RuntimeArtifact | null) {
  return (
    artifact?.versions.find((v) => v.version === artifact.latestVersion) ??
    artifact?.versions.at(-1)
  );
}

function toSessionListItem(
  session: RuntimeSessionMeta,
  capability: PublicCapabilityView,
): RuntimeSessionListItem {
  return {
    id: session.id,
    slug: session.slug,
    mode: session.mode,
    title: session.title,
    capabilityName: capability.name,
    updatedAt: session.updatedAt,
  };
}

function upsertSessionListItem(
  current: RuntimeSessionList | undefined,
  item: RuntimeSessionListItem,
): RuntimeSessionList {
  const items = current?.items ?? [];
  return { items: [item, ...items.filter((existing) => existing.id !== item.id)] };
}

function safeReturnTo(value: string | null): string {
  return value && value.startsWith('/') && !value.startsWith('//') ? value : '/create/capabilities';
}

function fieldValue(values: Record<string, string>, field: InputField): string {
  return values[field.key]?.trim() ?? '';
}

function includesAny(value: string, needles: string[]): boolean {
  return needles.some((needle) => value.includes(needle));
}

function defaultFieldValue(
  capability: PublicCapabilityView,
  field: InputField,
  index: number,
): string {
  const name = `${field.key} ${field.label}`.toLowerCase();

  if (field.type === 'enum') return field.options?.[0] ?? '';
  if (field.type === 'number') return includesAny(name, ['day', '天', 'week', '周']) ? '7' : '3';

  if (
    includesAny(name, ['audience', 'user', 'customer', 'persona', '受众', '用户', '客户', '人群'])
  ) {
    return '准备购买 AI 工具的独立开发者，熟悉基础自动化，但希望减少试错成本。';
  }
  if (includesAny(name, ['tone', 'style', 'voice', '语气', '风格', '口吻'])) {
    return '清晰、专业、具体，带一点鼓励感。';
  }
  if (includesAny(name, ['reference', 'case', 'example', '素材', '案例', '参考'])) {
    return '参考案例：用户之前试过两款工具，但因为配置复杂和结果不可控而放弃。希望看到更直接的行动建议。';
  }
  if (includesAny(name, ['topic', 'theme', '主题'])) {
    return capability.name;
  }
  if (includesAny(name, ['point', 'outline', '要点', '大纲'])) {
    return `目标：${capability.description}\n受众：独立开发者和小团队\n形式：可直接执行的一页方案`;
  }
  if (includesAny(name, ['competitor', 'company', 'product', '竞品', '产品', '公司'])) {
    return 'Cursor';
  }
  if (includesAny(name, ['dimension', 'criteria', '维度', '标准'])) {
    return '产品力\n上手成本\n生态与扩展\n商业化风险';
  }
  if (includesAny(name, ['ingredient', '食材'])) {
    return '鸡胸肉、鸡蛋、西兰花、番茄、燕麦、酸奶';
  }

  if (field.type === 'text') {
    return `我想用「${capability.name}」快速得到一版可直接使用的结果。请优先给出结构清晰、能马上行动的版本。`;
  }

  return index === 0 ? capability.description : capability.tagline;
}

function buildDefaultValues(capability: PublicCapabilityView): Record<string, string> {
  return Object.fromEntries(
    capability.inputs.fields.map((field, index) => [
      field.key,
      defaultFieldValue(capability, field, index),
    ]),
  );
}

function defaultExtra(capability: PublicCapabilityView): string {
  return (
    capability.starterPrompts[0] ??
    `请基于这些输入生成一版完整、可直接使用的${capability.output.type === 'score' ? '评分卡' : '产物'}。`
  );
}

function buildTrialPrompt(
  fields: InputField[],
  values: Record<string, string>,
  extra: string,
): string {
  const lines = fields
    .map((f) => {
      const value = fieldValue(values, f);
      return value ? `${f.label}：${value}` : null;
    })
    .filter(Boolean);
  if (extra.trim()) lines.push(`补充要求：${extra.trim()}`);
  return `请基于本次试用输入生成第一版产物。\n\n${lines.join('\n')}`;
}

function TrialIntakeForm({
  capability,
  disabled,
  onSubmit,
}: {
  capability: PublicCapabilityView;
  disabled: boolean;
  onSubmit: (prompt: string) => void;
}) {
  const defaultValues = useMemo(() => buildDefaultValues(capability), [capability]);
  const defaultPrompt = useMemo(() => defaultExtra(capability), [capability]);
  const [values, setValues] = useState<Record<string, string>>(defaultValues);
  const [extra, setExtra] = useState(defaultPrompt);
  const requiredMissing = capability.inputs.fields.some(
    (f) => f.required && !fieldValue(values, f),
  );

  useEffect(() => {
    setValues(defaultValues);
    setExtra(defaultPrompt);
  }, [defaultPrompt, defaultValues]);

  return (
    <section className="rt-intake" aria-label="本次试用输入">
      <div className="rt-intake__head">
        <h2>开始生成 · {capability.name}</h2>
        <p>补充这次使用需要的上下文，我会按这个能力生成第一版产物。</p>
      </div>
      <div className="rt-intake__fields">
        {capability.inputs.fields.map((field) => (
          <label
            key={field.key}
            className={`rt-field${field.type === 'text' ? ' rt-field--wide' : ''}`}
          >
            <span className="rt-field__label">
              {field.label}
              {field.required && <span className="rt-field__req">*</span>}
            </span>
            {field.type === 'text' ? (
              <textarea
                className="rt-field__control"
                rows={3}
                value={values[field.key] ?? ''}
                disabled={disabled}
                onChange={(event) => setValues((s) => ({ ...s, [field.key]: event.target.value }))}
              />
            ) : field.type === 'enum' ? (
              <select
                className="rt-field__control"
                value={values[field.key] ?? ''}
                disabled={disabled}
                onChange={(event) => setValues((s) => ({ ...s, [field.key]: event.target.value }))}
              >
                {(field.options ?? []).map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            ) : (
              <input
                className="rt-field__control"
                type={field.type === 'number' ? 'number' : 'text'}
                value={values[field.key] ?? ''}
                disabled={disabled}
                onChange={(event) => setValues((s) => ({ ...s, [field.key]: event.target.value }))}
              />
            )}
          </label>
        ))}
        <label className="rt-field rt-field--wide">
          <span className="rt-field__label">补充要求</span>
          <textarea
            className="rt-field__control"
            rows={3}
            value={extra}
            disabled={disabled}
            onChange={(event) => setExtra(event.target.value)}
          />
        </label>
      </div>
      {capability.starterPrompts.length > 0 && (
        <div className="rt-starters">
          <div className="rt-starters__label">或从一个开头开始</div>
          <div className="rt-starters__row">
            {capability.starterPrompts.slice(0, 3).map((prompt) => (
              <button
                key={prompt}
                type="button"
                className="rt-starter"
                disabled={disabled}
                onClick={() => setExtra(prompt)}
              >
                {prompt}
              </button>
            ))}
          </div>
        </div>
      )}
      <button
        type="button"
        className="rt-btn rt-btn--accent rt-intake__start"
        disabled={disabled || requiredMissing}
        onClick={() => onSubmit(buildTrialPrompt(capability.inputs.fields, values, extra))}
      >
        {disabled ? '正在生成…' : '开始生成 →'}
      </button>
    </section>
  );
}

function TrialGeneratingCard({
  capability,
  process,
}: {
  capability: PublicCapabilityView;
  process: TrialProcessState | null;
}) {
  const rows = process?.steps.slice(0, 4) ?? [
    { key: 'read_experience', label: `读取 @${capability.slug} 经验体`, status: 'completed' },
    { key: 'draft_output', label: '生成第一版产物', status: 'running' },
    { key: 'check_boundaries', label: '校验能力边界与输出格式', status: 'pending' },
    { key: 'compose_artifact', label: '整理产物结构', status: 'pending' },
  ];

  return (
    <section className="rt-generating-card" aria-label="正在生成">
      <h2>正在生成 · {capability.name}...</h2>
      <p>按 @{capability.slug} 的经验体生成第一版产物，用进度短语标记关键步骤。</p>
      <div className="rt-generating-card__steps">
        {rows.map((row) => (
          <div key={row.key} className="rt-generating-card__step" data-status={row.status}>
            <span className="rt-generating-card__dot" />
            <span>{row.label}</span>
          </div>
        ))}
      </div>
      <div className="rt-generating-card__skeletons" aria-hidden="true">
        <div className="rt-skeleton-card">
          <span />
          <i />
          <b />
        </div>
        <div className="rt-skeleton-card">
          <span />
          <i />
          <b />
        </div>
      </div>
    </section>
  );
}

function CreatorInspector({
  capability,
  onClose,
}: {
  capability: PublicCapabilityView;
  onClose: () => void;
}) {
  return (
    <aside className="rt-inspector" aria-label="创作者调试面板">
      <div className="rt-inspector__bar">
        <span>创作者面板</span>
        <button type="button" className="rt-icon-btn" onClick={onClose}>
          收起
        </button>
      </div>
      <div className="rt-inspector__tabs" role="tablist" aria-label="创作者信息">
        <button type="button" className="rt-inspector__tab is-active">
          经验体
        </button>
        <button type="button" className="rt-inspector__tab">
          规格说明
        </button>
        <button type="button" className="rt-inspector__tab">
          记忆
        </button>
      </div>
      <div className="rt-inspector__body">
        <p>当前模板字段：{capability.inputs.fields.length} 个</p>
        <p>引用要求：参考案例可选；不确定引用必须标注为模拟。</p>
        <p>输出类型：{capability.output.type}</p>
      </div>
    </aside>
  );
}

interface FloatingChatRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface FloatingChatViewportOffset {
  left: number;
  top: number;
}

type FloatingChatMode = 'normal' | 'minimized' | 'maximized';
type ResizeDirection = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

const FLOATING_CHAT_STORAGE_PREFIX = 'agora-runtime-floating-chat';
const FLOATING_CHAT_MARGIN = 16;
const FLOATING_CHAT_MIN_WIDTH = 320;
const FLOATING_CHAT_MIN_HEIGHT = 280;
const FLOATING_CHAT_MINIMIZED_HEIGHT = 42;
const FLOATING_CHAT_DEFAULT_WIDTH = 420;
const FLOATING_CHAT_DEFAULT_HEIGHT = 360;
const RESIZE_DIRECTIONS: ResizeDirection[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function validStoredRect(value: unknown): value is FloatingChatRect {
  if (!value || typeof value !== 'object') return false;
  const rect = value as FloatingChatRect;
  return [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite);
}

function readFloatingChatRect(storageKey: string): FloatingChatRect | null {
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    return validStoredRect(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeFloatingChatRect(storageKey: string, rect: FloatingChatRect): void {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(rect));
  } catch {
    /* localStorage can be unavailable in private or restricted contexts. */
  }
}

function constrainFloatingChatRect(
  rect: FloatingChatRect,
  container: HTMLElement,
): FloatingChatRect {
  const bounds = container.getBoundingClientRect();
  const maxWidth = Math.max(260, bounds.width - FLOATING_CHAT_MARGIN * 2);
  const maxHeight = Math.max(240, bounds.height - FLOATING_CHAT_MARGIN * 2);
  const minWidth = Math.min(FLOATING_CHAT_MIN_WIDTH, maxWidth);
  const minHeight = Math.min(FLOATING_CHAT_MIN_HEIGHT, maxHeight);
  const width = clamp(rect.width, minWidth, maxWidth);
  const height = clamp(rect.height, minHeight, maxHeight);
  const maxX = Math.max(FLOATING_CHAT_MARGIN, bounds.width - width - FLOATING_CHAT_MARGIN);
  const maxY = Math.max(FLOATING_CHAT_MARGIN, bounds.height - height - FLOATING_CHAT_MARGIN);
  return {
    x: clamp(rect.x, FLOATING_CHAT_MARGIN, maxX),
    y: clamp(rect.y, FLOATING_CHAT_MARGIN, maxY),
    width,
    height,
  };
}

function defaultFloatingChatRect(container: HTMLElement): FloatingChatRect {
  const bounds = container.getBoundingClientRect();
  const maxWidth = Math.max(260, bounds.width - FLOATING_CHAT_MARGIN * 2);
  const maxHeight = Math.max(240, bounds.height - FLOATING_CHAT_MARGIN * 2);
  const width = Math.min(FLOATING_CHAT_DEFAULT_WIDTH, maxWidth);
  const height = Math.min(FLOATING_CHAT_DEFAULT_HEIGHT, maxHeight);
  return constrainFloatingChatRect(
    {
      x: Math.max(FLOATING_CHAT_MARGIN, bounds.width - width - 32),
      y: Math.max(FLOATING_CHAT_MARGIN, bounds.height - height - 20),
      width,
      height,
    },
    container,
  );
}

function floatingChatViewportOffset(container: HTMLElement): FloatingChatViewportOffset {
  const bounds = container.getBoundingClientRect();
  return {
    left: bounds.left,
    top: bounds.top,
  };
}

function desktopFloatingChatEnabled(): boolean {
  return !window.matchMedia('(max-width: 900px)').matches;
}

function resizeFloatingChatRect(
  rect: FloatingChatRect,
  direction: ResizeDirection,
  deltaX: number,
  deltaY: number,
): FloatingChatRect {
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

function maximizedFloatingChatRect(container: HTMLElement): FloatingChatRect {
  const bounds = container.getBoundingClientRect();
  return {
    x: FLOATING_CHAT_MARGIN,
    y: FLOATING_CHAT_MARGIN,
    width: Math.max(260, bounds.width - FLOATING_CHAT_MARGIN * 2),
    height: Math.max(240, bounds.height - FLOATING_CHAT_MARGIN * 2),
  };
}

function minimizedFloatingChatRect(
  rect: FloatingChatRect,
  container: HTMLElement,
): FloatingChatRect {
  const bounds = container.getBoundingClientRect();
  const maxWidth = Math.max(260, bounds.width - FLOATING_CHAT_MARGIN * 2);
  const width = clamp(rect.width, Math.min(FLOATING_CHAT_MIN_WIDTH, maxWidth), maxWidth);
  const maxX = Math.max(FLOATING_CHAT_MARGIN, bounds.width - width - FLOATING_CHAT_MARGIN);
  const maxY = Math.max(
    FLOATING_CHAT_MARGIN,
    bounds.height - FLOATING_CHAT_MINIMIZED_HEIGHT - FLOATING_CHAT_MARGIN,
  );
  return {
    x: clamp(rect.x, FLOATING_CHAT_MARGIN, maxX),
    y: clamp(rect.y, FLOATING_CHAT_MARGIN, maxY),
    width,
    height: FLOATING_CHAT_MINIMIZED_HEIGHT,
  };
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(target.closest('input, textarea, select, [contenteditable="true"]'));
}

function FloatingChat({
  containerRef,
  sessionId,
  title,
  messages,
  isRunning,
  error,
  onSend,
  onInterrupt,
  onOpenArtifact,
}: {
  containerRef: RefObject<HTMLDivElement>;
  sessionId: string;
  title: string;
  messages: RuntimeMessage[];
  isRunning: boolean;
  error: string | null;
  onSend: (text: string) => void;
  onInterrupt: () => void;
  onOpenArtifact: (ref: RuntimeMessage['artifacts'][number]) => void;
}) {
  const [text, setText] = useState('');
  const [rect, setRect] = useState<FloatingChatRect | null>(null);
  const [viewportOffset, setViewportOffset] = useState<FloatingChatViewportOffset>({
    left: 0,
    top: 0,
  });
  const [windowMode, setWindowMode] = useState<FloatingChatMode>('normal');
  const restoreRectRef = useRef<FloatingChatRect | null>(null);
  const dragRef = useRef<{
    mode: 'move' | 'resize';
    direction?: ResizeDirection;
    startX: number;
    startY: number;
    startRect: FloatingChatRect;
    latestRect: FloatingChatRect;
  } | null>(null);
  const storageKey = `${FLOATING_CHAT_STORAGE_PREFIX}:${sessionId}`;

  const syncViewportOffset = useCallback((): void => {
    const container = containerRef.current;
    if (!container || !desktopFloatingChatEnabled()) return;
    const next = floatingChatViewportOffset(container);
    setViewportOffset((current) =>
      current.left === next.left && current.top === next.top ? current : next,
    );
  }, [containerRef]);

  const restoreChat = useCallback((): void => {
    const container = containerRef.current;
    if (!container || !desktopFloatingChatEnabled()) return;
    syncViewportOffset();
    const next = constrainFloatingChatRect(
      restoreRectRef.current ??
        readFloatingChatRect(storageKey) ??
        defaultFloatingChatRect(container),
      container,
    );
    restoreRectRef.current = next;
    writeFloatingChatRect(storageKey, next);
    setRect(next);
    setWindowMode('normal');
  }, [containerRef, storageKey, syncViewportOffset]);

  const minimizeChat = useCallback((): void => {
    const container = containerRef.current;
    if (!container || !desktopFloatingChatEnabled()) return;
    syncViewportOffset();
    setRect((current) => {
      const base =
        windowMode === 'maximized' && restoreRectRef.current
          ? restoreRectRef.current
          : (current ?? defaultFloatingChatRect(container));
      if (windowMode === 'normal') {
        restoreRectRef.current = constrainFloatingChatRect(base, container);
      }
      return minimizedFloatingChatRect(base, container);
    });
    setWindowMode('minimized');
  }, [containerRef, syncViewportOffset, windowMode]);

  const maximizeChat = useCallback((): void => {
    const container = containerRef.current;
    if (!container || !desktopFloatingChatEnabled()) return;
    syncViewportOffset();
    setRect((current) => {
      const base = current ?? defaultFloatingChatRect(container);
      if (windowMode === 'normal') {
        restoreRectRef.current = constrainFloatingChatRect(base, container);
      }
      return maximizedFloatingChatRect(container);
    });
    setWindowMode('maximized');
  }, [containerRef, syncViewportOffset, windowMode]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    syncViewportOffset();
    const stored = readFloatingChatRect(storageKey);
    const next = constrainFloatingChatRect(stored ?? defaultFloatingChatRect(container), container);
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
        const base = current ?? defaultFloatingChatRect(container);
        if (windowMode === 'maximized') return maximizedFloatingChatRect(container);
        if (windowMode === 'minimized') return minimizedFloatingChatRect(base, container);
        const next = constrainFloatingChatRect(base, container);
        restoreRectRef.current = next;
        writeFloatingChatRect(storageKey, next);
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
      if (!desktopFloatingChatEnabled() || !event.altKey || event.metaKey || event.ctrlKey) {
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
    if (event.button !== 0 || !desktopFloatingChatEnabled()) return;
    if (mode === 'move' && (event.target as HTMLElement).closest('button')) return;
    if (mode === 'resize' && windowMode !== 'normal') return;
    if (mode === 'move' && windowMode === 'maximized') return;
    const container = containerRef.current;
    if (!container) return;
    syncViewportOffset();
    const startRect = rect ?? defaultFloatingChatRect(container);
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
          ? {
              ...drag.startRect,
              x: drag.startRect.x + deltaX,
              y: drag.startRect.y + deltaY,
            }
          : resizeFloatingChatRect(drag.startRect, drag.direction ?? 'se', deltaX, deltaY);
      const constrained =
        windowMode === 'minimized'
          ? minimizedFloatingChatRect(next, activeContainer)
          : constrainFloatingChatRect(next, activeContainer);
      drag.latestRect = constrained;
      setRect(constrained);
    };

    const stopDrag = (): void => {
      const latest = dragRef.current?.latestRect;
      if (latest && windowMode === 'normal') {
        restoreRectRef.current = latest;
        writeFloatingChatRect(storageKey, latest);
      } else if (latest && windowMode === 'minimized' && restoreRectRef.current) {
        restoreRectRef.current = {
          ...restoreRectRef.current,
          x: latest.x,
          y: latest.y,
        };
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
          <ChatThread messages={messages} streamingText={null} onOpenArtifact={onOpenArtifact} />
          {error && <div className="rt-error rt-error--inline">{error}</div>}
          <div className="rt-floating-chat__input">
            <textarea
              value={text}
              disabled={isRunning}
              rows={1}
              placeholder="回复，或 /命令..."
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

export function ChatPage() {
  const { slug, sessionId: routeSessionId } = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const qc = useQueryClient();

  const [createFailed, setCreateFailed] = useState(false);
  const [mode, setMode] = useState<PreviewMode>('creator');
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [productionPending, setProductionPending] = useState(false);
  const [productionError, setProductionError] = useState<string | null>(null);
  const startedSlugRef = useRef<string | undefined>(undefined);
  const canvasRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!slug || startedSlugRef.current === slug) return;
    startedSlugRef.current = slug;
    createTrialSession(slug)
      .then((data) => {
        const item = toSessionListItem(data.session, data.capability);
        qc.setQueryData<RuntimeSessionList>(['sessions'], (current) =>
          upsertSessionListItem(current, item),
        );
        qc.setQueryData<RuntimeSessionList>(['sessions', data.capability.slug], (current) =>
          upsertSessionListItem(current, item),
        );
        void qc.invalidateQueries({ queryKey: ['sessions'] });
        navigate(`/session/${data.session.id}`, { replace: true });
      })
      .catch(() => setCreateFailed(true));
  }, [slug, navigate, qc]);

  const sessionId = routeSessionId;
  const sessionQ = useSession(sessionId);
  const detail = sessionQ.data;
  const capability = detail?.capability;
  const agui = useAguiSession(sessionId, detail);

  useEffect(() => {
    if (detail?.session.mode !== 'consume') return;
    setMode('consumer');
    setInspectorOpen(false);
  }, [detail?.session.mode]);

  const activeArtifact = agui.activeKey
    ? (agui.artifacts.find((a) => a.artifactKey === agui.activeKey) ?? null)
    : (agui.artifacts.at(-1) ?? null);
  const activeVersion = latestVersion(activeArtifact);
  const hasStarted = agui.messages.length > 0;
  const hasPriorMessages = (detail?.messages.length ?? 0) > 0;
  const hasRealArtifact = Boolean(
    activeVersion && activeArtifact?.artifactKey !== 'mock-full-html',
  );

  const activeSession = detail ? toSessionListItem(detail.session, detail.capability) : undefined;
  const sessionMode = detail?.session.mode ?? 'trial';
  const isTrialSession = sessionMode === 'trial';
  const isDraftTrial = isTrialSession && capability?.status === 'draft';
  const effectiveMode: PreviewMode = isTrialSession ? mode : 'consumer';
  const publishReturnTo = safeReturnTo(searchParams.get('returnTo'));

  const backToPublish = useCallback(() => {
    window.location.assign(publishReturnTo);
  }, [publishReturnTo]);

  const enterProduction = useCallback(async () => {
    if (!capability || capability.status === 'draft' || productionPending) return;
    setProductionPending(true);
    setProductionError(null);
    try {
      const created = await createProductionSession(capability.slug, capability.name);
      const item = toSessionListItem(created.session, created.capability);
      qc.setQueryData<RuntimeSessionList>(['sessions'], (current) =>
        upsertSessionListItem(current, item),
      );
      qc.setQueryData<RuntimeSessionList>(['sessions', created.capability.slug], (current) =>
        upsertSessionListItem(current, item),
      );
      void qc.invalidateQueries({ queryKey: ['sessions'] });
      navigate(`/session/${created.session.id}`);
    } catch {
      setProductionError('无法进入正式使用，请稍后重试。');
    } finally {
      setProductionPending(false);
    }
  }, [capability, navigate, productionPending, qc]);

  const uiMessages: RuntimeMessage[] = useMemo(
    () =>
      agui.messages.map((m, i) => ({
        id: m.id,
        seq: i,
        role: m.role,
        text: m.text,
        runId: null,
        artifacts: m.artifacts,
        createdAt: '',
      })),
    [agui.messages],
  );

  if (slug && !sessionId) {
    return (
      <div className="rt-loading">
        {createFailed ? (
          <div className="rt-error">无法开始试用：能力未找到、未发布，或当前账号无权试用。</div>
        ) : (
          '正在开始试用…'
        )}
      </div>
    );
  }
  if (sessionQ.isLoading) return <div className="rt-loading">加载会话…</div>;
  if (sessionQ.isError || !capability) {
    return <div className="rt-loading rt-error">会话加载失败或不存在。</div>;
  }

  const toolbarTitle = hasStarted ? (activeArtifact?.title ?? capability.name) : capability.name;
  const toolbarVersion =
    hasStarted && activeArtifact ? activeArtifact.latestVersion : capability.version;
  const showInitialGenerating = agui.isRunning && !hasPriorMessages;
  const showArtifact = hasStarted && hasRealArtifact && !showInitialGenerating;
  const showInspectorPanel =
    isTrialSession && effectiveMode === 'creator' && inspectorOpen && !agui.isRunning;
  const showCompanionChat = hasStarted && !showInitialGenerating && !showInspectorPanel;

  return (
    <div className="rt-app rt-trial-app" data-view={effectiveMode} data-mode={sessionMode}>
      <SessionSidebar
        activeSession={activeSession}
        activeSessionId={sessionId}
        capabilitySlug={capability.slug}
      />
      <div className="rt-trial">
        <header className="rt-trial__toolbar">
          <div className="rt-trial__title-group">
            <h1>{toolbarTitle}</h1>
            <span className="rt-version-chip">v{toolbarVersion}</span>
            <span className={`rt-mode-chip rt-mode-chip--${sessionMode}`}>
              {isTrialSession ? (isDraftTrial ? '草稿试用' : '试用') : '正式使用'}
            </span>
            <span className="rt-source-pill">
              @{capability.slug} · 守则 {capability.inputs.fields.length} · 案例{' '}
              {capability.starterPrompts.length}
            </span>
          </div>
          <div className="rt-trial__tools">
            <button type="button">TIMELINE</button>
            <button type="button">EXPORT</button>
            <button type="button">SHARE</button>
            <button type="button">FULL</button>
            {isTrialSession && hasStarted && isDraftTrial ? (
              <button
                type="button"
                className="rt-toolbar-pill rt-toolbar-pill--accent"
                onClick={backToPublish}
              >
                满意，回到发布
              </button>
            ) : isTrialSession && hasStarted ? (
              <button
                type="button"
                className="rt-toolbar-pill rt-toolbar-pill--accent"
                disabled={productionPending}
                onClick={() => void enterProduction()}
              >
                {productionPending ? '创建中…' : '满意，进入正式使用'}
              </button>
            ) : null}
            {isTrialSession && (
              <>
                <div className="rt-segment" role="group" aria-label="预览身份">
                  <button
                    type="button"
                    className={mode === 'creator' ? 'is-active' : ''}
                    onClick={() => setMode('creator')}
                  >
                    创作者
                  </button>
                  <button
                    type="button"
                    className={mode === 'consumer' ? 'is-active' : ''}
                    onClick={() => setMode('consumer')}
                  >
                    消费者
                  </button>
                </div>
                {effectiveMode === 'creator' && (
                  <button
                    type="button"
                    className="rt-toolbar-pill"
                    onClick={() => setInspectorOpen((v) => !v)}
                  >
                    {showInspectorPanel ? '回到对话' : '经验体'}
                  </button>
                )}
              </>
            )}
          </div>
        </header>

        <main className="rt-genui">
          <div
            ref={canvasRef}
            className="rt-genui__canvas"
            data-state={showInitialGenerating ? 'running' : hasStarted ? 'output' : 'intake'}
          >
            {productionError && <div className="rt-inline-error">{productionError}</div>}
            {showArtifact && activeVersion ? (
              <div className="rt-artifact-stage">
                <ArtifactRenderer artifact={activeVersion} />
              </div>
            ) : hasStarted && !agui.isRunning ? (
              <div className="rt-empty">暂无产物</div>
            ) : null}
            {!hasStarted && !agui.isRunning && (
              <div className="rt-genui__overlay">
                <TrialIntakeForm
                  capability={capability}
                  disabled={agui.isRunning}
                  onSubmit={(prompt) => agui.send(prompt)}
                />
              </div>
            )}
            {showInitialGenerating && (
              <div className="rt-genui__overlay rt-genui__overlay--plain">
                <TrialGeneratingCard capability={capability} process={agui.trialProcess} />
              </div>
            )}
            {showCompanionChat && (
              <FloatingChat
                containerRef={canvasRef}
                sessionId={sessionId ?? detail.session.id}
                title={activeArtifact?.title ?? detail.session.title ?? capability.name}
                messages={uiMessages}
                isRunning={agui.isRunning}
                error={agui.error}
                onSend={(text) => agui.send(text)}
                onInterrupt={agui.interrupt}
                onOpenArtifact={(ref) => agui.setActiveKey(ref.artifactKey)}
              />
            )}
            {showInspectorPanel && (
              <CreatorInspector capability={capability} onClose={() => setInspectorOpen(false)} />
            )}
          </div>
        </main>
      </div>
    </div>
  );
}

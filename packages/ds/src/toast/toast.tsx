import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import './toast.css';

export type ToastVariant = 'info' | 'ok' | 'warn' | 'danger';

export interface ToastProps {
  /** 变体决定左侧 3px 色条颜色，缺省为 info（中性墨灰）。 */
  variant?: ToastVariant;
  /** 通知标题，必填。 */
  title: string;
  /** 可选的补充说明文字，渲染在标题下方。 */
  description?: string;
}

/**
 * 纯视觉的通知条：raised 白底、极轻 overlay 阴影、左侧 3px 变体色条。
 * 全部视觉状态由纯 JSON props 表达，不依赖任何回调即可渲染。
 */
export function Toast({ variant = 'info', title, description }: ToastProps) {
  return (
    <div className={`cb-toast cb-toast--${variant}`}>
      <p className="cb-toast-title">{title}</p>
      {description ? <p className="cb-toast-desc">{description}</p> : null}
    </div>
  );
}

export interface ToastOptions {
  variant?: ToastVariant;
  title: string;
  description?: string;
  /** 自动消失的毫秒数，缺省 4000。 */
  durationMs?: number;
}

interface ToastContextValue {
  /** 入队一条通知，展示在右下角固定区域，到时自动消失。 */
  toast: (t: ToastOptions) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

interface QueueItem {
  id: number;
  variant?: ToastVariant;
  title: string;
  description?: string;
}

const DEFAULT_DURATION_MS = 4000;

/**
 * 通知队列的提供者：内部用 useState 维护队列，在页面右下角渲染
 * 一个 aria-live="polite" 的固定区域，每条通知到时自动出队。
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const nextIdRef = useRef(0);
  const timersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const timer of timers) {
        clearTimeout(timer);
      }
      timers.clear();
    };
  }, []);

  const toast = useCallback((t: ToastOptions) => {
    const id = nextIdRef.current;
    nextIdRef.current += 1;
    setQueue((prev) => [
      ...prev,
      { id, variant: t.variant, title: t.title, description: t.description },
    ]);
    const timer = setTimeout(() => {
      timersRef.current.delete(timer);
      setQueue((prev) => prev.filter((item) => item.id !== id));
    }, t.durationMs ?? DEFAULT_DURATION_MS);
    timersRef.current.add(timer);
  }, []);

  const value = useMemo(() => ({ toast }), [toast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="cb-toast-region" aria-live="polite">
        {queue.map((item) => (
          <Toast
            key={item.id}
            variant={item.variant}
            title={item.title}
            description={item.description}
          />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/** 读取通知上下文；必须在 ToastProvider 内部调用，否则抛错。 */
export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (ctx === null) {
    throw new Error('useToast() 必须在 <ToastProvider> 内部调用');
  }
  return ctx;
}

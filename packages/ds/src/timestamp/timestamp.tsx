import './timestamp.css';

export interface TimestampProps {
  /** ISO 8601 时间字符串，例如 2026-07-07T08:30:00+08:00。 */
  value: string;
  /** absolute 显示「YYYY-MM-DD HH:mm」，relative 显示「x 分钟前」等相对文案。默认 absolute。 */
  mode?: 'absolute' | 'relative';
  /** 相对文案的语言，zh 开头输出中文，其余输出英文。默认 zh-CN。 */
  locale?: string;
  /** 可选注入的「当前时间」（ISO 字符串），仅 relative 模式使用；不传时取真实当前时间。 */
  now?: string;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function toDate(value: string | Date): Date {
  return value instanceof Date ? value : new Date(value);
}

/** 把 ISO 时间格式化为本地时区的「YYYY-MM-DD HH:mm」。输入非法时原样返回。 */
export function formatAbsolute(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** title 用的完整绝对时间，比展示文案多一档秒。输入非法时原样返回。 */
function formatTitle(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return `${formatAbsolute(value)}:${pad2(d.getSeconds())}`;
}

/**
 * 纯函数：把 value 相对 now 的时间差格式化为「刚刚 / x 分钟前 / x 小时前 / x 天前」。
 * now 由调用方注入，便于测试；不满一分钟以及未来时间统一显示「刚刚」。
 */
export function formatRelative(value: string, now: string | Date, locale = 'zh-CN'): string {
  const target = new Date(value);
  const base = toDate(now);
  if (Number.isNaN(target.getTime()) || Number.isNaN(base.getTime())) return value;
  const zh = locale.toLowerCase().startsWith('zh');
  const diffMs = base.getTime() - target.getTime();
  if (diffMs < 60_000) return zh ? '刚刚' : 'just now';
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60)
    return zh ? `${minutes} 分钟前` : `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return zh ? `${hours} 小时前` : `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return zh ? `${days} 天前` : `${days} day${days === 1 ? '' : 's'} ago`;
}

/** 等宽弱化色时间戳。title 属性永远是完整绝对时间，鼠标悬停可查证。 */
export function Timestamp({ value, mode = 'absolute', locale = 'zh-CN', now }: TimestampProps) {
  const text =
    mode === 'relative' ? formatRelative(value, now ?? new Date(), locale) : formatAbsolute(value);
  return (
    <time className="cb-timestamp" dateTime={value} title={formatTitle(value)}>
      {text}
    </time>
  );
}

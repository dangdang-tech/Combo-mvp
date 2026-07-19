import { useState } from 'react';
import './avatar.css';

export type AvatarSize = 'sm' | 'md' | 'lg';

export interface AvatarProps {
  /** 显示名，用于无障碍标签与首字母回退。 */
  name: string;
  /** 可选头像图片地址；缺失或加载失败时回退到首字母。 */
  src?: string;
  /** 尺寸变体，默认 md。 */
  size?: AvatarSize;
}

const HAN_RE = /\p{Script=Han}/u;

/**
 * 从显示名提取回退首字母：中文名取第一个字；
 * 英文名取首尾两个词的首字母并大写，单词名只取首字母。
 * 空白字符串返回空串。
 */
export function initialsOf(name: string): string {
  const trimmed = name.trim();
  if (trimmed === '') {
    return '';
  }
  const firstChar = Array.from(trimmed)[0];
  if (firstChar === undefined) {
    return '';
  }
  if (HAN_RE.test(firstChar)) {
    return firstChar;
  }
  const words = trimmed.split(/\s+/).filter((word) => word.length > 0);
  const firstWord = words[0];
  if (firstWord === undefined) {
    return '';
  }
  const firstInitial = Array.from(firstWord)[0] ?? '';
  if (words.length === 1) {
    return firstInitial.toUpperCase();
  }
  const lastWord = words[words.length - 1];
  const lastInitial = lastWord === undefined ? '' : (Array.from(lastWord)[0] ?? '');
  return (firstInitial + lastInitial).toUpperCase();
}

const FALLBACK_TONES = ['muted', 'accent', 'ok'] as const;

type FallbackTone = (typeof FALLBACK_TONES)[number];

/** 按 name 的稳定 hash 从三种柔和底色（muted-bg、accent-soft、ok-soft）中挑选一种。 */
function toneOf(name: string): FallbackTone {
  let hash = 0;
  for (const char of name) {
    hash = (hash * 31 + (char.codePointAt(0) ?? 0)) | 0;
  }
  return FALLBACK_TONES[Math.abs(hash) % FALLBACK_TONES.length] ?? 'muted';
}

/**
 * 圆形头像组件：有 src 时显示图片，src 缺失或加载失败时回退到首字母，
 * 回退底色按 name hash 稳定挑选。全部视觉状态可用纯 JSON props 表达。
 */
export function Avatar({ name, src, size = 'md' }: AvatarProps) {
  const [failedSrc, setFailedSrc] = useState<string | undefined>(undefined);
  const showImage = src !== undefined && src !== '' && src !== failedSrc;
  const toneClass = showImage ? '' : ` cb-avatar--tone-${toneOf(name)}`;
  return (
    <span className={`cb-avatar cb-avatar--${size}${toneClass}`} role="img" aria-label={name}>
      {showImage ? (
        <img className="cb-avatar-img" src={src} alt="" onError={() => setFailedSrc(src)} />
      ) : (
        <span className="cb-avatar-initials" aria-hidden="true">
          {initialsOf(name)}
        </span>
      )}
    </span>
  );
}

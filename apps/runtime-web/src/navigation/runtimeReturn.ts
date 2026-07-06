export const CREATOR_CAPABILITIES_PATH = '/capabilities';

const RETURN_TO_STORAGE_PREFIX = 'combo.runtime.returnTo:';

export interface RuntimeReturnStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function sessionStorageSafe(): RuntimeReturnStorage | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}

function storageKey(sessionId: string): string {
  return `${RETURN_TO_STORAGE_PREFIX}${sessionId}`;
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

export function safeRuntimeReturnTo(value: string | null | undefined): string | null {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return null;
  if (value.includes('\\')) return null; // 反斜杠规避：浏览器把 /\evil.com 按协议相对跳外站
  if (/^\/[a-z][a-z0-9+.-]*:/i.test(value)) return null; // scheme 走私（/javascript: 等）
  if (containsControlCharacter(value)) return null;
  return value;
}

export function rememberRuntimeReturnTo(
  sessionId: string | undefined,
  returnTo: string | null | undefined,
  storage: RuntimeReturnStorage | undefined = sessionStorageSafe(),
): void {
  const safe = safeRuntimeReturnTo(returnTo);
  if (!sessionId || !safe || !storage) return;
  try {
    storage.setItem(storageKey(sessionId), safe);
  } catch {
    // Storage may be unavailable in private browsing or blocked contexts.
  }
}

export function readRuntimeReturnTo(
  sessionId: string | undefined,
  storage: RuntimeReturnStorage | undefined = sessionStorageSafe(),
): string | null {
  if (!sessionId || !storage) return null;
  try {
    return safeRuntimeReturnTo(storage.getItem(storageKey(sessionId)));
  } catch {
    return null;
  }
}

export function appendRuntimeReturnTo(path: string, returnTo: string | null | undefined): string {
  const safe = safeRuntimeReturnTo(returnTo);
  if (!safe) return path;
  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}returnTo=${encodeURIComponent(safe)}`;
}

export function runtimeBackLabel(returnTo: string | null | undefined): string {
  return safeRuntimeReturnTo(returnTo) ? '← 返回发布页' : '← 返回我的能力';
}

export function runtimeBackTarget(returnTo: string | null | undefined): string {
  return safeRuntimeReturnTo(returnTo) ?? CREATOR_CAPABILITIES_PATH;
}

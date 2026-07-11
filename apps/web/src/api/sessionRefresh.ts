/**
 * 浏览器会话续期协调器。
 *
 * - 单页内用 inFlight 合并并发 401。
 * - 同源多 tab / 创作端与 runtime 用同一 Web Lock 串行旋转，避免共用旧 RT 竞态。
 * - refresh 一旦发出就不绑定页面 AbortSignal：Logto 可能已旋转 RT，必须让 Set-Cookie 有机会到达。
 */
export const AUTH_REFRESH_PATH = '/api/v1/auth/refresh';
export const AUTH_REFRESH_LOCK = 'combo-auth-refresh';

export type SessionRefreshResult = 'refreshed' | 'rejected' | 'error';

let inFlight: Promise<SessionRefreshResult> | null = null;

async function requestRefresh(): Promise<SessionRefreshResult> {
  try {
    const res = await fetch(AUTH_REFRESH_PATH, {
      method: 'POST',
      credentials: 'include',
    });
    if (res.ok) return 'refreshed';
    return res.status === 401 ? 'rejected' : 'error';
  } catch {
    return 'error';
  }
}

async function withCrossTabLock(): Promise<SessionRefreshResult> {
  if (typeof navigator !== 'undefined' && navigator.locks) {
    return navigator.locks.request(AUTH_REFRESH_LOCK, { mode: 'exclusive' }, requestRefresh);
  }
  return requestRefresh();
}

/** 全应用共享的最多一次续期；任何调用者都不会取得 token 本文。 */
export function refreshSession(): Promise<SessionRefreshResult> {
  if (inFlight) return inFlight;
  const pending = withCrossTabLock();
  const tracked = pending.finally(() => {
    if (inFlight === tracked) inFlight = null;
  });
  inFlight = tracked;
  return tracked;
}

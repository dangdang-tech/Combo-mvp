/**
 * 运行端会话续期协调器。锁名与创作端一致，因此同源多 tab 也只会串行旋转 RT。
 * refresh 请求不绑定页面的 AbortSignal，避免上游已旋转但 Set-Cookie 在到达前被取消。
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

export function refreshSession(): Promise<SessionRefreshResult> {
  if (inFlight) return inFlight;
  const pending = withCrossTabLock();
  const tracked = pending.finally(() => {
    if (inFlight === tracked) inFlight = null;
  });
  inFlight = tracked;
  return tracked;
}

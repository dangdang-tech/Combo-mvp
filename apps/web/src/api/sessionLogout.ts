import { API_PREFIX, LogoutResultSchema, envelopeSchema, type LogoutResult } from '@cb/shared';

/** 后端幂等登出入口：清本地会话 Cookie，并可返回 Logto end-session URL。 */
export const AUTH_LOGOUT_PATH = `${API_PREFIX}/auth/logout`;

const LogoutEnvelopeSchema = envelopeSchema(LogoutResultSchema);

/**
 * 清理当前浏览器会话。失败返回 null，调用方保留菜单并提供可重试的人话错误。
 * logout 不走通用 apiPost：该端点由后端明确豁免 Idempotency-Key，且必须携带 HttpOnly Cookie。
 */
export async function logoutSession(): Promise<LogoutResult | null> {
  try {
    const res = await fetch(AUTH_LOGOUT_PATH, {
      method: 'POST',
      credentials: 'include',
    });
    if (!res.ok) return null;
    return LogoutEnvelopeSchema.parse((await res.json()) as unknown).data;
  } catch {
    return null;
  }
}

/** 只跟随浏览器可安全导航的 HTTP(S) 登出地址；其他 scheme 一律回站内登录页。 */
export function logoutDestination(result: LogoutResult): string {
  if (!result.logoutUrl) return '/login';
  try {
    const destination = new URL(result.logoutUrl);
    return destination.protocol === 'http:' || destination.protocol === 'https:'
      ? result.logoutUrl
      : '/login';
  } catch {
    return '/login';
  }
}

/**
 * 登出成功后必须整页离开受保护应用，清掉内存中的 /me 缓存。
 * 有上游 end-session URL 时跟随它，否则回站内登录页。
 */
export function completeLogout(
  result: LogoutResult,
  navigate: (url: string) => void = (url) => window.location.assign(url),
): void {
  navigate(logoutDestination(result));
}

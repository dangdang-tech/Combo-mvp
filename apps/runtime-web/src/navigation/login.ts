// 创作端登录入口（同源 Cookie cb_session 由创作端签发；登录完成跳回当前页）。
export const AUTH_LOGIN_PATH = '/api/v1/auth/login';

function safeLoginReturnTo(value: string): string {
  return value.startsWith('/') && !value.startsWith('//') ? value : '/try/';
}

/**
 * 登录后回到当前 runtime 深链（含 query），从 /try/c/:capabilityId 发起认证时不会丢能力。
 * 可注入 returnTo 便于单测；生产调用不传值时读取浏览器当前位置。
 */
export function loginUrl(returnTo?: string): string {
  const current = returnTo ?? `${window.location.pathname}${window.location.search}`;
  const target = safeLoginReturnTo(current || '/try/');
  return `${AUTH_LOGIN_PATH}?returnTo=${encodeURIComponent(target)}`;
}

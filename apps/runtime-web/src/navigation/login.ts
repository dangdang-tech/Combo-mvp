// 创作端登录入口（同源 Cookie cb_session 由创作端签发；登录完成跳回当前页）。
export const AUTH_LOGIN_PATH = '/api/v1/auth/login';

export function loginUrl(): string {
  const returnTo = window.location.pathname + window.location.search;
  return `${AUTH_LOGIN_PATH}?returnTo=${encodeURIComponent(returnTo || '/try/')}`;
}

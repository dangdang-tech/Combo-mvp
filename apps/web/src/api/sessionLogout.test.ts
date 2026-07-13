import { afterEach, describe, expect, it, vi } from 'vitest';
import { installFetchMock, type FetchMock } from '../test/mockFetch.js';
import {
  AUTH_LOGOUT_PATH,
  completeLogout,
  logoutDestination,
  logoutSession,
} from './sessionLogout.js';

let fetchMock: FetchMock | undefined;

afterEach(() => {
  fetchMock?.restore();
  fetchMock = undefined;
  vi.restoreAllMocks();
});

describe('logoutSession', () => {
  it('POST 同源登出端点并携带 HttpOnly 会话 Cookie', async () => {
    fetchMock = installFetchMock({
      status: 200,
      json: { data: { loggedOut: true }, meta: { traceId: 'logout-1' } },
    });

    await expect(logoutSession()).resolves.toEqual({ loggedOut: true });
    expect(fetchMock.calls).toEqual([
      {
        url: AUTH_LOGOUT_PATH,
        method: 'POST',
        headers: {},
        body: undefined,
        credentials: 'include',
      },
    ]);
  });

  it('保留后端返回的 Logto end-session URL', async () => {
    const logoutUrl = 'https://auth.example/oidc/session/end?client_id=combo';
    fetchMock = installFetchMock({
      status: 200,
      json: { data: { loggedOut: true, logoutUrl }, meta: {} },
    });

    await expect(logoutSession()).resolves.toEqual({ loggedOut: true, logoutUrl });
  });

  it.each([
    { name: 'HTTP 错误', response: { status: 503 } },
    { name: '网络错误', response: { networkError: true } },
    { name: '畸形响应', response: { status: 200, json: { data: { loggedOut: false } } } },
  ])('$name 返回 null，让 UI 保留可重试错误', async ({ response }) => {
    fetchMock = installFetchMock(response);
    await expect(logoutSession()).resolves.toBeNull();
  });
});

describe('completeLogout', () => {
  it('有上游登出地址时整页跟随该地址', () => {
    const navigate = vi.fn<(url: string) => void>();
    const logoutUrl = 'https://auth.example/oidc/session/end?client_id=combo';

    completeLogout({ loggedOut: true, logoutUrl }, navigate);

    expect(navigate).toHaveBeenCalledWith(logoutUrl);
  });

  it('没有上游登出地址时整页回站内登录页', () => {
    const navigate = vi.fn<(url: string) => void>();

    completeLogout({ loggedOut: true }, navigate);

    expect(navigate).toHaveBeenCalledWith('/login');
  });

  it.each(['javascript:alert(1)', 'data:text/html,logout', 'ftp://auth.example/logout'])(
    '拒绝非 HTTP(S) 登出地址 %s，并回站内登录页',
    (logoutUrl) => {
      const navigate = vi.fn<(url: string) => void>();

      completeLogout({ loggedOut: true, logoutUrl }, navigate);

      expect(navigate).toHaveBeenCalledWith('/login');
    },
  );

  it('只允许绝对 HTTP(S) 登出地址', () => {
    expect(logoutDestination({ loggedOut: true, logoutUrl: 'http://localhost/logout' })).toBe(
      'http://localhost/logout',
    );
    expect(logoutDestination({ loggedOut: true, logoutUrl: 'not a url' })).toBe('/login');
  });
});

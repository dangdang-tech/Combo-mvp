import { describe, expect, it } from 'vitest';
import { AUTH_LOGIN_PATH, loginUrl } from './login.js';

describe('runtime login navigation', () => {
  it('preserves the exact capability deep link as the authentication returnTo', () => {
    const returnTo = '/try/c/11111111-1111-4111-8111-111111111111?returnTo=%2Fa%2Fcap-wskatc';

    expect(loginUrl(returnTo)).toBe(`${AUTH_LOGIN_PATH}?returnTo=${encodeURIComponent(returnTo)}`);
  });

  it('rejects external and protocol-relative return targets', () => {
    expect(loginUrl('https://evil.example/path')).toBe(
      `${AUTH_LOGIN_PATH}?returnTo=${encodeURIComponent('/try/')}`,
    );
    expect(loginUrl('//evil.example/path')).toBe(
      `${AUTH_LOGIN_PATH}?returnTo=${encodeURIComponent('/try/')}`,
    );
  });
});

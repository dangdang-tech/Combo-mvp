// 路由注册自检：端点总数、无重复、写命令带守卫、助手端点豁免登录。
import { describe, it, expect } from 'vitest';
import { ALL_ENDPOINTS } from '../bootstrap/routes.js';

describe('route registry self-check', () => {
  it('registers exactly 15 endpoints (account 4 + task 7 + capability 4;dev-login 条件注册不进表)', () => {
    expect(ALL_ENDPOINTS).toHaveLength(15);
  });

  it('no duplicate (method,url) pairs', () => {
    const seen = new Set<string>();
    for (const ep of ALL_ENDPOINTS) {
      const key = `${String(ep.method)} ${ep.url}`;
      expect(seen.has(key), `duplicate route: ${key}`).toBe(false);
      seen.add(key);
    }
  });

  it('写命令（非 GET）除登录/助手上传外都带守卫链', () => {
    // /auth/*：登录流程本身；/connect/upload：助手侧凭配对码鉴权（handler 内验码），无登录态。
    const exempt = new Set(['/auth/logout', '/connect/upload']);
    for (const ep of ALL_ENDPOINTS) {
      if (ep.method === 'GET' || exempt.has(ep.url)) continue;
      expect(
        (ep.preHandlers ?? []).length,
        `${String(ep.method)} ${ep.url} 缺守卫`,
      ).toBeGreaterThan(0);
    }
  });

  it('助手侧端点不要求登录（无 requireAuth 前置）', () => {
    const connect = ALL_ENDPOINTS.filter((ep) => ep.url.startsWith('/connect/'));
    expect(connect.length).toBeGreaterThanOrEqual(2);
    for (const ep of connect) {
      expect(ep.preHandlers ?? []).toHaveLength(0);
    }
  });
});

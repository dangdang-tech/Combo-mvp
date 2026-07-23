// 路由注册自检：端点总数、无重复、写命令带守卫、助手端点豁免登录。
import { describe, it, expect } from 'vitest';
import { ALL_ENDPOINTS } from '../bootstrap/routes.js';

describe('route registry self-check', () => {
  it('registers exactly 21 endpoints (account 5 + task 12 + capability 4；dev-login 条件注册不进表)', () => {
    expect(ALL_ENDPOINTS).toHaveLength(21);
  });

  it('no duplicate (method,url) pairs', () => {
    const seen = new Set<string>();
    for (const ep of ALL_ENDPOINTS) {
      const key = `${String(ep.method)} ${ep.url}`;
      expect(seen.has(key), `duplicate route: ${key}`).toBe(false);
      seen.add(key);
    }
  });

  it('写命令（非 GET）除助手上传外都带守卫链', () => {
    // /auth/*：登录流程本身；connect 端点和 local claim 在 handler 内验短期绑定码，无登录态。
    // refresh/logout 不挂 requireAuth，但必须挂 Cookie 变更来源守卫。
    const exempt = new Set([
      '/connect/prepare',
      '/connect/upload',
      '/tasks/:taskId/local-execution/claim',
    ]);
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

  it('Cookie 变更来源守卫排在 refresh/logout 的 handler 与宽松鉴权之前', () => {
    const refresh = ALL_ENDPOINTS.find((ep) => ep.url === '/auth/refresh');
    const logout = ALL_ENDPOINTS.find((ep) => ep.url === '/auth/logout');

    expect(refresh?.preHandlers).toHaveLength(1);
    expect(logout?.preHandlers).toHaveLength(2);
  });
});

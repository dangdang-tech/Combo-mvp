// 路由注册自检：端点总数 + 方法分布 + 全 22 幂等 scope 被引用（守门，脊柱 §2/§4）。
import { describe, it, expect } from 'vitest';
import { REQUIRED_IDEMPOTENCY_SCOPES, type IdempotencyScopeValue } from '@cb/shared';
import { ALL_ENDPOINTS } from '../bootstrap/routes.js';
import { requireIdempotency } from '../platform/middleware/idempotency.js';

describe('route registry self-check', () => {
  it('registers the full contract endpoint set (55 in-scope callable endpoints)', () => {
    // contracts/_index.md §2.1–§2.8 全端点一览：52 + 草稿生命周期 2（POST /drafts bootstrap、
    //   GET /drafts/:draftId 续传 hydrate，脊柱 §8 / Codex phase4c P0-2）+ B-21 引导二进制下发 1
    //   （GET /import/connect/bin/:asset，公开匿名引导产物、与 /connect/script 同级）= 55 个本期可调用端点
    // （§2.9 的 3 个消费链路读端点本期范围外、仅冻结、不计入）。
    expect(ALL_ENDPOINTS).toHaveLength(55);
  });

  it('every endpoint has a method and an absolute url path', () => {
    for (const ep of ALL_ENDPOINTS) {
      expect(ep.method).toBeTruthy();
      expect(typeof ep.url).toBe('string');
      expect(ep.url.startsWith('/')).toBe(true);
    }
  });

  it('no duplicate (method,url) pairs', () => {
    const seen = new Set<string>();
    for (const ep of ALL_ENDPOINTS) {
      const key = `${String(ep.method)} ${ep.url}`;
      expect(seen.has(key), `duplicate route: ${key}`).toBe(false);
      seen.add(key);
    }
  });

  it('all 23 required idempotency scopes are valid scope values', () => {
    // 守门：23 写端点 scope 表完整（脊柱 §4.1；含草稿 bootstrap draft.create）。requireIdempotency 接受每个 scope 不抛。
    expect(REQUIRED_IDEMPOTENCY_SCOPES).toHaveLength(23);
    for (const scope of REQUIRED_IDEMPOTENCY_SCOPES as IdempotencyScopeValue[]) {
      expect(() => requireIdempotency(scope)).not.toThrow();
    }
  });

  it('write commands (POST/PATCH/DELETE) carry preHandlers (auth/idempotency guards)', () => {
    // 除显式豁免（/auth/login、/auth/callback、/import/connect/script、/auth/logout 幂等豁免），
    // 写命令必有守卫链。此处校验所有非 GET 端点都挂了至少一个 preHandler。
    const writes = ALL_ENDPOINTS.filter((ep) => ep.method !== 'GET');
    for (const ep of writes) {
      expect(
        (ep.preHandlers?.length ?? 0) > 0,
        `write route missing guards: ${String(ep.method)} ${ep.url}`,
      ).toBe(true);
    }
  });
});

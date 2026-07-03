// dev-login 条件注册 wiring 自检（端到端经 buildApp，无 Docker）：
//   - 默认（DEV_LOGIN_ENABLED 未开）：POST /api/v1/auth/dev-login → 404（端点根本不注册，走 notFound）；
//   - 开启（dev + 开关 + 密钥）：路由【存在】（命中 handler；provision 因无真 PG 失败 → 500，绝非 404）——
//     证明条件注册生效（route reached），且对外信封无 code（D1）。
// 不需要真 PG：只验「路由是否被注册/命中」，不验业务成功（业务成功属 live 测试）。
import { describe, it, expect, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../bootstrap/app.js';
import { loadEnv, type Env } from '../platform/config/env.js';

const DEV_LOGIN_URL = '/api/v1/auth/dev-login';

let app: FastifyInstance | undefined;

afterEach(async () => {
  if (app) {
    await app.close();
    app = undefined;
  }
});

/** 以真实 loadEnv 为基（含 infra 客户端所需全字段），仅覆写 dev-login 相关字段。 */
function envWith(overrides: Partial<Env>): Env {
  return { ...loadEnv(), ...overrides };
}

describe('dev-login 条件注册（buildApp wiring）', () => {
  it('开关关 → POST /auth/dev-login 不存在（404，notFound 信封无 code）', async () => {
    app = await buildApp({ env: envWith({ NODE_ENV: 'test', DEV_LOGIN_ENABLED: false }) });
    await app.ready();
    const res = await app.inject({ method: 'POST', url: DEV_LOGIN_URL, payload: {} });
    expect(res.statusCode).toBe(404);
    const body = res.json() as { error: Record<string, unknown> };
    expect(body.error).not.toHaveProperty('code'); // D1
  });

  it('生产（即便误配开关开）→ 仍 404（env.ts 强制关 + 不注册）', async () => {
    // 注意：用 buildApp 注入 env（绕过 loadEnv 生产必填校验）；env.ts 的强制关在 loadEnv 内，
    //   此处直接构造 production env 验「不注册」这一层（devLoginAvailable 守卫 1）。
    app = await buildApp({
      env: envWith({ NODE_ENV: 'production', DEV_LOGIN_ENABLED: true, DEV_SESSION_SECRET: 's' }),
    });
    await app.ready();
    const res = await app.inject({ method: 'POST', url: DEV_LOGIN_URL, payload: {} });
    expect(res.statusCode).toBe(404); // 生产恒不注册（devLoginAvailable=false）
  });

  it('开启（dev + 开关 + 密钥）→ 路由存在并命中 handler（非 404；无真 PG → 500，信封无 code）', async () => {
    app = await buildApp({
      env: envWith({
        NODE_ENV: 'test',
        DEV_LOGIN_ENABLED: true,
        DEV_SESSION_SECRET: 'dev-secret-wiring-0123456789',
      }),
    });
    await app.ready();
    const res = await app.inject({ method: 'POST', url: DEV_LOGIN_URL, payload: {} });
    // 路由存在 → 命中 handler；provision 因无真 PG 抛 → 500（绝非 404 的「不存在」）。
    expect(res.statusCode).not.toBe(404);
    expect([500, 503]).toContain(res.statusCode);
    const body = res.json() as { error: Record<string, unknown> };
    expect(body.error).not.toHaveProperty('code'); // D1
  });
});

import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../bootstrap/app.js';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe('api skeleton', () => {
  it('GET /health → ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('GET /ready → returns six dependency structure (db/redis×2/minio/logto/llm)', async () => {
    const res = await app.inject({ method: 'GET', url: '/ready' });
    // 骨架阶段无真实依赖：required 探针 down → 503；结构必须齐全（六依赖）。
    const body = res.json() as {
      data: { ready: boolean; status: string; dependencies: Array<{ name: string }> };
    };
    expect([200, 503]).toContain(res.statusCode);
    expect(body.data.dependencies).toHaveLength(6);
    expect(body.data.dependencies.map((d) => d.name)).toEqual([
      'db',
      'redis_queue',
      'redis_hot',
      'minio',
      'logto',
      'llm',
    ]);
  }, 15_000); // 探针并发、各自 ≤2s 超时；给宽裕 totale 上限避免无 Docker 环境抖动。

  it('GET /auth/login → 302 redirect (contract behavior, no longer 501)', async () => {
    // /auth/login 已是真实 Logto 登录流（10-auth §3.1）：302 跳授权端点；
    // 无 Docker/真 Logto 环境下 discovery 不可达 → 仍 302（降级回 /login，不裸返 JSON 错）。
    const res = await app.inject({ method: 'GET', url: '/api/v1/auth/login' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBeTruthy();
    // 绝不在重定向 URL 暴露内部 code/状态码（脊柱 §11.B）。
    expect(String(res.headers.location)).not.toMatch(/\b[1-5]\d{2}\b/);
  });

  it('requireAuth endpoint without token → 401 ErrorEnvelope (no code, D1)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/me' });
    expect(res.statusCode).toBe(401);
    const body = res.json() as { error: Record<string, unknown> };
    // D1：对外信封不含 code；可展示字段 userMessage + action（escalate）。
    expect(body.error).not.toHaveProperty('code');
    expect(body.error.action).toBe('escalate');
    expect(body.error.userMessage).toBeTruthy();
  });

  it('write command missing Idempotency-Key → 401 first (auth before idempotency)', async () => {
    // /notifications/read-all 需 requireAuth；无 token 先撞 401（鉴权在幂等之前）。
    const res = await app.inject({ method: 'POST', url: '/api/v1/notifications/read-all' });
    expect(res.statusCode).toBe(401);
  });

  it('unknown route → 404 ErrorEnvelope (no code, D1)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/nope' });
    expect(res.statusCode).toBe(404);
    const body = res.json() as { error: Record<string, unknown> };
    expect(body.error).not.toHaveProperty('code');
    expect(body.error.userMessage).toBeTruthy();
  });

  it('x-trace-id header present on responses (脊柱 §3.4 反馈代码)', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.headers['x-trace-id']).toBeTruthy();
  });

  it('inherits x-trace-id and emits traceparent response header', async () => {
    const traceId = '123e4567-e89b-12d3-a456-426614174000';
    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-trace-id': traceId },
    });
    expect(res.headers['x-trace-id']).toBe(traceId);
    expect(String(res.headers['traceparent'])).toContain('123e4567e89b12d3a456426614174000');
  });
});

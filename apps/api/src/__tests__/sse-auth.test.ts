// SSE 鉴权契约自检（脊柱 §11.C / Codex#4）：SSE 端点仅同源 Cookie，禁 Authorization / query token。
//   无真实 Logto/PG 环境：所有未携带【有效会话 Cookie】的 SSE 请求都应在【建流前】返 401 HTTP ErrorEnvelope
//   （不走 SSE error 帧、不裸露 code，D1）。携带 Bearer / query token 的来源被显式拒绝（不静默回落 Cookie）。
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { loadEnv } from '../config/env.js';
import { clearJwksCache } from '../infra/logto.js';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

const JOB_SSE = '/api/v1/jobs/00000000-0000-0000-0000-000000000000/events';
const STRUCT_SSE = '/api/v1/versions/00000000-0000-0000-0000-000000000000/structure/events';

function expectNoCodeEnvelope(res: { json: () => unknown }): void {
  const body = res.json() as { error: Record<string, unknown> };
  expect(body.error).not.toHaveProperty('code'); // D1
  expect(body.error.userMessage).toBeTruthy();
  // 鉴权失败一律 escalate（401/503 同口径，10-auth §4.4）。
  expect(body.error.action).toBe('escalate');
}

describe('SSE auth (same-origin Cookie only, 脊柱 §11.C)', () => {
  it('job SSE without any credential → 401 (建流前 HTTP，非 error 帧)', async () => {
    const res = await app.inject({ method: 'GET', url: JOB_SSE });
    expect(res.statusCode).toBe(401);
    // 不是 text/event-stream：鉴权失败在建流前。
    expect(res.headers['content-type']).not.toContain('text/event-stream');
    expectNoCodeEnvelope(res);
  });

  it('job SSE with Authorization Bearer → 401 (拒绝非 Cookie 来源)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: JOB_SSE,
      headers: { authorization: 'Bearer some.jwt.token' },
    });
    expect(res.statusCode).toBe(401);
    expectNoCodeEnvelope(res);
  });

  it('job SSE with query-string token → 401 (禁 query token)', async () => {
    const res = await app.inject({ method: 'GET', url: `${JOB_SSE}?token=some.jwt.token` });
    expect(res.statusCode).toBe(401);
    expectNoCodeEnvelope(res);
  });

  it('structure SSE without credential → 401', async () => {
    const res = await app.inject({ method: 'GET', url: STRUCT_SSE });
    expect(res.statusCode).toBe(401);
    expectNoCodeEnvelope(res);
  });

  it('structure SSE with malformed Cookie token → 401 (无法解析 = token 真无效)', async () => {
    // 不可解析的 token（非合法 JWS）→ jose 解析即失败、根本不取 JWKS → token 真无效 → 401。
    const res = await app.inject({
      method: 'GET',
      url: STRUCT_SSE,
      cookies: { cb_session: 'invalid.session.token' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).not.toContain('text/event-stream');
    expectNoCodeEnvelope(res);
  });

  it('structure SSE with well-formed JWT but JWKS unreachable → 503 (上游不可达≠token无效, Codex#3)', async () => {
    // 结构合法的 JWT（header.payload.signature 均 base64url）→ jose 解析成功、需取 JWKS 验签 →
    //   Logto/JWKS 不可达 → 验不了（上游不可达）→ 503 AUTH_UPSTREAM_UNAVAILABLE
    //   （区分「token 真无效」的 401；不裸露原始报错、不含 code，D1）。
    //
    // 隔离根因（live 抓到）：不能依赖运行环境「Logto 恰好离线」——dev stack 跑着 Logto 时
    //   localhost:3001 反而可达，JWKS 取得到、验签失败 → 401，用例不自洽。这里用一个【独立 app】，
    //   把 LOGTO_ISSUER / LOGTO_JWKS_URI 指向一个【必然连不上】的本地端口（127.0.0.1:1），
    //   让 discovery 探针与 jose 的 JWKS fetch 都确定地 ECONNREFUSED（上游不可达），
    //   从而 handler 在【任何环境】都稳定走 503 路径，不再依赖外部 Logto 是否在线。
    const UNREACHABLE_ISSUER = 'http://127.0.0.1:1/oidc';
    const UNREACHABLE_JWKS = 'http://127.0.0.1:1/oidc/jwks';
    // jwksCache 按 jwks_uri 缓存远端集；本用例用独立 URI（127.0.0.1:1）天然不与 localhost:3001 撞，
    //   仍先清一次确保不串台（防其它用例/环境预热同 URI 的缓存）。
    clearJwksCache();
    const unreachableApp = await buildApp({
      env: { ...loadEnv(), LOGTO_ISSUER: UNREACHABLE_ISSUER, LOGTO_JWKS_URI: UNREACHABLE_JWKS },
    });
    await unreachableApp.ready();
    try {
      const b64u = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');
      const header = b64u({ alg: 'RS256', typ: 'JWT', kid: 'test-kid' });
      const payload = b64u({
        sub: 'logto-user-1',
        iss: UNREACHABLE_ISSUER,
        exp: Math.floor(Date.now() / 1000) + 3600,
      });
      const sig = Buffer.from('not-a-real-signature').toString('base64url');
      const wellFormedJwt = `${header}.${payload}.${sig}`;
      const res = await unreachableApp.inject({
        method: 'GET',
        url: STRUCT_SSE,
        cookies: { cb_session: wellFormedJwt },
      });
      expect(res.statusCode).toBe(503);
      expect(res.headers['content-type']).not.toContain('text/event-stream');
      expectNoCodeEnvelope(res);
    } finally {
      await unreachableApp.close();
      // 清掉本用例制造的不可达 JWKS 缓存条目，避免泄漏到后续用例/套件。
      clearJwksCache();
    }
  });
});

import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../platform/config/env.js';
import type { InfraContext } from '../platform/infra/index.js';
import {
  canonicalBrowserOrigin,
  corsOriginPolicy,
  requireTrustedMutationOrigin,
} from '../platform/http/browser-origin.js';

const productionEnv = {
  NODE_ENV: 'production',
  LOGTO_REDIRECT_URI: 'https://combo.example/api/v1/auth/callback',
} as Env;

const developmentEnv = {
  NODE_ENV: 'development',
  LOGTO_REDIRECT_URI: 'http://localhost/api/v1/auth/callback',
} as Env;

const apps: FastifyInstance[] = [];

async function corsApp(env: Env): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  apps.push(app);
  await app.register(cors, { origin: corsOriginPolicy(env), credentials: true });
  app.get('/probe', async () => ({ ok: true }));
  return app;
}

async function mutationApp(env: Env, handler: ReturnType<typeof vi.fn>): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  apps.push(app);
  app.decorate('infra', { env } as InfraContext);
  app.post('/mutate', { preHandler: requireTrustedMutationOrigin() }, async (_req, reply) => {
    handler();
    return reply.code(204).send();
  });
  return app;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('browser origin policy', () => {
  it('derives the canonical origin without retaining path or query', () => {
    expect(canonicalBrowserOrigin(productionEnv)).toBe('https://combo.example');
    expect(
      canonicalBrowserOrigin({
        NODE_ENV: 'production',
        LOGTO_REDIRECT_URI: 'https://combo.example:8443/api/callback?q=1#done',
      }),
    ).toBe('https://combo.example:8443');
  });

  it('fails closed on a non-HTTP redirect URI without echoing its value', () => {
    expect(() =>
      canonicalBrowserOrigin({
        NODE_ENV: 'production',
        LOGTO_REDIRECT_URI: 'javascript:secret-value',
      }),
    ).toThrowError('LOGTO_REDIRECT_URI');

    try {
      canonicalBrowserOrigin({
        NODE_ENV: 'production',
        LOGTO_REDIRECT_URI: 'javascript:secret-value',
      });
    } catch (error) {
      expect(String(error)).not.toContain('secret-value');
    }
  });

  it('reflects only the production canonical origin in Fastify CORS responses', async () => {
    const app = await corsApp(productionEnv);

    const canonical = await app.inject({
      method: 'OPTIONS',
      url: '/probe',
      headers: {
        origin: 'https://combo.example',
        'access-control-request-method': 'GET',
      },
    });
    expect(canonical.statusCode).toBe(204);
    expect(canonical.headers['access-control-allow-origin']).toBe('https://combo.example');
    expect(canonical.headers['access-control-allow-credentials']).toBe('true');

    const sameSiteSibling = await app.inject({
      method: 'GET',
      url: '/probe',
      headers: { origin: 'https://admin.combo.example' },
    });
    expect(sameSiteSibling.statusCode).toBe(200);
    expect(sameSiteSibling.headers['access-control-allow-origin']).toBeUndefined();
    expect(sameSiteSibling.headers['access-control-allow-credentials']).toBeUndefined();

    const cli = await app.inject({ method: 'GET', url: '/probe' });
    expect(cli.statusCode).toBe(200);
    expect(cli.headers['access-control-allow-origin']).toBeUndefined();
  });

  it.each([
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'http://localhost:5174',
    'http://127.0.0.1:5174',
  ])('allows the fixed local Vite origin in development: %s', async (origin) => {
    const app = await corsApp(developmentEnv);
    const response = await app.inject({ method: 'GET', url: '/probe', headers: { origin } });

    expect(response.statusCode).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBe(origin);
  });

  it('does not allow an unlisted local port in development', async () => {
    const app = await corsApp(developmentEnv);
    const response = await app.inject({
      method: 'GET',
      url: '/probe',
      headers: { origin: 'http://localhost:5175' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('cookie mutation origin guard', () => {
  it('allows the exact production origin and an Origin-less CLI request', async () => {
    const handler = vi.fn();
    const app = await mutationApp(productionEnv, handler);

    const browser = await app.inject({
      method: 'POST',
      url: '/mutate',
      headers: { origin: 'https://combo.example', 'sec-fetch-site': 'same-origin' },
    });
    const cli = await app.inject({ method: 'POST', url: '/mutate' });

    expect(browser.statusCode).toBe(204);
    expect(cli.statusCode).toBe(204);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      name: 'same-site sibling origin',
      headers: { origin: 'https://admin.combo.example', 'sec-fetch-site': 'same-site' },
    },
    {
      name: 'cross-site metadata even with a matching Origin',
      headers: { origin: 'https://combo.example', 'sec-fetch-site': 'cross-site' },
    },
    { name: 'same-site metadata without Origin', headers: { 'sec-fetch-site': 'same-site' } },
    { name: 'unknown fetch metadata', headers: { 'sec-fetch-site': 'surprise-site' } },
  ])('rejects $name before the handler with a safe envelope', async ({ headers }) => {
    const handler = vi.fn();
    const app = await mutationApp(productionEnv, handler);
    const response = await app.inject({ method: 'POST', url: '/mutate', headers });

    expect(response.statusCode).toBe(403);
    expect(handler).not.toHaveBeenCalled();
    expect(response.json()).toEqual({
      error: expect.objectContaining({
        action: 'escalate',
        retriable: false,
        traceId: expect.any(String),
        userMessage: expect.any(String),
      }),
    });
    expect(response.body).not.toContain('FORBIDDEN');
    expect(response.body).not.toContain('combo.example');
  });

  it('allows only the explicitly listed local frontend origin in development', async () => {
    const handler = vi.fn();
    const app = await mutationApp(developmentEnv, handler);

    const allowed = await app.inject({
      method: 'POST',
      url: '/mutate',
      headers: { origin: 'http://localhost:5173', 'sec-fetch-site': 'same-site' },
    });
    const rejected = await app.inject({
      method: 'POST',
      url: '/mutate',
      headers: { origin: 'http://localhost:5175', 'sec-fetch-site': 'same-site' },
    });

    expect(allowed.statusCode).toBe(204);
    expect(rejected.statusCode).toBe(403);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

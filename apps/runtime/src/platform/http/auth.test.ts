import { SignJWT } from 'jose';
import type { FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import type { Env } from '../config/env.js';
import { resolveCookieAuth } from './auth.js';

const env: Env = {
  NODE_ENV: 'test',
  PORT: 3100,
  HOST: '127.0.0.1',
  LOG_LEVEL: 'fatal',
  DATABASE_URL: 'postgres://test',
  ANTHROPIC_API_KEY: '',
  OPENROUTER_API_KEY: '',
  RUNTIME_LLM_MODEL: '',
  CORS_ORIGIN: '',
  LOGTO_ISSUER: 'http://logto.example/oidc',
  LOGTO_JWKS_URI: 'http://logto.example/oidc/jwks',
  LOGTO_AUDIENCE: '',
  DEV_LOGIN_ENABLED: true,
  DEV_SESSION_SECRET: 'test-secret',
};

function reqWithCookie(token?: string): FastifyRequest {
  return { cookies: token ? { cb_session: token } : {} } as unknown as FastifyRequest;
}

function poolReturning(row: unknown): Pool {
  return {
    query: async () => ({ rows: row ? [row] : [] }),
  } as unknown as Pool;
}

async function signDevToken(args: {
  sub: string;
  roles: string[];
  username: string;
}): Promise<string> {
  return new SignJWT({ roles: args.roles, username: args.username })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(args.sub)
    .setIssuer('cb-dev-login')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(env.DEV_SESSION_SECRET));
}

describe('runtime cb_session auth', () => {
  it('returns anonymous without cb_session', async () => {
    const res = await resolveCookieAuth(reqWithCookie(), poolReturning(null), env);
    expect(res.kind).toBe('anonymous');
  });

  it('maps a dev cb_session to business users.id', async () => {
    const token = await signDevToken({
      sub: 'dev|wayne',
      roles: ['creator'],
      username: 'wayne',
    });
    const res = await resolveCookieAuth(
      reqWithCookie(token),
      poolReturning({
        id: 'user-1',
        roles: ['creator'],
        status: 'active',
        account: 'wayne',
      }),
      env,
    );
    expect(res).toEqual({
      kind: 'ok',
      identity: { userId: 'user-1', roles: ['creator'], account: 'wayne' },
    });
  });

  it('rejects disabled users after token verification', async () => {
    const token = await signDevToken({
      sub: 'dev|blocked',
      roles: ['creator'],
      username: 'blocked',
    });
    const res = await resolveCookieAuth(
      reqWithCookie(token),
      poolReturning({
        id: 'user-2',
        roles: ['creator'],
        status: 'disabled',
        account: 'blocked',
      }),
      env,
    );
    expect(res.kind).toBe('disabled');
  });
});

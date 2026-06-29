// 10 · Logto OIDC 流纯函数自检（B-08，10-auth §3.1/§3.2）：PKCE / returnTo 白名单 / nonce 取值 / 501 占位。
//   纯函数无依赖（不碰网络）：PKCE S256 确定性、returnTo open-redirect 防护、id_token nonce 解析、notImplemented 信封。
import { describe, it, expect } from 'vitest';
import {
  pkceChallengeS256,
  randomToken,
  sanitizeReturnTo,
  readNonceFromIdToken,
} from '../infra/logto-oidc.js';
import { notImplemented } from '../routes/_helpers.js';
import type { FastifyReply, FastifyRequest } from 'fastify';

describe('PKCE S256 (10-auth §3.1)', () => {
  it('同一 verifier 产出确定 challenge（base64url，无填充）', () => {
    const v = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const c = pkceChallengeS256(v);
    // RFC 7636 已知向量。
    expect(c).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
    expect(c).not.toMatch(/[+/=]/); // base64url：无 + / =
  });

  it('randomToken 高熵且每次不同', () => {
    const a = randomToken();
    const b = randomToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(32);
    expect(a).not.toMatch(/[+/=]/);
  });
});

describe('sanitizeReturnTo open-redirect 防护 (10-auth §3.1)', () => {
  it('站内相对路径放行', () => {
    expect(sanitizeReturnTo('/creator/dashboard')).toBe('/creator/dashboard');
    expect(sanitizeReturnTo('/me')).toBe('/me');
  });
  it('外站 / 协议相对 / scheme / 反斜杠 → 降级 /creator', () => {
    expect(sanitizeReturnTo('https://evil.com')).toBe('/creator');
    expect(sanitizeReturnTo('//evil.com')).toBe('/creator');
    expect(sanitizeReturnTo('/\\evil.com')).toBe('/creator');
    expect(sanitizeReturnTo('/javascript:alert(1)')).toBe('/creator');
  });
  it('缺省 / 超长 → 降级 /creator', () => {
    expect(sanitizeReturnTo(undefined)).toBe('/creator');
    expect(sanitizeReturnTo('/' + 'a'.repeat(600))).toBe('/creator');
  });
});

describe('readNonceFromIdToken (10-auth §3.2)', () => {
  it('从 JWT payload 取 nonce', () => {
    const payload = Buffer.from(JSON.stringify({ nonce: 'NONCE-1', sub: 's' })).toString(
      'base64url',
    );
    const jwt = `header.${payload}.sig`;
    expect(readNonceFromIdToken(jwt)).toBe('NONCE-1');
  });
  it('畸形 token / 无 nonce → null', () => {
    expect(readNonceFromIdToken('not-a-jwt')).toBeNull();
    const noNonce = Buffer.from(JSON.stringify({ sub: 's' })).toString('base64url');
    expect(readNonceFromIdToken(`h.${noNonce}.s`)).toBeNull();
  });
});

describe('notImplemented 501 占位信封（绝不裸露 code，脊柱 §11.B）', () => {
  it('501 + ErrorEnvelope（action:wait，无 code）', () => {
    let code: number | undefined;
    let body: unknown;
    const reply = {
      code: (c: number) => {
        code = c;
        return reply;
      },
      send: (b: unknown) => {
        body = b;
        return reply;
      },
    } as unknown as FastifyReply;
    const req = { id: 'trace-501' } as unknown as FastifyRequest;
    notImplemented(req, reply);
    expect(code).toBe(501);
    const env = (body as { error: Record<string, unknown> }).error;
    expect(env).not.toHaveProperty('code'); // D1
    expect(env.action).toBe('wait');
    expect(env.userMessage).toBeTruthy();
  });
});

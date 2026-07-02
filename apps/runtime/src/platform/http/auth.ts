// runtime 侧 trial 鉴权：复用 authoring 写入的 cb_session，但不 import authoring 代码。
// trial 路径必须是已登录 creator；consume 路径优先使用登录用户 owner，失败/匿名则回落 rt_uid。
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { ErrorCode, RoleSchema, type Role } from '@cb/shared';
import type { Env } from '../config/env.js';
import { sendError } from './errors.js';
import { resolveOwnerId as resolveAnonymousOwnerId } from './identity.js';

const SESSION_COOKIE = 'cb_session';
const DEV_SESSION_ISSUER = 'cb-dev-login';

export interface RuntimeAuthIdentity {
  userId: string;
  roles: Role[];
  account: string;
}

type AuthResolution =
  | { kind: 'ok'; identity: RuntimeAuthIdentity }
  | { kind: 'anonymous' }
  | { kind: 'invalid' }
  | { kind: 'disabled' }
  | { kind: 'upstream_unavailable' }
  | { kind: 'internal' };

type JwtIdentity =
  | { kind: 'ok'; sub: string; roles: Role[]; account: string }
  | { kind: 'invalid' }
  | { kind: 'upstream_unavailable' };

type RemoteJwks = ReturnType<typeof createRemoteJWKSet>;
const jwksCache = new Map<string, RemoteJwks>();

function normalizeIssuer(issuer: string): string {
  return issuer.replace(/\/$/, '');
}

function cookieToken(req: FastifyRequest): string | null {
  const token = req.cookies?.[SESSION_COOKIE];
  return token && token.trim() ? token : null;
}

function devLoginAvailable(env: Env): boolean {
  return env.NODE_ENV !== 'production' && env.DEV_LOGIN_ENABLED && env.DEV_SESSION_SECRET.trim() !== '';
}

function rolesFromPayload(payload: JWTPayload): Role[] {
  const p = payload as Record<string, unknown>;
  const candidates: string[] = [];
  const rawRoles = p.roles;
  if (Array.isArray(rawRoles)) {
    for (const r of rawRoles) if (typeof r === 'string') candidates.push(r);
  }
  const rawScope = p.scope;
  if (typeof rawScope === 'string') {
    for (const s of rawScope.split(/\s+/)) if (s) candidates.push(s);
  }
  const seen = new Set<Role>();
  const out: Role[] = [];
  for (const c of candidates) {
    const parsed = RoleSchema.safeParse(c);
    if (parsed.success && !seen.has(parsed.data)) {
      seen.add(parsed.data);
      out.push(parsed.data);
    }
  }
  return out;
}

function accountFromPayload(payload: JWTPayload): string {
  const p = payload as Record<string, unknown>;
  if (typeof p.username === 'string' && p.username) return p.username;
  if (typeof p.email === 'string' && p.email) return p.email.split('@')[0] || p.email;
  return typeof payload.sub === 'string' ? payload.sub : '';
}

async function verifyDevToken(token: string, env: Env): Promise<JwtIdentity> {
  if (!devLoginAvailable(env)) return { kind: 'invalid' };
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(env.DEV_SESSION_SECRET), {
      issuer: DEV_SESSION_ISSUER,
      algorithms: ['HS256'],
      clockTolerance: 60,
    });
    if (!payload.sub) return { kind: 'invalid' };
    return {
      kind: 'ok',
      sub: payload.sub,
      roles: rolesFromPayload(payload),
      account: accountFromPayload(payload),
    };
  } catch {
    return { kind: 'invalid' };
  }
}

function remoteJwks(env: Env): RemoteJwks | null {
  const uri = env.LOGTO_JWKS_URI.trim();
  if (!uri) return null;
  let set = jwksCache.get(uri);
  if (!set) {
    set = createRemoteJWKSet(new URL(uri));
    jwksCache.set(uri, set);
  }
  return set;
}

async function verifyLogtoToken(token: string, env: Env): Promise<JwtIdentity> {
  const jwks = remoteJwks(env);
  if (!jwks || !env.LOGTO_ISSUER.trim()) return { kind: 'upstream_unavailable' };
  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: normalizeIssuer(env.LOGTO_ISSUER),
      ...(env.LOGTO_AUDIENCE.trim() ? { audience: env.LOGTO_AUDIENCE } : {}),
      clockTolerance: 60,
    });
    if (!payload.sub) return { kind: 'invalid' };
    return {
      kind: 'ok',
      sub: payload.sub,
      roles: rolesFromPayload(payload),
      account: accountFromPayload(payload),
    };
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    if (name === 'JWKSTimeout' || name === 'AbortError' || name === 'FetchError') {
      return { kind: 'upstream_unavailable' };
    }
    return { kind: 'invalid' };
  }
}

async function readIdentityForSub(
  pool: Pool,
  sub: string,
  fallbackRoles: Role[],
  fallbackAccount: string,
): Promise<AuthResolution> {
  try {
    const res = await pool.query<{
      id: string;
      roles: string[];
      status: 'active' | 'disabled';
      account: string;
    }>(
      `SELECT id, roles, status, account
         FROM users
        WHERE logto_user_id = $1
        LIMIT 1`,
      [sub],
    );
    const row = res.rows[0];
    if (!row) return { kind: 'invalid' };
    if (row.status === 'disabled') return { kind: 'disabled' };
    const roles = (row.roles ?? []).filter((r): r is Role => RoleSchema.safeParse(r).success);
    return {
      kind: 'ok',
      identity: {
        userId: row.id,
        roles: roles.length > 0 ? roles : fallbackRoles,
        account: row.account || fallbackAccount,
      },
    };
  } catch {
    return { kind: 'internal' };
  }
}

export async function resolveCookieAuth(
  req: FastifyRequest,
  pool: Pool,
  env: Env,
): Promise<AuthResolution> {
  const token = cookieToken(req);
  if (!token) return { kind: 'anonymous' };

  // dev token 本地可验，先尝试它可以让本地 trial smoke 不依赖 Logto/JWKS 在线。
  const dev = await verifyDevToken(token, env);
  const verified = dev.kind === 'ok' ? dev : await verifyLogtoToken(token, env);
  if (verified.kind !== 'ok') return verified;
  return readIdentityForSub(pool, verified.sub, verified.roles, verified.account);
}

export async function resolveRuntimeOwnerId(
  req: FastifyRequest,
  reply: FastifyReply,
  pool: Pool,
  env: Env,
): Promise<string> {
  const auth = await resolveCookieAuth(req, pool, env);
  if (auth.kind === 'ok') return auth.identity.userId;
  return resolveAnonymousOwnerId(req, reply);
}

export async function requireCreatorIdentity(
  req: FastifyRequest,
  reply: FastifyReply,
  pool: Pool,
  env: Env,
): Promise<RuntimeAuthIdentity | null> {
  const auth = await resolveCookieAuth(req, pool, env);
  if (auth.kind === 'ok') {
    if (!auth.identity.roles.includes('creator')) {
      sendError(reply, ErrorCode.FORBIDDEN, req.id);
      return null;
    }
    return auth.identity;
  }
  if (auth.kind === 'disabled') sendError(reply, ErrorCode.FORBIDDEN, req.id);
  else if (auth.kind === 'upstream_unavailable') sendError(reply, ErrorCode.AUTH_UPSTREAM_UNAVAILABLE, req.id);
  else if (auth.kind === 'internal') sendError(reply, ErrorCode.INTERNAL, req.id);
  else sendError(reply, ErrorCode.UNAUTHENTICATED, req.id);
  return null;
}


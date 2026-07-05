// Logto access_token 验签（与 authoring 同口径，runtime 只验不发起 OIDC）。
//   - JWT 校验：issuer discovery 取 JWKS（kid 轮换自动跟），校 issuer / audience / exp。
//   - 失败区分：token 无效 → 'invalid'（401）；JWKS/Logto 上游不可达 → 'upstream_unavailable'（503）。
//     「外部不可达 ≠ 鉴权失败」——绝不把上游抖动收口成 401。
//   - 绝不裸抛 jose/网络原始异常给上层：收口为分类结果，由中间件出人话信封。
import { createRemoteJWKSet, jwtVerify, errors as joseErrors, type JWTPayload } from 'jose';
import { RoleSchema, type Role } from '@cb/shared';
import type { Env } from '../config/env.js';

interface OidcDiscovery {
  issuer?: string;
  jwks_uri?: string;
}

function normalizeIssuer(issuer: string): string {
  return issuer.replace(/\/$/, '');
}

/** 带超时拉 discovery 文档（探针与 JWKS 取址共用，依赖宕机时快速失败）。 */
async function fetchDiscovery(
  env: Env,
  timeoutMs = 2_000,
): Promise<{ reachable: boolean; doc: OidcDiscovery | null }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const url = `${normalizeIssuer(env.LOGTO_ISSUER)}/.well-known/openid-configuration`;
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return { reachable: false, doc: null };
    return { reachable: true, doc: (await res.json()) as OidcDiscovery };
  } catch {
    return { reachable: false, doc: null };
  } finally {
    clearTimeout(timer);
  }
}

/** /ready 中 logto 依赖探针：discovery 可达且 issuer 匹配配置才 ready。 */
export async function probeLogto(env: Env): Promise<boolean> {
  const { doc } = await fetchDiscovery(env);
  if (!doc?.issuer || !doc.jwks_uri) return false;
  return normalizeIssuer(doc.issuer) === normalizeIssuer(env.LOGTO_ISSUER);
}

/** 校验通过的 token 关键身份（中间件据此查 users 建 AuthContext）。 */
export interface VerifiedToken {
  sub: string;
  roles: Role[];
  account: string;
  email: string | null;
}

export type VerifyResult =
  | { kind: 'ok'; token: VerifiedToken }
  | { kind: 'invalid' }
  | { kind: 'upstream_unavailable' };

type RemoteJwks = ReturnType<typeof createRemoteJWKSet>;
const jwksCache = new Map<string, RemoteJwks>();

/** JWKS 取址：优先 discovery（真源），不可达回落配置 LOGTO_JWKS_URI；全无来源 → 上游不可达。 */
async function getRemoteJwks(env: Env): Promise<{ jwks: RemoteJwks } | { upstream: true }> {
  const { doc } = await fetchDiscovery(env);
  const uri = doc?.jwks_uri ?? (env.LOGTO_JWKS_URI || undefined);
  if (!uri) return { upstream: true };
  let set = jwksCache.get(uri);
  if (!set) {
    set = createRemoteJWKSet(new URL(uri));
    jwksCache.set(uri, set);
  }
  return { jwks: set };
}

/** 测试/进程退出用：清 JWKS 缓存。 */
export function clearJwksCache(): void {
  jwksCache.clear();
}

/** 从 payload 解角色：roles 数组 + scope 字符串双通道合并，RoleSchema 过滤（未知值丢弃，不强转）。 */
export function extractRoles(payload: JWTPayload): Role[] {
  const p = payload as Record<string, unknown>;
  const candidates: string[] = [];
  if (Array.isArray(p.roles)) {
    for (const r of p.roles) if (typeof r === 'string') candidates.push(r);
  }
  if (typeof p.scope === 'string') {
    for (const s of p.scope.split(/\s+/)) if (s) candidates.push(s);
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

/** 取 account（username/email 前缀，按存在性回落 sub）。 */
export function extractAccount(payload: JWTPayload): string {
  const p = payload as Record<string, unknown>;
  if (typeof p.username === 'string' && p.username) return p.username;
  if (typeof p.email === 'string' && p.email) return p.email.split('@')[0] || p.email;
  return typeof payload.sub === 'string' ? payload.sub : '';
}

export function extractEmail(payload: JWTPayload): string | null {
  const p = payload as Record<string, unknown>;
  return typeof p.email === 'string' && p.email ? p.email : null;
}

/** 生产无条件校 aud（env.ts 保证生产必填）；dev/test 配了才校。 */
function resolveAudience(env: Env): string | undefined {
  if (env.NODE_ENV === 'production') return env.LOGTO_AUDIENCE;
  return env.LOGTO_AUDIENCE || undefined;
}

/** 判定 jose 异常是否为「JWKS 取址/获取不可达」（上游不可达，区分 token 无效）。 */
function isJwksFetchError(err: unknown): boolean {
  if (err instanceof joseErrors.JWKSNoMatchingKey) return false; // kid 不匹配 = token 无效
  if (err instanceof joseErrors.JWKSMultipleMatchingKeys) return false;
  if (err instanceof joseErrors.JWKSTimeout) return true;
  if (typeof err === 'object' && err !== null) {
    const code = (err as { code?: unknown }).code;
    if (
      code === 'ERR_JOSE_GENERIC' ||
      code === 'ECONNREFUSED' ||
      code === 'ENOTFOUND' ||
      code === 'ETIMEDOUT' ||
      code === 'UND_ERR_CONNECT_TIMEOUT'
    ) {
      return true;
    }
    const name = (err as { name?: unknown }).name;
    if (name === 'AbortError' || name === 'FetchError') return true;
  }
  return false;
}

/** 校验 cb_session 里的 Logto access_token（aud = API resource）。 */
export async function verifyLogtoJwt(token: string, env: Env): Promise<VerifyResult> {
  if (!token) return { kind: 'invalid' };
  const resolved = await getRemoteJwks(env);
  if ('upstream' in resolved) return { kind: 'upstream_unavailable' };
  try {
    const audience = resolveAudience(env);
    const { payload } = await jwtVerify(token, resolved.jwks, {
      issuer: normalizeIssuer(env.LOGTO_ISSUER),
      ...(audience ? { audience } : {}),
      clockTolerance: 60,
    });
    if (!payload.sub) return { kind: 'invalid' };
    return {
      kind: 'ok',
      token: {
        sub: payload.sub,
        roles: extractRoles(payload),
        account: extractAccount(payload),
        email: extractEmail(payload),
      },
    };
  } catch (err) {
    if (isJwksFetchError(err)) return { kind: 'upstream_unavailable' };
    return { kind: 'invalid' };
  }
}

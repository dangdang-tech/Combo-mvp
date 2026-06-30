// B-08 · Logto OIDC 接入辅助：discovery 探针 + 真实 JWKS 校验（脊柱 §10.2 / 10-auth §4.1，Codex#2/#3/#5）。
//   - ready 探针：GET {LOGTO_ISSUER}/.well-known/openid-configuration，
//     断言返回 issuer 与 jwks_uri 存在且 issuer 匹配（不用 /api/.well-known 错误路径）。
//   - JWT 校验：从 issuer discovery 取 JWKS（createRemoteJWKSet，kid 轮换自动跟），
//     校验 issuer / audience / exp / kid（jose 内部含 nbf/alg）。
//   - audience 职责分开（OIDC 规范）：access_token 的 aud = API resource（LOGTO_AUDIENCE，verifyLogtoJwt）；
//     id_token 的 aud = client_id（LOGTO_APP_ID，verifyLogtoIdToken）。两支共用 JWKS/iss/exp 验签核心，
//     只 audience 不同——access_token 走资源校验、id_token 走 client 校验，绝不混用。
//   - audience（Codex#2）：生产【无条件】校 aud（env.ts 保证生产必填 LOGTO_AUDIENCE / LOGTO_APP_ID）；dev/test 配了才校。
//   - 失败区分（Codex#3）：token 无效（验签/过期/iss/aud）→ 'invalid'（中间件 401）；
//     JWKS/Logto 上游不可达 → 'upstream_unavailable'（中间件 503 AUTH_UPSTREAM_UNAVAILABLE）。
//     「外部不可达不等于鉴权失败」——绝不把上游抖动收口成 401。
//   - 绝不裸抛 jose/网络原始异常给上层（脊柱 §11.B）：收口为分类结果，由中间件出人话信封。
import { createRemoteJWKSet, jwtVerify, errors as joseErrors, type JWTPayload } from 'jose';
import { RoleSchema, type Role } from '@cb/shared';
import type { Env } from '../config/env.js';

/** OIDC discovery 文档关键字段（脊柱 §10.2 断言 + JWKS 取址）。 */
interface OidcDiscovery {
  issuer?: string;
  jwks_uri?: string;
}

function normalizeIssuer(issuer: string): string {
  return issuer.replace(/\/$/, '');
}

function discoveryUrl(env: Env): string {
  return `${normalizeIssuer(env.LOGTO_ISSUER)}/.well-known/openid-configuration`;
}

/**
 * 带超时拉 discovery 文档（探针与 JWKS 取址共用，依赖宕机时快速失败、不裸挂）。
 *   - reachable=false：网络不可达 / 超时 / 非 2xx（上游不可达，区分 token 无效，Codex#3）。
 *   - reachable=true + doc：拿到文档（可能字段缺失，由调用方再判）。
 */
interface DiscoveryResult {
  reachable: boolean;
  doc: OidcDiscovery | null;
}

async function fetchDiscovery(env: Env, timeoutMs = 2_000): Promise<DiscoveryResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(discoveryUrl(env), { signal: ctrl.signal });
    if (!res.ok) return { reachable: false, doc: null };
    return { reachable: true, doc: (await res.json()) as OidcDiscovery };
  } catch {
    // 网络异常 / 超时 / abort → 上游不可达。
    return { reachable: false, doc: null };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * /ready 中 logto 依赖探针（脊柱 §10.2 唯一权威口径）。
 * 拉 discovery，断言 issuer 与 jwks_uri 存在且 issuer 与 LOGTO_ISSUER 匹配，通才 ready。
 */
export async function probeLogto(env: Env): Promise<boolean> {
  const { doc } = await fetchDiscovery(env);
  if (!doc?.issuer || !doc.jwks_uri) return false;
  // issuer 必须匹配配置（防错配 / 防中间人改写）。
  return normalizeIssuer(doc.issuer) === normalizeIssuer(env.LOGTO_ISSUER);
}

/** 校验通过的 token 关键身份（中间件据此建 AuthContext）。 */
export interface VerifiedToken {
  sub: string;
  /** 已用 shared RoleSchema 过滤+去重的合法角色（creator|consumer|reviewer），绝不含原始 raw string。 */
  roles: Role[];
  account: string;
  /** 邮箱 claim（首登 provision 落 users.email；无则 null）。 */
  email: string | null;
}

/**
 * verifyLogtoJwt 分类结果（Codex#3）：
 *   - 'ok'：验签通过，带 token 身份。
 *   - 'invalid'：token 无效（验签失败 / 过期 / iss / aud / 无 sub）→ 中间件 401 UNAUTHENTICATED。
 *   - 'upstream_unavailable'：JWKS / Logto 上游不可达（验不了，非「token 无效」）→ 中间件 503 AUTH_UPSTREAM_UNAVAILABLE。
 */
export type VerifyResult =
  | { kind: 'ok'; token: VerifiedToken }
  | { kind: 'invalid' }
  | { kind: 'upstream_unavailable' };

// —— JWKS 远端集缓存（按 jwks_uri 单例；createRemoteJWKSet 自带 kid 轮换 + 内部短缓存）——
type RemoteJwks = ReturnType<typeof createRemoteJWKSet>;
const jwksCache = new Map<string, RemoteJwks>();

/**
 * 解析 JWKS_URI：优先从 issuer discovery 取（真源、随 Logto 配置走），
 * discovery 不可达时回落配置里的 LOGTO_JWKS_URI（启动期/网络抖动兜底）。
 *   - { uri }：解析到 jwks_uri。
 *   - { upstream: true }：discovery 不可达且无配置兜底 → 上游不可达（Codex#3）。
 */
async function resolveJwksUri(env: Env): Promise<{ uri: string } | { upstream: true }> {
  const { reachable, doc } = await fetchDiscovery(env);
  if (doc?.jwks_uri) return { uri: doc.jwks_uri };
  // discovery 不可达：回落配置里的 JWKS_URI（仍可验签）；连配置都没有 → 上游不可达。
  if (!reachable && env.LOGTO_JWKS_URI) return { uri: env.LOGTO_JWKS_URI };
  if (env.LOGTO_JWKS_URI) return { uri: env.LOGTO_JWKS_URI };
  // discovery 可达但缺 jwks_uri（错配）或全无来源 → 上游不可达（验不了）。
  return { upstream: true };
}

async function getRemoteJwks(env: Env): Promise<{ jwks: RemoteJwks } | { upstream: true }> {
  const resolved = await resolveJwksUri(env);
  if ('upstream' in resolved) return resolved;
  const uri = resolved.uri;
  let set = jwksCache.get(uri);
  if (!set) {
    set = createRemoteJWKSet(new URL(uri));
    jwksCache.set(uri, set);
  }
  return { jwks: set };
}

/** 测试/进程退出用：清 JWKS 缓存（避免跨用例/跨环境串台）。 */
export function clearJwksCache(): void {
  jwksCache.clear();
}

/**
 * 从 Logto JWT payload 解角色（10-auth §4.1/§6.1，Codex#7 r3）。
 *   - Logto 双通道下发角色：`roles`（数组）+ `scope`（空格分隔字符串，默认把角色编进 scope）。
 *     两通道【合并】解析（reviewer 可能只在 scope 里，必须能被识别），不能只读 roles 忽略 scope。
 *   - 用 shared RoleSchema 逐项校验过滤：只保留合法 creator|consumer|reviewer，未知值【丢弃】（不强转）。
 *   - 去重后返回 Role[]（绝不把 raw string 强转 Role[] 入库）。
 */
function extractRoles(payload: JWTPayload): Role[] {
  const p = payload as Record<string, unknown>;
  const candidates: string[] = [];

  // 通道 1：roles 数组（取字符串项）。
  const rawRoles = p.roles;
  if (Array.isArray(rawRoles)) {
    for (const r of rawRoles) {
      if (typeof r === 'string') candidates.push(r);
    }
  }

  // 通道 2：scope 字符串（空格分隔，OIDC 标准形态；Logto 默认把角色编进 scope）。
  const rawScope = p.scope;
  if (typeof rawScope === 'string') {
    for (const s of rawScope.split(/\s+/)) {
      if (s) candidates.push(s);
    }
  }

  // RoleSchema 校验过滤（丢弃未知值，不强转）+ 去重，保持稳定顺序。
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

/** 取 account（用户名/邮箱，Logto username/email claim，按存在性回落 sub）。 */
function extractAccount(payload: JWTPayload): string {
  const p = payload as Record<string, unknown>;
  if (typeof p.username === 'string' && p.username) return p.username;
  if (typeof p.email === 'string' && p.email) {
    // email 派生 account：取 @ 前缀（撞名由 provisionUser 追后缀消歧）。
    return p.email.split('@')[0] || p.email;
  }
  return typeof payload.sub === 'string' ? payload.sub : '';
}

/** 取 email（Logto email claim；无则 null，首登 provision 落 users.email）。 */
function extractEmail(payload: JWTPayload): string | null {
  const p = payload as Record<string, unknown>;
  return typeof p.email === 'string' && p.email ? p.email : null;
}

/**
 * access_token 的 audience（10-auth §4.1，Codex#2）：API resource indicator（LOGTO_AUDIENCE）。
 *   生产无条件校（env.ts 保证生产必填）；dev/test 配了才校（不强校 = dev 兜底）。
 */
function resolveAudience(env: Env): string | undefined {
  if (env.NODE_ENV === 'production') return env.LOGTO_AUDIENCE; // 生产必填（env.ts 已守卫）
  return env.LOGTO_AUDIENCE || undefined;
}

/**
 * id_token 的 audience（OIDC 规范 + 10-auth §3.2 步 3）：== client_id（LOGTO_APP_ID）。
 *   id_token 的 aud 永远是发起认证的客户端，不是 API resource——与 access_token 的 aud 职责分开。
 *   生产无条件校（env.ts 保证 LOGTO_APP_ID 生产必填）；dev/test 配了才校（默认空 → dev 兜底）。
 */
function resolveIdTokenAudience(env: Env): string | undefined {
  if (env.NODE_ENV === 'production') return env.LOGTO_APP_ID; // 生产必填（env.ts 已守卫）
  return env.LOGTO_APP_ID || undefined;
}

/** 判定 jose 异常是否为「JWKS 取址/获取不可达」（上游不可达，区分 token 无效，Codex#3）。 */
function isJwksFetchError(err: unknown): boolean {
  if (err instanceof joseErrors.JWKSNoMatchingKey) return false; // kid 不匹配 = token 无效，非不可达
  if (err instanceof joseErrors.JWKSMultipleMatchingKeys) return false;
  // createRemoteJWKSet 拉取失败抛 JWKSTimeout / 通用 Error（fetch 网络异常）。
  if (err instanceof joseErrors.JWKSTimeout) return true;
  if (typeof err === 'object' && err !== null) {
    const code = (err as { code?: unknown }).code;
    if (code === 'ERR_JOSE_GENERIC') return true;
    // node fetch 网络层错误（DNS/连接）经 jose 透传。
    if (
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

/**
 * 真实 Logto JWT 校验核心（10-auth §4.1，Codex#2/#3/#5）：
 *   JWKS（kid 轮换）+ issuer + audience + exp（jose 内部含 alg/nbf/签名）。
 *   audience 由调用方按 token 类型传入（access_token=LOGTO_AUDIENCE / id_token=LOGTO_APP_ID，职责分开）。
 * 返回分类结果（绝不把 jose/OIDC 原始异常抛给上层——中间件统一出人话信封，脊柱 §11.B）：
 *   - token 无效（验签失败/过期/iss 或 aud 不符/无 sub/kid 不匹配）→ { kind:'invalid' }（中间件 401）。
 *   - JWKS / Logto 上游不可达（取不到 JWKS / 网络异常 / 超时）→ { kind:'upstream_unavailable' }（中间件 503）。
 *     「外部不可达 ≠ 鉴权失败」（Codex#3）：绝不把上游抖动误判成 token 无效。
 */
async function verifyWithAudience(
  token: string,
  env: Env,
  audience: string | undefined,
): Promise<VerifyResult> {
  if (!token) return { kind: 'invalid' };
  const resolved = await getRemoteJwks(env);
  if ('upstream' in resolved) return { kind: 'upstream_unavailable' };
  try {
    const { payload } = await jwtVerify(token, resolved.jwks, {
      issuer: normalizeIssuer(env.LOGTO_ISSUER),
      // 生产无条件校 aud（Codex#2，env.ts 保证生产必填）；dev/test 配了才校。
      ...(audience ? { audience } : {}),
      // 时钟偏移容忍 ≤60s（10-auth §4.1）。
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
    // JWKS 拉取不可达（网络/超时）→ 上游不可达；其余（验签/过期/iss/aud/kid 不匹配）→ token 无效。
    if (isJwksFetchError(err)) return { kind: 'upstream_unavailable' };
    return { kind: 'invalid' };
  }
}

/**
 * 校验 **access_token**（10-auth §4.1）：aud = API resource indicator（LOGTO_AUDIENCE）。
 *   受保护路由 / SSE 中间件、callback 第 5 步种 cb_session 前都用这一支——会话承载的是 access_token，
 *   其 aud 必须是本服务的 API resource，而非 client_id。
 */
export async function verifyLogtoJwt(token: string, env: Env): Promise<VerifyResult> {
  return verifyWithAudience(token, env, resolveAudience(env));
}

/**
 * 校验 **id_token**（OIDC 规范 + 10-auth §3.2 步 3）：aud = client_id（LOGTO_APP_ID）。
 *   仅用于 callback 验回调下发的 id_token——其 aud 永远是发起认证的客户端 id，与 access_token 的
 *   aud（LOGTO_AUDIENCE）职责分开。verifyLogtoJwt 误用 LOGTO_AUDIENCE 验 id_token 会让生产 callback
 *   恒失败（id_token.aud 不含 API resource）。nonce 比对在 callback 内单独做（需 auth_tx.nonce）。
 */
export async function verifyLogtoIdToken(token: string, env: Env): Promise<VerifyResult> {
  return verifyWithAudience(token, env, resolveIdTokenAudience(env));
}

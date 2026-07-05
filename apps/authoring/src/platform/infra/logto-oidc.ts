// B-08 · Logto OIDC 授权码流（PKCE）辅助（10-auth §3.1/§3.2）。
//   登录流真实链路（discovery → authorize URL → code 换 token → 验 id_token）。
//   - discovery：从 {LOGTO_ISSUER}/.well-known/openid-configuration 取 authorization_endpoint / token_endpoint
//     （与 infra/logto.ts 的 ready 探针 / JWKS 取址同一文档源，铸 token 的 iss 必 == canonical LOGTO_ISSUER）。
//   - PKCE S256：code_verifier 随机串 → code_challenge = base64url(sha256(verifier))。
//   - state / nonce：CSRF 与 id_token 绑定随机串（落短时 auth_tx cookie，回调比对）。
//   - 换 token：authorization_code grant + code_verifier，client_id/secret（按 Logto app 类型，secret 可空）。
//   - 验 id_token：复用 infra/logto.ts 的 verifyLogtoJwt（JWKS + iss + aud + exp），再在回调里比对 nonce。
//   失败一律收口为分类结果（绝不裸抛 OIDC/网络原始异常给上层，脊柱 §11.B）：上游不可达 vs 换 token 失败分开。
import { createHash, randomBytes } from 'node:crypto';
import type { Env } from '../config/env.js';

/** OIDC discovery 端点（authorize/token 取址；与 ready 探针同源文档）。 */
interface OidcEndpoints {
  authorizationEndpoint: string;
  tokenEndpoint: string;
}

function normalizeIssuer(issuer: string): string {
  return issuer.replace(/\/$/, '');
}

function discoveryUrl(env: Env): string {
  return `${normalizeIssuer(env.LOGTO_ISSUER)}/.well-known/openid-configuration`;
}

/**
 * 拉 discovery 取 authorize/token 端点（带超时，依赖宕机快速失败、不裸挂）。
 *   - null：上游不可达 / 超时 / 非 2xx / 缺关键字段（调用方据此走 escalate / 失败重定向）。
 */
async function fetchOidcEndpoints(env: Env, timeoutMs = 2_000): Promise<OidcEndpoints | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(discoveryUrl(env), { signal: ctrl.signal });
    if (!res.ok) return null;
    const doc = (await res.json()) as {
      authorization_endpoint?: unknown;
      token_endpoint?: unknown;
    };
    if (typeof doc.authorization_endpoint !== 'string' || typeof doc.token_endpoint !== 'string') {
      return null;
    }
    return {
      authorizationEndpoint: doc.authorization_endpoint,
      tokenEndpoint: doc.token_endpoint,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** base64url 编码（无填充，PKCE / 随机串用）。 */
function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 生成密码学随机 base64url 串（state / nonce / code_verifier 用）。 */
export function randomToken(bytes = 32): string {
  return base64url(randomBytes(bytes));
}

/** PKCE：code_verifier → code_challenge（S256）。 */
export function pkceChallengeS256(codeVerifier: string): string {
  return base64url(createHash('sha256').update(codeVerifier).digest());
}

/** 登录短时事务（落 auth_tx cookie，回调比对 state / nonce / 用 code_verifier 换 token）。 */
export interface AuthTx {
  state: string;
  nonce: string;
  codeVerifier: string;
  /** 回跳站内路径（白名单校验后存；缺省 /creator）。 */
  returnTo: string;
}

/** returnTo 白名单：仅站内相对路径（以 / 开头、非 //、非含协议），防 open redirect（10-auth §3.1）。 */
export function sanitizeReturnTo(raw: string | undefined): string {
  const fallback = '/tasks'; // 重构后创作端首页（旧 /creator 路由已删，落过去是 404）
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 512) return fallback;
  // 必须站内相对路径：以单个 / 开头，且不是 //（协议相对，跳外站）或含 scheme。
  if (!raw.startsWith('/')) return fallback;
  if (raw.startsWith('//')) return fallback;
  if (raw.includes('\\')) return fallback; // 反斜杠规避
  if (/^\/[a-z][a-z0-9+.-]*:/i.test(raw)) return fallback; // /javascript: 之类
  return raw;
}

/** 构建授权 URL 的入参。 */
export interface BuildAuthorizeUrlInput {
  env: Env;
  state: string;
  nonce: string;
  codeChallenge: string;
  /** 透传给 Logto 的首选登录方式提示（可选）。 */
  prompt?: string;
}

/**
 * 构建 Logto 授权 URL（10-auth §3.1）。
 *   - 取 discovery 的 authorization_endpoint；scope = openid profile email + 角色 claim（roles）。
 *   - client_id = LOGTO_APP_ID、redirect_uri = LOGTO_REDIRECT_URI、PKCE S256。
 * 返回 null = 上游不可达（discovery 拉不到）；调用方据此 503/escalate（不在 login 暴露内部错）。
 */
export async function buildAuthorizeUrl(input: BuildAuthorizeUrlInput): Promise<string | null> {
  const { env, state, nonce, codeChallenge } = input;
  const endpoints = await fetchOidcEndpoints(env);
  if (!endpoints) return null;
  const url = new URL(endpoints.authorizationEndpoint);
  const params = url.searchParams;
  params.set('client_id', env.LOGTO_APP_ID);
  params.set('redirect_uri', env.LOGTO_REDIRECT_URI);
  params.set('response_type', 'code');
  // openid profile email = 基础身份；roles = 角色 claim（中间件解析为 creator/consumer/reviewer，§6.1）。
  params.set('scope', 'openid profile email roles');
  // API resource indicator（配了才带）：使铸出的 access_token aud 含本服务，供 §4.1 校 aud。
  if (env.LOGTO_AUDIENCE) params.set('resource', env.LOGTO_AUDIENCE);
  params.set('state', state);
  params.set('nonce', nonce);
  params.set('code_challenge', codeChallenge);
  params.set('code_challenge_method', 'S256');
  if (input.prompt) params.set('prompt', input.prompt);
  return url.toString();
}

/** code 换 token 的分类结果（绝不裸抛 OIDC/网络原始异常，脊柱 §11.B）。 */
export type TokenExchangeResult =
  | { kind: 'ok'; accessToken: string; idToken: string | null }
  | { kind: 'failed' } // code 无效 / 换 token 被拒（4xx）→ AUTH_CALLBACK_FAILED
  | { kind: 'upstream_unavailable' }; // token 端点不可达 / 超时 / 5xx → AUTH_UPSTREAM_UNAVAILABLE

/**
 * 用授权码 + code_verifier 向 Logto token 端点换 token（10-auth §3.2 步 2）。
 *   - grant_type=authorization_code，带 client_id（+ 可选 client_secret）、redirect_uri、code_verifier。
 *   - 区分「换 token 失败（code 无效 / 客户端凭据不符）」与「上游不可达（网络 / 5xx）」（Codex#3 同口径）。
 */
export async function exchangeCodeForToken(
  env: Env,
  code: string,
  codeVerifier: string,
  timeoutMs = 4_000,
): Promise<TokenExchangeResult> {
  const endpoints = await fetchOidcEndpoints(env);
  if (!endpoints) return { kind: 'upstream_unavailable' };

  const body = new URLSearchParams();
  body.set('grant_type', 'authorization_code');
  body.set('code', code);
  body.set('redirect_uri', env.LOGTO_REDIRECT_URI);
  body.set('client_id', env.LOGTO_APP_ID);
  body.set('code_verifier', codeVerifier);
  if (env.LOGTO_AUDIENCE) body.set('resource', env.LOGTO_AUDIENCE);
  // 机密客户端：带 client_secret（公共客户端 secret 为空则不带，靠 PKCE）。
  if (env.LOGTO_APP_SECRET) body.set('client_secret', env.LOGTO_APP_SECRET);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(endpoints.tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: ctrl.signal,
    });
    if (res.status >= 500) return { kind: 'upstream_unavailable' };
    if (!res.ok) return { kind: 'failed' }; // 4xx：code 无效 / 凭据不符 → 换 token 失败
    const json = (await res.json()) as { access_token?: unknown; id_token?: unknown };
    if (typeof json.access_token !== 'string' || !json.access_token) return { kind: 'failed' };
    return {
      kind: 'ok',
      accessToken: json.access_token,
      idToken: typeof json.id_token === 'string' ? json.id_token : null,
    };
  } catch {
    // 网络异常 / 超时 / abort → 上游不可达（区分 token 无效，Codex#3）。
    return { kind: 'upstream_unavailable' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * RP-Initiated Logout URL（10-auth §3.3，可选）：取 discovery 的 end_session_endpoint，
 * 拼 client_id + post_logout_redirect_uri（回站内 /login）。拉不到则返 null（仅清本地会话，不强求跳 Logto）。
 */
export async function buildLogoutUrl(env: Env, timeoutMs = 1_500): Promise<string | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(discoveryUrl(env), { signal: ctrl.signal });
    if (!res.ok) return null;
    const doc = (await res.json()) as { end_session_endpoint?: unknown };
    if (typeof doc.end_session_endpoint !== 'string') return null;
    const url = new URL(doc.end_session_endpoint);
    url.searchParams.set('client_id', env.LOGTO_APP_ID);
    return url.toString();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 从 id_token JWT 取 nonce claim（不验签，仅取值供回调比对；验签走 verifyLogtoJwt）。 */
export function readNonceFromIdToken(idToken: string): string | null {
  const parts = idToken.split('.');
  if (parts.length !== 3) return null;
  try {
    const payloadPart = parts[1];
    if (!payloadPart) return null;
    const json = Buffer.from(payloadPart, 'base64url').toString('utf8');
    const payload = JSON.parse(json) as { nonce?: unknown };
    return typeof payload.nonce === 'string' ? payload.nonce : null;
  } catch {
    return null;
  }
}

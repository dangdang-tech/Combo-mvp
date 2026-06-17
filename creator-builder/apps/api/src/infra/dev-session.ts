// 仅 dev/test 的种子会话（live 测试拿有效会话跑主链路，不依赖真实 Logto 浏览器登录）。
//
// 安全模型（第一位）——双守卫，缺一不可用：
//   1) NODE_ENV !== 'production'（env.ts 的 schema 约束 production 只能是这三值之一）；
//   2) DEV_LOGIN_ENABLED === true（显式开关；env.ts 在生产已无条件强制关回 false）；
//   且签名密钥 DEV_SESSION_SECRET 非空（无密钥 = 不可用，即便开关开）。
// 任一不满足：devLoginAvailable=false → 端点不注册（404）、requireAuth/SSE 的 dev 验证分支完全不走。
//
// 与 Logto 会话并存而不混淆：dev 会话是 app 侧 HS256（对称密钥）自签的 JWT，与 Logto RS256/JWKS 体系正交。
//   cb_session 现承载 Logto access_token（RS256，经 verifyLogtoJwt/JWKS 验）；dev 登录无法签 Logto JWT，
//   故另立一支 HS256 dev token，仅在双守卫开启时、且 Logto 验签判定为 invalid 后才作为兜底分支尝试
//   （绝不与 Logto token 抢先；生产路径因双守卫完全不进入本模块）。
//
// 绝不裸抛 jose 异常给上层（脊柱 §11.B）：verify 收口为分类结果（ok / invalid），由中间件出人话信封。
import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { RoleSchema, type Role } from '@cb/shared';
import type { Env } from '../config/env.js';

/** dev 会话 token 的固定 issuer（与 Logto issuer 显式区分，防跨体系误认）。 */
const DEV_SESSION_ISSUER = 'cb-dev-login';
/** dev 会话 TTL（秒）：8h，与 cb_session cookie 同量级（足够跑完一轮 live 测试）。 */
export const DEV_SESSION_MAX_AGE = 8 * 60 * 60;

/**
 * 双守卫总判定（唯一真源）：dev 种子登录是否可用。
 *   - 生产恒 false（env.ts 已把生产的 DEV_LOGIN_ENABLED 强制关回 false，此处再兜一层 NODE_ENV 断言）；
 *   - 必须 DEV_LOGIN_ENABLED===true 且 DEV_SESSION_SECRET 非空。
 * 端点注册（routes）与中间件 dev 验证分支都只认这一个判定，保证「注册即可验、不注册即不验」一致。
 */
export function devLoginAvailable(env: Env): boolean {
  if (env.NODE_ENV === 'production') return false; // 守卫 1（双保险，env.ts 已强制关）
  if (!env.DEV_LOGIN_ENABLED) return false; // 守卫 2（显式开关）
  if (!env.DEV_SESSION_SECRET) return false; // 无密钥 = 不可用（即便开关开）
  return true;
}

/** dev 会话身份要素（等价 Logto VerifiedToken 的子集，中间件据此建 AuthContext）。 */
export interface DevSessionClaims {
  /** OIDC sub 等价物（去重键 logto_user_id；dev 用稳定前缀 + 测试用户标识）。 */
  sub: string;
  /** 已过 RoleSchema 过滤+去重的合法角色。 */
  roles: Role[];
  account: string;
  email: string | null;
}

/** verifyDevSession 分类结果（绝不裸抛）：ok 带 claims；invalid = token 无效（中间件交由后续落 401）。 */
export type DevVerifyResult = { kind: 'ok'; claims: DevSessionClaims } | { kind: 'invalid' };

function secretKey(env: Env): Uint8Array {
  return new TextEncoder().encode(env.DEV_SESSION_SECRET);
}

/**
 * 签发 dev 会话 token（HS256）。仅在 devLoginAvailable(env) 为 true 时调用（调用方守门）。
 * payload 形态对齐 Logto access_token 的可消费字段（sub/roles/scope/email/username），
 *   让 provisionUser 的派生逻辑（extractAccount/email/roles 在 Logto 侧）与本侧口径一致。
 */
export async function signDevSession(env: Env, claims: DevSessionClaims): Promise<string> {
  const payload: JWTPayload & { roles: Role[]; email: string | null; username: string } = {
    roles: claims.roles,
    email: claims.email,
    username: claims.account,
  };
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(claims.sub)
    .setIssuer(DEV_SESSION_ISSUER)
    .setIssuedAt()
    .setExpirationTime(`${DEV_SESSION_MAX_AGE}s`)
    .sign(secretKey(env));
}

/** 从 dev payload 解角色（RoleSchema 过滤+去重；与 Logto extractRoles 同口径，不强转）。 */
function extractRoles(payload: JWTPayload): Role[] {
  const raw = (payload as Record<string, unknown>).roles;
  const out: Role[] = [];
  const seen = new Set<Role>();
  if (Array.isArray(raw)) {
    for (const r of raw) {
      if (typeof r !== 'string') continue;
      const parsed = RoleSchema.safeParse(r);
      if (parsed.success && !seen.has(parsed.data)) {
        seen.add(parsed.data);
        out.push(parsed.data);
      }
    }
  }
  return out;
}

function extractAccount(payload: JWTPayload): string {
  const p = payload as Record<string, unknown>;
  if (typeof p.username === 'string' && p.username) return p.username;
  if (typeof p.email === 'string' && p.email) return p.email.split('@')[0] || p.email;
  return typeof payload.sub === 'string' ? payload.sub : '';
}

function extractEmail(payload: JWTPayload): string | null {
  const p = payload as Record<string, unknown>;
  return typeof p.email === 'string' && p.email ? p.email : null;
}

/**
 * 校验 dev 会话 token（HS256 + issuer + exp，jose 内部含 alg/签名/nbf）。
 * 仅在 devLoginAvailable(env) 为 true 时由中间件调用（调用方双守卫守门，生产绝不进入）。
 * 返回分类结果（绝不裸抛 jose 异常给上层，脊柱 §11.B）：
 *   - 验签通过 + 有 sub → { kind:'ok' }（中间件据此 provision 建 AuthContext，等价真实会话）；
 *   - 任何失败（验签/过期/issuer 不符/无 sub/畸形）→ { kind:'invalid' }（中间件后续落 401）。
 * 不区分「上游不可达」：HS256 本地对称验签无远端依赖，永不出 503。
 */
export async function verifyDevSession(token: string, env: Env): Promise<DevVerifyResult> {
  if (!token) return { kind: 'invalid' };
  try {
    const { payload } = await jwtVerify(token, secretKey(env), {
      issuer: DEV_SESSION_ISSUER,
      algorithms: ['HS256'], // 显式锁 HS256，绝不接受其它 alg（防 alg 混淆）
      clockTolerance: 60,
    });
    if (!payload.sub) return { kind: 'invalid' };
    return {
      kind: 'ok',
      claims: {
        sub: payload.sub,
        roles: extractRoles(payload),
        account: extractAccount(payload),
        email: extractEmail(payload),
      },
    };
  } catch {
    // 验签失败/过期/issuer 不符/畸形 → token 无效（不裸露原始报错）。
    return { kind: 'invalid' };
  }
}

/** seeded 默认测试创作者 Wayne（dev-login body 未指定 email/role 时的兜底，role=creator）。 */
export const DEFAULT_DEV_USER: { sub: string; email: string; account: string; roles: Role[] } = {
  // 稳定 sub（= logto_user_id 去重键）：复登命中同一 users 行，account/owner 稳定。
  sub: 'dev|wayne',
  email: 'wayne@dev.local',
  account: 'wayne',
  roles: ['creator'],
};

// dev 种子会话验证（只验不签：签发在 authoring 的 dev-login，两端共享同一 DEV_SESSION_SECRET）。
//   双守卫缺一不可用：NODE_ENV !== 'production' 且 DEV_LOGIN_ENABLED=true，且密钥非空；
//   生产路径完全不进入（env.ts 已强制关回 false，此处再兜一层断言）。
//   dev token 是 app 侧 HS256 自签 JWT，与 Logto RS256/JWKS 体系正交：仅在 Logto 验签判定
//   invalid 后作为兜底分支尝试。绝不裸抛 jose 异常：收口为 ok/invalid 分类结果。
import { jwtVerify } from 'jose';
import type { Role } from '@cb/shared';
import type { Env } from '../config/env.js';
import { extractAccount, extractEmail, extractRoles } from './logto.js';

/** dev 会话 token 的固定 issuer（与 authoring 签发侧一致）。 */
const DEV_SESSION_ISSUER = 'cb-dev-login';

/** 双守卫总判定（唯一真源）：dev 会话验证分支是否可用。 */
export function devLoginAvailable(env: Env): boolean {
  if (env.NODE_ENV === 'production') return false;
  if (!env.DEV_LOGIN_ENABLED) return false;
  if (!env.DEV_SESSION_SECRET) return false;
  return true;
}

/** dev 会话身份要素（等价 Logto VerifiedToken）。 */
export interface DevSessionClaims {
  sub: string;
  roles: Role[];
  account: string;
  email: string | null;
}

export type DevVerifyResult = { kind: 'ok'; claims: DevSessionClaims } | { kind: 'invalid' };

/**
 * 校验 dev 会话 token（HS256 + issuer + exp；显式锁 alg 防混淆）。
 * 仅在 devLoginAvailable 为 true 时由中间件调用。HS256 本地验签无远端依赖，永不出 503。
 */
export async function verifyDevSession(token: string, env: Env): Promise<DevVerifyResult> {
  if (!token) return { kind: 'invalid' };
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(env.DEV_SESSION_SECRET), {
      issuer: DEV_SESSION_ISSUER,
      algorithms: ['HS256'],
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
    return { kind: 'invalid' };
  }
}

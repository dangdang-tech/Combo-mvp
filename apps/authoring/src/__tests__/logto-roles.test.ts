// 角色 claim 合并解析自检（10-auth §4.1/§6.1，Codex#7 r3）：
//   Logto 双通道下发角色——`roles`（数组）+ `scope`（空格分隔字符串）。verifyLogtoJwt 必须【合并】两通道、
//   用 shared RoleSchema 过滤（丢弃未知值、不强转）、去重，得到合法 Role[]。
//   无真实 Logto/PG：mock jose（jwtVerify 返受控 payload + createRemoteJWKSet 返哑 key set），
//   再喂 env.LOGTO_JWKS_URI 走配置兜底取 JWKS（不触网），即可端到端验证 verifyLogtoJwt 的角色解析。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { JWTPayload } from 'jose';

// —— mock jose：jwtVerify 返我们指定的 payload；createRemoteJWKSet 返哑对象（不触网）——
const jwtVerifyMock = vi.fn();
vi.mock('jose', () => ({
  createRemoteJWKSet: vi.fn(() => ({ __dummyJwks: true })),
  jwtVerify: (...args: unknown[]) => jwtVerifyMock(...args),
  // verifyLogtoJwt 仅 import errors 做 instanceof 判定；给空壳类即可（本测不走异常分支）。
  errors: {
    JWKSNoMatchingKey: class JWKSNoMatchingKey extends Error {},
    JWKSMultipleMatchingKeys: class JWKSMultipleMatchingKeys extends Error {},
    JWKSTimeout: class JWKSTimeout extends Error {},
  },
}));

const { verifyLogtoJwt, verifyLogtoIdToken, clearJwksCache } = await import('../platform/infra/logto.js');

// env：配 LOGTO_JWKS_URI 让 resolveJwksUri 走配置兜底（discovery fetch 会失败/不可达，回落配置，不触网）。
//   注：fetchDiscovery 内的 fetch 在测试环境会拒绝 → reachable=false，于是回落 env.LOGTO_JWKS_URI。
const env = {
  NODE_ENV: 'test',
  LOGTO_ISSUER: 'http://logto.test/oidc',
  LOGTO_JWKS_URI: 'http://logto.test/oidc/jwks',
  LOGTO_AUDIENCE: '',
} as unknown as Parameters<typeof verifyLogtoJwt>[1];

/** 让 jwtVerify 返带指定 claim 的 payload（sub 固定，角色由 roles/scope 注入）。 */
function mockPayload(extra: Partial<JWTPayload> & Record<string, unknown>): void {
  jwtVerifyMock.mockResolvedValue({
    payload: { sub: 'logto-sub-1', ...extra } as JWTPayload,
  });
}

async function rolesOf(): Promise<string[]> {
  const res = await verifyLogtoJwt('any.jwt.token', env);
  if (res.kind !== 'ok') throw new Error(`expected ok, got ${res.kind}`);
  return res.token.roles;
}

beforeEach(() => {
  jwtVerifyMock.mockReset();
  clearJwksCache(); // 防跨用例 JWKS 缓存串台
  // discovery fetch 直接拒绝 → resolveJwksUri 回落 env.LOGTO_JWKS_URI（不触网、确定性）。
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no network in test'));
});

describe('角色 claim 合并解析（roles + scope，Codex#7 r3）', () => {
  it('scope-only reviewer：scope 里有 reviewer、无 roles 数组 → 识别为 reviewer', async () => {
    mockPayload({ scope: 'openid profile reviewer' });
    expect(await rolesOf()).toEqual(['reviewer']);
  });

  it('scope-only creator：scope 里有 creator → 识别为 creator', async () => {
    mockPayload({ scope: 'openid creator email' });
    expect(await rolesOf()).toEqual(['creator']);
  });

  it('roles + scope 合并去重：roles=[creator]、scope 含 creator+reviewer → [creator, reviewer]（去重）', async () => {
    mockPayload({ roles: ['creator'], scope: 'creator reviewer openid' });
    const roles = await rolesOf();
    expect(roles).toContain('creator');
    expect(roles).toContain('reviewer');
    expect(roles).toHaveLength(2); // creator 去重，仅一份
  });

  it('未知角色被丢弃：roles/scope 含非法值 → 仅保留合法角色，不强转', async () => {
    mockPayload({
      roles: ['admin', 'creator', 42],
      scope: 'openid super-user consumer offline_access',
    });
    const roles = await rolesOf();
    // 合法：creator（roles）、consumer（scope）；丢弃 admin/super-user/openid/offline_access/数字 42。
    expect(roles).toContain('creator');
    expect(roles).toContain('consumer');
    expect(roles).not.toContain('admin');
    expect(roles).not.toContain('super-user');
    expect(roles).not.toContain('openid');
    expect(roles).toHaveLength(2);
  });

  it('无 roles 无可识别 scope → 空角色集（首登 provision 按 DEFAULT 兜底）', async () => {
    mockPayload({ scope: 'openid profile email offline_access' });
    expect(await rolesOf()).toEqual([]);
  });
});

// ===========================================================================
// audience 职责分开（Codex r2 P0）：access_token=LOGTO_AUDIENCE / id_token=LOGTO_APP_ID
//   端到端验：verifyLogtoJwt 喂给 jose.jwtVerify 的 audience == LOGTO_AUDIENCE；
//             verifyLogtoIdToken 喂给的 audience == LOGTO_APP_ID（client_id），绝不互换。
// ===========================================================================
describe('audience 职责分开：id_token=APP_ID / access_token=AUDIENCE（Codex r2 P0）', () => {
  // dev/test 下「配了才校」——两值都配上，断言各自传对的 audience。
  const splitEnv = {
    NODE_ENV: 'test',
    LOGTO_ISSUER: 'http://logto.test/oidc',
    LOGTO_JWKS_URI: 'http://logto.test/oidc/jwks',
    LOGTO_AUDIENCE: 'https://api.agora.test', // access_token aud（API resource）
    LOGTO_APP_ID: 'app-client-id-123', // id_token aud（client_id）
  } as unknown as Parameters<typeof verifyLogtoJwt>[1];

  /** 取最近一次 jwtVerify 调用传入的 options.audience。 */
  function lastAudience(): unknown {
    const call = jwtVerifyMock.mock.calls.at(-1);
    const opts = call?.[2] as { audience?: unknown } | undefined;
    return opts?.audience;
  }

  it('verifyLogtoJwt（access_token）→ jose 校 aud == LOGTO_AUDIENCE（API resource，非 client_id）', async () => {
    mockPayload({ scope: 'openid creator' });
    const res = await verifyLogtoJwt('access.jwt', splitEnv);
    expect(res.kind).toBe('ok');
    expect(lastAudience()).toBe('https://api.agora.test');
    expect(lastAudience()).not.toBe('app-client-id-123'); // 绝不用 client_id 校 access_token
  });

  it('verifyLogtoIdToken（id_token）→ jose 校 aud == LOGTO_APP_ID（client_id，非 API resource）', async () => {
    mockPayload({ scope: 'openid creator' });
    const res = await verifyLogtoIdToken('id.jwt', splitEnv);
    expect(res.kind).toBe('ok');
    expect(lastAudience()).toBe('app-client-id-123');
    expect(lastAudience()).not.toBe('https://api.agora.test'); // 绝不用 API resource 校 id_token
  });
});

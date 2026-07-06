// users 仓储：Logto `sub` ⟷ 业务 `users.id` 映射 + 首登 provision + /me 视图读。
//   - JWT 验签通过后，按 `logto_user_id = sub` 查/建 `users`，把业务 `users.id` 填进
//     AuthContext.userId（owner 校验拿 tasks/capabilities 的 owner_user_id 与之比，绝不拿 sub 比）。
//   - 首登 upsert：ON CONFLICT (logto_user_id) DO UPDATE last_login_at / email / roles，
//     RETURNING id —— roles 以 Logto 为权威每次登录同步。
//   - account 首登从 token profile 派生，撞 uq_users_account_lower 时追加后缀消歧（如 wayne-2）。
import type { Role } from '@cb/shared';
import { RoleSchema } from '@cb/shared';
import { toIso, type Queryable } from '../../platform/infra/db.js';

/** provision 入参：来自已验签 token 的身份要素。 */
export interface ProvisionInput {
  /** OIDC sub（去重键 logto_user_id）。 */
  logtoUserId: string;
  /** 展示账号候选（username / GitHub login / email 前缀；撞名追后缀）。 */
  account: string;
  email: string | null;
  /** Logto 权威角色（每次登录同步；缺省按建表 DEFAULT '{creator}'）。 */
  roles: Role[];
}

/** provision 结果：业务 users.id 是 AuthContext.userId 的真源（非 sub）。 */
export interface ProvisionedUser {
  id: string;
  roles: Role[];
  account: string;
}

/** account 撞名时的最大消歧尝试次数（wayne / wayne-2 / … / wayne-N）。 */
const MAX_ACCOUNT_SUFFIX = 50;

/** 规范化 account 候选（去空白；空则回落 sub 末段，保证 NOT NULL）。 */
function normalizeAccount(account: string, logtoUserId: string): string {
  const trimmed = account.trim();
  if (trimmed) return trimmed;
  const tail = logtoUserId.split(/[:/]/).pop() ?? logtoUserId;
  return `user-${tail}`.slice(0, 64);
}

/** raw string[] → Role[]（过 RoleSchema 过滤，绝不把未知角色强转出去）。 */
function parseRoles(raw: string[] | null | undefined): Role[] {
  const out: Role[] = [];
  for (const r of raw ?? []) {
    const parsed = RoleSchema.safeParse(r);
    if (parsed.success && !out.includes(parsed.data)) out.push(parsed.data);
  }
  return out.length > 0 ? out : ['creator'];
}

/**
 * 首登 provision / 复登同步。
 *   1) ON CONFLICT (logto_user_id) DO UPDATE：复登同步 last_login_at / email / roles，RETURNING id
 *      —— 已存在则直接拿到业务 id，account 不动（首建后稳定）。
 *   2) 首建撞 account 唯一键（uq_users_account_lower）→ 追后缀重试（wayne-2…）。
 * 任何持续失败由调用方收口（中间件转 500 信封，不裸抛）。
 */
export async function provisionUser(
  db: Queryable,
  input: ProvisionInput,
): Promise<ProvisionedUser> {
  const baseAccount = normalizeAccount(input.account, input.logtoUserId);
  const rolesArr = input.roles.length > 0 ? input.roles : (['creator'] as Role[]);
  // pg text[] 字面量：{a,b}
  const rolesLiteral = `{${rolesArr.join(',')}}`;

  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_ACCOUNT_SUFFIX; attempt += 1) {
    const account = attempt === 0 ? baseAccount : `${baseAccount}-${attempt + 1}`;
    try {
      const res = await db.query<{ id: string; roles: string[]; account: string }>(
        `INSERT INTO users (logto_user_id, account, email, roles, last_login_at)
         VALUES ($1, $2, $3, $4::text[], now())
         ON CONFLICT (logto_user_id)
         DO UPDATE SET last_login_at = now(),
                       email = COALESCE(EXCLUDED.email, users.email),
                       roles = EXCLUDED.roles
         RETURNING id, roles, account`,
        [input.logtoUserId, account, input.email, rolesLiteral],
      );
      const row = res.rows[0];
      if (!row) throw new Error('provisionUser: empty RETURNING');
      return { id: row.id, roles: parseRoles(row.roles), account: row.account };
    } catch (err) {
      // 仅 account 唯一键冲突（23505 + 约束名）才重试追后缀；其它错误立即上抛。
      if (isAccountUniqueViolation(err)) {
        lastErr = err;
        continue;
      }
      throw err;
    }
  }
  throw lastErr ?? new Error('provisionUser: account disambiguation exhausted');
}

/** /me 视图的 DB 行。 */
export interface MeRow {
  id: string;
  account: string;
  email: string | null;
  roles: Role[];
  createdAt: string;
  lastLoginAt: string | null;
}

/** 读 /me 视图行。找不到（理论不可达，requireAuth 已 provision）→ null，调用方按登录态失效处理。 */
export async function readMe(db: Queryable, userId: string): Promise<MeRow | null> {
  const res = await db.query<{
    id: string;
    account: string;
    email: string | null;
    roles: string[];
    created_at: string | Date;
    last_login_at: string | Date | null;
  }>(
    `SELECT id, account, email, roles, created_at, last_login_at
       FROM users
      WHERE id = $1`,
    [userId],
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    account: row.account,
    email: row.email,
    roles: parseRoles(row.roles),
    createdAt: toIso(row.created_at),
    lastLoginAt: row.last_login_at == null ? null : toIso(row.last_login_at),
  };
}

/** 判定 pg 错误是否为 account 唯一键冲突（用于追后缀重试）。 */
function isAccountUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown; constraint?: unknown; message?: unknown };
  if (e.code !== '23505') return false;
  const constraint = typeof e.constraint === 'string' ? e.constraint : '';
  const message = typeof e.message === 'string' ? e.message : '';
  return constraint.includes('account') || /account/i.test(message);
}

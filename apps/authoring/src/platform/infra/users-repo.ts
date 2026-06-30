// B-08 · users 仓储（10-auth §4.2/§7，Codex#1）：Logto `sub` ⟷ 业务 `users.id` 映射 + 首登 provision。
//   - JWT 验签通过后，按 `logto_user_id = sub` 查/建 `users`，把业务 `users.id` 填进 AuthContext.userId
//     （owner 校验拿 jobs.owner_user_id / capabilities.creator_user_id 这些 UUID 与之比，绝不拿 sub 比）。
//   - 首登 upsert（10-auth §7）：ON CONFLICT (logto_user_id) DO UPDATE last_login_at / email / roles，
//     RETURNING id —— roles 以 Logto 为权威每次登录同步。
//   - account 首登从 token profile 派生，撞 uq_users_account_lower 时追加后缀消歧（如 wayne-2）。
//   - 逻辑收口在可注入的 DB 句柄上（仅依赖 `query`），无 PG 也能用 mock 单测（脊柱测试基准）。
import type { Role } from '@cb/shared';

/** 仅依赖 query 的最小 DB 句柄（pg.Pool 子集），便于 mock 单测。 */
export interface QueryableDb {
  query<R = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: R[]; rowCount?: number | null }>;
}

/** provision 入参：来自已验签 token 的身份要素（10-auth §7）。 */
export interface ProvisionInput {
  /** OIDC sub（去重键 logto_user_id）。 */
  logtoUserId: string;
  /** 展示账号候选（username / GitHub login / email 前缀；撞名追后缀）。 */
  account: string;
  /** 邮箱（可空）。 */
  email: string | null;
  /** Logto 权威角色（每次登录同步；缺省按建表 DEFAULT '{creator}'）。 */
  roles: Role[];
}

/** provision 结果：业务 users.id + 状态（中间件据 status 拦截禁用账号）。 */
export interface ProvisionedUser {
  /** 业务 users.id（UUID v7）—— AuthContext.userId 的真源（非 sub）。 */
  id: string;
  status: 'active' | 'disabled';
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

/**
 * 首登 provision / 复登同步（10-auth §7，Codex#1）。
 *   1) ON CONFLICT (logto_user_id) DO UPDATE：复登同步 last_login_at / email / roles，RETURNING id+status。
 *      —— 已存在则直接拿到业务 id，account 不动（首建后稳定，发布署名一致）。
 *   2) 首建撞 account 唯一键（uq_users_account_lower）→ 追后缀重试（wayne-2…），仍是同一 logto_user_id。
 * 返回业务 users.id（绝非 sub）。任何持续失败由调用方收口（中间件转 503/500 信封，不裸抛）。
 */
export async function provisionUser(
  db: QueryableDb,
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
      const res = await db.query<{
        id: string;
        status: string;
        roles: string[];
        account: string;
      }>(
        `INSERT INTO users (logto_user_id, account, email, roles, last_login_at)
         VALUES ($1, $2, $3, $4::text[], now())
         ON CONFLICT (logto_user_id)
         DO UPDATE SET last_login_at = now(),
                       email = COALESCE(EXCLUDED.email, users.email),
                       roles = EXCLUDED.roles,
                       updated_at = now()
         RETURNING id, status, roles, account`,
        [input.logtoUserId, account, input.email, rolesLiteral],
      );
      const row = res.rows[0];
      if (!row) {
        // 理论不可达（INSERT…ON CONFLICT…RETURNING 必返一行）；当作内部错误上抛由中间件收口。
        throw new Error('provisionUser: empty RETURNING');
      }
      return {
        id: row.id,
        status: row.status === 'disabled' ? 'disabled' : 'active',
        roles: (row.roles ?? []).filter(
          (r): r is Role => r === 'creator' || r === 'consumer' || r === 'reviewer',
        ),
        account: row.account,
      };
    } catch (err) {
      // 仅 account 唯一键冲突（23505 + 约束名）才重试追后缀；其它错误立即上抛。
      if (isAccountUniqueViolation(err)) {
        lastErr = err;
        continue;
      }
      throw err;
    }
  }
  // 后缀耗尽仍撞名（极罕见）：上抛由中间件收口为内部错误信封。
  throw lastErr ?? new Error('provisionUser: account disambiguation exhausted');
}

/** /me 视图的 DB 行（10-auth §3.4 MeView：账号映射 + 角色 + profile 引用）。 */
export interface MeRow {
  id: string;
  logtoUserId: string;
  account: string;
  email: string | null;
  roles: Role[];
  status: 'active' | 'disabled';
  hasProfile: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

/**
 * 读 /me 视图行（10-auth §3.4）：按业务 users.id 取账号映射全字段 + hasProfile（creator_profiles EXISTS）。
 *   - profile 全字段不在此返回（属主页域 B-33），只回 hasProfile + creatorId(=id) 引用。
 *   - 找不到（理论不可达，requireAuth 已 provision）→ null，调用方落 404/重新登录。
 *   - roles 过 RoleSchema 同口径过滤（绝不把 raw string 当 Role 出对外视图）。
 */
export async function readMeRow(db: QueryableDb, userId: string): Promise<MeRow | null> {
  const res = await db.query<{
    id: string;
    logto_user_id: string;
    account: string;
    email: string | null;
    roles: string[];
    status: string;
    has_profile: boolean;
    created_at: string | Date;
    last_login_at: string | Date | null;
  }>(
    `SELECT u.id, u.logto_user_id, u.account, u.email, u.roles, u.status,
            EXISTS (SELECT 1 FROM creator_profiles cp WHERE cp.user_id = u.id) AS has_profile,
            u.created_at, u.last_login_at
       FROM users u
      WHERE u.id = $1`,
    [userId],
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    logtoUserId: row.logto_user_id,
    account: row.account,
    email: row.email,
    roles: (row.roles ?? []).filter(
      (r): r is Role => r === 'creator' || r === 'consumer' || r === 'reviewer',
    ),
    status: row.status === 'disabled' ? 'disabled' : 'active',
    hasProfile: Boolean(row.has_profile),
    createdAt: toIso(row.created_at),
    lastLoginAt: row.last_login_at == null ? null : toIso(row.last_login_at),
  };
}

/** timestamptz → ISO 字符串（pg 可能回 Date 或字符串，统一 IsoDateTime）。 */
function toIso(v: string | Date): string {
  if (v instanceof Date) return v.toISOString();
  // 字符串：尽量规范成 ISO（pg 文本格式可被 Date 解析）；解析失败原样回（不阻塞）。
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : d.toISOString();
}

/** 判定 pg 错误是否为 account 唯一键冲突（用于追后缀重试；不依赖具体 pg 版本细节）。 */
function isAccountUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown; constraint?: unknown; message?: unknown };
  if (e.code !== '23505') return false;
  const constraint = typeof e.constraint === 'string' ? e.constraint : '';
  const message = typeof e.message === 'string' ? e.message : '';
  return constraint.includes('account') || /account/i.test(message);
}

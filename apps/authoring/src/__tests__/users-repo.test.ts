// users 仓储 provision 自检（10-auth §4.2/§7，Codex#1）：无 PG，用 mock DB 句柄验逻辑。
//   - 首登 / 复登 upsert（ON CONFLICT logto_user_id）RETURNING 业务 users.id（非 sub）。
//   - account 撞唯一键（23505）→ 追后缀消歧重试。
//   - disabled 账号原样回传 status（中间件据此 403）。
//   - 角色过滤（只留合法角色），空角色回落 creator。
import { describe, it, expect, vi } from 'vitest';
import { provisionUser, type QueryableDb } from '../platform/infra/users-repo.js';

/** 构造一个按脚本依次回应的 mock DB（每次 query 返回数组里下一项，或抛出）。 */
function scriptedDb(responses: Array<{ rows: unknown[] } | Error>): {
  db: QueryableDb;
  calls: Array<{ sql: string; params?: unknown[] }>;
} {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  let i = 0;
  const db: QueryableDb = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      const r = responses[i++];
      if (r instanceof Error) throw r;
      if (!r) throw new Error('scriptedDb: no more responses');
      return r as { rows: never[] };
    }),
  };
  return { db, calls };
}

/** pg 唯一键冲突错误（account 唯一键）。 */
function accountConflict(): Error {
  const e = new Error('duplicate key value violates unique constraint "uq_users_account_lower"');
  (e as unknown as { code: string }).code = '23505';
  (e as unknown as { constraint: string }).constraint = 'uq_users_account_lower';
  return e;
}

describe('provisionUser (Codex#1)', () => {
  it('首登/复登 upsert 返回业务 users.id（非 sub）+ status + roles', async () => {
    const { db, calls } = scriptedDb([
      { rows: [{ id: 'uuid-users-id-1', status: 'active', roles: ['creator'], account: 'wayne' }] },
    ]);
    const result = await provisionUser(db, {
      logtoUserId: 'logto-sub-abc',
      account: 'wayne',
      email: 'wayne@example.com',
      roles: ['creator'],
    });
    expect(result.id).toBe('uuid-users-id-1'); // 业务 id，绝非 sub
    expect(result.id).not.toBe('logto-sub-abc');
    expect(result.status).toBe('active');
    expect(result.roles).toEqual(['creator']);
    // INSERT … ON CONFLICT (logto_user_id) DO UPDATE … RETURNING id
    expect(calls[0]!.sql).toContain('ON CONFLICT (logto_user_id)');
    expect(calls[0]!.sql).toContain('RETURNING id');
    expect(calls[0]!.params?.[0]).toBe('logto-sub-abc'); // logto_user_id = sub
  });

  it('account 撞唯一键 → 追后缀重试（wayne → wayne-2）', async () => {
    const { db, calls } = scriptedDb([
      accountConflict(), // 首建 account=wayne 撞名
      { rows: [{ id: 'uuid-2', status: 'active', roles: ['creator'], account: 'wayne-2' }] },
    ]);
    const result = await provisionUser(db, {
      logtoUserId: 'sub-2',
      account: 'wayne',
      email: null,
      roles: ['creator'],
    });
    expect(result.account).toBe('wayne-2');
    expect(calls).toHaveLength(2);
    expect(calls[0]!.params?.[1]).toBe('wayne'); // 第一次 account=wayne
    expect(calls[1]!.params?.[1]).toBe('wayne-2'); // 重试 account=wayne-2
  });

  it('disabled 账号原样回传 status（中间件据此 403）', async () => {
    const { db } = scriptedDb([
      { rows: [{ id: 'uuid-3', status: 'disabled', roles: ['creator'], account: 'banned' }] },
    ]);
    const result = await provisionUser(db, {
      logtoUserId: 'sub-3',
      account: 'banned',
      email: null,
      roles: ['creator'],
    });
    expect(result.status).toBe('disabled');
  });

  it('reviewer 角色被保留（评审角色合法）', async () => {
    const { db } = scriptedDb([
      { rows: [{ id: 'uuid-4', status: 'active', roles: ['reviewer'], account: 'ops' }] },
    ]);
    const result = await provisionUser(db, {
      logtoUserId: 'sub-4',
      account: 'ops',
      email: null,
      roles: ['reviewer'],
    });
    expect(result.roles).toEqual(['reviewer']);
  });

  it('过滤非法角色，保留合法角色', async () => {
    const { db } = scriptedDb([
      {
        rows: [
          { id: 'uuid-5', status: 'active', roles: ['creator', 'bogus', 'consumer'], account: 'x' },
        ],
      },
    ]);
    const result = await provisionUser(db, {
      logtoUserId: 'sub-5',
      account: 'x',
      email: null,
      roles: ['creator', 'consumer'],
    });
    expect(result.roles).toEqual(['creator', 'consumer']);
  });

  it('空角色入参 → 回落 creator（DEFAULT 一致）', async () => {
    const { db, calls } = scriptedDb([
      { rows: [{ id: 'uuid-6', status: 'active', roles: ['creator'], account: 'y' }] },
    ]);
    await provisionUser(db, { logtoUserId: 'sub-6', account: 'y', email: null, roles: [] });
    // text[] 字面量带 creator
    expect(calls[0]!.params?.[3]).toBe('{creator}');
  });

  it('非 account 冲突的 DB 错误立即上抛（不无限重试）', async () => {
    const fatal = new Error('connection terminated');
    (fatal as unknown as { code: string }).code = '08006';
    const { db } = scriptedDb([fatal]);
    await expect(
      provisionUser(db, { logtoUserId: 'sub-7', account: 'z', email: null, roles: ['creator'] }),
    ).rejects.toThrow();
  });
});

// 40 受保护写【并发交错】回归（Codex r2 P0，真实 PG）：四个软字段受保护写的 idx/next_state 必须从【FOR UPDATE
//   锁住的目标行】算——否则无锁 stale 读下，迟到写会覆盖并发已落的 done/failed。本测试用两条真实连接交错复现：
//     T1：BEGIN → writeFieldDoneSurgical(name→done)（取 version 行锁）→ 暂不提交（hold）。
//     T2：另一连接调 writeFieldStuckIfGenerating(同字段)——应被 T1 的 FOR UPDATE 阻塞；T1 commit 后解阻，
//        FOR UPDATE 重读到最新行（name 已 done、非 generating）→ idx 空 → 0 行（返回 false），name 保持 done。
//   反向破坏：去掉 structure-repo.ts 里 tgt 的 FOR UPDATE（无锁 stale 读）→ T2 用 stale idx 把 done 覆盖成 stuck，
//     断言 stuck-write 返回 false / name 仍 done 立即变红（已在真 PG 实测复现，见仓库说明）。
//   连不到真 PG（CI 无 docker）→ 整组 skip（不误红）；连得到 → 实跑断言。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { writeFieldStuckIfGenerating, writeFieldDoneSurgical } from '../modules/structure/repo.js';

/** 连接串：优先 DATABASE_URL，否则 POSTGRES_* 拼（docker infra-postgres-1，host 端口 5432），最后 dev 默认。 */
function resolveDbUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const { POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DB } = process.env;
  if (POSTGRES_USER && POSTGRES_PASSWORD && POSTGRES_DB) {
    const host = process.env.POSTGRES_HOST ?? 'localhost';
    const port = process.env.POSTGRES_PORT ?? '5432';
    return `postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@${host}:${port}/${POSTGRES_DB}`;
  }
  return 'postgres://agora:agora@localhost:5432/agora';
}

async function reachable(url: string): Promise<boolean> {
  const probe = new Pool({ connectionString: url, connectionTimeoutMillis: 1500, max: 1 });
  try {
    const c = await probe.connect();
    try {
      await c.query('SELECT 1');
      return true;
    } finally {
      c.release();
    }
  } catch {
    return false;
  } finally {
    await probe.end().catch(() => undefined);
  }
}

// 固定 fixture id（v4 形态，避开真实数据；afterEach 全清）。
const USER = '00000000-0000-0000-0000-00000000c001';
const CAP = '00000000-0000-0000-0000-00000000c002';
const VER = '00000000-0000-0000-0000-00000000c003';
const JOB = '00000000-0000-0000-0000-00000000c004';
const FENCE = 7;

const url = resolveDbUrl();
let online = false;
let pool: Pool;

beforeAll(async () => {
  online = await reachable(url);
  if (online) pool = new Pool({ connectionString: url, max: 4 });
});

afterAll(async () => {
  if (pool) await pool.end().catch(() => undefined);
});

async function seedFixture(): Promise<void> {
  await pool.query(`DELETE FROM jobs WHERE id = $1`, [JOB]);
  await pool.query(`DELETE FROM capability_versions WHERE id = $1`, [VER]);
  await pool.query(`DELETE FROM capabilities WHERE id = $1`, [CAP]);
  await pool.query(`DELETE FROM users WHERE id = $1`, [USER]);
  await pool.query(`INSERT INTO users (id, logto_user_id, account) VALUES ($1,$2,$3)`, [
    USER,
    `logto-conc-${VER}`,
    `conc-${VER}`,
  ]);
  await pool.query(
    `INSERT INTO capabilities (id, creator_user_id, slug, status) VALUES ($1,$2,$3,'active')`,
    [CAP, USER, `conc-slug-${VER}`],
  );
  await pool.query(
    `INSERT INTO capability_versions (id, capability_id, version, status, manifest, structure_state)
     VALUES ($1,$2,'1.0.0','draft',$3::jsonb,$4::jsonb)`,
    [
      VER,
      CAP,
      JSON.stringify({ name: '' }),
      JSON.stringify({
        versionId: VER,
        doneCount: 0,
        totalCount: 7,
        fields: [{ field: 'name', status: 'generating', attempts: 0 }],
      }),
    ],
  );
  await pool.query(
    `INSERT INTO jobs (id, type, status, owner_user_id, subject_ref, progress, fence_token)
     VALUES ($1,'structure','running',$2,$3::jsonb,'{}'::jsonb,$4)`,
    [JOB, USER, JSON.stringify({ versionId: VER, mode: 'full' }), FENCE],
  );
}

async function cleanup(): Promise<void> {
  await pool.query(`DELETE FROM jobs WHERE id = $1`, [JOB]);
  await pool.query(`DELETE FROM capability_versions WHERE id = $1`, [VER]);
  await pool.query(`DELETE FROM capabilities WHERE id = $1`, [CAP]);
  await pool.query(`DELETE FROM users WHERE id = $1`, [USER]);
}

async function nameStatus(): Promise<string | undefined> {
  const r = await pool.query<{ st: string }>(
    `SELECT structure_state #>> '{fields,0,status}' AS st FROM capability_versions WHERE id = $1`,
    [VER],
  );
  return r.rows[0]?.st;
}

describe('受保护写 · 并发交错回归（真实 PG；连不到则 skip）', () => {
  it('T1 锁+done 暂不提交，T2 stuck 被阻塞；T1 commit 后 T2=false 且 name 保持 done（FOR UPDATE 不变量）', async () => {
    if (!online) {
      // 真 PG 不可达（CI 无 docker）→ 跳过，不误红。
      return;
    }
    await seedFixture();
    try {
      // T1：独占连接，BEGIN → writeFieldDoneSurgical(name→done) 取行锁 → 暂不提交（hold）。
      const t1: PoolClient = await pool.connect();
      try {
        await t1.query('BEGIN');
        const t1done = await writeFieldDoneSurgical(
          // PoolClient 满足 Queryable（query 返回 {rows,rowCount}）。
          t1 as unknown as Parameters<typeof writeFieldDoneSurgical>[0],
          {
            jobId: JOB,
            fenceToken: FENCE,
            versionId: VER,
            field: 'name',
            fieldState: { field: 'name', status: 'done', value: 'FinalName', attempts: 0 },
            manifestField: 'FinalName',
            derivedHard: null,
          },
        );
        expect(t1done).toBe(true); // T1 在事务内已把 name 置 done（持锁）。

        // T2：另一连接调 writeFieldStuckIfGenerating(name)——应被 T1 的 FOR UPDATE 阻塞，直到 T1 commit。
        let t2Settled = false;
        const t2Promise = writeFieldStuckIfGenerating(pool, {
          jobId: JOB,
          fenceToken: FENCE,
          versionId: VER,
          field: 'name',
          stuckMs: 9999,
        }).then((r) => {
          t2Settled = true;
          return r;
        });

        // 给 T2 一点时间去抢锁；它应仍被阻塞（未 settle），证明 FOR UPDATE 串行化生效。
        await new Promise((res) => setTimeout(res, 600));
        expect(t2Settled).toBe(false); // 仍阻塞在 T1 行锁上（无锁版这里不会阻在「读」，会读 stale 并最终覆盖）。

        // T1 提交：name=done 落库，释放行锁 → T2 解阻，FOR UPDATE 重读最新行。
        await t1.query('COMMIT');

        const t2 = await t2Promise;
        // 核心不变量：T2 stuck 写命中 0 行 → false（name 已非 generating，迟到 stuck 不覆盖 done）。
        expect(t2).toBe(false);
      } finally {
        // 兜底：若断言中途失败而事务未提交，回滚释放锁，避免后续 cleanup 卡死。
        await t1.query('ROLLBACK').catch(() => undefined);
        t1.release();
      }

      // 终态：name 必须仍是 done（绝不被 stuck 覆盖）。
      expect(await nameStatus()).toBe('done');
    } finally {
      await cleanup();
    }
  }, 20_000);
});

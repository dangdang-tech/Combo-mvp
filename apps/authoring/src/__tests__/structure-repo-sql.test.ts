// 40 受保护写 SQL 形态静态自检（P0 回归守门）：四个软字段受保护写函数的 LATERAL 子查询【绝不引用 UPDATE 目标表 v】。
//   背景：原实现把 LATERAL (... jsonb_array_elements(v.structure_state ...)) 放进 UPDATE ... FROM——PostgreSQL 禁
//   FROM 子句内 LATERAL 引用 UPDATE 目标表，实跑抛 `invalid reference to FROM-clause entry for table "v"`，
//   结构化 Job 每个软字段第一笔写即 failed → 整 job 立即对外 INTERNAL（live E2E P0：结构化 100% 不可用）。
//   修复：idx/重建经 CTE（tgt）算，LATERAL 引用 tgt 而非 v；该 bug 单测 mock DB 不可见，故此处静态校验 SQL 文本特征
//   （真实 docker PG 实跑另在仓库说明记录），并保证 fence 守门 + CTE 结构不被回退。
import { describe, it, expect } from 'vitest';
import type { Queryable, QueryResultLike } from '../platform/jobs/types.js';
import {
  writeFieldStuckIfGenerating,
  writeArrayItemIfGenerating,
  writeFieldStateSurgical,
  writeFieldDoneSurgical,
} from '../modules/structure/repo.js';

/** 记录最近一次 SQL 的假 Queryable（不执行，只捕获文本 → 静态校验 SQL 形态）。返回 0 行（不影响断言）。 */
class SqlRecorder implements Queryable {
  lastSql = '';
  async query<R = Record<string, unknown>>(sql: string): Promise<QueryResultLike<R>> {
    this.lastSql = sql;
    return { rows: [], rowCount: 0 };
  }
}

/**
 * 取每个受保护写函数生成的 SQL（用任意占位参数；recorder 不执行、只捕获）。
 *   注意：四个函数都以 db.query 单语句发出，故 lastSql 即该函数的受保护写 SQL。
 */
async function captureSql(run: (db: Queryable) => Promise<unknown>): Promise<string> {
  const rec = new SqlRecorder();
  await run(rec);
  return rec.lastSql;
}

const base = {
  jobId: '00000000-0000-0000-0000-000000000000',
  fenceToken: 1,
  versionId: '11111111-1111-1111-1111-111111111111',
  field: 'name',
};

const cases: Array<{ name: string; run: (db: Queryable) => Promise<unknown> }> = [
  {
    name: 'writeFieldStuckIfGenerating',
    run: (db) => writeFieldStuckIfGenerating(db, { ...base, stuckMs: 1000 }),
  },
  {
    name: 'writeArrayItemIfGenerating',
    run: (db) => writeArrayItemIfGenerating(db, { ...base, field: 'skill_set', item: 'x' }),
  },
  {
    name: 'writeFieldStateSurgical',
    run: (db) =>
      writeFieldStateSurgical(db, {
        ...base,
        status: 'failed',
        attempts: 1,
        error: { message: 'boom' },
        guard: 'in-progress',
      }),
  },
  {
    name: 'writeFieldDoneSurgical',
    run: (db) =>
      writeFieldDoneSurgical(db, {
        ...base,
        fieldState: { field: 'name', status: 'done', value: 'X', attempts: 0 },
        manifestField: 'X',
        derivedHard: null,
      }),
  },
];

describe('受保护写 SQL：LATERAL 绝不引用 UPDATE 目标表 v（P0 invalid-reference 回归守门）', () => {
  for (const c of cases) {
    it(`${c.name}：LATERAL/jsonb_array_elements 不引用 v.structure_state`, async () => {
      const sql = await captureSql(c.run);
      // 反向破坏断言：任何 `... LATERAL ... jsonb_array_elements(v.structure_state ...)` 或 FROM 内 `jsonb_array_elements(v.`
      //   都会让真实 PG 抛 invalid reference for table "v"。修复后该模式不得再出现。
      expect(sql).not.toMatch(/LATERAL[\s\S]*?jsonb_array_elements\(\s*v\.structure_state/);
      expect(sql).not.toMatch(/jsonb_array_elements\(\s*v\.structure_state/);
    });

    it(`${c.name}：经 CTE tgt 取目标行、LATERAL 引用 tgt（合法源）`, async () => {
      const sql = await captureSql(c.run);
      // CTE 把目标行读进 tgt；下标/重建的 LATERAL 引用 tgt.structure_state（FROM 列表更靠前项，合法）。
      expect(sql).toMatch(/WITH tgt AS(?: MATERIALIZED)?\s*\(/);
      expect(sql).toMatch(/jsonb_array_elements\(\s*tgt\.structure_state/);
    });

    it(`${c.name}：fence 守门仍在最终 UPDATE 的 WHERE（job_id+fence_token+status='running'+v.id）`, async () => {
      const sql = await captureSql(c.run);
      // fence 三要素 + v.id 仍内联进最终 WHERE：阻止 stale/越权写、命中 0 行 = 安全退出（不变量不可回退）。
      expect(sql).toMatch(/j\.id = \$1/);
      expect(sql).toMatch(/j\.fence_token = \$2/);
      expect(sql).toMatch(/j\.status = 'running'/);
      expect(sql).toMatch(/v\.id = \$3/);
    });

    it(`${c.name}：tgt 行锁读最新（FOR UPDATE + MATERIALIZED，防并发 stale 覆盖回归，Codex r2 P0）`, async () => {
      const sql = await captureSql(c.run);
      // tgt 必须以 FOR UPDATE 锁住目标 version 行再读 structure_state——否则无锁 stale 读，迟到写会用 stale
      //   idx/整列覆盖并发已落的 done/failed（done-surgical 的整列写最严重）。反向破坏：去掉 FOR UPDATE → 此断言红。
      expect(sql).toMatch(/WITH tgt AS MATERIALIZED\s*\(/);
      expect(sql).toMatch(/FROM capability_versions WHERE id = \$3 FOR UPDATE/);
    });

    it(`${c.name}：最终 UPDATE 改的就是锁住的那一行（v.id = tgt.id，读—算—写同一锁下行）`, async () => {
      const sql = await captureSql(c.run);
      // UPDATE 目标 v 与锁住的 tgt 焊死同一行：idx/next_state 从锁后 tgt 算，最终改 v.id = tgt.id（= $3）。
      expect(sql).toMatch(/FROM jobs j, tgt[\s\S]*WHERE/);
      expect(sql).toMatch(/v\.id = tgt\.id/);
    });
  }
});

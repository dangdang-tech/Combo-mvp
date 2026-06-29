// PairAuth 自检（20 §3.3 / Codex#5 + P0-1/P1-4/P1-6）：配对码 hash 真源确定性 + 缺凭据 401 +
//   pairId 走 query 定位行 + 码错失败计数(达上限即 expired) + 多分片途中不置 used_at（used_at 只在兑换落）。
import { describe, it, expect, afterAll, beforeAll, vi } from 'vitest';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { buildApp } from '../app.js';
import { hashPairingCode, requirePairAuth } from '../middleware/pair-auth.js';

describe('hashPairingCode (20 §6.3 唯一真源)', () => {
  it('is deterministic SHA-256 hex (64 chars)', () => {
    const h1 = hashPairingCode('ABCD-1234');
    const h2 = hashPairingCode('ABCD-1234');
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('different codes → different hashes', () => {
    expect(hashPairingCode('ABCD-1234')).not.toBe(hashPairingCode('ABCD-1235'));
  });
});

describe('PairAuth guard wiring (无凭据 → 401)', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  it('connect/upload without Bearer pairing code → 401 ErrorEnvelope (no code, D1)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/import/connect/upload',
      headers: { 'idempotency-key': 'k1' },
    });
    expect(res.statusCode).toBe(401);
    const body = res.json() as { error: Record<string, unknown> };
    expect(body.error).not.toHaveProperty('code');
    expect(body.error.userMessage).toBeTruthy();
  });
});

// ── PairAuth 中间件行为（mock DB；query pairId / used_at 时机 / max_attempts，Codex P0-1/P1-4/P1-6）──

interface QCall {
  sql: string;
  params: unknown[];
}

/** scriptable mock req：query pairId + Bearer code，infra.db 记录 SQL。 */
function makePairReq(
  opts: { query?: Record<string, string>; bearer?: string },
  dbQuery: (sql: string, params: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number }>,
): { req: FastifyRequest; calls: QCall[] } {
  const calls: QCall[] = [];
  const db = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      return dbQuery(sql, params);
    }),
  };
  const req = {
    id: 'trace-1',
    query: opts.query ?? {},
    headers: opts.bearer ? { authorization: 'Bearer ' + opts.bearer } : {},
    server: { infra: { db } },
  } as unknown as FastifyRequest;
  return { req, calls };
}

function makeReply(): { reply: FastifyReply; sent: { code?: number } } {
  const sent: { code?: number } = {};
  const reply = {
    code: vi.fn(function (this: unknown, c: number) {
      sent.code = c;
      return this;
    }),
    send: vi.fn(function (this: unknown) {
      return this;
    }),
  } as unknown as FastifyReply;
  return { reply, sent };
}

describe('PairAuth 行为（query pairId / used_at / max_attempts）', () => {
  const activeRow = {
    owner_user_id: 'creator-1',
    pairing_code_hash: hashPairingCode('424242'),
    phase: 'uploading',
    job_id: null,
    attempt_count: 0,
    max_attempts: 5,
    expired: false,
    used: false,
  };

  it('pairId 走 query + 码匹配 → 放行，注入 req.pairAuth（Codex P0-1）', async () => {
    const { req, calls } = makePairReq(
      { query: { pairId: 'pair-1' }, bearer: '424242' },
      async (sql) =>
        sql.includes('SELECT owner_user_id') ? { rows: [activeRow], rowCount: 1 } : { rows: [] },
    );
    const { reply, sent } = makeReply();
    await requirePairAuth()(req, reply);
    expect(sent.code).toBeUndefined(); // 未 fail
    expect(req.pairAuth).toEqual({ pairId: 'pair-1', ownerUserId: 'creator-1' });
    // 定位行用的是 query 的 pairId（WHERE id = $1）。
    expect(calls[0]!.params[0]).toBe('pair-1');
  });

  it('pairId 只在 body、不在 query → 401（preHandler 不读 multipart body，Codex P0-1）', async () => {
    const { req } = makePairReq({ query: {}, bearer: '424242' }, async () => ({ rows: [] }));
    (req as unknown as { body: unknown }).body = { pairId: 'pair-1' };
    const { reply, sent } = makeReply();
    await requirePairAuth()(req, reply);
    expect(sent.code).toBe(401);
  });

  it('PairAuth 全程【不置 used_at】（多分片途中可续传，Codex P1-4）', async () => {
    const { req, calls } = makePairReq(
      { query: { pairId: 'pair-1' }, bearer: '424242' },
      async (sql) =>
        sql.includes('SELECT owner_user_id') ? { rows: [activeRow], rowCount: 1 } : { rows: [] },
    );
    const { reply } = makeReply();
    await requirePairAuth()(req, reply);
    // 中间件没有任何写 used_at 的 SQL（used_at 只在 complete 兑换时由 pairings-repo 落）。
    expect(calls.every((c) => !/used_at\s*=/.test(c.sql))).toBe(true);
  });

  it('码错 → attempt_count+1 且 SQL 内达上限即 phase=expired（Codex P1-6）', async () => {
    const { req, calls } = makePairReq(
      { query: { pairId: 'pair-1' }, bearer: 'WRONG' },
      async (sql) =>
        sql.includes('SELECT owner_user_id')
          ? { rows: [activeRow], rowCount: 1 }
          : { rows: [], rowCount: 1 },
    );
    const { reply, sent } = makeReply();
    await requirePairAuth()(req, reply);
    expect(sent.code).toBe(401);
    const upd = calls.find((c) => c.sql.includes('attempt_count = attempt_count + 1'))!;
    expect(upd).toBeTruthy();
    // 同一条 UPDATE 内 attempt_count+1 >= max_attempts 即置 expired（不留试错窗口）。
    expect(upd.sql).toContain("THEN 'expired'");
    expect(upd.sql).toContain('attempt_count + 1 >= max_attempts');
  });

  it('行已用尽（attempt_count>=max_attempts）→ 401，不再放行', async () => {
    const exhausted = { ...activeRow, attempt_count: 5, max_attempts: 5 };
    const { req } = makePairReq({ query: { pairId: 'pair-1' }, bearer: '424242' }, async (sql) =>
      sql.includes('SELECT owner_user_id') ? { rows: [exhausted], rowCount: 1 } : { rows: [] },
    );
    const { reply, sent } = makeReply();
    await requirePairAuth()(req, reply);
    expect(sent.code).toBe(401);
  });

  // ── 终态恢复短路（Codex P1-r6）：job_created + job_id + 正确 code → 放行恢复（非 401），码错仍拒 ──
  const terminalRow = {
    owner_user_id: 'creator-1',
    pairing_code_hash: hashPairingCode('424242'),
    phase: 'job_created',
    job_id: 'job-7',
    attempt_count: 0,
    max_attempts: 5,
    expired: true, // job_created 是终态，不被过期覆盖（恢复短路在 used/expired 拦之前）
    used: true, // 兑换时已置 used_at
  };

  it('终态 job_created + job_id + 正确 code → 放行恢复（注入 recovery.jobId，非 401，不被 used/expired 拦）', async () => {
    const { req, calls } = makePairReq(
      { query: { pairId: 'pair-1' }, bearer: '424242' },
      async (sql) =>
        sql.includes('SELECT owner_user_id') ? { rows: [terminalRow], rowCount: 1 } : { rows: [] },
    );
    const { reply, sent } = makeReply();
    await requirePairAuth()(req, reply);
    expect(sent.code).toBeUndefined(); // 未 fail（短路恢复优先于 used_at 401）
    expect(req.pairAuth).toEqual({
      pairId: 'pair-1',
      ownerUserId: 'creator-1',
      recovery: { jobId: 'job-7' },
    });
    // 终态恢复绝不写 attempt_count（不是失败尝试）。
    expect(calls.every((c) => !c.sql.includes('attempt_count = attempt_count + 1'))).toBe(true);
  });

  it('终态 job_created + 码错 → 401（恢复也须凭正确 code，不绕过码校验）', async () => {
    const { req, calls } = makePairReq(
      { query: { pairId: 'pair-1' }, bearer: 'WRONG' },
      async (sql) =>
        sql.includes('SELECT owner_user_id') ? { rows: [terminalRow], rowCount: 1 } : { rows: [] },
    );
    const { reply, sent } = makeReply();
    await requirePairAuth()(req, reply);
    expect(sent.code).toBe(401);
    expect(req.pairAuth).toBeUndefined();
    // 终态行不计 attempt_count（attempt_count 谓词对 job_created 不生效；只是拒）。
    expect(calls.every((c) => !c.sql.includes('attempt_count = attempt_count + 1'))).toBe(true);
  });

  it('终态 job_created 但 job_id 为空（不变式破坏，理论不应出现）+ 正确 code → 401（无可恢复 job，不放行）', async () => {
    const noJob = { ...terminalRow, job_id: null };
    const { req } = makePairReq({ query: { pairId: 'pair-1' }, bearer: '424242' }, async (sql) =>
      sql.includes('SELECT owner_user_id') ? { rows: [noJob], rowCount: 1 } : { rows: [] },
    );
    const { reply, sent } = makeReply();
    await requirePairAuth()(req, reply);
    expect(sent.code).toBe(401); // 终态无 job_id → 落回 used/phase 拦 → 401
  });
});

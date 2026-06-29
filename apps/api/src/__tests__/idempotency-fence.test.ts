// 幂等租约 fence 自检（脊柱 §4.2，Codex#4）：无 PG，用 mock DB 验「持租 token 匹配」防旧覆盖新。
//   场景：旧请求取租约 → 超时被新请求 steal（换 lease_token）→ 旧请求返回时落库，
//         UPDATE 带 WHERE … AND lease_token=<旧 token> → 匹配 0 行 → 绝不覆盖新持有者的 response_ref。
import { describe, it, expect, vi } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { requireIdempotency, persistIdempotencyResponse } from '../middleware/idempotency.js';
import { IdempotencyScope } from '@cb/shared';

interface QueryCall {
  sql: string;
  params: unknown[];
}

/** mock fastify req（带可脚本化的 infra.db），onSend payload 走 persistIdempotencyResponse。 */
function makeReq(
  responses: Array<{ rows: unknown[] }>,
  opts: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): { req: FastifyRequest; calls: QueryCall[] } {
  const calls: QueryCall[] = [];
  let i = 0;
  const db = {
    query: vi.fn(async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      const r = responses[i++] ?? { rows: [] };
      return r;
    }),
  };
  const req = {
    id: 'trace-1',
    method: opts.method ?? 'POST',
    url: '/api/v1/versions/v1/publish',
    body: opts.body ?? { a: 1 },
    headers: opts.headers ?? { 'idempotency-key': 'key-123' },
    server: { infra: { db } },
  } as unknown as FastifyRequest;
  return { req, calls };
}

function makeReply(): { reply: FastifyReply; sent: { code?: number; body?: unknown } } {
  const sent: { code?: number; body?: unknown } = {};
  const reply = {
    code: vi.fn(function (this: unknown, c: number) {
      sent.code = c;
      return this;
    }),
    send: vi.fn((b: unknown) => {
      sent.body = b;
      return reply;
    }),
  } as unknown as FastifyReply;
  return { reply, sent };
}

describe('idempotency lease fence (Codex#4)', () => {
  it('取得新租约 → 注入 leaseToken 到上下文（INSERT 带 lease_token 列）', async () => {
    // INSERT … ON CONFLICT DO NOTHING RETURNING key → 返回一行 = 取得租约。
    const { req, calls } = makeReq([{ rows: [{ key: 'key-123' }] }]);
    const { reply } = makeReply();
    const guard = requireIdempotency(IdempotencyScope.PUBLISH_VERSION);
    await guard(req, reply);
    expect(req.idempotency?.leaseAcquired).toBe(true);
    expect(typeof req.idempotency?.leaseToken).toBe('string');
    expect(req.idempotency?.leaseToken).toBeTruthy();
    // INSERT 写入了 lease_token 列 + 把生成的 token 作为参数传入。
    expect(calls[0]!.sql).toContain('lease_token');
    expect(calls[0]!.params).toContain(req.idempotency!.leaseToken);
  });

  it('夺租约（steal 过期行）→ 换新 lease_token（UPDATE steal 带 lease_token=新token）', async () => {
    // 现行 = locked 且 expired，且 request_hash 与本请求一致（同 key 同 body 重试）→ 走 steal 分支。
    // 先用 INSERT-成功路径取一次 hash？不便。改为：让 SELECT 返回的 request_hash 等于 guard 计算值——
    //   通过先以同一 req 触发一次「取得新租约」拿不到 hash。这里直接用同 body 算法可重现：
    //   guard computeRequestHash 只依赖 method/url/body，固定后 hash 稳定。
    // 第一次调用 guard 取得 hash：用 INSERT 成功路径，记下 requestHash。
    const probe = makeReq([{ rows: [{ key: 'key-123' }] }]);
    const probeReply = makeReply();
    await requireIdempotency(IdempotencyScope.PUBLISH_VERSION)(probe.req, probeReply.reply);
    const knownHash = probe.req.idempotency!.requestHash;

    // 正式 steal 场景：INSERT 0 行 → SELECT 现行(locked+expired, hash 同) → UPDATE steal 返回一行。
    const { req, calls } = makeReq([
      { rows: [] },
      {
        rows: [{ request_hash: knownHash, response_ref: null, status: 'locked', expired: true }],
      },
      { rows: [{ key: 'key-123' }] },
    ]);
    const { reply } = makeReply();
    await requireIdempotency(IdempotencyScope.PUBLISH_VERSION)(req, reply);
    expect(req.idempotency?.leaseAcquired).toBe(true);
    const newToken = req.idempotency!.leaseToken!;
    // 第 3 条是 steal 的 UPDATE：换新 lease_token + 清 response_ref。
    const stealUpd = calls[2]!;
    expect(stealUpd.sql).toContain('lease_token = $5');
    expect(stealUpd.sql).toContain('response_ref = NULL');
    expect(stealUpd.params).toContain(newToken);
  });

  it('完成落库 UPDATE 必须带 fence（WHERE … AND lease_token=?），防旧覆盖新', async () => {
    // 模拟旧请求持有的 leaseToken；steal 后该 token 已失效 → UPDATE 匹配 0 行（rowCount 0）。
    const { req, calls } = makeReq([{ rows: [], rowCount: 0 } as { rows: unknown[] }]);
    req.idempotency = {
      scope: IdempotencyScope.PUBLISH_VERSION,
      key: 'key-123',
      requestHash: 'h',
      leaseAcquired: true,
      leaseToken: 'old-stale-token',
    };
    await persistIdempotencyResponse(req, 200, JSON.stringify({ ok: true }));
    expect(calls).toHaveLength(1);
    const upd = calls[0]!;
    // 完成 UPDATE 带 fence 子句 + 旧 token 作参数（steal 后匹配 0 行，不覆盖新持有者）。
    expect(upd.sql).toContain('AND lease_token =');
    expect(upd.sql).toContain("status = 'completed'");
    expect(upd.params).toContain('old-stale-token');
  });

  it('失败落库 UPDATE 同样带 fence（只标自己持有的租约 failed）', async () => {
    const { req, calls } = makeReq([{ rows: [], rowCount: 0 } as { rows: unknown[] }]);
    req.idempotency = {
      scope: IdempotencyScope.PUBLISH_VERSION,
      key: 'key-123',
      requestHash: 'h',
      leaseAcquired: true,
      leaseToken: 'my-token',
    };
    await persistIdempotencyResponse(req, 500, JSON.stringify({ error: {} }));
    const upd = calls[0]!;
    expect(upd.sql).toContain("status = 'failed'");
    expect(upd.sql).toContain('AND lease_token =');
    expect(upd.params).toContain('my-token');
  });

  it('未取得租约（leaseAcquired=false / 无 leaseToken）→ 不落库', async () => {
    const { req, calls } = makeReq([]);
    req.idempotency = {
      scope: IdempotencyScope.PUBLISH_VERSION,
      key: 'key-123',
      requestHash: 'h',
      leaseAcquired: false,
    };
    await persistIdempotencyResponse(req, 200, '{}');
    expect(calls).toHaveLength(0);
  });
});

// ── per-part 幂等：分片元数据走 query，不同片 → 不同 key + 不同 request_hash（Codex P1-5）──
describe('connect/upload per-part idempotency (Codex P1-5)', () => {
  /** 用 INSERT-成功路径取得某请求的 requestHash（computeRequestHash 依赖 method/url/auth/body，Codex P1-r6）。 */
  async function hashFor(url: string, key: string, authorization?: string): Promise<string> {
    const calls: QueryCall[] = [];
    const db = {
      query: vi.fn(async (sql: string, params: unknown[]) => {
        calls.push({ sql, params });
        return { rows: [{ key }] };
      }),
    };
    const headers: Record<string, string> = { 'idempotency-key': key };
    if (authorization !== undefined) headers.authorization = authorization;
    const req = {
      id: 't',
      method: 'POST',
      url,
      body: null,
      headers,
      server: { infra: { db } },
    } as unknown as FastifyRequest;
    const { reply } = makeReply();
    await requireIdempotency(IdempotencyScope.IMPORT_CONNECT_UPLOAD)(req, reply);
    return req.idempotency!.requestHash;
  }

  it('不同 partIndex/contentSha256（query）→ 不同 request_hash（分片互不 replay/冲突）', async () => {
    const h0 = await hashFor(
      '/api/v1/import/connect/upload?pairId=p1&partIndex=0&contentSha256=aaa',
      'pair-p1-0-aaa',
    );
    const h1 = await hashFor(
      '/api/v1/import/connect/upload?pairId=p1&partIndex=1&contentSha256=bbb',
      'pair-p1-1-bbb',
    );
    expect(h0).not.toBe(h1);
  });

  it('同片重传（同 query 同 key）→ 同 request_hash（幂等续传，可回放）', async () => {
    const a = await hashFor(
      '/api/v1/import/connect/upload?pairId=p1&partIndex=0&contentSha256=aaa',
      'pair-p1-0-aaa',
    );
    const b = await hashFor(
      '/api/v1/import/connect/upload?pairId=p1&partIndex=0&contentSha256=aaa',
      'pair-p1-0-aaa',
    );
    expect(a).toBe(b);
  });

  // ── Authorization（配对码）纳入 request_hash（Codex P1-r6）：换错码复用同 key 不得回放（避免绕过码校验）──
  it('同 url/key 但换不同 Authorization 配对码 → 不同 request_hash（绕码回放 → 落 409 IDEMPOTENCY_CONFLICT，不回放）', async () => {
    const url = '/api/v1/import/connect/upload?pairId=p1&partIndex=0&contentSha256=aaa';
    const right = await hashFor(url, 'pair-p1-0-aaa', 'Bearer 424242');
    const wrong = await hashFor(url, 'pair-p1-0-aaa', 'Bearer 999999');
    expect(right).not.toBe(wrong); // 码入 hash → 换码即异 hash → §4 行为矩阵判 409，绝不回放首次成功体
  });

  it('同 url/key 且同 Authorization 配对码 → 同 request_hash（正常同片同码续传可回放）', async () => {
    const url = '/api/v1/import/connect/upload?pairId=p1&partIndex=0&contentSha256=aaa';
    const a = await hashFor(url, 'pair-p1-0-aaa', 'Bearer 424242');
    const b = await hashFor(url, 'pair-p1-0-aaa', 'Bearer 424242');
    expect(a).toBe(b);
  });

  // ── Authorization 仅对 import.connect.upload 纳入 hash（Codex r7 P2）：普通 Bearer 写命令 token 轮换不破坏回放 ──
  it('非 upload scope（普通 Bearer 写命令）→ 换 Authorization 不影响 request_hash（Logto JWT 轮换仍按契约回放，不误 409）', async () => {
    /** 用 INSERT-成功路径取 PUBLISH_VERSION scope 下某 Authorization 的 requestHash。 */
    async function publishHash(authorization: string): Promise<string> {
      const db = {
        query: vi.fn(async () => ({ rows: [{ key: 'k' }] })),
      };
      const req = {
        id: 't',
        method: 'POST',
        url: '/api/v1/versions/v1/publish',
        body: { a: 1 },
        headers: { 'idempotency-key': 'k', authorization: authorization },
        server: { infra: { db } },
      } as unknown as FastifyRequest;
      const { reply } = makeReply();
      await requireIdempotency(IdempotencyScope.PUBLISH_VERSION)(req, reply);
      return req.idempotency!.requestHash;
    }
    const tokenA = await publishHash('Bearer jwt-old');
    const tokenB = await publishHash('Bearer jwt-rotated'); // 同用户 token 刷新
    expect(tokenA).toBe(tokenB); // 普通 scope 不纳入 Authorization → 同 hash → 可回放（不误判 409）
  });
});

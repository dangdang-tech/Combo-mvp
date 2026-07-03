// B-20/B-19 导入接入 API handler 自检：presign 签名/校验、create-job 传齐校验+建job入队、
//   快照读 owner 守门 + 分页、对外失败一律 ErrorEnvelope（无 code/堆栈）。
import { describe, it, expect } from 'vitest';
import type { RouteHandlerMethod } from 'fastify';
import {
  presignHandler,
  createJobHandler,
  getSnapshotHandler,
  listSegmentsHandler,
  listSnapshotsHandler,
} from '../modules/import/handlers.js';
import {
  insertSnapshotProtected,
  insertSegmentProtected,
} from '../modules/import/snapshot-repo.js';
import { ImportFakeDb, type JobRowF } from './import-fakes.js';

interface Sent {
  code: number;
  body: unknown;
}

function makeReqReply(opts: {
  userId?: string;
  body?: unknown;
  params?: Record<string, string>;
  query?: Record<string, string>;
  infra: Record<string, unknown>;
}) {
  const sent: Sent = { code: 0, body: undefined };
  const reply = {
    code(c: number) {
      sent.code = c;
      return this;
    },
    send(b: unknown) {
      sent.body = b;
      return this;
    },
    header() {
      return this;
    },
  };
  const req = {
    id: 'trace-1',
    auth: opts.userId ? { userId: opts.userId } : undefined,
    body: opts.body,
    params: opts.params ?? {},
    query: opts.query ?? {},
    headers: {},
    log: { error: () => {}, warn: () => {} },
    server: { infra: opts.infra },
  };
  return { req, reply, sent };
}

async function call(h: RouteHandlerMethod, ctx: ReturnType<typeof makeReqReply>): Promise<void> {
  await (h as (req: unknown, reply: unknown) => Promise<unknown>).call(
    undefined,
    ctx.req,
    ctx.reply,
  );
}

/** 对外信封绝不含 code（D1）。 */
function assertNoCode(body: unknown): void {
  const s = JSON.stringify(body);
  expect(s).not.toMatch(/"code"/);
}

function runningJob(db: ImportFakeDb, id: string, owner: string, fence: number): JobRowF {
  const j: JobRowF = {
    id,
    type: 'import',
    status: 'running',
    owner_user_id: owner,
    subject_ref: null,
    progress: {},
    fence_token: fence,
  };
  db.jobs.set(id, j);
  return j;
}

describe('presignHandler (B-20)', () => {
  const objectStore = {
    presignPut: async (_b: string, key: string) => ({ url: `https://s3/${key}?sig=x`, key }),
  };

  it('合法 parts → 200 + 每 part 预签名 URL + uploadId + bucket + 持久化 manifest（Codex P1-r2）', async () => {
    const db = new ImportFakeDb();
    const ctx = makeReqReply({
      userId: 'u1',
      body: {
        parts: [
          { clientPartId: 'p0', sizeBytes: 10 },
          { clientPartId: 'p1', sizeBytes: 20 },
        ],
        source: 'claude',
        totalBytes: 30,
      },
      infra: { db, objectStore },
    });
    await call(presignHandler(), ctx);
    expect(ctx.sent.code).toBe(200);
    const data = (ctx.sent.body as { data: { uploadId: string; bucket: string; parts: unknown[] } })
      .data;
    expect(data.bucket).toBe('agora-raw');
    expect(data.parts).toHaveLength(2);
    expect(data.uploadId).toBeTruthy();
    // manifest 已落库：声明了两个 expected part（Codex P1-r2 完整性闸前置）。
    const upl = db.uploads.get(`u1:${data.uploadId}`)!;
    expect(upl).toBeTruthy();
    expect(Object.keys(upl.expected_parts)).toEqual(['p0', 'p1']);
  });

  it('parts 为空 → 400 VALIDATION（人话 change_input，无 code）', async () => {
    const db = new ImportFakeDb();
    const ctx = makeReqReply({
      userId: 'u1',
      body: { parts: [], source: 'claude', totalBytes: 0 },
      infra: { db, objectStore },
    });
    await call(presignHandler(), ctx);
    expect(ctx.sent.code).toBe(400);
    const err = (ctx.sent.body as { error: { action: string; userMessage: string } }).error;
    expect(err.action).toBe('change_input');
    assertNoCode(ctx.sent.body);
  });

  it('S3 不可用 → 503 DEPENDENCY_UNAVAILABLE（人话，无裸报错）', async () => {
    const db = new ImportFakeDb();
    const ctx = makeReqReply({
      userId: 'u1',
      body: { parts: [{ clientPartId: 'p0', sizeBytes: 1 }], source: 'claude', totalBytes: 1 },
      infra: {
        db,
        objectStore: {
          presignPut: async () => {
            throw new Error('s3 down');
          },
        },
      },
    });
    await call(presignHandler(), ctx);
    expect(ctx.sent.code).toBe(503);
    assertNoCode(ctx.sent.body);
  });

  it('未登录 → 401', async () => {
    const ctx = makeReqReply({
      body: { parts: [{ clientPartId: 'p0', sizeBytes: 1 }], source: 'claude', totalBytes: 1 },
      infra: { db: new ImportFakeDb(), objectStore },
    });
    await call(presignHandler(), ctx);
    expect(ctx.sent.code).toBe(401);
  });
});

describe('createJobHandler (B-20→B-19) — manifest 完整性闸（Codex P1-r2）', () => {
  /** 模拟 presign：在 manifest 落 expected parts（clientPartId → s3Key）。返回 expected s3Key 集。 */
  function seedManifest(
    db: ImportFakeDb,
    owner: string,
    uploadId: string,
    partIds: string[],
  ): string[] {
    const expected: Record<string, { s3Key: string; contentSha256: string | null }> = {};
    const keys: string[] = [];
    for (const pid of partIds) {
      const s3Key = `raw/${owner}/${uploadId}/${pid}`;
      expected[pid] = { s3Key, contentSha256: null };
      keys.push(s3Key);
    }
    db.uploads.set(`${owner}:${uploadId}`, {
      id: 'upl-seed',
      owner_user_id: owner,
      upload_id: uploadId,
      source: 'claude',
      expected_parts: expected,
      total_bytes: 0,
      consumed_at: null,
      job_id: null,
    });
    return keys;
  }

  it('全部 part 到齐 → 202 + JobView(queued, type=import) + 建 job 入队 + 兑换 manifest', async () => {
    const db = new ImportFakeDb();
    const landed = seedManifest(db, 'u1', 'up1', ['p0', 'p1']);
    const enqueued: Array<{ type: string; jobId: string }> = [];
    const objectStore = {
      list: async (_b: string, prefix: string) => {
        expect(prefix).toContain('u1');
        return landed.map((key) => ({ key, size: 10, lastModified: 'x' }));
      },
    };
    const queue = {
      enqueue: async (type: string, jobId: string) => {
        enqueued.push({ type, jobId });
      },
    };
    const ctx = makeReqReply({
      userId: 'u1',
      body: { uploadId: 'up1', source: 'claude' },
      infra: { db, objectStore, queue },
    });
    await call(createJobHandler(), ctx);
    expect(ctx.sent.code).toBe(202);
    const data = (ctx.sent.body as { data: { id: string; type: string; status: string } }).data;
    expect(data.type).toBe('import');
    expect(data.status).toBe('queued');
    expect(db.jobs.size).toBe(1); // 建了 job 行
    // subject_ref 带有序 rawS3Keys（manifest 的全部 expected key）。
    const job = [...db.jobs.values()][0]!;
    expect((job.subject_ref as { rawS3Keys: string[] }).rawS3Keys).toEqual(landed);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.type).toBe('import');
    // manifest 已兑换（consumed_at 置）。
    expect(db.uploads.get('u1:up1')!.consumed_at).not.toBeNull();
  });

  it('【闸 Codex P1-r2】N 分片只到 1 片 → 409 STATE_CONFLICT，绝不建 job（直传补齐 manifest 闸）', async () => {
    const db = new ImportFakeDb();
    const landed = seedManifest(db, 'u1', 'up1', ['p0', 'p1', 'p2']); // 声明 3 片
    const objectStore = {
      // 桶里只落地了 1 片（p0）——旧实现「有任意对象就建 job」会误放行。
      list: async () => [{ key: landed[0]!, size: 1, lastModified: 'x' }],
    };
    const queue = { enqueue: async () => {} };
    const ctx = makeReqReply({
      userId: 'u1',
      body: { uploadId: 'up1', source: 'claude' },
      infra: { db, objectStore, queue },
    });
    await call(createJobHandler(), ctx);
    expect(ctx.sent.code).toBe(409); // 未齐 → STATE_CONFLICT
    const err = (ctx.sent.body as { error: { action: string } }).error;
    expect(err.action).toBe('change_input');
    expect(db.jobs.size).toBe(0); // 关键：未齐绝不建 job（manifest 完整性闸）
    expect(db.uploads.get('u1:up1')!.consumed_at).toBeNull(); // 未兑换
    assertNoCode(ctx.sent.body);
  });

  it('uploadId 无 manifest（presign 未发起/已清）→ 404 引导重发（不建 job，无 code）', async () => {
    const db = new ImportFakeDb();
    const objectStore = { list: async () => [] };
    const queue = { enqueue: async () => {} };
    const ctx = makeReqReply({
      userId: 'u1',
      body: { uploadId: 'up-missing', source: 'claude' },
      infra: { db, objectStore, queue },
    });
    await call(createJobHandler(), ctx);
    expect(ctx.sent.code).toBe(404);
    const err = (ctx.sent.body as { error: { action: string } }).error;
    expect(err.action).toBe('change_input');
    expect(db.jobs.size).toBe(0);
    assertNoCode(ctx.sent.body);
  });

  it('【原子+留 queued Codex P1-r5】入队失败 → manifest+job 同事务已提交、job 留 queued、202 真实 JobView（非 503、不删 job）', async () => {
    const db = new ImportFakeDb();
    const landed = seedManifest(db, 'u1', 'up1', ['p0']);
    const objectStore = {
      list: async () => landed.map((key) => ({ key, size: 1, lastModified: 'x' })),
    };
    const queue = {
      enqueue: async () => {
        throw new Error('redis down');
      },
    };
    const ctx = makeReqReply({
      userId: 'u1',
      body: { uploadId: 'up1', source: 'claude' },
      infra: { db, objectStore, queue },
    });
    await call(createJobHandler(), ctx);
    // 入队失败不再 503/删 job：job 已原子建成 queued，交 staleQueued sweeper 补投（不裸转圈、不假转圈）。
    expect(ctx.sent.code).toBe(202);
    const data = (ctx.sent.body as { data: { id: string; status: string } }).data;
    expect(data.status).toBe('queued'); // 真实 queued 态（sweeper 保证最终取走 + 有进度）
    // 关键：manifest+job 同事务提交，job 留 queued（不删、不标 failed）。
    expect(db.jobs.size).toBe(1);
    expect([...db.jobs.values()][0]!.status).toBe('queued');
    // manifest 已兑换 + job_id 已回写（同 uploadId 重试可恢复，非 404）。
    const upl = db.uploads.get('u1:up1')!;
    expect(upl.consumed_at).not.toBeNull();
    expect(upl.job_id).toBe(data.id);
    assertNoCode(ctx.sent.body);
  });

  it('【可恢复 Codex P1-r5】同一 uploadId 入队失败后重试 → 恢复同一 job 的 JobView（202，非 404、非新建）', async () => {
    const db = new ImportFakeDb();
    const landed = seedManifest(db, 'u1', 'up1', ['p0']);
    const objectStore = {
      list: async () => landed.map((key) => ({ key, size: 1, lastModified: 'x' })),
    };
    const failQueue = {
      enqueue: async () => {
        throw new Error('redis down');
      },
    };
    const first = makeReqReply({
      userId: 'u1',
      body: { uploadId: 'up1', source: 'claude' },
      infra: { db, objectStore, queue: failQueue },
    });
    await call(createJobHandler(), first);
    expect(first.sent.code).toBe(202);
    const firstId = (first.sent.body as { data: { id: string } }).data.id;

    // 重试（manifest 已 consumed、job_id 已回写）→ 恢复同一 job（非 404、不重复建）。
    const okQueue = { enqueue: async () => {} };
    const retry = makeReqReply({
      userId: 'u1',
      body: { uploadId: 'up1', source: 'claude' },
      infra: { db, objectStore, queue: okQueue },
    });
    await call(createJobHandler(), retry);
    expect(retry.sent.code).toBe(202); // 非 404
    const retryData = (retry.sent.body as { data: { id: string; status: string } }).data;
    expect(retryData.id).toBe(firstId); // 同一个 job
    expect(db.jobs.size).toBe(1); // 没重复建
  });

  it('【恢复短路 Codex P1-r6】manifest 已 consumed + job_id 已回写 + 桶对象已清/不可列 → 仍按 job_id 恢复（202，非 404，绝不 list 桶/过闸）', async () => {
    const db = new ImportFakeDb();
    seedManifest(db, 'u1', 'up1', ['p0']);
    // 先正常建一次 job（兑换 manifest + 回写 job_id）。
    const okStore = {
      list: async () => [{ key: 'raw/u1/up1/p0', size: 1, lastModified: 'x' }],
    };
    const first = makeReqReply({
      userId: 'u1',
      body: { uploadId: 'up1', source: 'claude' },
      infra: { db, objectStore: okStore, queue: { enqueue: async () => {} } },
    });
    await call(createJobHandler(), first);
    expect(first.sent.code).toBe(202);
    const firstId = (first.sent.body as { data: { id: string } }).data.id;
    const upl = db.uploads.get('u1:up1')!;
    expect(upl.consumed_at).not.toBeNull();
    expect(upl.job_id).toBe(firstId);

    // 重试：桶对象已被清/不可列（list 抛错）。恢复短路必须在 list/gate 之前 → 不应碰到 list 抛错。
    let listCalled = false;
    const clearedStore = {
      list: async () => {
        listCalled = true;
        throw new Error('bucket object gone / not listable');
      },
    };
    const retry = makeReqReply({
      userId: 'u1',
      body: { uploadId: 'up1', source: 'claude' },
      infra: { db, objectStore: clearedStore, queue: { enqueue: async () => {} } },
    });
    await call(createJobHandler(), retry);
    expect(retry.sent.code).toBe(202); // 关键：非 404——按 job_id 恢复既有 JobView
    const data = (retry.sent.body as { data: { id: string; status: string } }).data;
    expect(data.id).toBe(firstId); // 同一个 job
    expect(listCalled).toBe(false); // 恢复优先于完整性闸：绝不 list 桶
    expect(db.jobs.size).toBe(1); // 不重复建
    assertNoCode(retry.sent.body);
  });

  it('body 不合法 → 400', async () => {
    const ctx = makeReqReply({
      userId: 'u1',
      body: { source: 'claude' }, // 缺 uploadId
      infra: { db: new ImportFakeDb(), objectStore: { list: async () => [] }, queue: {} },
    });
    await call(createJobHandler(), ctx);
    expect(ctx.sent.code).toBe(400);
  });
});

describe('快照读 handler (B-19) — owner 守门 + 分页', () => {
  async function seedSnapshot(db: ImportFakeDb, owner: string, segs = 0): Promise<string> {
    runningJob(db, `j-${owner}`, owner, 1);
    const id = (await insertSnapshotProtected(db, {
      jobId: `j-${owner}`,
      fenceToken: 1,
      source: 'claude',
      sources: ['claude'],
      rawS3Key: null,
      segmentCount: segs,
      messageCount: segs * 5,
      projectCount: 1,
      timeFrom: '2026-03-01',
      timeTo: '2026-06-01',
      redactionReport: {
        applied: true,
        totalRedactions: 0,
        byCategory: [],
        rulesetVersion: 'redaction-v1',
      },
      rulesetVersion: 'redaction-v1',
    }))!;
    for (let i = 0; i < segs; i++) {
      await insertSegmentProtected(db, {
        snapshotId: id,
        fenceToken: 1,
        contentHash: `h${i}`,
        source: 'claude',
        title: `会话${i}`,
        dateLabel: '03-20',
        happenedAt: null,
        project: null,
        messageCount: 5,
        content: `c${i}`,
      });
    }
    return id;
  }

  it('getSnapshot：属主 200 + 统计四格 + 去敏报告；非属主 404（不暴露存在性）', async () => {
    const db = new ImportFakeDb();
    const id = await seedSnapshot(db, 'u1', 2);
    const mine = makeReqReply({ userId: 'u1', params: { snapshotId: id }, infra: { db } });
    await call(getSnapshotHandler(), mine);
    expect(mine.sent.code).toBe(200);
    const view = (
      mine.sent.body as { data: { stats: { segmentCount: number }; redaction: unknown } }
    ).data;
    expect(view.stats.segmentCount).toBe(2);
    expect(view.redaction).toBeDefined();

    const attacker = makeReqReply({ userId: 'x', params: { snapshotId: id }, infra: { db } });
    await call(getSnapshotHandler(), attacker);
    expect(attacker.sent.code).toBe(404);
  });

  it('listSegments：属主 200 + readOnly:true + cursor 分页；非属主 404', async () => {
    const db = new ImportFakeDb();
    const id = await seedSnapshot(db, 'u1', 3);
    const p1 = makeReqReply({
      userId: 'u1',
      params: { snapshotId: id },
      query: { limit: '2' },
      infra: { db },
    });
    await call(listSegmentsHandler(), p1);
    expect(p1.sent.code).toBe(200);
    const body = p1.sent.body as {
      data: Array<{ readOnly: boolean }>;
      meta: { page: { nextCursor: string | null; hasMore: boolean } };
    };
    expect(body.data).toHaveLength(2);
    expect(body.data[0]!.readOnly).toBe(true);
    expect(body.meta.page.hasMore).toBe(true);

    const attacker = makeReqReply({ userId: 'x', params: { snapshotId: id }, infra: { db } });
    await call(listSegmentsHandler(), attacker);
    expect(attacker.sent.code).toBe(404);
  });

  it('listSnapshots：只列本人快照（重导后旧快照仍在）', async () => {
    const db = new ImportFakeDb();
    await seedSnapshot(db, 'u1', 1);
    await seedSnapshot(db, 'other', 1);
    const ctx = makeReqReply({ userId: 'u1', infra: { db } });
    await call(listSnapshotsHandler(), ctx);
    expect(ctx.sent.code).toBe(200);
    const body = ctx.sent.body as { data: Array<{ id: string; isLatest: boolean }> };
    expect(body.data).toHaveLength(1); // 只本人
    expect(body.data[0]!.isLatest).toBe(true);
  });

  it('limit 非法 → 400', async () => {
    const db = new ImportFakeDb();
    const ctx = makeReqReply({ userId: 'u1', query: { limit: '999' }, infra: { db } });
    await call(listSnapshotsHandler(), ctx);
    expect(ctx.sent.code).toBe(400);
  });
});

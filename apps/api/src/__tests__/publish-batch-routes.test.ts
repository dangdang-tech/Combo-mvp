// 50 · 批量发布域 API handler 自检（B-29，50-step5-publish §2.3/§2.4/§2.5）。忠实 mock，无真 PG。
//   重点（契约）：
//     · 建批：202 Envelope<PublishBatchView>（含 jobId 供前端连 SSE；初始全 pending、进度可渲染、不裸转圈）+ 入队。
//       items 空 / 项缺 candidateId&versionId → 400 change_input；对外信封绝不含 code（D1）。
//     · 查批：200 owner 守门（404/403）；恢复全量（已发布不丢）。
//     · 单 item 重试：202 该 item 回 pending + 重新入队；非 failed→409、非本人→403、不存在→404；均无 code。
import { describe, it, expect } from 'vitest';
import type { RouteHandlerMethod } from 'fastify';
import {
  createPublishBatchHandler,
  getPublishBatchHandler,
  retryPublishBatchItemHandler,
} from '../routes/publish-batch-handlers.js';
import { asTxPool } from '../events/db-tx.js';
import {
  createPublishBatchTx,
  finalizeBatchItemTx,
  readBatchItems,
} from '../publish/batch-repo.js';
import { PublishBatchFakeDb, seedUser } from './publish-batch-fakes.js';
import type { ErrorBody } from '@cb/shared';

interface Sent {
  code: number;
  body: unknown;
}
class FakeQueue {
  enqueued: Array<{ type: string; jobId: string; fence: number }> = [];
  fail = false;
  async enqueue(type: string, jobId: string, fence: number): Promise<void> {
    if (this.fail) throw new Error('enqueue down');
    this.enqueued.push({ type, jobId, fence });
  }
}
function makeReqReply(opts: {
  userId?: string;
  params?: Record<string, string>;
  body?: unknown;
  db: PublishBatchFakeDb;
  queue: FakeQueue;
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
  };
  const req = {
    id: 'trace-batch',
    auth: opts.userId ? { userId: opts.userId } : undefined,
    params: opts.params ?? {},
    body: opts.body,
    headers: {},
    log: { warn() {}, info() {} },
    server: { infra: { db: opts.db, queue: opts.queue } },
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
function assertNoCode(body: unknown): void {
  expect(JSON.stringify(body)).not.toMatch(/"code"/);
}
function dataOf<T>(body: unknown): T {
  return (body as { data: T }).data;
}
function errOf(body: unknown): { action: string; userMessage: string } {
  return (body as { error: { action: string; userMessage: string } }).error;
}

const errBody: ErrorBody = {
  userMessage: '这一项没发出去，稍后单独重试一下。',
  retriable: true,
  action: 'retry',
  traceId: 'tr',
};

function stdItems(...keys: string[]) {
  return keys.map((k) => ({
    versionId: `ver-${k}`,
    idempotencyKey: k,
    tiers: [{ tierCode: 'standard', priceMicros: 9_900_000 }],
    visibility: 'public' as const,
  }));
}

// ===========================================================================
// §2.3 · 建批
// ===========================================================================
describe('createPublishBatchHandler (§2.3)', () => {
  it('成功 → 202 Envelope<PublishBatchView>（jobId + 全 pending + 进度三元）+ 入队；无 code', async () => {
    const db = new PublishBatchFakeDb();
    const queue = new FakeQueue();
    const owner = seedUser(db);
    const ctx = makeReqReply({ userId: owner, body: { items: stdItems('a', 'b') }, db, queue });
    await call(createPublishBatchHandler(), ctx);
    expect(ctx.sent.code).toBe(202);
    assertNoCode(ctx.sent.body);
    const v = dataOf<{
      jobId: string;
      total: number;
      processedCount: number;
      publishedCount: number;
      failedCount: number;
      items: Array<{ state: string }>;
      status: string;
    }>(ctx.sent.body);
    expect(v.jobId).toBeTruthy();
    expect(v.total).toBe(2);
    expect(v.processedCount).toBe(0);
    expect(v.items.every((i) => i.state === 'pending')).toBe(true);
    // 入队 publish_batch job。
    expect(queue.enqueued).toEqual([{ type: 'publish_batch', jobId: v.jobId, fence: 1 }]);
  });

  it('入队失败 → 仍 202（job 留 queued 交 sweeper 补投，不裸转圈/不 503）', async () => {
    const db = new PublishBatchFakeDb();
    const queue = new FakeQueue();
    queue.fail = true;
    const owner = seedUser(db);
    const ctx = makeReqReply({ userId: owner, body: { items: stdItems('a') }, db, queue });
    await call(createPublishBatchHandler(), ctx);
    expect(ctx.sent.code).toBe(202);
    assertNoCode(ctx.sent.body);
  });

  it('items 空 → 400 change_input（回上一步选），无 code', async () => {
    const db = new PublishBatchFakeDb();
    const queue = new FakeQueue();
    const owner = seedUser(db);
    const ctx = makeReqReply({ userId: owner, body: { items: [] }, db, queue });
    await call(createPublishBatchHandler(), ctx);
    expect(ctx.sent.code).toBe(400);
    expect(errOf(ctx.sent.body).action).toBe('change_input');
    assertNoCode(ctx.sent.body);
  });

  it('项缺 candidateId&versionId → 400 change_input，无 code', async () => {
    const db = new PublishBatchFakeDb();
    const queue = new FakeQueue();
    const owner = seedUser(db);
    const ctx = makeReqReply({
      userId: owner,
      body: { items: [{ idempotencyKey: 'x' }] },
      db,
      queue,
    });
    await call(createPublishBatchHandler(), ctx);
    expect(ctx.sent.code).toBe(400);
    assertNoCode(ctx.sent.body);
  });

  it('项同时给 candidateId+versionId（非恰好二选一）→ 400 change_input，不建畸形批、不入队，无 code（反向破坏守门）', async () => {
    // 缺口：旧 `!(candidateId ?? versionId)` 只挡「两者都缺」，放行「两者都给」——会走 candidate 路径却因
    //   existingVersionId 跳过 create、把外部 version 挂到不相关候选项下。恰好二选一 refine 后此项整批校验阶段被拒。
    const db = new PublishBatchFakeDb();
    const queue = new FakeQueue();
    const owner = seedUser(db);
    const ctx = makeReqReply({
      userId: owner,
      body: {
        items: [{ candidateId: 'cand-x', versionId: 'ver-x', idempotencyKey: 'x' }],
      },
      db,
      queue,
    });
    await call(createPublishBatchHandler(), ctx);
    expect(ctx.sent.code).toBe(400);
    expect(errOf(ctx.sent.body).action).toBe('change_input');
    assertNoCode(ctx.sent.body);
    // 整批校验阶段拒，绝不建库/入队（不建畸形批）。
    expect(db.batches.size).toBe(0);
    expect(db.items.size).toBe(0);
    expect(queue.enqueued).toHaveLength(0);
  });

  it('正常 candidate-only / version-only 单给项 → 通过（恰好二选一不误伤既有路径）', async () => {
    const db = new PublishBatchFakeDb();
    const queue = new FakeQueue();
    const owner = seedUser(db);
    const ctx = makeReqReply({
      userId: owner,
      body: {
        items: [
          { candidateId: 'cand-only', idempotencyKey: 'c' },
          { versionId: 'ver-only', idempotencyKey: 'v' },
        ],
      },
      db,
      queue,
    });
    await call(createPublishBatchHandler(), ctx);
    expect(ctx.sent.code).toBe(202);
    assertNoCode(ctx.sent.body);
    expect(queue.enqueued).toHaveLength(1);
  });

  it('未登录 → 401，无 code', async () => {
    const db = new PublishBatchFakeDb();
    const queue = new FakeQueue();
    const ctx = makeReqReply({ body: { items: stdItems('a') }, db, queue });
    await call(createPublishBatchHandler(), ctx);
    expect(ctx.sent.code).toBe(401);
    assertNoCode(ctx.sent.body);
  });

  it('【P1】请求内重复 idempotencyKey → 400 change_input 人话冲突（整事务回滚、不留卡死 batch、不入队）；无 code', async () => {
    const db = new PublishBatchFakeDb();
    const queue = new FakeQueue();
    const owner = seedUser(db);
    // 两项同 key 'a'：建批强校验 insertedCount != total → PublishBatchError → handler 出 400 change_input。
    const ctx = makeReqReply({
      userId: owner,
      body: {
        items: [
          { versionId: 'ver-a', idempotencyKey: 'a' },
          { versionId: 'ver-a2', idempotencyKey: 'a' },
        ],
      },
      db,
      queue,
    });
    await call(createPublishBatchHandler(), ctx);
    expect(ctx.sent.code).toBe(400);
    expect(errOf(ctx.sent.body).action).toBe('change_input');
    assertNoCode(ctx.sent.body);
    // 回滚兜底：不留半建/卡死 batch，不入队（worker 不会拿到一个 total 不符的批）。
    expect(db.batches.size).toBe(0);
    expect(db.items.size).toBe(0);
    expect(queue.enqueued).toHaveLength(0);
  });
});

// ===========================================================================
// §2.4 · 查批
// ===========================================================================
describe('getPublishBatchHandler (§2.4)', () => {
  it('成功 → 200 全量（含已 published item，恢复不丢）；owner 本人', async () => {
    const db = new PublishBatchFakeDb();
    const queue = new FakeQueue();
    const owner = seedUser(db);
    const created = await createPublishBatchTx(asTxPool(db), {
      ownerUserId: owner,
      items: stdItems('a', 'b'),
    });
    db.startJob(created.jobId, 1);
    const [a] = await readBatchItems(db, created.batchId);
    await finalizeBatchItemTx(db, {
      itemId: a!.id,
      jobId: created.jobId,
      fenceToken: 1,
      state: 'published',
    });
    const ctx = makeReqReply({ userId: owner, params: { batchId: created.batchId }, db, queue });
    await call(getPublishBatchHandler(), ctx);
    expect(ctx.sent.code).toBe(200);
    const v = dataOf<{ processedCount: number; publishedCount: number; items: unknown[] }>(
      ctx.sent.body,
    );
    expect(v.processedCount).toBe(1);
    expect(v.publishedCount).toBe(1);
    expect(v.items).toHaveLength(2);
    assertNoCode(ctx.sent.body);
  });

  it('非本人 → 403；不存在 → 404；未登录 → 401（均无 code）', async () => {
    const db = new PublishBatchFakeDb();
    const queue = new FakeQueue();
    const owner = seedUser(db);
    const created = await createPublishBatchTx(asTxPool(db), {
      ownerUserId: owner,
      items: stdItems('a'),
    });
    const c1 = makeReqReply({
      userId: 'intruder',
      params: { batchId: created.batchId },
      db,
      queue,
    });
    await call(getPublishBatchHandler(), c1);
    expect(c1.sent.code).toBe(403);
    assertNoCode(c1.sent.body);
    const c2 = makeReqReply({ userId: owner, params: { batchId: 'nope' }, db, queue });
    await call(getPublishBatchHandler(), c2);
    expect(c2.sent.code).toBe(404);
    assertNoCode(c2.sent.body);
    const c3 = makeReqReply({ params: { batchId: created.batchId }, db, queue });
    await call(getPublishBatchHandler(), c3);
    expect(c3.sent.code).toBe(401);
    assertNoCode(c3.sent.body);
  });
});

// ===========================================================================
// §2.5 · 单 item 重试
// ===========================================================================
describe('retryPublishBatchItemHandler (§2.5)', () => {
  async function seedFailedItem(db: PublishBatchFakeDb, owner: string) {
    const created = await createPublishBatchTx(asTxPool(db), {
      ownerUserId: owner,
      items: stdItems('a'),
    });
    db.startJob(created.jobId, 1);
    const [a] = await readBatchItems(db, created.batchId);
    await finalizeBatchItemTx(db, {
      itemId: a!.id,
      jobId: created.jobId,
      fenceToken: 1,
      state: 'failed',
      error: errBody,
      missingFields: ['name'],
    });
    return { batchId: created.batchId, jobId: created.jobId, itemId: a!.id };
  }

  it('failed item → 202 该 item 回 pending + 重新入队（换 fence）；无 code', async () => {
    const db = new PublishBatchFakeDb();
    const queue = new FakeQueue();
    const owner = seedUser(db);
    const { batchId, itemId, jobId } = await seedFailedItem(db, owner);
    const ctx = makeReqReply({ userId: owner, params: { batchId, itemId }, body: {}, db, queue });
    await call(retryPublishBatchItemHandler(), ctx);
    expect(ctx.sent.code).toBe(202);
    const v = dataOf<{ state: string }>(ctx.sent.body);
    expect(v.state).toBe('pending');
    assertNoCode(ctx.sent.body);
    // 换 fence 重新入队（fence=2）。
    expect(queue.enqueued).toEqual([{ type: 'publish_batch', jobId, fence: 2 }]);
  });

  it('item 非 failed（已 published）→ 409 STATE_CONFLICT（不需要重试，action none），无 code', async () => {
    const db = new PublishBatchFakeDb();
    const queue = new FakeQueue();
    const owner = seedUser(db);
    const created = await createPublishBatchTx(asTxPool(db), {
      ownerUserId: owner,
      items: stdItems('a'),
    });
    db.startJob(created.jobId, 1);
    const [a] = await readBatchItems(db, created.batchId);
    await finalizeBatchItemTx(db, {
      itemId: a!.id,
      jobId: created.jobId,
      fenceToken: 1,
      state: 'published',
    });
    const ctx = makeReqReply({
      userId: owner,
      params: { batchId: created.batchId, itemId: a!.id },
      body: {},
      db,
      queue,
    });
    await call(retryPublishBatchItemHandler(), ctx);
    expect(ctx.sent.code).toBe(409);
    expect(errOf(ctx.sent.body).action).toBe('none');
    assertNoCode(ctx.sent.body);
  });

  it('非本人 → 403；批/项不存在 → 404；未登录 → 401（均无 code）', async () => {
    const db = new PublishBatchFakeDb();
    const queue = new FakeQueue();
    const owner = seedUser(db);
    const { batchId, itemId } = await seedFailedItem(db, owner);
    const c1 = makeReqReply({
      userId: 'intruder',
      params: { batchId, itemId },
      body: {},
      db,
      queue,
    });
    await call(retryPublishBatchItemHandler(), c1);
    expect(c1.sent.code).toBe(403);
    assertNoCode(c1.sent.body);
    const c2 = makeReqReply({
      userId: owner,
      params: { batchId: 'nope', itemId },
      body: {},
      db,
      queue,
    });
    await call(retryPublishBatchItemHandler(), c2);
    expect(c2.sent.code).toBe(404);
    assertNoCode(c2.sent.body);
    const c3 = makeReqReply({ params: { batchId, itemId }, body: {}, db, queue });
    await call(retryPublishBatchItemHandler(), c3);
    expect(c3.sent.code).toBe(401);
    assertNoCode(c3.sent.body);
  });

  it('携新发布入参重试 → 202（修过封面/价格后重试）', async () => {
    const db = new PublishBatchFakeDb();
    const queue = new FakeQueue();
    const owner = seedUser(db);
    const { batchId, itemId } = await seedFailedItem(db, owner);
    const ctx = makeReqReply({
      userId: owner,
      params: { batchId, itemId },
      body: { tiers: [{ tierCode: 'standard', priceMicros: 1_000_000 }], visibility: 'unlisted' },
      db,
      queue,
    });
    await call(retryPublishBatchItemHandler(), ctx);
    expect(ctx.sent.code).toBe(202);
    assertNoCode(ctx.sent.body);
  });
});

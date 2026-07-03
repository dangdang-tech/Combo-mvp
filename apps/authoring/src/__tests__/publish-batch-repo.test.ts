// 50 · 批量发布仓储自检（B-29 无连坐 P0，50-step5-publish §2.3/§2.4/§2.5/§5）。忠实 mock，无真 PG。
//   重点（契约 + 合规清单）：
//     · 建批单事务：jobs + publish_batches + N×items（idempotency_key UNIQ → 重发不重复建项）。
//     · 模板 A 中间态推进：fence 守门（fence 失配 0 行）、终态不可回退。
//     · 模板 B 终态 + 计数【合成单条 CTE 计数幂等化】：重复回写不重复递增（不漏不重）；processed=published+failed；
//       processed===total 即 completed（含失败也到完成、永不裸转圈，Codex#7）。
//     · 单 item 重试：仅 failed→pending、failed_count-1 复位、job 换 fence；不动其余 item。
import { describe, it, expect } from 'vitest';
import { asTxPool } from '../platform/events/db-tx.js';
import {
  createPublishBatchTx,
  advanceBatchItemTx,
  backfillItemVersionTx,
  finalizeBatchItemTx,
  retryBatchItemTx,
  readBatch,
  readBatchItems,
  readPublishBatchFull,
  PublishBatchError,
  type BatchItemPublishInput,
} from '../modules/publish/batch-repo.js';
import { PublishBatchFakeDb, seedUser } from './publish-batch-fakes.js';
import type { ErrorBody } from '@cb/shared';

const errBody: ErrorBody = {
  userMessage: '这一项没发出去，稍后单独重试一下。',
  retriable: true,
  action: 'retry',
  traceId: 'tr',
};

function items(...keys: string[]): BatchItemPublishInput[] {
  return keys.map((k) => ({ versionId: `ver-${k}`, idempotencyKey: k }));
}

describe('createPublishBatchTx (§2.3 / §5)', () => {
  it('建 job + batch + N items（idempotency_key UNIQ），total 正确、初值 0', async () => {
    const db = new PublishBatchFakeDb();
    const owner = seedUser(db);
    const created = await createPublishBatchTx(asTxPool(db), {
      ownerUserId: owner,
      items: items('a', 'b', 'c'),
    });
    expect(created.total).toBe(3);
    expect(db.jobs.get(created.jobId)?.type).toBe('publish_batch');
    const batch = await readBatch(db, created.batchId);
    expect(batch?.total).toBe(3);
    expect(batch?.publishedCount).toBe(0);
    expect(batch?.failedCount).toBe(0);
    expect(batch?.processedCount).toBe(0);
    const rows = await readBatchItems(db, created.batchId);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.state === 'pending')).toBe(true);
  });

  it('【P1 守门】请求内重复 idempotencyKey → 整事务回滚 + 抛 PublishBatchError（不留 total 不符的卡死 batch）', async () => {
    const db = new PublishBatchFakeDb();
    const owner = seedUser(db);
    // 一个请求里两项同 key 'a'：ON CONFLICT 静默跳第二项 → insertedCount(1) != total(2) → 强校验回滚。
    await expect(
      createPublishBatchTx(asTxPool(db), {
        ownerUserId: owner,
        items: [...items('a'), { versionId: 'ver-a2', idempotencyKey: 'a' }],
      }),
    ).rejects.toBeInstanceOf(PublishBatchError);
    // 回滚后：无半建批次 / 无落库 item（事务原子，不留 total > 行数的卡死 batch）。
    expect(db.batches.size).toBe(0);
    expect(db.items.size).toBe(0);
    expect(db.jobs.size).toBe(0);
  });

  it('【P1 守门】跨批撞同一 idempotencyKey（全局 UNIQ）→ 同样整事务回滚（不留卡死 batch）', async () => {
    const db = new PublishBatchFakeDb();
    const owner = seedUser(db);
    const first = await createPublishBatchTx(asTxPool(db), {
      ownerUserId: owner,
      items: items('a'),
    });
    // 第二批复用既有 key 'a' + 新 key 'b'：'a' 全局已存在 → 跳过 → insertedCount(1) != total(2) → 回滚。
    await expect(
      createPublishBatchTx(asTxPool(db), { ownerUserId: owner, items: items('a', 'b') }),
    ).rejects.toBeInstanceOf(PublishBatchError);
    // 第一批完好；第二批整体回滚（不留半建批、不落 'b'）。全局仅第一批的 'a' 一项。
    expect((await readBatchItems(db, first.batchId)).map((r) => r.idempotencyKey)).toEqual(['a']);
    expect(db.items.size).toBe(1);
    expect(db.batches.size).toBe(1);
  });

  it('【反向破坏假想】若保留「静默跳过 + total=请求数」→ 该批 total>实际行数：processed 永追不到 total（会卡死）', async () => {
    // 正向：现修法保证 total === 实际落库行数（无重复时相等），下方 finalize 全部项即可到 completed。
    const db = new PublishBatchFakeDb();
    const owner = seedUser(db);
    const created = await createPublishBatchTx(asTxPool(db), {
      ownerUserId: owner,
      items: items('a', 'b'),
    });
    db.startJob(created.jobId, 1);
    const rows = await readBatchItems(db, created.batchId);
    expect(rows).toHaveLength(created.total); // 实际行数 === total（修法核心保证）
    for (const r of rows) {
      await finalizeBatchItemTx(db, {
        itemId: r.id,
        jobId: created.jobId,
        fenceToken: 1,
        state: 'published',
      });
    }
    const b = await readBatch(db, created.batchId);
    // processed 能追到 total → completed（绝不卡 running）。若退回静默跳过 + total=请求数，此处 processed<total 会永卡。
    expect(b?.processedCount).toBe(created.total);
    expect(b?.status).toBe('completed');
  });
});

describe('advanceBatchItemTx 模板 A（中间态，§5）', () => {
  it('fence 匹配 + 非终态 → 推进 publishing（true）；终态不可回退（false）', async () => {
    const db = new PublishBatchFakeDb();
    const owner = seedUser(db);
    const created = await createPublishBatchTx(asTxPool(db), {
      ownerUserId: owner,
      items: items('a'),
    });
    db.startJob(created.jobId, 7);
    const it = (await readBatchItems(db, created.batchId))[0]!;
    const ok = await advanceBatchItemTx(db, {
      itemId: it.id,
      jobId: created.jobId,
      fenceToken: 7,
      state: 'publishing',
    });
    expect(ok).toBe(true);
    expect((await readBatchItems(db, created.batchId))[0]!.state).toBe('publishing');

    // 把它推到终态后再 advance → 终态不可回退（false）。
    await finalizeBatchItemTx(db, {
      itemId: it.id,
      jobId: created.jobId,
      fenceToken: 7,
      state: 'published',
    });
    const re = await advanceBatchItemTx(db, {
      itemId: it.id,
      jobId: created.jobId,
      fenceToken: 7,
      state: 'publishing',
    });
    expect(re).toBe(false);
  });

  it('fence 失配 → 0 行（false），item 不动（已被接管，安全退出）', async () => {
    const db = new PublishBatchFakeDb();
    const owner = seedUser(db);
    const created = await createPublishBatchTx(asTxPool(db), {
      ownerUserId: owner,
      items: items('a'),
    });
    db.startJob(created.jobId, 7);
    const it = (await readBatchItems(db, created.batchId))[0]!;
    const ok = await advanceBatchItemTx(db, {
      itemId: it.id,
      jobId: created.jobId,
      fenceToken: 999, // 失配
      state: 'publishing',
    });
    expect(ok).toBe(false);
    expect((await readBatchItems(db, created.batchId))[0]!.state).toBe('pending');
  });
});

describe('backfillItemVersionTx 早回填 versionId（已生成不丢，硬规则③）', () => {
  /** 建一条 candidate-only item（version_id null，需批内 create→structure），起 job running。 */
  async function setupCandidateItem(
    db: PublishBatchFakeDb,
    owner: string,
    fence = 1,
  ): Promise<{ itemId: string; jobId: string; batchId: string }> {
    const created = await createPublishBatchTx(asTxPool(db), {
      ownerUserId: owner,
      items: [{ candidateId: 'cand-1', idempotencyKey: 'k1' }],
    });
    db.startJob(created.jobId, fence);
    const it = (await readBatchItems(db, created.batchId))[0]!;
    expect(it.versionId).toBeNull(); // candidate-only：起点无 versionId。
    return { itemId: it.id, jobId: created.jobId, batchId: created.batchId };
  }

  it('fence 匹配 + item 无 versionId → 立即回填 versionId + capabilityId（true），早于 structure', async () => {
    const db = new PublishBatchFakeDb();
    const owner = seedUser(db);
    const { itemId, jobId, batchId } = await setupCandidateItem(db, owner, 1);

    const ok = await backfillItemVersionTx(db, {
      itemId,
      jobId,
      fenceToken: 1,
      versionId: 'ver-new',
      capabilityId: 'cap-new',
    });
    expect(ok).toBe(true);
    const it = (await readBatchItems(db, batchId))[0]!;
    expect(it.versionId).toBe('ver-new'); // 已焊到 item 行（重试可据此复用，不重复建版）。
    expect(it.capabilityId).toBe('cap-new');
    expect(it.state).toBe('pending'); // 不动 state（state 由模板 A/B 管）。
  });

  it('fence 失配 → 0 行（false），item 不回填（已被接管，按 fencedOut 收口）', async () => {
    const db = new PublishBatchFakeDb();
    const owner = seedUser(db);
    const { itemId, jobId, batchId } = await setupCandidateItem(db, owner, 1);

    const ok = await backfillItemVersionTx(db, {
      itemId,
      jobId,
      fenceToken: 999, // 失配（已被接管换 fence）。
      versionId: 'ver-new',
    });
    expect(ok).toBe(false);
    expect((await readBatchItems(db, batchId))[0]!.versionId).toBeNull();
  });

  it('幂等：item 已有 versionId → 不覆盖（false），保留既有版本（重投/并发安全）', async () => {
    const db = new PublishBatchFakeDb();
    const owner = seedUser(db);
    const { itemId, jobId, batchId } = await setupCandidateItem(db, owner, 1);
    // 先回填 ver-1。
    expect(
      await backfillItemVersionTx(db, { itemId, jobId, fenceToken: 1, versionId: 'ver-1' }),
    ).toBe(true);
    // 再回填 ver-2（重投/并发再 create）→ 不覆盖（仅 version_id IS NULL 才写）。
    const second = await backfillItemVersionTx(db, {
      itemId,
      jobId,
      fenceToken: 1,
      versionId: 'ver-2',
    });
    expect(second).toBe(false);
    expect((await readBatchItems(db, batchId))[0]!.versionId).toBe('ver-1'); // 既有版本不丢。
  });
});

describe('finalizeBatchItemTx 模板 B（终态 + 计数，计数幂等化，§5 Codex#5-r3）', () => {
  it('item published → published_count+1、processed 自洽（processed=published+failed）', async () => {
    const db = new PublishBatchFakeDb();
    const owner = seedUser(db);
    const created = await createPublishBatchTx(asTxPool(db), {
      ownerUserId: owner,
      items: items('a', 'b'),
    });
    db.startJob(created.jobId, 1);
    const [a] = await readBatchItems(db, created.batchId);
    const r = await finalizeBatchItemTx(db, {
      itemId: a!.id,
      jobId: created.jobId,
      fenceToken: 1,
      state: 'published',
    });
    expect(r.moved).toBe(true);
    expect(r.batchCompleted).toBe(false); // 2 项中刚成 1
    const b = await readBatch(db, created.batchId);
    expect(b?.publishedCount).toBe(1);
    expect(b?.processedCount).toBe(1);
    expect(b?.status).toBe('running');
  });

  it('重复回写同一终态 → moved=false、计数 +0（不重复递增，重投/双消费不漏不重）', async () => {
    const db = new PublishBatchFakeDb();
    const owner = seedUser(db);
    const created = await createPublishBatchTx(asTxPool(db), {
      ownerUserId: owner,
      items: items('a'),
    });
    db.startJob(created.jobId, 1);
    const [a] = await readBatchItems(db, created.batchId);
    const first = await finalizeBatchItemTx(db, {
      itemId: a!.id,
      jobId: created.jobId,
      fenceToken: 1,
      state: 'published',
    });
    expect(first.moved).toBe(true);
    // 第二次（重投/双消费）：防重 state NOT IN(published,failed) 挡住 → moved=false、计数不变。
    const again = await finalizeBatchItemTx(db, {
      itemId: a!.id,
      jobId: created.jobId,
      fenceToken: 1,
      state: 'published',
    });
    expect(again.moved).toBe(false);
    const b = await readBatch(db, created.batchId);
    expect(b?.publishedCount).toBe(1); // 仍 1（未双计）
    expect(b?.processedCount).toBe(1);
  });

  it('全部终态（含失败）→ processed===total、batchCompleted=true、status=completed（有失败也到完成）', async () => {
    const db = new PublishBatchFakeDb();
    const owner = seedUser(db);
    const created = await createPublishBatchTx(asTxPool(db), {
      ownerUserId: owner,
      items: items('a', 'b', 'c'),
    });
    db.startJob(created.jobId, 1);
    const rows = await readBatchItems(db, created.batchId);
    await finalizeBatchItemTx(db, {
      itemId: rows[0]!.id,
      jobId: created.jobId,
      fenceToken: 1,
      state: 'published',
    });
    await finalizeBatchItemTx(db, {
      itemId: rows[1]!.id,
      jobId: created.jobId,
      fenceToken: 1,
      state: 'failed',
      error: errBody,
    });
    const last = await finalizeBatchItemTx(db, {
      itemId: rows[2]!.id,
      jobId: created.jobId,
      fenceToken: 1,
      state: 'published',
    });
    expect(last.batchCompleted).toBe(true);
    const b = await readBatch(db, created.batchId);
    expect(b?.publishedCount).toBe(2);
    expect(b?.failedCount).toBe(1);
    expect(b?.processedCount).toBe(3); // = total（有失败也到完成，Codex#7）
    expect(b?.status).toBe('completed');
  });

  it('fence 失配 → moved=false、计数 +0（已被接管）', async () => {
    const db = new PublishBatchFakeDb();
    const owner = seedUser(db);
    const created = await createPublishBatchTx(asTxPool(db), {
      ownerUserId: owner,
      items: items('a'),
    });
    db.startJob(created.jobId, 1);
    const [a] = await readBatchItems(db, created.batchId);
    const r = await finalizeBatchItemTx(db, {
      itemId: a!.id,
      jobId: created.jobId,
      fenceToken: 999,
      state: 'published',
    });
    expect(r.moved).toBe(false);
    expect((await readBatch(db, created.batchId))?.publishedCount).toBe(0);
  });

  it('failed item 落人话 ErrorBody（非堆栈/非 code）+ missingFields（去补齐）', async () => {
    const db = new PublishBatchFakeDb();
    const owner = seedUser(db);
    const created = await createPublishBatchTx(asTxPool(db), {
      ownerUserId: owner,
      items: items('a'),
    });
    db.startJob(created.jobId, 1);
    const [a] = await readBatchItems(db, created.batchId);
    await finalizeBatchItemTx(db, {
      itemId: a!.id,
      jobId: created.jobId,
      fenceToken: 1,
      state: 'failed',
      error: errBody,
      missingFields: ['name', 'tagline'],
    });
    const row = (await readBatchItems(db, created.batchId))[0]!;
    expect(row.state).toBe('failed');
    expect(row.error?.userMessage).toBeTruthy();
    expect(JSON.stringify(row.error)).not.toMatch(/"code"/);
    expect(row.missingFields).toEqual(['name', 'tagline']);
  });
});

describe('retryBatchItemTx (§2.5 单 item 重试，无连坐)', () => {
  it('failed → pending（清 error/missingFields、attempt+1），failed_count-1 复位，job 换 fence', async () => {
    const db = new PublishBatchFakeDb();
    const owner = seedUser(db);
    const created = await createPublishBatchTx(asTxPool(db), {
      ownerUserId: owner,
      items: items('a', 'b'),
    });
    db.startJob(created.jobId, 1);
    const rows = await readBatchItems(db, created.batchId);
    // a 失败、b 成功 → failed_count=1, published_count=1。
    await finalizeBatchItemTx(db, {
      itemId: rows[0]!.id,
      jobId: created.jobId,
      fenceToken: 1,
      state: 'failed',
      error: errBody,
      missingFields: ['name'],
    });
    await finalizeBatchItemTx(db, {
      itemId: rows[1]!.id,
      jobId: created.jobId,
      fenceToken: 1,
      state: 'published',
    });
    const beforeFence = db.jobs.get(created.jobId)!.fence_token;

    const out = await retryBatchItemTx(asTxPool(db), {
      batchId: created.batchId,
      itemId: rows[0]!.id,
      ownerUserId: owner,
    });
    expect(out.kind).toBe('requeued');
    if (out.kind !== 'requeued') return;
    expect(out.fenceToken).toBe(beforeFence + 1); // 换 fence（旧 fence 写回 0 行安全退出）
    const a = (await readBatchItems(db, created.batchId)).find((r) => r.id === rows[0]!.id)!;
    expect(a.state).toBe('pending');
    expect(a.error).toBeNull();
    expect(a.missingFields).toBeNull();
    expect(a.attemptNo).toBe(1);
    const b = await readBatch(db, created.batchId);
    // failed_count 复位 -1（重试再终态时模板 B 重新计入，不双计）；published_count 不动（b 项仍成功）。
    expect(b?.failedCount).toBe(0);
    expect(b?.publishedCount).toBe(1);
    expect(b?.processedCount).toBe(1); // 重试中的 a 暂不计入 processed
  });

  it('重试后再终态 → failed_count 重新 +1（不双计，processed/total 与真值恒等）', async () => {
    const db = new PublishBatchFakeDb();
    const owner = seedUser(db);
    const created = await createPublishBatchTx(asTxPool(db), {
      ownerUserId: owner,
      items: items('a'),
    });
    db.startJob(created.jobId, 1);
    const [a] = await readBatchItems(db, created.batchId);
    await finalizeBatchItemTx(db, {
      itemId: a!.id,
      jobId: created.jobId,
      fenceToken: 1,
      state: 'failed',
      error: errBody,
    });
    expect((await readBatch(db, created.batchId))?.failedCount).toBe(1);

    const out = await retryBatchItemTx(asTxPool(db), {
      batchId: created.batchId,
      itemId: a!.id,
      ownerUserId: owner,
    });
    expect(out.kind).toBe('requeued');
    if (out.kind !== 'requeued') return;
    expect((await readBatch(db, created.batchId))?.failedCount).toBe(0); // 复位
    db.startJob(created.jobId, out.fenceToken);
    // 重试这次发成功。
    await finalizeBatchItemTx(db, {
      itemId: a!.id,
      jobId: created.jobId,
      fenceToken: out.fenceToken,
      state: 'published',
    });
    const b = await readBatch(db, created.batchId);
    expect(b?.publishedCount).toBe(1);
    expect(b?.failedCount).toBe(0);
    expect(b?.processedCount).toBe(1); // = total，不双计
    expect(b?.status).toBe('completed');
  });

  it('item 非 failed（pending/published/在跑）→ state_conflict（不需要重试）', async () => {
    const db = new PublishBatchFakeDb();
    const owner = seedUser(db);
    const created = await createPublishBatchTx(asTxPool(db), {
      ownerUserId: owner,
      items: items('a'),
    });
    db.startJob(created.jobId, 1);
    const [a] = await readBatchItems(db, created.batchId);
    await finalizeBatchItemTx(db, {
      itemId: a!.id,
      jobId: created.jobId,
      fenceToken: 1,
      state: 'published',
    });
    const out = await retryBatchItemTx(asTxPool(db), {
      batchId: created.batchId,
      itemId: a!.id,
      ownerUserId: owner,
    });
    expect(out.kind).toBe('state_conflict');
  });

  it('非本人 → forbidden；批/项不存在 → not_found', async () => {
    const db = new PublishBatchFakeDb();
    const owner = seedUser(db);
    const created = await createPublishBatchTx(asTxPool(db), {
      ownerUserId: owner,
      items: items('a'),
    });
    const [a] = await readBatchItems(db, created.batchId);
    const intruder = await retryBatchItemTx(asTxPool(db), {
      batchId: created.batchId,
      itemId: a!.id,
      ownerUserId: 'intruder',
    });
    expect(intruder.kind).toBe('forbidden');
    const missing = await retryBatchItemTx(asTxPool(db), {
      batchId: 'nope',
      itemId: a!.id,
      ownerUserId: owner,
    });
    expect(missing.kind).toBe('not_found');
  });

  it('携新发布入参 → 覆盖 subject（修过封面/价格后重试）', async () => {
    const db = new PublishBatchFakeDb();
    const owner = seedUser(db);
    const created = await createPublishBatchTx(asTxPool(db), {
      ownerUserId: owner,
      items: items('a'),
    });
    db.startJob(created.jobId, 1);
    const [a] = await readBatchItems(db, created.batchId);
    await finalizeBatchItemTx(db, {
      itemId: a!.id,
      jobId: created.jobId,
      fenceToken: 1,
      state: 'failed',
      error: errBody,
    });
    const out = await retryBatchItemTx(asTxPool(db), {
      batchId: created.batchId,
      itemId: a!.id,
      ownerUserId: owner,
      tiers: [{ tierCode: 'standard', priceMicros: 12_000_000 }],
      visibility: 'unlisted',
    });
    expect(out.kind).toBe('requeued');
    const stored = db.items.get(a!.id)!;
    const subj = stored.subject as BatchItemPublishInput;
    expect(subj.tiers?.[0]?.priceMicros).toBe(12_000_000);
    expect(subj.visibility).toBe('unlisted');
  });
});

describe('readPublishBatchFull (§2.4 恢复/轮询)', () => {
  it('返回批 + items 全量（已发布的不丢，硬规则③）', async () => {
    const db = new PublishBatchFakeDb();
    const owner = seedUser(db);
    const created = await createPublishBatchTx(asTxPool(db), {
      ownerUserId: owner,
      items: items('a', 'b'),
    });
    db.startJob(created.jobId, 1);
    const rows = await readBatchItems(db, created.batchId);
    await finalizeBatchItemTx(db, {
      itemId: rows[0]!.id,
      jobId: created.jobId,
      fenceToken: 1,
      state: 'published',
    });
    const full = await readPublishBatchFull(db, created.batchId);
    expect(full?.items).toHaveLength(2);
    expect(full?.batch.processedCount).toBe(1);
    const nope = await readPublishBatchFull(db, 'missing');
    expect(nope).toBeNull();
  });
});

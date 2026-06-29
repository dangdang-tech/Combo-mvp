// 50 · 批量发布 Job handler 自检（B-29 无连坐 P0，50-step5-publish §2.3/§3/§5）。忠实 mock，无真 PG。
//   重点（契约 + 决策⑤）：
//     · 逐项无连坐：一项失败（被拒/缺必填）其余照常 published，批次不「一败全败」，仍走到完成（processed===total）。
//     · 进度永不裸转圈：done=processed(=published+failed)，有失败也照走到 total/100%（Codex#7）。
//     · 逐个浮现：每项发布完/失败经 ctx.appendItem 浮现一条 PublishBatchItemView（state + error?，失败只标该项）。
//     · 计数幂等：worker 重跑（重投/接管后续跑）已终态项不重复发布、不重复计数。
//     · 候选项（仅 candidateId）走 B-29 编排 create→structure→publish（§5.3）；编排失败【只标该 item】、不连坐版本项。
//     · 每发布成功的 item 各走独立发布门事务（各自 publications/tiers/outbox 双事件），互不串。
import { describe, it, expect } from 'vitest';
import { asTxPool } from '../events/db-tx.js';
import { createPublishBatchHandler } from '../jobs/handlers/publish-batch.js';
import { createPublishBatchTx, readBatch, readBatchItems } from '../publish/batch-repo.js';
import { PublishBatchFakeDb, seedUser, seedCapabilityVersion } from './publish-batch-fakes.js';
import { StreamingFakeGateway } from './structure-fakes.js';
import { readyManifest } from './publish-fakes.js';
import { lintUserMessage } from '@cb/shared';
import type { JobContext, LeasedJob } from '../jobs/types.js';
import type { BatchItemPublishInput } from '../publish/batch-repo.js';

interface Frame {
  event: string;
  payload: unknown;
}
interface Cap {
  ctx: JobContext;
  items: () => Array<{ itemId: string; state: string; error?: { userMessage: string } }>;
  progress: Array<{ percent: number; done?: number; total?: number; phrase: string }>;
  subtasks: Array<{ key: string; status: string }>;
  setCancelled: (v: boolean) => void;
}

function makeCtx(jobId: string, fenceToken: number): Cap {
  const frames: Frame[] = [];
  const progress: Cap['progress'] = [];
  const subtasks: Cap['subtasks'] = [];
  let cancelled = false;
  const ctx: JobContext = {
    jobId,
    traceId: 'tr-batch',
    fenceToken,
    attemptNo: 1,
    signal: new AbortController().signal,
    isCancelled: () => cancelled,
    async reportProgress(u) {
      progress.push({ percent: u.percent, done: u.done, total: u.total, phrase: u.phrase });
    },
    async reportSubtask(key, status) {
      subtasks.push({ key, status });
    },
    async appendItem(item) {
      frames.push({ event: 'item-appended', payload: item });
    },
    async emitField(event, payload) {
      frames.push({ event, payload });
    },
    async emitSlowHint() {},
  };
  return {
    ctx,
    items: () =>
      frames
        .filter((f) => f.event === 'item-appended')
        .map(
          (f) => f.payload as { itemId: string; state: string; error?: { userMessage: string } },
        ),
    progress,
    subtasks,
    setCancelled: (v) => (cancelled = v),
  };
}

function leased(jobId: string, fenceToken: number): LeasedJob {
  return {
    id: jobId,
    type: 'publish_batch',
    ownerUserId: 'owner',
    subjectRef: { kind: 'publish_batch' },
    attemptNo: 1,
    fenceToken,
    progress: { percent: 0, phrase: '', subtasks: [] },
  };
}

/** 播种一批可发布版本，建批 + 起 job（running, fence=1），返回 batchId/jobId + 各 item。 */
async function setupBatch(
  db: PublishBatchFakeDb,
  owner: string,
  specs: Array<{
    status?: string;
    nameEmpty?: boolean;
    candidateOnly?: boolean;
    noTiers?: boolean;
  }>,
): Promise<{ batchId: string; jobId: string }> {
  const items: BatchItemPublishInput[] = [];
  let n = 0;
  for (const s of specs) {
    n += 1;
    const key = `k${n}`;
    if (s.candidateOnly) {
      items.push({ candidateId: `cand-${n}`, idempotencyKey: key });
      continue;
    }
    const manifest = s.nameEmpty ? { ...readyManifest(`c${n}`), name: '' } : undefined;
    const seeded = seedCapabilityVersion(db, owner, {
      ...(s.status ? { status: s.status } : {}),
      ...(manifest ? { manifest } : {}),
    });
    items.push({
      versionId: seeded.versionId,
      idempotencyKey: key,
      // noTiers：模拟前端「全部发布」只提交 candidateId+visibility、不带 tiers（缺价由 worker 补默认免费档，P0-3）。
      ...(s.noTiers ? {} : { tiers: [{ tierCode: 'standard', priceMicros: 9_900_000 }] }),
      visibility: 'public',
    });
  }
  const created = await createPublishBatchTx(asTxPool(db), { ownerUserId: owner, items });
  // 把 item 的 candidate/version 与 subject 对齐（subject 已存全量入参）。
  db.startJob(created.jobId, 1);
  return { batchId: created.batchId, jobId: created.jobId };
}

// 装配 handler 时注入 gateway（与 worker 入口同依赖面：candidate 项编排 create→structure 需 LLM 网关补软字段）。
const handler = (db: PublishBatchFakeDb) =>
  createPublishBatchHandler({ db, txPool: asTxPool(db), gateway: new StreamingFakeGateway() });

describe('publish_batch handler · 逐项无连坐（决策⑤ / §2.3）', () => {
  it('全 draft → 全 published；批次完成（processed===total，100%）', async () => {
    const db = new PublishBatchFakeDb();
    const owner = seedUser(db, 'WAYNE');
    const { batchId, jobId } = await setupBatch(db, owner, [{}, {}, {}]);
    const cap = makeCtx(jobId, 1);
    await handler(db).run(leased(jobId, 1), cap.ctx);

    const b = await readBatch(db, batchId);
    expect(b?.publishedCount).toBe(3);
    expect(b?.failedCount).toBe(0);
    expect(b?.processedCount).toBe(3);
    expect(b?.status).toBe('completed');
    // 进度走到 100%（done=processed=total）。
    const last = cap.progress.at(-1)!;
    expect(last.percent).toBe(100);
    expect(last.done).toBe(3);
    expect(last.total).toBe(3);
    // 逐个浮现 3 条 item-appended（全 published）。
    expect(cap.items().filter((i) => i.state === 'published')).toHaveLength(3);
  });

  it('全部发布缺价（前端只提交 candidateId+visibility，不带 tiers）→ worker 补默认免费档 {standard,0} → 成功 published（非缺price失败，P0-3）', async () => {
    // §5.3「全部发布」跳过逐个调价、价格用默认：缺/空 tiers 统一补 {standard,0} 默认免费档，
    //   保证候选 happy path 不被 manifest-hash 价格门判缺 price 而全失败（Codex r2 P0-3）。
    const db = new PublishBatchFakeDb();
    const owner = seedUser(db, 'WAYNE');
    // 三项全缺价（noTiers）：补默认免费档后全部成功发布。
    const { batchId, jobId } = await setupBatch(db, owner, [
      { noTiers: true },
      { noTiers: true },
      { noTiers: true },
    ]);
    const cap = makeCtx(jobId, 1);
    await handler(db).run(leased(jobId, 1), cap.ctx);

    const b = await readBatch(db, batchId);
    expect(b?.publishedCount).toBe(3); // 缺价不再全失败：默认免费档下全 published。
    expect(b?.failedCount).toBe(0);
    expect(b?.processedCount).toBe(3);
    expect(b?.status).toBe('completed');
    // 每项冻结一条默认免费档（priceMicros=0，tierCode=standard）。
    expect(db.tiers).toHaveLength(3);
    expect(db.tiers.every((t) => t.tier_code === 'standard' && t.price_micros === 0)).toBe(true);
    // 逐项浮现 3 条 published（永不裸转圈，满进度）。
    expect(cap.items().filter((i) => i.state === 'published')).toHaveLength(3);
    expect(cap.progress.at(-1)?.percent).toBe(100);
  });

  it('缺价项（默认免费档）与一项被拒并存 → 缺价项照样 published、被拒项独立 failed、不连坐（P0-3 + 决策⑤）', async () => {
    const db = new PublishBatchFakeDb();
    const owner = seedUser(db);
    // item1 缺价（→ 默认免费档 published）、item2 被拒（STATE_CONFLICT failed）、item3 缺价（published）。
    const { batchId, jobId } = await setupBatch(db, owner, [
      { noTiers: true },
      { status: 'review_rejected' },
      { noTiers: true },
    ]);
    await handler(db).run(leased(jobId, 1), makeCtx(jobId, 1).ctx);

    const b = await readBatch(db, batchId);
    expect(b?.publishedCount).toBe(2); // 两缺价项默认免费档发成（不因缺价连坐）。
    expect(b?.failedCount).toBe(1); // 仅被拒项失败。
    expect(b?.status).toBe('completed');
    const rows = await readBatchItems(db, batchId);
    expect(rows.filter((r) => r.state === 'published')).toHaveLength(2);
    expect(rows.filter((r) => r.state === 'failed')).toHaveLength(1);
  });

  it('一项失败（被拒版 / 缺必填）其余成功 → 失败只标该项、不连累其余、批次仍到完成（有失败也 100%）', async () => {
    const db = new PublishBatchFakeDb();
    const owner = seedUser(db);
    // item2 = 被拒版（STATE_CONFLICT）、item4 = 缺必填（PUBLISH_MISSING_FIELDS）；其余成功。
    const { batchId, jobId } = await setupBatch(db, owner, [
      {},
      { status: 'review_rejected' },
      {},
      { nameEmpty: true },
      {},
    ]);
    const cap = makeCtx(jobId, 1);
    await handler(db).run(leased(jobId, 1), cap.ctx);

    const b = await readBatch(db, batchId);
    expect(b?.publishedCount).toBe(3);
    expect(b?.failedCount).toBe(2);
    expect(b?.processedCount).toBe(5);
    expect(b?.status).toBe('completed'); // 不「一败全败」
    // 进度照走到 100%（有失败也满进度，Codex#7，永不裸转圈）。
    expect(cap.progress.at(-1)?.percent).toBe(100);

    // 逐项 state：失败项落人话 error（非 code）、其余成功不受影响。
    const rows = await readBatchItems(db, batchId);
    const failed = rows.filter((r) => r.state === 'failed');
    expect(failed).toHaveLength(2);
    for (const f of failed) {
      expect(f.error?.userMessage).toBeTruthy();
      expect(JSON.stringify(f.error)).not.toMatch(/"code"/);
    }
    expect(rows.filter((r) => r.state === 'published')).toHaveLength(3);
    // 失败项浮现一条带 error 的 item-appended（无连坐：只标该项）。
    const appendedFailed = cap.items().filter((i) => i.state === 'failed');
    expect(appendedFailed).toHaveLength(2);
    expect(appendedFailed.every((i) => !!i.error?.userMessage)).toBe(true);
  });

  it('每发布成功的 item 各走独立发布门事务（各自 publications/tiers/outbox 双事件），互不串', async () => {
    const db = new PublishBatchFakeDb();
    const owner = seedUser(db);
    const { jobId } = await setupBatch(db, owner, [{}, {}]);
    const cap = makeCtx(jobId, 1);
    await handler(db).run(leased(jobId, 1), cap.ctx);
    // 两个能力各一条 publication（互不串）。
    expect(db.publications.size).toBe(2);
    // 各两条 outbox（capability.published + notify.publish_completed）→ 共 4 条。
    expect(db.outbox.filter((o) => o.topic === 'capability.published')).toHaveLength(2);
    expect(db.outbox.filter((o) => o.topic === 'notify.publish_completed')).toHaveLength(2);
  });

  it('候选项（仅 candidateId）→ B-29 编排 create→structure→publish；本 fake 未播种该候选 → 该项独立 failed（人话+退路）、不连坐版本项', async () => {
    // §5.3「全部发布」从 candidate 起：handler 对 candidate-only item 串 create→structure→publish（复用 3D/3E）。
    //   本 fake DB 不建模 create-capability 的 SQL 面（候选/证据表），candidate 'cand-2' 解析不出来 → 该项编排失败。
    //   本用例验证的不变量（决策⑤ 无连坐）：编排失败【只标该 item】，落人话 error（非 code）+ 明确退路，
    //   且同批 version 项照常 published、批次仍走到完成（processed===total）。candidate→published 的happy
    //   path 由 3D create-capability / structure handler 各自的全量 fake 套件覆盖（此处不重复建那套 SQL 面）。
    const db = new PublishBatchFakeDb();
    const owner = seedUser(db);
    const { batchId, jobId } = await setupBatch(db, owner, [{}, { candidateOnly: true }]);
    const cap = makeCtx(jobId, 1);
    await handler(db).run(leased(jobId, 1), cap.ctx);

    const rows = await readBatchItems(db, batchId);
    const cand = rows.find((r) => r.candidateId && !r.versionId)!;
    // 该候选项独立失败（不停批、不连坐）：落人话 error（绝不裸露 code）+ 有效退路。
    expect(cand.state).toBe('failed');
    expect(cand.error?.userMessage).toBeTruthy();
    expect(JSON.stringify(cand.error)).not.toMatch(/"code"/);
    expect(['retry', 'change_input', 'escalate']).toContain(cand.error?.action);
    // 版本项仍成功（无连坐：candidate 项编排失败不连累已就绪版本项）。
    expect(rows.filter((r) => r.state === 'published')).toHaveLength(1);
    // 失败项浮现一条带 error 的 item-appended（只标该项）。
    const appendedFailed = cap.items().filter((i) => i.state === 'failed');
    expect(appendedFailed).toHaveLength(1);
    expect(appendedFailed[0]?.error?.userMessage).toBeTruthy();
    // 批次走到完成（有失败也满进度，永不裸转圈）。
    const b = await readBatch(db, batchId);
    expect(b?.processedCount).toBe(2);
    expect(b?.status).toBe('completed');
    expect(cap.progress.at(-1)?.percent).toBe(100);
  });
});

describe('publish_batch handler · 计数幂等 + 取消（硬规则①③）', () => {
  it('worker 重跑（已终态项）→ 不重复发布、不重复计数（重投/接管续跑幂等）', async () => {
    const db = new PublishBatchFakeDb();
    const owner = seedUser(db);
    const { batchId, jobId } = await setupBatch(db, owner, [{}, {}]);
    // 第一遍：全 published。
    await handler(db).run(leased(jobId, 1), makeCtx(jobId, 1).ctx);
    const afterFirst = await readBatch(db, batchId);
    expect(afterFirst?.publishedCount).toBe(2);
    const pubCount1 = db.publications.size;
    const outbox1 = db.outbox.length;

    // 第二遍（重投/接管后续跑同 fence）：已终态项跳过 → 计数/产物不变（幂等）。
    db.startJob(jobId, 1);
    await handler(db).run(leased(jobId, 1), makeCtx(jobId, 1).ctx);
    const afterSecond = await readBatch(db, batchId);
    expect(afterSecond?.publishedCount).toBe(2); // 未双计
    expect(afterSecond?.processedCount).toBe(2);
    expect(db.publications.size).toBe(pubCount1); // 未重复发布
    expect(db.outbox.length).toBe(outbox1); // 未重复事件
  });

  it('重跑识别已发布产物（Codex#6）：发布门已 COMMIT(版本 published) 但 finalize 前 fence 丢失 → 重跑命中 ALREADY_PUBLISHED → 终态 published，不误标 failed', async () => {
    const db = new PublishBatchFakeDb();
    const owner = seedUser(db);
    const { batchId, jobId } = await setupBatch(db, owner, [{}]);
    const rows = await readBatchItems(db, batchId);
    const item = rows[0]!;
    const versionId = item.versionId!;

    // 模拟「发布门已 COMMIT、item finalize 前进程崩/fence 丢」：版本已 published（含 publication/tiers），
    //   但 item 仍非终态（pending）、计数未递增。重跑会再走 publish-one → 命中 ALREADY_PUBLISHED。
    db.versions.get(versionId)!.status = 'published';
    const cap = db.capabilities.get(db.versions.get(versionId)!.capability_id)!;
    cap.current_version_id = versionId;
    db.publications.set(cap.id, {
      capability_id: cap.id,
      current_version_id: versionId,
      share_token: 'tok-prior',
      visibility: 'public',
      review_status: 'alpha_pending',
      reject_reason: null,
    });

    await handler(db).run(leased(jobId, 1), makeCtx(jobId, 1).ctx);

    // 重跑识别已发布产物 → item 终态 published（不误标 failed，「已生成不丢」）。
    const after = (await readBatchItems(db, batchId))[0]!;
    expect(after.state).toBe('published');
    const b = await readBatch(db, batchId);
    expect(b?.publishedCount).toBe(1);
    expect(b?.failedCount).toBe(0);
    expect(b?.processedCount).toBe(1);
    expect(b?.status).toBe('completed');
  });

  it('失败项人话 error 全部通过 lintUserMessage（无 code/SQL/堆栈/状态码裸露，§11.B）', async () => {
    const db = new PublishBatchFakeDb();
    const owner = seedUser(db);
    const { batchId, jobId } = await setupBatch(db, owner, [
      { status: 'review_rejected' },
      { nameEmpty: true },
      { candidateOnly: true },
    ]);
    await handler(db).run(leased(jobId, 1), makeCtx(jobId, 1).ctx);
    const rows = await readBatchItems(db, batchId);
    const failed = rows.filter((r) => r.state === 'failed');
    expect(failed.length).toBeGreaterThan(0);
    for (const f of failed) {
      expect(lintUserMessage(f.error!.userMessage)).toEqual([]);
    }
  });

  it('取消（ctx.isCancelled）→ 停在安全点，已处理项保留（剩余交新 attempt 续跑）', async () => {
    const db = new PublishBatchFakeDb();
    const owner = seedUser(db);
    const { batchId, jobId } = await setupBatch(db, owner, [{}, {}, {}]);
    const cap = makeCtx(jobId, 1);
    cap.setCancelled(true); // 一开始即取消 → 循环首项即 break。
    await handler(db).run(leased(jobId, 1), cap.ctx);
    const b = await readBatch(db, batchId);
    // 取消停在安全点：未处理项保留 pending（已生成不丢）。
    expect(b?.processedCount).toBe(0);
    const rows = await readBatchItems(db, batchId);
    expect(rows.every((r) => r.state === 'pending')).toBe(true);
  });
});

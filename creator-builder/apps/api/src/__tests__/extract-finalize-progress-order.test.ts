// Codex r4 P1 自检（finalize 后再 reportProgress 触发 fence-out、done 退化）。
//   缺陷复现 + 反向破坏：finalizeExtractJob() 把 job 置 completed 后再调 ctx.reportProgress()，
//   runner 的 persistProgress 受保护写只允许 status='running' → 0 行 → 抛 FencedOutError →
//   handler 无法返回 finalized:true → SSE done 退化为无 result/progress 的 fence-out 兜底。
//
//   修法：在 finalize（置 completed）【之前】（仍 running 时）上报最终 100%（含 finalProgress.done==total、
//   五项子任务全完成）；再 finalize（complete job + 同事务 outbox）；finalize 之后绝不再 reportProgress；
//   done 帧由 runner 依据 handler 返回的 finalProgress 发（含 result + 完整 progress，非兜底）。
//
//   本测用【真实 runner（runJob）+ 真实 makeContext】驱动【真实 extract handler】，
//   对接一个同时实现 jobs 生命周期 SQL（claimLease/persistProgress/completeJob，status='running' 守门）
//   与 extract 域 SQL（段集/候选/证据）的合并假 PG —— 这是该 P1 唯一忠实复现路径
//   （handler 单测的 mock ctx.reportProgress 永不抛，复现不了 fence-out 退化）。
import { describe, it, expect } from 'vitest';
import { runJob } from '../jobs/runner.js';
import { createExtractHandler } from '../jobs/handlers/extract.js';
import type { JobEventBridge, QueryResultLike } from '../jobs/types.js';
import type { TxConn } from '../events/db-tx.js';
import {
  ExtractFakeDb,
  ExtractFakeTxPool,
  FakeLlmGateway,
  type SegmentRowF,
} from './extract-fakes.js';

// ---------------------------------------------------------------------------
// 合并假 PG：extract 域 SQL（继承 ExtractFakeDb）+ jobs 生命周期 SQL（claimLease/
//   renewLease/persistProgress/completeJob/failJob/readJobStatus，status='running' 守门）。
//   关键：persistProgress 严格按受保护语义——fence 失配或 status!=running → 0 行（runner 据此抛 FencedOutError）。
//   这样 finalize 后（status=completed）再 reportProgress 必 0 行 → FencedOutError → done 退化，正是被守门的回归。
// ---------------------------------------------------------------------------
interface JobLifecycleRow {
  status: string;
  fence_token: number;
  attempt_no: number;
  lease_owner: string | null;
  lease_until: number | null;
}

class CombinedFakeDb extends ExtractFakeDb {
  /** jobs 生命周期态（与 ExtractFakeDb.jobs 同 id；ExtractFakeDb.jobs 持业务字段，本表持租约/attempt）。 */
  readonly lifecycle = new Map<string, JobLifecycleRow>();
  now = 2_000;

  seedJob(id: string): void {
    this.lifecycle.set(id, {
      status: 'queued',
      fence_token: 0,
      attempt_no: 0,
      lease_owner: null,
      lease_until: null,
    });
  }

  override async query<R = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<QueryResultLike<R>> {
    // —— claimLease：UPDATE ... SET status='running', lease_owner=$2 ... ——
    if (sql.includes("status        = 'running'") && sql.includes('lease_owner   = $2')) {
      const jobId = params[0] as string;
      const leaseOwner = params[1] as string;
      const ttlMs = params[2] as number;
      const lc = this.lifecycle.get(jobId);
      const claimable =
        lc &&
        (lc.status === 'queued' ||
          (lc.status === 'running' && (lc.lease_until === null || lc.lease_until < this.now)));
      if (!lc || !claimable) return { rows: [], rowCount: 0 } as QueryResultLike<R>;
      const isReclaimed = lc.status === 'running' && lc.lease_owner === null;
      lc.status = 'running';
      if (!isReclaimed) {
        lc.attempt_no += 1;
        lc.fence_token += 1;
      }
      lc.lease_owner = leaseOwner;
      lc.lease_until = this.now + ttlMs;
      // 同步业务行（ExtractFakeDb.jobs）的 fence/status，供 extract 受保护写与 completeJobInTx 守门一致。
      const biz = this.jobs.get(jobId);
      if (biz) {
        biz.status = 'running';
        biz.fence_token = lc.fence_token;
      }
      const owner = biz?.owner_user_id ?? 'u1';
      const subjectRef = biz?.subject_ref ?? null;
      return {
        rows: [
          {
            id: jobId,
            type: 'extract',
            owner_user_id: owner,
            subject_ref: subjectRef,
            progress: biz?.progress ?? {},
            attempt_no: lc.attempt_no,
            fence_token: lc.fence_token,
          },
        ] as R[],
        rowCount: 1,
      };
    }

    // —— renewLease：SET lease_until ... WHERE fence_token=$2 AND status='running' ——
    if (sql.includes('SET lease_until = now()') && sql.includes('fence_token = $2')) {
      const jobId = params[0] as string;
      const fence = params[1] as number;
      const ttlMs = params[2] as number;
      const lc = this.lifecycle.get(jobId);
      if (!lc || lc.fence_token !== fence || lc.status !== 'running')
        return { rows: [], rowCount: 0 } as QueryResultLike<R>;
      lc.lease_until = this.now + ttlMs;
      return { rows: [], rowCount: 1 } as QueryResultLike<R>;
    }

    // —— persistProgress：WITH guard ... UPDATE jobs SET progress=$3 ...（受保护：fence + status='running'）——
    if (sql.includes('SET progress = $3::jsonb') && sql.includes('guard')) {
      const jobId = params[0] as string;
      const fence = params[1] as number;
      const lc = this.lifecycle.get(jobId);
      if (!lc || lc.fence_token !== fence || lc.status !== 'running')
        return { rows: [], rowCount: 0 } as QueryResultLike<R>; // ← finalize 后 status=completed 命中此处 → 0 行 → FencedOutError
      const biz = this.jobs.get(jobId);
      if (biz) biz.progress = JSON.parse(params[2] as string);
      return { rows: [], rowCount: 1 } as QueryResultLike<R>;
    }

    // —— completeJob（runner 兜底直走 db，非 txPool 路径；本流 handler finalized 不会用，但留全）——
    //   注意：与 completeJobInTx 同 SQL 形态；但 finalizeExtractJob 走 txPool，故此分支基本不触发。
    //   为避免与 txPool 路径混淆（txPool 自己处理 'completed'），这里只处理“直接对 db”的 completeJob。
    if (sql.includes("status      = 'completed'")) {
      const jobId = params[0] as string;
      const fence = params[1] as number;
      const lc = this.lifecycle.get(jobId);
      if (!lc || lc.fence_token !== fence || lc.status !== 'running')
        return { rows: [], rowCount: 0 } as QueryResultLike<R>;
      lc.status = 'completed';
      const biz = this.jobs.get(jobId);
      if (biz) {
        biz.status = 'completed';
        biz.progress = JSON.parse(params[3] as string);
      }
      return { rows: [], rowCount: 1 } as QueryResultLike<R>;
    }

    // —— failJob：WITH guard ... SET status='failed' ... ——
    if (sql.includes("status      = 'failed'")) {
      const jobId = params[0] as string;
      const fence = params[1] as number;
      const lc = this.lifecycle.get(jobId);
      if (!lc || lc.fence_token !== fence || lc.status !== 'running')
        return { rows: [], rowCount: 0 } as QueryResultLike<R>;
      lc.status = 'failed';
      const biz = this.jobs.get(jobId);
      if (biz) biz.status = 'failed';
      return { rows: [], rowCount: 1 } as QueryResultLike<R>;
    }

    // —— readJobStatus：SELECT status FROM jobs WHERE id ——
    if (sql.includes('SELECT status FROM jobs')) {
      const lc = this.lifecycle.get(params[0] as string);
      return {
        rows: lc ? ([{ status: lc.status }] as R[]) : [],
        rowCount: lc ? 1 : 0,
      };
    }

    // 其余（段集/候选/证据/FOR UPDATE guard/BEGIN/COMMIT/ROLLBACK）走 extract 域。
    return super.query<R>(sql, params);
  }
}

/** txPool 包一层：completeJobInTx 提交时同步 lifecycle.status='completed'（与业务行一致）。 */
class CombinedTxPool extends ExtractFakeTxPool {
  constructor(private readonly cdb: CombinedFakeDb) {
    super(cdb);
  }
  override async connect(): Promise<TxConn> {
    const inner = await super.connect();
    const cdb = this.cdb;
    return {
      async query<R = Record<string, unknown>>(
        sql: string,
        innerParams: unknown[] = [],
      ): Promise<QueryResultLike<R>> {
        const res = (await inner.query<R>(sql, innerParams)) as QueryResultLike<R>;
        // completeJobInTx COMMIT 后 ExtractFakeTxPool 把 biz.status 置 completed；同步 lifecycle。
        if (sql.startsWith('COMMIT')) {
          for (const [id, lc] of cdb.lifecycle) {
            const biz = cdb.jobs.get(id);
            if (biz && biz.status === 'completed') lc.status = 'completed';
          }
        }
        return res;
      },
      release: inner.release,
    };
  }
}

class CollectBridge implements JobEventBridge {
  readonly published: Array<{ event: string; payload: unknown }> = [];
  async publish(
    _jobId: string,
    frame: { event: string; payload: unknown },
  ): Promise<string | null> {
    this.published.push({ event: frame.event, payload: frame.payload });
    return `${this.published.length}-0`;
  }
}

function seg(over: Partial<SegmentRowF> & { id: string; snapshot_id: string }): SegmentRowF {
  return {
    title: '工作流',
    source: 'claude',
    project: null,
    happened_at: '2026-06-10T10:00:00.000Z',
    content: '内容',
    message_count: 4,
    ...over,
  };
}

function seedSegments(db: ExtractFakeDb, snapshotId: string): void {
  for (let i = 0; i < 6; i++) {
    const s = seg({
      id: `seg-a-${i}`,
      snapshot_id: snapshotId,
      project: 'alpha',
      title: '重构模块',
      content: 'refactor module dependency 重构 依赖 分析',
    });
    db.segments.set(s.id, s);
  }
  for (let i = 0; i < 2; i++) {
    const s = seg({
      id: `seg-b-${i}`,
      snapshot_id: snapshotId,
      project: 'beta',
      title: '写测试',
      content: 'write unit test 写 单元 测试 覆盖',
    });
    db.segments.set(s.id, s);
  }
}

/** 建一个 extract job（业务行 + 生命周期行同 id，status=queued 待 runner 领租约）。 */
function seedExtractJob(db: CombinedFakeDb, id: string, subjectRef: unknown): void {
  db.jobs.set(id, {
    id,
    type: 'extract',
    status: 'queued',
    owner_user_id: 'u1',
    subject_ref: subjectRef,
    progress: {},
    fence_token: 0,
  });
  db.seedJob(id);
}

function setup(): {
  db: CombinedFakeDb;
  tx: CombinedTxPool;
  gw: FakeLlmGateway;
  bridge: CollectBridge;
} {
  const db = new CombinedFakeDb();
  const tx = new CombinedTxPool(db);
  const gw = new FakeLlmGateway();
  const bridge = new CollectBridge();
  return { db, tx, gw, bridge };
}

describe('Codex r4 P1 — finalize 后绝不 reportProgress（全量萃取 done 帧不退化）', () => {
  it('正常完成：done 帧含 result + 完整 progress（非 fence-out 兜底）；job 落 completed；最终进度在 finalize 前已上报', async () => {
    const { db, tx, gw, bridge } = setup();
    seedSegments(db, 'snap-1');
    seedExtractJob(db, 'ejob-1', { mode: 'extract', snapshotId: 'snap-1' });
    const handler = createExtractHandler({ db, txPool: tx, gateway: gw });

    const outcome = await runJob(db, bridge as unknown as JobEventBridge, handler, 'ejob-1', {
      leaseOwner: 'w1',
      traceId: 't1',
    });

    // 跑到 completed（绝不退化为 fenced_out）。
    expect(outcome.kind).toBe('completed');
    expect(db.lifecycle.get('ejob-1')!.status).toBe('completed');

    // done 帧含 result + 完整 progress（非「无 result/progress 的 fence-out 兜底」）。
    const doneFrames = bridge.published.filter((p) => p.event === 'done');
    expect(doneFrames).toHaveLength(1);
    const done = doneFrames[0]!.payload as {
      status: string;
      result?: { candidateCount?: number } | null;
      progress?: { percent: number; done?: number; total?: number; items?: unknown[] };
    };
    expect(done.status).toBe('completed');
    // 反向破坏锚点①：done.result 非空（fence-out 兜底的 done 无 result）。
    expect(done.result).toBeTruthy();
    expect(done.result!.candidateCount).toBeGreaterThanOrEqual(2);
    // 反向破坏锚点②：done.progress 非空、percent=100、done==total、items 不丢（fence-out 兜底无 progress）。
    expect(done.progress).toBeTruthy();
    expect(done.progress!.percent).toBe(100);
    expect(done.progress!.done).toBe(done.progress!.total);
    expect((done.progress!.items ?? []).length).toBeGreaterThanOrEqual(2);

    // 同事务 outbox 发出（完成通知）——退化路径下不会发。
    expect(tx.outbox).toHaveLength(1);
    expect(tx.outbox[0]!.topic).toBe('notify.extract_completed');

    // 最终 100% progress 帧在 job 仍 running 时上报成功（持久化进 jobs.progress）。
    const persisted = db.jobs.get('ejob-1')!.progress as { percent: number; items?: unknown[] };
    expect(persisted.percent).toBe(100);
    expect((persisted.items ?? []).length).toBeGreaterThanOrEqual(2);

    // 全程无 error 帧、无非 done 的终态退化。
    expect(bridge.published.filter((p) => p.event === 'error')).toHaveLength(0);
  });

  it('反向破坏：若把 reportProgress 放回 finalize 之后 → 命中 status!=running 0 行 → FencedOutError → done 退化为 fence-out 兜底（无 result/progress）', async () => {
    const { db, tx, gw, bridge } = setup();
    seedSegments(db, 'snap-1');
    seedExtractJob(db, 'ejob-bad', { mode: 'extract', snapshotId: 'snap-1' });

    // 用一个“破坏版” handler 包装：在真实 handler 返回 finalized:true 之后，
    //   模拟回归写法——对已 completed 的 job 再 reportProgress（正是本 P1 的错误顺序）。
    const real = createExtractHandler({ db, txPool: tx, gateway: gw });
    const buggyHandler = {
      type: real.type,
      run: async (job: Parameters<typeof real.run>[0], ctx: Parameters<typeof real.run>[1]) => {
        const res = await real.run(job, ctx);
        // 回归注入：finalize 之后（job 此刻已 completed）再上报进度。
        //   persistProgress guard status='running' → 0 行 → runner ctx 抛 FencedOutError。
        await ctx.reportProgress({ percent: 100, phrase: '退化注入', done: 1, total: 1 });
        return res;
      },
    };

    const outcome = await runJob(
      db,
      bridge as unknown as JobEventBridge,
      buggyHandler,
      'ejob-bad',
      {
        leaseOwner: 'w1',
        traceId: 't1',
      },
    );

    // 守门：回归写法被 fence-out 退化捕获——runner 把它当 fenced_out，绝不返回 completed 终态帧。
    expect(outcome.kind).toBe('fenced_out');
    // done 帧退化：job 实际已 completed（finalize 提交过），publishFenceOutTerminal 据真状态发 done(completed)，
    //   但【无 result、无 progress】——这正是用户看到的退化（前端拿不到候选明细/计数）。
    const doneFrames = bridge.published.filter((p) => p.event === 'done');
    expect(doneFrames).toHaveLength(1);
    const done = doneFrames[0]!.payload as {
      status: string;
      result?: unknown;
      progress?: unknown;
    };
    // 反向破坏断言：退化 done 帧不带 result / progress（与正常路径形成对比 → 守住修复）。
    expect(done.result).toBeUndefined();
    expect(done.progress).toBeUndefined();
  });
});

describe('Codex r4 P1 — retry 同修（单候选重试 done 帧不退化）', () => {
  /** 先全量跑一遍产出候选，再把一个标 failed，模拟 retry job 接力。 */
  async function seedFailedCandidate(): Promise<{
    db: CombinedFakeDb;
    tx: CombinedTxPool;
    gw: FakeLlmGateway;
    candidateId: string;
  }> {
    const { db, tx, gw, bridge } = setup();
    seedSegments(db, 'snap-1');
    seedExtractJob(db, 'ejob-1', { mode: 'extract', snapshotId: 'snap-1' });
    const handler = createExtractHandler({ db, txPool: tx, gateway: gw });
    await runJob(db, bridge as unknown as JobEventBridge, handler, 'ejob-1', {
      leaseOwner: 'w1',
      traceId: 't1',
    });
    const c = [...db.candidates.values()][0]!;
    c.status = 'failed';
    c.error = {
      userMessage: '这一项没能识别出来，可点重试。',
      action: 'retry',
      retriable: true,
      traceId: 't',
    };
    for (const [k, e] of db.evidence) if (e.candidate_id === c.id) db.evidence.delete(k);
    return { db, tx, gw, candidateId: c.id };
  }

  it('retry 成功：done 帧含 result + 完整 progress（非退化）；retry job 落 completed；进度在 finalize 前上报', async () => {
    const { db, tx, gw, candidateId } = await seedFailedCandidate();
    const outboxBefore = tx.outbox.length;
    seedExtractJob(db, 'retry-1', {
      mode: 'single-candidate',
      snapshotId: 'snap-1',
      candidateId,
      extractJobId: 'ejob-1',
    });
    gw.default = { text: '{"name":"重试后能力","intent":"重试后用途"}', degraded: false };
    const bridge = new CollectBridge();
    const handler = createExtractHandler({ db, txPool: tx, gateway: gw });

    const outcome = await runJob(db, bridge as unknown as JobEventBridge, handler, 'retry-1', {
      leaseOwner: 'w2',
      traceId: 't2',
    });

    expect(outcome.kind).toBe('completed');
    expect(db.lifecycle.get('retry-1')!.status).toBe('completed');

    const doneFrames = bridge.published.filter((p) => p.event === 'done');
    expect(doneFrames).toHaveLength(1);
    const done = doneFrames[0]!.payload as {
      status: string;
      result?: { status?: string } | null;
      progress?: { percent: number; done?: number; total?: number };
    };
    expect(done.status).toBe('completed');
    expect(done.result).toBeTruthy();
    expect(done.result!.status).toBe('ready');
    expect(done.progress).toBeTruthy();
    expect(done.progress!.percent).toBe(100);
    expect(done.progress!.done).toBe(done.progress!.total);

    // retry 也发同事务 outbox（口径同全量）。
    const retryOutbox = tx.outbox.slice(outboxBefore);
    expect(retryOutbox).toHaveLength(1);
    expect(retryOutbox[0]!.topic).toBe('notify.extract_completed');

    expect(bridge.published.filter((p) => p.event === 'error')).toHaveLength(0);
  });

  it('反向破坏（retry）：finalize 后再 reportProgress → FencedOutError → done 退化为 fence-out 兜底（无 result/progress）', async () => {
    const { db, tx, gw, candidateId } = await seedFailedCandidate();
    seedExtractJob(db, 'retry-bad', {
      mode: 'single-candidate',
      snapshotId: 'snap-1',
      candidateId,
      extractJobId: 'ejob-1',
    });
    gw.default = { text: '{"name":"重试后能力","intent":"重试后用途"}', degraded: false };
    const bridge = new CollectBridge();
    const real = createExtractHandler({ db, txPool: tx, gateway: gw });
    const buggyHandler = {
      type: real.type,
      run: async (job: Parameters<typeof real.run>[0], ctx: Parameters<typeof real.run>[1]) => {
        const res = await real.run(job, ctx);
        await ctx.reportProgress({ percent: 100, phrase: '退化注入', done: 1, total: 1 });
        return res;
      },
    };

    const outcome = await runJob(
      db,
      bridge as unknown as JobEventBridge,
      buggyHandler,
      'retry-bad',
      { leaseOwner: 'w3', traceId: 't3' },
    );

    expect(outcome.kind).toBe('fenced_out');
    const doneFrames = bridge.published.filter((p) => p.event === 'done');
    expect(doneFrames).toHaveLength(1);
    const done = doneFrames[0]!.payload as { status: string; result?: unknown; progress?: unknown };
    expect(done.result).toBeUndefined();
    expect(done.progress).toBeUndefined();
  });
});

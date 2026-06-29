// B-16 job 对账自检（脊柱 §6.2）：过期 running 换 fence 重入队；未过期不动；入队失败不阻断其它条。
import { describe, it, expect } from 'vitest';
import {
  reconcileJobsOnce,
  pgTypeLookup,
  type ReEnqueue,
  type JobTypeLookup,
} from '../jobs/sweeper-reconcile.js';
import { runJob } from '../jobs/runner.js';
import { FakeDb, FakeBridge, makeJob, type FakeClock, type FakeJob } from './jobs-fence.js';
import type { JobEventBridge, JobHandler } from '../jobs/types.js';
import type { JobType } from '@cb/shared';

function setup(jobs: FakeJob[], now = 1_000): { db: FakeDb; map: Map<string, FakeJob> } {
  const map = new Map(jobs.map((j) => [j.id, j]));
  const clock: FakeClock = { now };
  return { db: new FakeDb(map, clock), map };
}

/** 记录重入队调用的假 ReEnqueue。 */
function recorder(failOn: string[] = []): {
  re: ReEnqueue;
  calls: Array<{ id: string; fence: number; type: JobType }>;
} {
  const calls: Array<{ id: string; fence: number; type: JobType }> = [];
  const re: ReEnqueue = {
    enqueue: async (jobType, jobId, fenceToken) => {
      if (failOn.includes(jobId)) throw new Error('enqueue failed');
      calls.push({ id: jobId, fence: fenceToken, type: jobType });
    },
  };
  return { re, calls };
}

describe('reconcileJobsOnce', () => {
  it('过期 running（worker 持租后死/卡）→ 换 fence + 以新 fence 重入队（旧 worker 回写带旧 fence 0 行，不双写）', async () => {
    const { db, map } = setup(
      [
        // lease_owner 非空 = worker 曾持租后死/卡 → 由 reclaimExpired 接管。
        makeJob('exp1', {
          type: 'import',
          status: 'running',
          lease_owner: 'w-dead-1',
          lease_until: 500,
          fence_token: 1,
        }),
        makeJob('exp2', {
          type: 'extract',
          status: 'running',
          lease_owner: 'w-dead-2',
          lease_until: 600,
          fence_token: 4,
        }),
        makeJob('fresh', {
          type: 'import',
          status: 'running',
          lease_owner: 'w-alive',
          lease_until: 999_999,
          fence_token: 2,
        }),
      ],
      1_000,
    );
    const { re, calls } = recorder();
    const res = await reconcileJobsOnce(db, re, pgTypeLookup(db));
    expect(res.reclaimed).toBe(2);
    expect(res.reEnqueued).toBe(2);
    expect(res.requeued).toBe(0); // 没有历史欠账
    // 重入队带换新后的 fence（exp1: 1→2, exp2: 4→5）。
    expect(calls.find((c) => c.id === 'exp1')?.fence).toBe(2);
    expect(calls.find((c) => c.id === 'exp2')?.fence).toBe(5);
    // 未过期的 fresh 不动（fence 仍 2，未被重入队）。
    expect(map.get('fresh')?.fence_token).toBe(2);
    expect(calls.find((c) => c.id === 'fresh')).toBeUndefined();
  });

  it('入队失败不阻断其它条（新 fence 已落库；lease_until 置为已过去而非 NULL，下一轮可补）', async () => {
    const { db, map } = setup(
      [
        makeJob('a', {
          type: 'import',
          status: 'running',
          lease_owner: 'w1',
          lease_until: 500,
          fence_token: 1,
        }),
        makeJob('b', {
          type: 'import',
          status: 'running',
          lease_owner: 'w2',
          lease_until: 500,
          fence_token: 1,
        }),
      ],
      1_000,
    );
    const { re, calls } = recorder(['a']); // a 入队失败
    const res = await reconcileJobsOnce(db, re, pgTypeLookup(db));
    expect(res.reclaimed).toBe(2);
    expect(res.reEnqueued).toBe(1); // 只有 b 成功
    expect(calls.map((c) => c.id)).toEqual(['b']);
    // a 的 fence 已换新（落库），lease_owner=NULL + lease_until=已过去（now-1s=0）→ 下一轮 requeuePending 可补。
    const a = map.get('a')!;
    expect(a.fence_token).toBe(2);
    expect(a.lease_owner).toBeNull();
    expect(a.lease_until).toBe(0); // 非 NULL（=now-1s），可被下轮扫到（Codex P0-3 核心修复）
  });

  it('入队失败后【第二轮补入队】：不再乱跳 fence/attempt，用既有 fence 补入（Codex P0-3）', async () => {
    const { db, map } = setup(
      [
        makeJob('stuck', {
          type: 'import',
          status: 'running',
          lease_owner: 'w-dead',
          lease_until: 500,
          fence_token: 1,
          attempt_no: 1,
        }),
      ],
      1_000,
    );

    // —— 第一轮：reclaimExpired 接管（fence 1→2, attempt 1→2），但入队失败 ——
    const r1 = recorder(['stuck']);
    const res1 = await reconcileJobsOnce(db, r1.re, pgTypeLookup(db));
    expect(res1.reclaimed).toBe(1);
    expect(res1.reEnqueued).toBe(0); // 入队失败
    expect(res1.requeued).toBe(0);
    expect(r1.calls).toEqual([]); // 没成功入队
    const afterR1 = map.get('stuck')!;
    expect(afterR1.fence_token).toBe(2); // 接管换了一次
    expect(afterR1.attempt_no).toBe(2);
    expect(afterR1.lease_owner).toBeNull();
    expect(afterR1.lease_until).toBe(0); // 已过去（now-1s） → 下一轮 requeuePending 可补

    // —— 第二轮：requeuePending 补入队成功，且【不再换 fence/attempt】 ——
    const r2 = recorder(); // 这轮不失败
    const res2 = await reconcileJobsOnce(db, r2.re, pgTypeLookup(db));
    expect(res2.requeued).toBe(1); // 补入队成功
    expect(res2.reclaimed).toBe(0); // 不再被 reclaimExpired 命中（lease_owner 已是 NULL）
    expect(res2.reEnqueued).toBe(1); // = requeued
    // 补入队用【既有 fence=2】，绝不乱跳到 3。
    expect(r2.calls).toEqual([{ id: 'stuck', fence: 2, type: 'import' }]);
    const afterR2 = map.get('stuck')!;
    expect(afterR2.fence_token).toBe(2); // 不变
    expect(afterR2.attempt_no).toBe(2); // 不变
  });

  it('第二轮补入队仍失败 → fence/attempt 不变，第三轮继续补（幂等不放弃）', async () => {
    const { db, map } = setup(
      [
        makeJob('s', {
          type: 'import',
          status: 'running',
          lease_owner: 'w-dead',
          lease_until: 500,
          fence_token: 1,
          attempt_no: 1,
        }),
      ],
      1_000,
    );
    const failing = recorder(['s']); // 三轮都失败
    await reconcileJobsOnce(db, failing.re, pgTypeLookup(db)); // 接管，入队失败
    await reconcileJobsOnce(db, failing.re, pgTypeLookup(db)); // 补，仍失败
    const after2 = map.get('s')!;
    expect(after2.fence_token).toBe(2); // 仅接管那次换过，补入队不再换
    expect(after2.attempt_no).toBe(2);
    expect(after2.lease_until).toBe(0); // 仍可被下轮扫到（now-1s）

    // 第三轮终于成功补入：用既有 fence=2。
    const ok = recorder();
    const res3 = await reconcileJobsOnce(db, ok.re, pgTypeLookup(db));
    expect(res3.requeued).toBe(1);
    expect(ok.calls).toEqual([{ id: 's', fence: 2, type: 'import' }]);
  });

  it('typeOf 查不到 → 跳过该条（不裸崩）', async () => {
    const { db } = setup(
      [
        makeJob('x', {
          status: 'running',
          lease_owner: 'w-dead',
          lease_until: 500,
          fence_token: 1,
        }),
      ],
      1_000,
    );
    const { re, calls } = recorder();
    const emptyLookup: JobTypeLookup = { typeOf: async () => undefined };
    const res = await reconcileJobsOnce(db, re, emptyLookup);
    expect(res.reclaimed).toBe(1);
    expect(res.reEnqueued).toBe(0);
    expect(calls).toEqual([]);
  });

  it('无过期任务 → reclaimed=0', async () => {
    const { db } = setup(
      [makeJob('fresh', { status: 'running', lease_owner: 'w', lease_until: 999_999 })],
      1_000,
    );
    const res = await reconcileJobsOnce(db, recorder().re, pgTypeLookup(db));
    expect(res).toEqual({ reclaimed: 0, reEnqueued: 0, requeued: 0, requeuedQueued: 0 });
  });

  it('停滞 queued 补投（Codex P1-r2）：建后入队失败被吞、长时间 queued 无主 → 用既有 fence 补投，不换 fence/attempt', async () => {
    // now=200_000、默认阈值 60s（60_000）→ 停滞判定 updated_at < now-threshold = 140_000。
    const { db, map } = setup(
      [
        makeJob('stale-q', {
          type: 'import',
          status: 'queued',
          lease_owner: null,
          lease_until: null,
          fence_token: 0,
          attempt_no: 0,
          updated_at: 0, // 0 < 140_000 → 停滞命中
        }),
        // 对照：一条刚建的健康 queued（updated_at 近=now）→ 不应被误补（阈值挡住）。
        makeJob('fresh-q', {
          type: 'import',
          status: 'queued',
          lease_owner: null,
          lease_until: null,
          fence_token: 0,
          updated_at: 199_000, // 199_000 > 140_000 → 不命中
        }),
      ],
      200_000,
    );
    const { re, calls } = recorder();
    const res = await reconcileJobsOnce(db, re, pgTypeLookup(db));
    expect(res.requeuedQueued).toBe(1);
    expect(res.reEnqueued).toBe(1);
    expect(res.reclaimed).toBe(0);
    // 补投用既有 fence=0（claimLease 领时才换），绝不在此乱跳。
    expect(calls).toEqual([{ id: 'stale-q', fence: 0, type: 'import' }]);
    // 停滞 job 仍 queued（补投不改状态，等 worker claimLease 接管）；fence/attempt 不变。
    const sq = map.get('stale-q')!;
    expect(sq.status).toBe('queued');
    expect(sq.fence_token).toBe(0);
    expect(sq.attempt_no).toBe(0);
    // 健康的 fresh-q 未被补投（阈值挡住，避免误补在线刚建的 queued）。
    expect(calls.find((c) => c.id === 'fresh-q')).toBeUndefined();
  });

  it('停滞 queued 补投失败 → 下一轮继续补（幂等不放弃，fence/attempt 不变）', async () => {
    const { db, map } = setup(
      [
        makeJob('sq', {
          type: 'import',
          status: 'queued',
          lease_owner: null,
          lease_until: null,
          fence_token: 0,
          updated_at: 0, // now=200_000、阈值 60s → 停滞命中
        }),
      ],
      200_000,
    );
    const failing = recorder(['sq']);
    const r1 = await reconcileJobsOnce(db, failing.re, pgTypeLookup(db));
    expect(r1.requeuedQueued).toBe(0); // 补投失败
    expect(map.get('sq')!.status).toBe('queued'); // 仍 queued，下轮可再补
    const ok2 = recorder();
    const r2 = await reconcileJobsOnce(db, ok2.re, pgTypeLookup(db));
    expect(r2.requeuedQueued).toBe(1);
    expect(ok2.calls).toEqual([{ id: 'sq', fence: 0, type: 'import' }]);
  });
});

describe('全链回归（Codex P1-r5）：reconcileJobsOnce → BullMQ 触发 → runJob/claimLease 不跳号、不 N+2', () => {
  it('worker 持租后死/卡 → sweeper 接管(N→N+1) → worker 用 BullMQ 触发的 fence 接管执行 → attempt 不跳号、fence == reclaim 设定、不出现 N+2', async () => {
    // 起手：一个 worker 持租后死/卡的过期 running job（attempt=1, fence=1）。
    const map = new Map<string, FakeJob>([
      [
        'j1',
        makeJob('j1', {
          type: 'import',
          status: 'running',
          lease_owner: 'w-dead',
          lease_until: 500, // 已过期
          fence_token: 1,
          attempt_no: 1,
          progress: { percent: 30, phrase: '半路死了', subtasks: [] },
        }),
      ],
    ]);
    const clock: FakeClock = { now: 1_000 };
    const db = new FakeDb(map, clock);
    const bridge = new FakeBridge();

    // BullMQ 触发记录器：reEnqueue.enqueue 即「入队 → BullMQ 后续触发 worker」。
    //   关键断言点：sweeper 入队时带的 fence 必 = reclaim 设定的新 fence（2），worker 用它执行。
    const triggered: Array<{ jobId: string; fence: number }> = [];
    const re: ReEnqueue = {
      enqueue: async (_type, jobId, fenceToken) => {
        triggered.push({ jobId, fence: fenceToken });
      },
    };

    // —— ① sweeper 一轮：reclaimExpired 把 attempt/fence 从 1→2 并以 fence=2 入队 ——
    const res = await reconcileJobsOnce(db, re, pgTypeLookup(db));
    expect(res.reclaimed).toBe(1);
    expect(res.reEnqueued).toBe(1);
    const afterReclaim = map.get('j1')!;
    expect(afterReclaim.fence_token).toBe(2); // N→N+1（恰好一次，发生在 reclaim）
    expect(afterReclaim.attempt_no).toBe(2);
    expect(afterReclaim.lease_owner).toBeNull(); // 接管态：无主、待 worker claim
    // sweeper 入队带的 fence = reclaim 设定的新 fence（BullMQ 触发 id 据此对齐执行 fence）。
    expect(triggered).toEqual([{ jobId: 'j1', fence: 2 }]);

    // —— ② BullMQ 触发 worker → runJob → claimLease：worker 忽略 BullMQ data.fenceToken，
    //    用 DB 返回的 fence 执行。claimLease 命中「已被 reclaim 的行」→ 只接管租约、绝不再 +1 ——
    let executedFence: number | undefined;
    let executedAttempt: number | undefined;
    const h: JobHandler = {
      type: 'import',
      run: async (job) => {
        executedFence = job.fenceToken; // worker 实际执行用的 fence（DB 返回值）
        executedAttempt = job.attemptNo;
        // 断点续传：从 reclaim 前已落的 progress（percent=30）续跑，已生成不丢。
        expect(job.progress.percent).toBe(30);
        return { result: { ok: true } };
      },
    };
    const outcome = await runJob(db, bridge as unknown as JobEventBridge, h, 'j1', {
      leaseOwner: 'w-new',
      traceId: 't',
    });

    expect(outcome.kind).toBe('completed');
    // 关键不变量（r5）：worker 接管后 attempt 不跳号（仍是 2，不是 3），执行 fence == reclaim 设定（2），绝不 N+2。
    expect(executedAttempt).toBe(2);
    expect(executedFence).toBe(2);
    const finalJob = map.get('j1')!;
    expect(finalJob.attempt_no).toBe(2); // 全链下来 attempt 恰好递增一次（reclaim 处）
    expect(finalJob.fence_token).toBe(2); // fence 与 reclaim 设定一致，未被 claim 再 +1
    expect(finalJob.status).toBe('completed');
    expect(finalJob.lease_owner).toBe('w-new'); // 新 worker 持租执行
  });

  it('对照组：queued 首次派发仍正常递增（0→1），不受接管路径影响', async () => {
    const map = new Map<string, FakeJob>([
      ['q1', makeJob('q1', { type: 'import', status: 'queued', fence_token: 0, attempt_no: 0 })],
    ]);
    const db = new FakeDb(map, { now: 1_000 });
    const bridge = new FakeBridge();
    let execFence: number | undefined;
    let execAttempt: number | undefined;
    const h: JobHandler = {
      type: 'import',
      run: async (job) => {
        execFence = job.fenceToken;
        execAttempt = job.attemptNo;
        return { result: null };
      },
    };
    await runJob(db, bridge as unknown as JobEventBridge, h, 'q1', {
      leaseOwner: 'w1',
      traceId: 't',
    });
    expect(execFence).toBe(1); // queued 首派：递增路径
    expect(execAttempt).toBe(1);
  });
});

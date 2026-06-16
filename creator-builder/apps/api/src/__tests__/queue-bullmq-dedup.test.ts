// Codex P0-new · BullMQ jobId 去重不再吞掉重入队触发（attempt 级触发 id）。
//   背景旧 bug：BullMQ 触发 jobId = 业务 jobId。sweeper 重入队时旧 BullMQ job 未清，
//   add({jobId: 业务id}) 命中 BullMQ jobId 去重 → 不创建新触发；reconcileJobsOnce 仍记成功，
//   过期 running 永久无主（worker 不会再被触发）。
//   修复：BullMQ 触发 jobId = `${业务jobId}:${fenceToken}`（attempt 级唯一），业务 jobId 放 data；
//        换 fence 必产生新触发（不被去重吞掉）；取消/完成按业务 jobId 清理其所有 attempt 触发。
//   本测用【模拟真实 BullMQ duplicate 语义】的假 Queue（同 jobId add 被吞、返回既有 job、不新增）证明新机制。
import { describe, it, expect, vi } from 'vitest';
import type { ReEnqueue } from '../jobs/sweeper-reconcile.js';

/** 一条假 BullMQ job（含 jobId/data/可被 remove）。 */
interface FakeBullJob {
  id: string;
  name: string;
  data: { jobId: string; fenceToken: number };
  removed: boolean;
  remove: () => Promise<void>;
}

/**
 * 假 BullMQ Queue，复刻【真实 BullMQ duplicate 语义】：
 *   - add(name, data, { jobId }) 当 jobId 已存在（且未被 remove）→ **被吞**：不新增 job、返回既有 job（去重）。
 *   - jobId 不存在 → 新增一条 job。
 *   - getJobs([...]) → 返回当前所有未 remove 的 job（测试只用全态过滤，types 忽略）。
 * 记录 addCalls 便于断言「产生了几次真实新触发」。
 */
class FakeBullQueue {
  readonly jobs = new Map<string, FakeBullJob>();
  readonly addCalls: Array<{ jobId: string; data: FakeBullJob['data']; deduped: boolean }> = [];

  async add(
    name: string,
    data: FakeBullJob['data'],
    opts: { jobId: string },
  ): Promise<FakeBullJob> {
    const existing = this.jobs.get(opts.jobId);
    if (existing && !existing.removed) {
      // 真实 BullMQ 语义：同 jobId 已存在 → 去重，不创建新触发，返回既有 job。
      this.addCalls.push({ jobId: opts.jobId, data, deduped: true });
      return existing;
    }
    const job: FakeBullJob = {
      id: opts.jobId,
      name,
      data,
      removed: false,
      remove: async () => {
        job.removed = true;
        this.jobs.delete(opts.jobId);
      },
    };
    this.jobs.set(opts.jobId, job);
    this.addCalls.push({ jobId: opts.jobId, data, deduped: false });
    return job;
  }

  async getJobs(_states: string[], _start?: number, _end?: number): Promise<FakeBullJob[]> {
    return [...this.jobs.values()].filter((j) => !j.removed);
  }

  async close(): Promise<void> {
    /* noop */
  }

  /** 真实新触发数（去重吞掉的不算）= 实际会让 worker 跑的次数。 */
  realTriggers(): number {
    return this.addCalls.filter((c) => !c.deduped).length;
  }
}

// —— 用单例假 Queue 替换 bullmq.Queue（queue.ts 惰性 new Queue 时拿到它）——
const fakeQueue = new FakeBullQueue();
vi.mock('bullmq', () => ({
  Queue: vi.fn(() => fakeQueue),
}));

const { createBullQueuePort, bullJobId } = await import('../infra/queue.js');
const { reconcileJobsOnce, pgTypeLookup } = await import('../jobs/sweeper-reconcile.js');

const env = { REDIS_QUEUE_URL: 'redis://localhost:6379/0' } as never;

describe('BullMQ 触发 jobId attempt 级唯一（Codex P0-new）', () => {
  it('换 fence 重入队 → 产生【新触发】（不被旧触发的 jobId 去重吞掉）', async () => {
    const port = createBullQueuePort(env);
    // attempt 1：fence=1 入队 → 新触发。
    await port.enqueue('import', 'job-1' as never, 1);
    // attempt 1 同 fence 重复入队（worker 重投/幂等）→ 同触发 id → 被去重（保留第二道幂等闸）。
    await port.enqueue('import', 'job-1' as never, 1);
    expect(fakeQueue.realTriggers()).toBe(1); // 同 fence 第二次被吞

    // sweeper 换 fence（1→2）重入队 → attempt 级触发 id 不同 → 必产生【新触发】（旧 bug 会被吞）。
    await port.enqueue('import', 'job-1' as never, 2);
    expect(fakeQueue.realTriggers()).toBe(2); // 换 fence 产生了真实新触发
    // 两条触发各带 attempt 级 id；业务 jobId 在 data。
    expect(fakeQueue.jobs.has(bullJobId('job-1', 1))).toBe(true);
    expect(fakeQueue.jobs.has(bullJobId('job-1', 2))).toBe(true);
    const trig2 = fakeQueue.jobs.get(bullJobId('job-1', 2))!;
    expect(trig2.data.jobId).toBe('job-1'); // 业务 jobId 放 data
    expect(trig2.data.fenceToken).toBe(2);
  });

  it('remove 按业务 jobId 清理其【所有 attempt 触发】（attempt 级 id 后 getJob(业务id) 已找不到）', async () => {
    fakeQueue.jobs.clear();
    fakeQueue.addCalls.length = 0;
    const port = createBullQueuePort(env);
    await port.enqueue('import', 'job-2' as never, 1);
    await port.enqueue('import', 'job-2' as never, 2); // 两个 attempt 触发并存
    await port.enqueue('import', 'other' as never, 1); // 不相干 job
    expect(fakeQueue.jobs.size).toBe(3);

    await port.remove('job-2' as never);
    // job-2 的两个 attempt 触发都被清；other 不动。
    expect(fakeQueue.jobs.has(bullJobId('job-2', 1))).toBe(false);
    expect(fakeQueue.jobs.has(bullJobId('job-2', 2))).toBe(false);
    expect(fakeQueue.jobs.has(bullJobId('other', 1))).toBe(true);
  });
});

describe('reconcileJobsOnce 经真实 BullMQ duplicate 语义不再误判 / 不再永久无主（Codex P0-new）', () => {
  // 极简内存 jobs：只够 reclaimExpired/requeuePending/typeOf 的 SQL 形态（复用 sweeper 语义）。
  function memJobsDb() {
    const job = {
      id: 'jx',
      type: 'import',
      status: 'running',
      lease_owner: 'w-dead' as string | null,
      lease_until: 500 as number | null,
      fence_token: 1,
      attempt_no: 1,
    };
    let now = 1_000;
    const db = {
      setNow: (n: number) => {
        now = n;
      },
      job,
      query: async (sql: string, params: unknown[] = []) => {
        // reclaimExpired：换 fence + attempt+1 + lease_owner=NULL + lease_until=now-1s。
        if (
          sql.includes('attempt_no  = attempt_no + 1') &&
          sql.includes('fence_token = fence_token + 1')
        ) {
          if (
            job.status === 'running' &&
            job.lease_owner !== null &&
            job.lease_until !== null &&
            job.lease_until < now
          ) {
            job.attempt_no += 1;
            job.fence_token += 1;
            job.lease_owner = null;
            job.lease_until = now - 1_000;
            return {
              rows: [{ id: job.id, fence_token: job.fence_token, attempt_no: job.attempt_no }],
            };
          }
          return { rows: [] };
        }
        // staleQueued：status='queued' AND lease_owner IS NULL AND updated_at < now()-threshold（Codex P1-r2）。
        //   本用例 job 始终 running，故恒空（不影响 running 接管/补入队语义）。
        if (
          sql.includes('SELECT id, fence_token, attempt_no') &&
          sql.includes("status = 'queued'") &&
          sql.includes('updated_at < now()')
        ) {
          return { rows: [] };
        }
        // requeuePending：lease_owner IS NULL AND lease_until < now()。
        if (
          sql.includes('SELECT id, fence_token, attempt_no') &&
          sql.includes('lease_owner IS NULL') &&
          sql.includes('lease_until < now()')
        ) {
          if (
            job.status === 'running' &&
            job.lease_owner === null &&
            (job.lease_until ?? 0) < now
          ) {
            return {
              rows: [{ id: job.id, fence_token: job.fence_token, attempt_no: job.attempt_no }],
            };
          }
          return { rows: [] };
        }
        // typeOf。
        if (sql.includes('SELECT type FROM jobs')) {
          return params[0] === job.id ? { rows: [{ type: job.type }] } : { rows: [] };
        }
        throw new Error(`memJobsDb unhandled: ${sql.slice(0, 60)}`);
      },
    };
    return db;
  }

  it('过期 running 重入队：换 fence 后 add 命中真实 BullMQ 队列【不被去重吞掉】→ 产生新触发、计为成功', async () => {
    fakeQueue.jobs.clear();
    fakeQueue.addCalls.length = 0;
    // 模拟旧触发仍在队列（旧 bug 前置条件：上一 attempt 的 BullMQ job 未清）。
    // 旧触发用【旧 fence=1】的 attempt 级 id（这正是 reclaim 前的 attempt）。
    await fakeQueue.add('import', { jobId: 'jx', fenceToken: 1 }, { jobId: bullJobId('jx', 1) });
    expect(fakeQueue.realTriggers()).toBe(1);

    const db = memJobsDb();
    const port = createBullQueuePort(env);
    const reEnqueue: ReEnqueue = {
      enqueue: (jobType, jobId, fenceToken) => port.enqueue(jobType, jobId as never, fenceToken),
    };

    const res = await reconcileJobsOnce(db as never, reEnqueue, pgTypeLookup(db as never));
    // 接管换 fence（1→2），以 fence=2 重入队。
    expect(res.reclaimed).toBe(1);
    expect(res.reEnqueued).toBe(1); // 真成功（不是被去重吞掉后误判成功）
    // 关键：换 fence 的触发 id `jx:2` 与旧 `jx:1` 不同 → 真实 BullMQ 队列【产生了新触发】（旧 bug 此处会被吞）。
    expect(fakeQueue.realTriggers()).toBe(2);
    expect(fakeQueue.jobs.has(bullJobId('jx', 2))).toBe(true);
    // 不再永久无主：jx 已有新 attempt 触发在队列里等 worker 跑。
    expect(db.job.fence_token).toBe(2);
  });

  it('对照·旧机制（业务 jobId 作触发 id）会被去重吞掉 → 证明 attempt 级 id 是必要修复', async () => {
    // 直接调假队列复现旧语义：两次都用业务 jobId 'jy' 作触发 id（旧 bug 写法）。
    fakeQueue.jobs.clear();
    fakeQueue.addCalls.length = 0;
    await fakeQueue.add('import', { jobId: 'jy', fenceToken: 1 }, { jobId: 'jy' });
    await fakeQueue.add('import', { jobId: 'jy', fenceToken: 2 }, { jobId: 'jy' }); // 换 fence 但同触发 id
    // 旧机制：第二次（重入队）被去重吞掉 → 只有 1 个真实触发 → 过期 running 永久无主（worker 不再被触发）。
    expect(fakeQueue.realTriggers()).toBe(1);
    expect(fakeQueue.addCalls[1]?.deduped).toBe(true);
  });
});

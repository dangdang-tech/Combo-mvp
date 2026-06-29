// Codex P1-r4 · 取消清理跨【全部 job 类型】触发（冷启动/重启后进程未预先实例化队列也能清到）。
//   背景旧 bug：remove(jobId) 只扫 queues.values()（进程内已实例化的队列）。冷启动/重启后取消时，
//   本进程还没 enqueue 过该业务 job 所属类型的队列 → queues map 为空/缺该类型 → 扫不到 → 清不掉
//   重启前 BullMQ 里已有的 attempt 触发 → worker 仍会被重投。
//   修复：remove 遍历 ACTIVE_JOB_TYPES，对每类 queueFor(env,type) 惰性补建后按 data.jobId 扫全队列各态移除。
//   本测用【每个队列名一条独立假 Queue】的工厂，模拟「重启前 BullMQ 里已有触发、但进程冷 map 未实例化」。
import { describe, it, expect, vi } from 'vitest';

/** 一条假 BullMQ job（按 data.jobId 可被 remove）。 */
interface FakeBullJob {
  id: string;
  name: string;
  data: { jobId: string; fenceToken: number };
  removed: boolean;
  remove: () => Promise<void>;
}

/** 每个队列名一条独立假 Queue（区分 job 类型）。getJobs 返回未 remove 的全部 job。 */
class FakeBullQueue {
  readonly jobs = new Map<string, FakeBullJob>();
  constructor(readonly name: string) {}

  /**
   * 测试夹具：直接往这条队列种一条「重启前 BullMQ 里已有」的触发（不经 createBullQueuePort）。
   *   触发 id 走【共享 bullJobId helper】（无冒号，Codex P0-2nd），与生产端构造完全一致——
   *   不再硬编码 `${jobId}:${fenceToken}`，否则 seed 的 id 与 remove 扫到/匹配的 id 分隔符不一致。
   */
  seed(jobId: string, fenceToken: number): void {
    const bullId = bullJobId(jobId as never, fenceToken);
    const job: FakeBullJob = {
      id: bullId,
      name: this.name,
      data: { jobId, fenceToken },
      removed: false,
      remove: async () => {
        job.removed = true;
        this.jobs.delete(bullId);
      },
    };
    this.jobs.set(bullId, job);
  }

  async getJobs(_states: string[], _start?: number, _end?: number): Promise<FakeBullJob[]> {
    return [...this.jobs.values()].filter((j) => !j.removed);
  }

  async close(): Promise<void> {
    /* noop */
  }
}

// —— 每个队列名一条独立实例（new Queue('<type>', { prefix }) 拿到对应那条）。记录 newQueueCalls 证明冷 map 惰性补建。——
//   队列名只留 jobType（无 ':'，BullMQ 约束）；命名空间走 prefix 选项。
const queuesByName = new Map<string, FakeBullQueue>();
const newQueueCalls: string[] = [];
function getOrMakeFake(name: string): FakeBullQueue {
  let q = queuesByName.get(name);
  if (!q) {
    q = new FakeBullQueue(name);
    queuesByName.set(name, q);
  }
  return q;
}
vi.mock('bullmq', () => ({
  Queue: vi.fn((name: string, _opts?: unknown) => {
    // 模拟真实 BullMQ queue-base 校验：队列名禁含 ':'（否则生产真跑即崩）。mock 也校验,否则 mock 永抓不到此 bug。
    if (name.includes(':')) throw new Error("Queue name cannot contain ':'");
    newQueueCalls.push(name);
    return getOrMakeFake(name);
  }),
}));

const { createBullQueuePort, closeQueues, bullJobId } = await import('../infra/queue.js');
const env = { REDIS_QUEUE_URL: 'redis://localhost:6379/0' } as never;

/** 每个 it 前彻底冷起：清 queue.ts 内部 queues map + 底层假队列工厂 + new Queue 调用记录。 */
async function coldStart(): Promise<void> {
  await closeQueues(); // 清 queue.ts 内部 queues map（模拟进程重启后的冷 map）
  queuesByName.clear();
  newQueueCalls.length = 0;
}

describe('remove 跨全部 job 类型清理触发（Codex P1-r4：冷 map 也清得到）', () => {
  it('冷 map（进程从未实例化该类型队列）→ remove 仍能清到重启前 BullMQ 里已有的 attempt 触发', async () => {
    await coldStart();

    // 模拟「重启前 BullMQ 里已有触发」：直接在底层假队列种 job-cold 的两个 attempt 触发（不经 enqueue）。
    //   注意：这是【冷 map】——当前进程的 queue.ts queues map 还没实例化过任何队列（seed 不走 queueFor）。
    const extractQ = getOrMakeFake('extract');
    extractQ.seed('job-cold', 1);
    extractQ.seed('job-cold', 2);
    // 另一类型里不相干的 job，验证不误删。
    const importQ = getOrMakeFake('import');
    importQ.seed('other', 1);

    const port = createBullQueuePort(env);
    // 取消：进程内 queues map 此前没 enqueue 过 → 旧实现只扫 queues.values()（空）会清不到。
    await port.remove('job-cold' as never);

    // 关键：remove 遍历 ACTIVE_JOB_TYPES 惰性补建了各类型队列（含 extract）→ 扫到并清掉两个 attempt 触发。
    expect(extractQ.jobs.has(bullJobId('job-cold' as never, 1))).toBe(false);
    expect(extractQ.jobs.has(bullJobId('job-cold' as never, 2))).toBe(false);
    // 不相干 job 不动。
    expect(importQ.jobs.has(bullJobId('other' as never, 1))).toBe(true);
    // 证明确实按【全部活动类型】惰性补建了队列（而非只扫进程内已建的；旧实现这里一条都不会 new）。
    expect(newQueueCalls).toEqual(
      expect.arrayContaining(['import', 'extract', 'structure', 'publish_batch']),
    );
  });

  it('业务 job 属某一类型，其它类型空队列被扫但无害（不抛、不误删）', async () => {
    await coldStart();

    const structureQ = getOrMakeFake('structure');
    structureQ.seed('job-s', 7);

    const port = createBullQueuePort(env);
    await port.remove('job-s' as never);

    expect(structureQ.jobs.has(bullJobId('job-s' as never, 7))).toBe(false);
    // 其余三类型队列被惰性补建、扫了空队列、无异常。
    expect(newQueueCalls).toEqual(
      expect.arrayContaining(['import', 'extract', 'structure', 'publish_batch']),
    );
  });
});

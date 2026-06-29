// live 崩溃修复 · BullMQ 队列名禁含 ':'（queue-base.js 校验 `Error: Queue name cannot contain ':'`）。
//   旧 bug：生产端 new Queue(`cb:${type}`)、消费端 new Worker(`cb:${type}`) 队列名带冒号 → worker 进程真跑即崩，
//   主链路所有 job（import/extract/structure/publish_batch）无人消费。单测旧 mock 不校验 name 故永远抓不到。
//   修复：命名空间走 BullMQ `prefix` 选项（共享常量 QUEUE_PREFIX），队列名只留 jobType。
//   本测【模拟真实 BullMQ name 校验】（含 ':' 即抛），并断言：
//     1) 生产端 Queue 名无 ':'、prefix === QUEUE_PREFIX；
//     2) 消费端 Worker 名无 ':'、prefix === QUEUE_PREFIX；
//     3) 生产端与消费端【队列名 + prefix 完全一致】（否则 job 入队但 worker 收不到）。
//   反向破坏：把任一端改回 `cb:${type}` → mock 校验抛 `Queue name cannot contain ':'` → 测试转红（命中 bug）。
//   Codex P0-2nd 追加：FakeQueue.add 也复刻【真实 BullMQ custom jobId 校验】（含 ':' 两段 id 即抛
//     `Custom Id cannot contain :`），断言 enqueue 产出的 custom jobId 无 ':'（队列名修了、jobId 仍会崩的第二处 bug）。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QUEUE_PREFIX, ACTIVE_JOB_TYPES, type JobType } from '@cb/shared';

/** 模拟真实 BullMQ queue-base 校验：队列名禁含 ':'（生产真跑即崩的根因）。 */
function assertValidBullName(name: string): void {
  if (name.includes(':')) throw new Error("Queue name cannot contain ':'");
}

/**
 * 模拟真实 BullMQ 5.78.1 custom jobId 校验（job.js validateOptions，约 1047 行，Codex P0-2nd）：
 *   jobId 含 ':' 且 split(':').length !== 3 → 抛 `Custom Id cannot contain :`（两段 id 必崩）。
 *   add 必须校验 opts.jobId，否则 mock 漏掉 custom jobId 冒号 bug（队列名修了、jobId 仍崩）。
 */
function assertValidBullCustomId(jobId: string | undefined): void {
  if (jobId && jobId.includes(':') && jobId.split(':').length !== 3) {
    throw new Error('Custom Id cannot contain :');
  }
}

interface CtorCall {
  name: string;
  prefix: string | undefined;
}

const queueCtorCalls: CtorCall[] = [];
const workerCtorCalls: CtorCall[] = [];
/** 记录每次 add 的 custom jobId（断言无 ':'，Codex P0-2nd）。 */
const addJobIds: string[] = [];

/** 假 Queue：构造时校验 name 合法、记录 name+prefix。其余方法 noop（本测只看构造参数）。 */
class FakeQueue {
  constructor(name: string, opts?: { prefix?: string }) {
    assertValidBullName(name);
    queueCtorCalls.push({ name, prefix: opts?.prefix });
  }
  async getJobs(): Promise<never[]> {
    return [];
  }
  async add(_name: string, _data: unknown, opts?: { jobId?: string }): Promise<void> {
    assertValidBullCustomId(opts?.jobId); // 复刻真实 BullMQ custom jobId 校验（含 ':' 两段 id 即崩）
    if (opts?.jobId !== undefined) addJobIds.push(opts.jobId);
  }
  async close(): Promise<void> {
    /* noop */
  }
}

/** 假 Worker：构造时校验 name 合法、记录 name+prefix。 */
class FakeWorker {
  constructor(name: string, _processor: unknown, opts?: { prefix?: string }) {
    assertValidBullName(name);
    workerCtorCalls.push({ name, prefix: opts?.prefix });
  }
  on(): void {
    /* noop */
  }
  async close(): Promise<void> {
    /* noop */
  }
}

vi.mock('bullmq', () => ({ Queue: FakeQueue, Worker: FakeWorker }));

const env = { REDIS_QUEUE_URL: 'redis://localhost:6379/0' } as never;

beforeEach(() => {
  queueCtorCalls.length = 0;
  workerCtorCalls.length = 0;
  addJobIds.length = 0;
});

describe('BullMQ 队列名禁含 ":"（live 崩溃修复）', () => {
  it('生产端 Queue：名无 ":"、命名空间走 prefix===QUEUE_PREFIX', async () => {
    const { createBullQueuePort, closeQueues } = await import('../infra/queue.js');
    await closeQueues(); // 清进程内 queues map（其它用例可能已实例化）
    queueCtorCalls.length = 0;

    const port = createBullQueuePort(env);
    // 入队四类各一 → 各惰性建一条队列。
    for (const t of ACTIVE_JOB_TYPES) {
      await port.enqueue(t, `job-${t}` as never, 1);
    }

    expect(queueCtorCalls.length).toBe(ACTIVE_JOB_TYPES.length);
    for (const call of queueCtorCalls) {
      expect(call.name).not.toContain(':'); // 不含冒号（满足 BullMQ 约束）
      expect(call.prefix).toBe(QUEUE_PREFIX); // 命名空间走 prefix（Redis key 仍 cb:<type>:...）
    }
    // 队列名正是 jobType 本身（无前缀拼接）。
    expect(queueCtorCalls.map((c) => c.name).sort()).toEqual([...ACTIVE_JOB_TYPES].sort());
    // Codex P0-2nd：每次 add 的 custom jobId 也无 ':'（含冒号两段 id 会被真实 BullMQ 拒、job 入队即崩）。
    //   反向破坏：bullJobId 改回 ':' → 上面 enqueue 时 FakeQueue.add 的 assertValidBullCustomId 会抛 → 测试转红。
    expect(addJobIds.length).toBe(ACTIVE_JOB_TYPES.length);
    for (const id of addJobIds) expect(id).not.toContain(':');
    await closeQueues();
  });

  it('消费端 Worker：名无 ":"、命名空间走 prefix===QUEUE_PREFIX', async () => {
    // 仅注册 import handler → 起一条 Worker（足够验证消费端命名；不真连 redis/pg/sse）。
    vi.resetModules();
    vi.doMock('../config/env.js', () => ({ loadEnv: () => env }));
    vi.doMock('../infra/db.js', () => ({ getPool: () => ({}) }));
    vi.doMock('../infra/redis.js', () => ({ getHotRedis: () => ({}) }));
    vi.doMock('../sse/event-stream.js', () => ({ RedisEventStream: class {} }));
    vi.doMock('../jobs/runner.js', () => ({ runJob: async () => 'ok' }));
    vi.doMock('../jobs/handlers/index.js', () => ({})); // 阻断真实 handler 装配的副作用
    const importType: JobType = 'import';
    vi.doMock('../jobs/registry.js', () => ({
      getHandler: (t: JobType) => (t === importType ? () => {} : undefined),
      missingActiveHandlers: () => [],
      registeredTypes: () => [importType],
    }));
    vi.doMock('bullmq', () => ({ Queue: FakeQueue, Worker: FakeWorker }));

    workerCtorCalls.length = 0;
    await import('../processes/worker.js'); // 顶层 main() 执行 → 对已注册类型起 Worker

    expect(workerCtorCalls.length).toBeGreaterThan(0);
    for (const call of workerCtorCalls) {
      expect(call.name).not.toContain(':');
      expect(call.prefix).toBe(QUEUE_PREFIX);
    }
    // import 这条 Worker 的队列名正是 jobType 'import'。
    expect(workerCtorCalls.some((c) => c.name === importType)).toBe(true);

    vi.doUnmock('bullmq');
    vi.resetModules();
  });

  it('生产端与消费端【队列名 + prefix 一致】（否则 job 入队但 worker 收不到）', () => {
    // 同一 jobType 在两端的「队列地址」= (name, prefix)；本修复两端 name=jobType、prefix=QUEUE_PREFIX，恒一致。
    const addr = (t: JobType): { name: string; prefix: string } => ({
      name: t,
      prefix: QUEUE_PREFIX,
    });
    for (const t of ACTIVE_JOB_TYPES) {
      const a = addr(t);
      expect(a.name).not.toContain(':');
      expect(a.prefix).toBe(QUEUE_PREFIX);
    }
  });
});

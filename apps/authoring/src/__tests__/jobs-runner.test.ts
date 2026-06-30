// 通用 runner 自检（B-10/B-11/B-12）：领租约执行、进度受保护持久化 + 推帧、
//   超时被 sweeper 接管不双写、取消中途安全退出（已生成保留）、handler 失败归一人话 ErrorBody。
import { describe, it, expect } from 'vitest';
import { runJob, FencedOutError, normalizeToErrorBody } from '../platform/jobs/runner.js';
import { reclaimExpired } from '../platform/jobs/repo.js';
import { ErrorCode } from '@cb/shared';
import type { Logger } from 'pino';
import type { JobContext, JobHandler, JobEventBridge, LeasedJob } from '../platform/jobs/types.js';
import { FakeDb, FakeBridge, makeJob, type FakeClock, type FakeJob } from './jobs-fence.js';

/** 一次被捕获的日志调用：合并后的 child bindings + 本次 mergeObject + msg。 */
interface CapturedLog {
  level: 'error' | 'info' | 'warn';
  bindings: Record<string, unknown>;
  obj: Record<string, unknown>;
  msg: string | undefined;
}

/**
 * 假 pino logger（捕获结构化日志，断言 job 失败时 logger.error 含 code/jobId/jobType/attempt/fenceToken）。
 *   忠实复刻 pino 的 child bindings 继承（child 合并父 bindings）与 (obj, msg) 调用形态。
 *   只实现 runner 用到的 child/info/error；其余 method 桩成空，便于 as 成 Logger 给 runner。
 */
function makeFakeLogger(): { logger: Logger; calls: CapturedLog[] } {
  const calls: CapturedLog[] = [];
  function build(bindings: Record<string, unknown>): Logger {
    const record =
      (level: CapturedLog['level']) =>
      (a?: unknown, b?: unknown): void => {
        // pino 形态：logger.error(mergeObj, msg) 或 logger.error(msg)。
        if (typeof a === 'object' && a !== null) {
          calls.push({ level, bindings, obj: a as Record<string, unknown>, msg: b as string });
        } else {
          calls.push({ level, bindings, obj: {}, msg: a as string });
        }
      };
    const stub = (): void => {};
    return {
      child: (b: Record<string, unknown>) => build({ ...bindings, ...b }),
      error: record('error'),
      info: record('info'),
      warn: record('warn'),
      debug: stub,
      trace: stub,
      fatal: stub,
      silent: stub,
    } as unknown as Logger;
  }
  return { logger: build({}), calls };
}

function setup(
  jobs: FakeJob[],
  now = 1_000,
): {
  db: FakeDb;
  bridge: FakeBridge;
  clock: FakeClock;
  map: Map<string, FakeJob>;
} {
  const map = new Map(jobs.map((j) => [j.id, j]));
  const clock: FakeClock = { now };
  return { db: new FakeDb(map, clock), bridge: new FakeBridge(), clock, map };
}

/** 一个最小 handler：跑 fn(ctx) 并返回结果。 */
function handler(
  type: JobHandler['type'],
  fn: (job: LeasedJob, ctx: JobContext) => Promise<unknown>,
): JobHandler {
  return { type, run: async (job, ctx) => ({ result: await fn(job, ctx) }) };
}

describe('runJob 正常路径（领租约 → 进度 → 完成）', () => {
  it('completed：进度受保护持久化 + 推 progress/done 帧 + jobs.result 落库', async () => {
    const { db, bridge, map } = setup([makeJob('j1')]);
    const h = handler('import', async (_job, ctx) => {
      await ctx.reportSubtask('credential', 'done');
      await ctx.reportProgress({ percent: 50, phrase: '一半了', done: 1, total: 2 });
      await ctx.appendItem({ id: 'seg-1' });
      return { snapshotId: 'snap-1' };
    });
    const outcome = await runJob(db, bridge as unknown as JobEventBridge, h, 'j1', {
      leaseOwner: 'w1',
      traceId: 't1',
    });
    expect(outcome.kind).toBe('completed');
    const j = map.get('j1')!;
    expect(j.status).toBe('completed');
    expect(j.result).toEqual({ snapshotId: 'snap-1' });
    expect((j.progress as { percent: number }).percent).toBe(100); // 完成拉满
    // 推帧含 progress / subtask / item-appended / done。
    const events = bridge.published.map((p) => p.event);
    expect(events).toContain('progress');
    expect(events).toContain('subtask');
    expect(events).toContain('item-appended');
    expect(events).toContain('done');
    const done = bridge.published.find((p) => p.event === 'done');
    expect((done?.payload as { status: string }).status).toBe('completed');
  });

  it('成功落终态保留累积明细（Codex P1-new：用最新镜像，不被领取旧快照覆盖；items/subtasks/done/total 不丢）', async () => {
    const { db, bridge, map } = setup([makeJob('j1')]);
    const h = handler('import', async (_job, ctx) => {
      // handler 内累积：子任务点亮 + 边生成边显示 items + 分子分母。
      await ctx.reportSubtask('fetch', 'done', '拉取会话');
      await ctx.reportSubtask('segment', 'done', '切段');
      await ctx.appendItem({ id: 'seg-1' });
      await ctx.appendItem({ id: 'seg-2' });
      await ctx.appendItem({ id: 'seg-3' });
      await ctx.reportProgress({ percent: 90, phrase: '快好了', done: 3, total: 3, unit: '段' });
      return { snapshotId: 'snap-1' };
    });
    const outcome = await runJob(db, bridge as unknown as JobEventBridge, h, 'j1', {
      leaseOwner: 'w1',
      traceId: 't1',
    });
    expect(outcome.kind).toBe('completed');
    const prog = map.get('j1')!.progress as {
      percent: number;
      items?: unknown[];
      subtasks: Array<{ key: string; status: string }>;
      done?: number;
      total?: number;
      unit?: string;
    };
    expect(prog.percent).toBe(100); // 拉满
    // 关键：累积明细不被领取旧快照覆盖（旧 bug 会只剩 percent=100、明细丢失）。
    expect(prog.items).toEqual([{ id: 'seg-1' }, { id: 'seg-2' }, { id: 'seg-3' }]);
    expect(prog.done).toBe(3);
    expect(prog.total).toBe(3);
    expect(prog.unit).toBe('段');
    // 子任务保留且全标 done（completed 拉满语义）。
    expect(prog.subtasks.map((s) => s.key)).toEqual(['fetch', 'segment']);
    expect(prog.subtasks.every((s) => s.status === 'done')).toBe(true);
  });

  it('item-appended 帧 payload 契约形态 = { item }（Codex P0-1），progress.items 仍存裸 item', async () => {
    const { db, bridge, map } = setup([makeJob('j1')]);
    const candidate = { id: 'cand-1', status: 'ready', name: '港险资格打分器', isNew: true };
    const h = handler('extract', async (_job, ctx) => {
      await ctx.appendItem(candidate);
      return null;
    });
    await runJob(db, bridge as unknown as JobEventBridge, h, 'j1', {
      leaseOwner: 'w1',
      traceId: 't1',
    });
    const frame = bridge.published.find((p) => p.event === 'item-appended')!;
    expect(frame).toBeTruthy();
    // 契约：SSE item-appended payload 恒为 { item: CandidateItem }，前端按 data.item 分发（30 §3.1/§3.4）。
    const payload = frame.payload as { item?: typeof candidate };
    expect(payload.item).toEqual(candidate);
    // 反向破坏：若推裸 item（payload 直接是 item），前端取 data.item 会 undefined → 收不到候选（B-22/B-23 断）。
    //   守门：payload 不是裸 item（payload.id 不存在，必须经 payload.item.id 才取得到）。
    expect((payload as { id?: string }).id).toBeUndefined();
    expect(payload.item!.id).toBe('cand-1');
    // progress.items 仍存【裸 item】（state_snapshot.progress.items[] 直接是 CandidateItem 列表，30 §3.2）。
    const persistedItems = (map.get('j1')!.progress as { items?: unknown[] }).items;
    expect(persistedItems).toEqual([candidate]);
  });

  it('percent 单调护栏：report 60 后再 report 30，持久化仍是 60（不倒退，脊柱 §7）', async () => {
    const { db, bridge } = setup([makeJob('j1')]);
    const h = handler('import', async (_job, ctx) => {
      await ctx.reportProgress({ percent: 60, phrase: 'a' });
      await ctx.reportProgress({ percent: 30, phrase: 'b' });
      return null;
    });
    await runJob(db, bridge as unknown as JobEventBridge, h, 'j1', {
      leaseOwner: 'w1',
      traceId: 't',
    });
    // 完成会拉满到 100；取完成前最后一次 progress 帧（percent=60，非 30）。
    const progressFrames = bridge.published.filter((p) => p.event === 'progress');
    expect((progressFrames.at(-1)?.payload as { percent: number }).percent).toBe(60);
  });
});

describe('not_claimed（脊柱 §6.2：活跃租约持有时抢不到）', () => {
  it('lease 未过期 → not_claimed，不执行 handler', async () => {
    const { db, bridge } = setup([
      makeJob('j1', { status: 'running', lease_until: 999_999, fence_token: 1 }),
    ]);
    let ran = false;
    const h = handler('import', async () => {
      ran = true;
      return null;
    });
    const outcome = await runJob(db, bridge as unknown as JobEventBridge, h, 'j1', {
      leaseOwner: 'w2',
      traceId: 't',
    });
    expect(outcome.kind).toBe('not_claimed');
    expect(ran).toBe(false);
  });
});

describe('超时被 sweeper 接管不双写（B-16 + §11.A 铁律）', () => {
  it('runner-A 执行中被 sweeper 换 fence；A 完成时落 completed → 0 行（fenced_out），不覆盖新 attempt', async () => {
    const { db, bridge, clock, map } = setup([makeJob('j1')], 1_000);
    // handler-A：报一次进度后“卡住”（我们在中途模拟 sweeper 接管），再尝试完成。
    const h = handler('import', async (_job, ctx) => {
      await ctx.reportProgress({ percent: 20, phrase: 'A 干了一半' });
      // 模拟 A 卡住、lease 过期 → sweeper reclaimExpired 换 fence（attempt+1）。
      clock.now = 1_000 + 40_000; // 越过 lease_until（claim 时 now+30s）
      await reclaimExpired(db, 50); // sweeper 换 fence：j1.fence_token 1→2
      // A 继续“干完”并尝试完成（持旧 fence=1）→ runner completeJob 应 0 行 → fenced_out。
      return { snapshotId: 'A-result' };
    });
    const outcome = await runJob(db, bridge as unknown as JobEventBridge, h, 'j1', {
      leaseOwner: 'A',
      traceId: 'tA',
    });
    expect(outcome.kind).toBe('fenced_out'); // A 的完成被 fence out
    const j = map.get('j1')!;
    expect(j.status).toBe('running'); // 仍 running（等新 attempt 接管），未被 A 写 completed
    expect(j.fence_token).toBe(2); // sweeper 换发的新 fence
    expect(j.result).toBeNull(); // A 的结果未污染
    // A 报过的进度（percent=20）保留（已生成不丢，硬规则③）。
    expect((j.progress as { percent: number }).percent).toBe(20);
    // Codex P1-4：接管（status 仍 running）≠ 取消 → 绝不发 done(cancelled)，否则前端误判取消关流。
    const doneFrame = bridge.published.find((p) => p.event === 'done');
    expect(doneFrame).toBeUndefined();
  });

  it('接管后 runner-B 用新 fence 领租约并正常完成', async () => {
    const { db, bridge, map } = setup(
      [
        makeJob('j1', {
          status: 'running',
          lease_owner: 'w-dead', // worker 持租后死/卡 → reclaimExpired 接管
          lease_until: 500,
          fence_token: 1,
          progress: { percent: 20, phrase: 'x', subtasks: [] },
        }),
      ],
      1_000,
    );
    // sweeper 先换 fence（1→2）。
    await reclaimExpired(db, 50);
    expect(map.get('j1')?.fence_token).toBe(2);
    const h = handler('import', async (job) => {
      // B 应从已落进度（percent=20）断点续传（已生成不丢）。
      expect(job.progress.percent).toBe(20);
      return { snapshotId: 'B-result' };
    });
    const outcome = await runJob(db, bridge as unknown as JobEventBridge, h, 'j1', {
      leaseOwner: 'B',
      traceId: 'tB',
    });
    expect(outcome.kind).toBe('completed');
    expect(map.get('j1')?.result).toEqual({ snapshotId: 'B-result' });
  });
});

describe('取消中途安全退出（B-11：已生成保留）', () => {
  it('handler 中途 ctx.reportProgress 在被取消后 → FencedOutError → fenced_out，已生成保留', async () => {
    const { db, bridge, map } = setup([makeJob('j1')], 1_000);
    const h = handler('import', async (_job, ctx) => {
      await ctx.reportProgress({ percent: 30, phrase: '干了 30%' });
      // 外部取消（标 cancelled + 换 fence）。
      map.get('j1')!.status = 'cancelled';
      map.get('j1')!.fence_token += 1;
      // 取消后再报进度 → persistProgress 0 行 → 抛 FencedOutError。
      await ctx.reportProgress({ percent: 60, phrase: '继续' });
      return { never: true };
    });
    const outcome = await runJob(db, bridge as unknown as JobEventBridge, h, 'j1', {
      leaseOwner: 'w1',
      traceId: 't',
    });
    expect(outcome.kind).toBe('fenced_out');
    const j = map.get('j1')!;
    expect(j.status).toBe('cancelled'); // 取消态保留
    expect((j.progress as { percent: number }).percent).toBe(30); // 取消前已生成的 30% 保留
    expect(j.result).toBeNull(); // 未写结果
    // Codex P1-4：真取消（status='cancelled'）→ 发 done(cancelled) 终态，前端据此关流。
    const doneFrame = bridge.published.find((p) => p.event === 'done');
    expect((doneFrame?.payload as { status: string }).status).toBe('cancelled');
  });

  it('Codex P1-4 区分：fence-out 后 status=running（重入队接管）→ 不发任何终态帧（连接续流不误判取消）', async () => {
    const { db, bridge, map } = setup([makeJob('j1')], 1_000);
    const h = handler('import', async (_job, ctx) => {
      await ctx.reportProgress({ percent: 40, phrase: '干到 40%' });
      // 模拟 sweeper 重入队接管：换 fence，但 status 仍 running（新 attempt 将接手）。
      map.get('j1')!.fence_token += 1;
      // 接管后再报进度 → persistProgress 0 行 → FencedOutError。
      await ctx.reportProgress({ percent: 70, phrase: '继续' });
      return { never: true };
    });
    const outcome = await runJob(db, bridge as unknown as JobEventBridge, h, 'j1', {
      leaseOwner: 'A',
      traceId: 't',
    });
    expect(outcome.kind).toBe('fenced_out');
    expect(map.get('j1')!.status).toBe('running'); // 仍 running = 接管，不是取消
    // 关键：不发 done（既不是 cancelled、也不是 completed/failed）→ 在线连接保持、等新 attempt 续推。
    expect(bridge.published.find((p) => p.event === 'done')).toBeUndefined();
    // 已生成的 40% 保留（硬规则③）。
    expect((map.get('j1')!.progress as { percent: number }).percent).toBe(40);
  });
});

describe('handler 失败归一（绝不裸露错误码，脊柱 §3/§11.B）', () => {
  it('handler 抛通用错误 → failed + 人话 ErrorBody（无 code）+ error/done 帧', async () => {
    const { db, bridge, map } = setup([makeJob('j1')]);
    const h: JobHandler = {
      type: 'import',
      run: async () => {
        throw new Error('ECONNREFUSED 127.0.0.1:5432'); // 原始报错
      },
    };
    const outcome = await runJob(db, bridge as unknown as JobEventBridge, h, 'j1', {
      leaseOwner: 'w1',
      traceId: 't',
    });
    expect(outcome.kind).toBe('failed');
    const j = map.get('j1')!;
    expect(j.status).toBe('failed');
    const err = j.error as Record<string, unknown>;
    // 对外 error 不含 code/堆栈/原始报错；只人话 + action + retriable + traceId。
    expect(err).not.toHaveProperty('code');
    expect(typeof err.userMessage).toBe('string');
    expect(err.userMessage).not.toContain('ECONNREFUSED');
    // error 帧 = 完整 ErrorEnvelope（{ error: {...} }）。
    const errFrame = bridge.published.find((p) => p.event === 'error');
    expect((errFrame?.payload as { error: unknown }).error).toBeDefined();
    const doneFrame = bridge.published.find((p) => p.event === 'done');
    expect((doneFrame?.payload as { status: string }).status).toBe('failed');
  });

  it('handler 抛 { code } → 用该分类（如 JOB_TIMEOUT）', () => {
    const { body } = normalizeToErrorBody({ code: ErrorCode.JOB_TIMEOUT }, 't');
    expect(body.action).toBe('retry');
    expect(body).not.toHaveProperty('code');
  });
});

describe('FencedOutError', () => {
  it('是 Error 子类、name 正确', () => {
    const e = new FencedOutError();
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('FencedOutError');
  });
});

describe('job 失败的【服务端内部日志】（排障可见性：内部 code+堆栈落 stdout/stderr，绝不外泄客户端）', () => {
  it('handler 抛错 → logger.error 被调用且含内部 code + 原始 err(带 stack) + jobId/jobType/attempt/fenceToken/traceId', async () => {
    const { db, bridge } = setup([makeJob('j1', { type: 'extract' })]);
    const { logger, calls } = makeFakeLogger();
    const raw = new Error('ECONNREFUSED 127.0.0.1:5432'); // 原始报错（含 stack）
    const h: JobHandler = {
      type: 'extract',
      run: async () => {
        throw raw;
      },
    };
    const outcome = await runJob(
      db,
      bridge as unknown as JobEventBridge,
      h,
      'j1',
      { leaseOwner: 'w1', traceId: 'trace-xyz' },
      logger,
    );
    expect(outcome.kind).toBe('failed');

    // 关键断言：失败时 logger.error 被调用，msg='job failed'。
    const failLog = calls.find((c) => c.level === 'error' && c.msg === 'job failed');
    expect(failLog).toBeTruthy();
    // 内部 code（如 INTERNAL）必须落内部日志（便于排障），但绝不进对外响应（对外 ErrorBody 无 code，见上一组测试）。
    expect(failLog!.obj.code).toBe(ErrorCode.INTERNAL);
    // 原始错误对象（pino err 序列化器据此落 message + stack）原样传入，不被人话归一吞掉。
    expect(failLog!.obj.err).toBe(raw);
    // 结构化定位字段：claimLease 后 child 绑定的 jobId/jobType/attempt/fenceToken/traceId/leaseOwner。
    expect(failLog!.bindings.jobId).toBe('j1');
    expect(failLog!.bindings.jobType).toBe('extract');
    expect(failLog!.bindings.traceId).toBe('trace-xyz');
    expect(failLog!.bindings.leaseOwner).toBe('w1');
    // attempt：claimLease 把 queued(attempt_no=0) 递增到 1；fenceToken 同步到 1。
    expect(failLog!.bindings.attempt).toBe(1);
    expect(failLog!.bindings.fenceToken).toBe(1);
  });

  it('失败内部日志不泄漏给客户端：error/done 帧 payload 不含 code/stack（对外只人话 ErrorBody）', async () => {
    const { db, bridge } = setup([makeJob('j1')]);
    const { logger } = makeFakeLogger();
    const h: JobHandler = {
      type: 'import',
      run: async () => {
        throw new Error('ECONNREFUSED 127.0.0.1:5432\n  at db.connect (pg.js:42)');
      },
    };
    await runJob(
      db,
      bridge as unknown as JobEventBridge,
      h,
      'j1',
      { leaseOwner: 'w1', traceId: 't' },
      logger,
    );
    // 对外帧（error/done）只带归一人话 ErrorBody：无 code、无原始报错、无堆栈。
    const errFrame = bridge.published.find((p) => p.event === 'error');
    const body = (errFrame!.payload as { error: Record<string, unknown> }).error;
    expect(body).not.toHaveProperty('code');
    expect(JSON.stringify(errFrame!.payload)).not.toContain('ECONNREFUSED');
    expect(JSON.stringify(errFrame!.payload)).not.toContain('pg.js:42');
  });

  it('不传 logger 时不崩（log?.* 全 no-op）——但那样 docker logs 看不到内部失败，正是本次修复的痛点', async () => {
    const { db, bridge } = setup([makeJob('j1')]);
    const h: JobHandler = {
      type: 'import',
      run: async () => {
        throw new Error('boom');
      },
    };
    // 不传第 6 个参数 logger：runner 内 log 为 undefined，不应抛。
    const outcome = await runJob(db, bridge as unknown as JobEventBridge, h, 'j1', {
      leaseOwner: 'w1',
      traceId: 't',
    });
    expect(outcome.kind).toBe('failed');
  });
});

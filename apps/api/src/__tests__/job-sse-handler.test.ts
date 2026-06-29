// B-12 job SSE handler 自检（脊柱 §5.2/§5.4/§11.C）：
//   建流前 owner 校验（404/403 HTTP，不走 error 帧）+ 连接即 state_snapshot（从 jobs.progress 重建）+ Last-Event-ID 恢复。
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { jobSseHandler } from '../routes/_sse.js';
import { FakeDb, makeJob, type FakeClock, type FakeJob } from './jobs-fence.js';

function makeRaw() {
  const writes: string[] = [];
  return {
    writes,
    writableEnded: false,
    writeHead: vi.fn(),
    write: vi.fn((chunk: string) => {
      writes.push(chunk);
      return true;
    }),
    end: vi.fn(function (this: { writableEnded: boolean }) {
      this.writableEnded = true;
    }),
  };
}

/**
 * 假 redisHot：replaySince 用到 xinfo/xrange；latestId 用 xrevrange；subscribe 用 duplicate+xread（Codex P0-1）。
 *   默认空流（→ 超窗 → snapshot 重置）。subscribeFrames：建流后由订阅持续“到达”的帧（按序一次性吐出，然后空读）。
 */
function makeHot(
  entries: Array<[string, string[]]> = [],
  subscribeFrames: Array<[string, string[]]> = [],
) {
  let drained = false;
  const conn = {
    xread: async (...args: unknown[]) => {
      // args: 'BLOCK', ms, 'STREAMS', key, lastId
      const key = args[3] as string;
      if (drained || subscribeFrames.length === 0) return null; // BLOCK 超时无新帧
      drained = true;
      return [[key, subscribeFrames]];
    },
    disconnect: () => undefined,
  };
  return {
    xinfo: async () => {
      if (entries.length === 0) throw new Error('no key');
      return ['length', entries.length, 'first-entry', entries[0]];
    },
    xrange: async (_k: string, start: string) => {
      const exclusive = start.startsWith('(');
      const startId = exclusive ? start.slice(1) : start;
      return entries.filter(([id]) => (exclusive ? id > startId : id >= startId));
    },
    xrevrange: async () => (entries.length ? [entries[entries.length - 1]] : []),
    duplicate: () => conn,
  };
}

function makeReqReply(opts: {
  jobId: string;
  userId?: string;
  db: FakeDb;
  hot: unknown;
  lastEventId?: string;
}) {
  const raw = makeRaw();
  const reqRaw = new EventEmitter();
  const sent: { code: number; body: unknown } = { code: 0, body: undefined };
  const reply = {
    raw,
    hijack: vi.fn(),
    code(c: number) {
      sent.code = c;
      return this;
    },
    send(b: unknown) {
      sent.body = b;
      return this;
    },
  };
  const headers: Record<string, string> = {};
  if (opts.lastEventId) headers['last-event-id'] = opts.lastEventId;
  const req = {
    id: 'trace-1',
    params: { jobId: opts.jobId },
    auth: opts.userId ? { userId: opts.userId } : undefined,
    headers,
    raw: reqRaw,
    server: { infra: { db: opts.db, redisHot: opts.hot } },
  };
  return { req, reply, raw, sent, reqRaw };
}

function setup(jobs: FakeJob[]): { db: FakeDb; map: Map<string, FakeJob> } {
  const map = new Map(jobs.map((j) => [j.id, j]));
  const clock: FakeClock = { now: 1_000 };
  return { db: new FakeDb(map, clock), map };
}

describe('jobSseHandler 建流前 owner 校验（脊柱 §11.C）', () => {
  it('job 不存在 → 404 HTTP（不建流、不发 error 帧）', async () => {
    const { db } = setup([]);
    const { req, reply, sent, raw } = makeReqReply({
      jobId: 'none',
      userId: 'u1',
      db,
      hot: makeHot(),
    });
    await jobSseHandler().call(undefined as never, req as never, reply as never);
    expect(sent.code).toBe(404);
    expect(raw.writeHead).not.toHaveBeenCalled(); // 未建流
  });

  it('非 owner → 403 HTTP', async () => {
    const { db } = setup([makeJob('j1', { owner_user_id: 'u1' })]);
    const { req, reply, sent, raw } = makeReqReply({
      jobId: 'j1',
      userId: 'attacker',
      db,
      hot: makeHot(),
    });
    await jobSseHandler().call(undefined as never, req as never, reply as never);
    expect(sent.code).toBe(403);
    expect(raw.writeHead).not.toHaveBeenCalled();
  });
});

describe('jobSseHandler 连接即 state_snapshot（从 jobs.progress 重建，脊柱 §5.2）', () => {
  it('owner 命中、无 Last-Event-ID → 写 SSE 头 + 首帧 state_snapshot(kind=job, 重建 progress)', async () => {
    const { db } = setup([
      makeJob('j1', {
        owner_user_id: 'u1',
        progress: {
          percent: 42,
          phrase: '已抓取 90/215 段',
          subtasks: [{ key: 'fetch_index', label: '拉取会话索引', status: 'running' }],
        },
      }),
    ]);
    const { req, reply, raw } = makeReqReply({ jobId: 'j1', userId: 'u1', db, hot: makeHot() });
    await jobSseHandler().call(undefined as never, req as never, reply as never);
    expect(raw.writeHead).toHaveBeenCalledWith(
      200,
      expect.objectContaining({ 'Content-Type': 'text/event-stream' }),
    );
    const out = raw.writes.join('');
    expect(out).toContain('event: state_snapshot');
    expect(out).toContain('"kind":"job"');
    expect(out).toContain('"percent":42'); // 从 jobs.progress 重建（断点续传基座）
    expect(out).toContain('拉取会话索引');
    reqRawClose(req);
  });

  it('retry 新流首帧 state_snapshot 含该候选 generating 态（progress.items 注入，永不裸转圈，Codex r2#4）', async () => {
    // 受理重试时 retry job 初始 progress.items 已注入 { id, status:'generating', isNew:false, name }（见 createRetryJob）。
    const { db } = setup([
      makeJob('retry-j', {
        owner_user_id: 'u1',
        status: 'queued',
        progress: {
          percent: 0,
          phrase: '正在准备提取…',
          subtasks: [],
          items: [{ id: 'cand-42', status: 'generating', isNew: false, name: '港险资格打分器' }],
        },
      }),
    ]);
    const { req, reply, raw } = makeReqReply({
      jobId: 'retry-j',
      userId: 'u1',
      db,
      hot: makeHot(),
    });
    await jobSseHandler().call(undefined as never, req as never, reply as never);
    const out = raw.writes.join('');
    expect(out).toContain('event: state_snapshot');
    // 首帧即含该候选在生成（前端连上就有「重试中」的项，对位靠 item.id == candidateId）。
    expect(out).toContain('"id":"cand-42"');
    expect(out).toContain('"status":"generating"');
    expect(out).toContain('港险资格打分器');
    expect(out).not.toContain('event: done'); // queued 非终态，流保持开放等回填
    reqRawClose(req);
  });

  it('progress 为 {} → snapshot 仍给合法 ProgressView（永不裸转圈：0% + 空子任务）', async () => {
    const { db } = setup([makeJob('j1', { owner_user_id: 'u1', progress: {} })]);
    const { req, reply, raw } = makeReqReply({ jobId: 'j1', userId: 'u1', db, hot: makeHot() });
    await jobSseHandler().call(undefined as never, req as never, reply as never);
    const out = raw.writes.join('');
    expect(out).toContain('event: state_snapshot');
    expect(out).toContain('"percent":0');
    expect(out).toContain('"subtasks":[]');
    reqRawClose(req);
  });
});

describe('jobSseHandler Last-Event-ID 恢复（脊柱 §5.4）', () => {
  it('窗口内 → 补发增量帧、不重推 snapshot', async () => {
    const { db } = setup([
      makeJob('j1', { owner_user_id: 'u1', progress: { percent: 50, phrase: 'x', subtasks: [] } }),
    ]);
    const hot = makeHot([
      ['1000-0', ['event', 'progress', 'data', JSON.stringify({ percent: 50 })]],
      ['1001-0', ['event', 'progress', 'data', JSON.stringify({ percent: 70 })]],
    ]);
    const { req, reply, raw } = makeReqReply({
      jobId: 'j1',
      userId: 'u1',
      db,
      hot,
      lastEventId: '1000-0',
    });
    await jobSseHandler().call(undefined as never, req as never, reply as never);
    const out = raw.writes.join('');
    // 窗口内续传：推 1001-0 增量，不重推 snapshot。
    expect(out).toContain('id: 1001-0');
    expect(out).toContain('"percent":70');
    expect(out).not.toContain('event: state_snapshot');
    reqRawClose(req);
  });

  it('超窗（lastEventId 早于流最早条目）→ 回落 state_snapshot 重置', async () => {
    const { db } = setup([
      makeJob('j1', { owner_user_id: 'u1', progress: { percent: 95, phrase: 'x', subtasks: [] } }),
    ]);
    const hot = makeHot([
      ['5000-0', ['event', 'progress', 'data', JSON.stringify({ percent: 95 })]],
    ]);
    const { req, reply, raw } = makeReqReply({
      jobId: 'j1',
      userId: 'u1',
      db,
      hot,
      lastEventId: '1-0',
    });
    await jobSseHandler().call(undefined as never, req as never, reply as never);
    const out = raw.writes.join('');
    expect(out).toContain('event: state_snapshot'); // 超窗 → snapshot 重置
    expect(out).toContain('"percent":95');
    reqRawClose(req);
  });
});

describe('jobSseHandler 持续订阅 Redis Stream（Codex P0-1：worker 后续帧实时下发）', () => {
  it('建流后订阅 events:job:{jobId}，把后续 progress/done 帧 push 给在线连接，done 终态后关流', async () => {
    const { db } = setup([
      makeJob('j1', { owner_user_id: 'u1', progress: { percent: 0, phrase: 'x', subtasks: [] } }),
    ]);
    // 建流后，worker 后续推来的帧（由假 xread 一次性吐出）。
    const hot = makeHot(
      [], // 无 Last-Event-ID、空历史 → 走 snapshot 路径，latestId='0-0'
      [
        ['2000-0', ['event', 'progress', 'data', JSON.stringify({ percent: 55 })]],
        ['2001-0', ['event', 'done', 'data', JSON.stringify({ status: 'completed' })]],
      ],
    );
    const { req, reply, raw } = makeReqReply({ jobId: 'j1', userId: 'u1', db, hot });
    await jobSseHandler().call(undefined as never, req as never, reply as never);
    // 等订阅微任务循环把帧 push 出去（subscribe 是 fire-and-forget，需让出事件循环）。
    await waitFor(() => raw.writes.join('').includes('event: done'));
    const out = raw.writes.join('');
    // 首帧 snapshot（连接即下发）。
    expect(out).toContain('event: state_snapshot');
    // 持续订阅 push 的后续业务帧。
    expect(out).toContain('id: 2000-0');
    expect(out).toContain('"percent":55');
    expect(out).toContain('event: done');
    expect(out).toContain('"status":"completed"');
    // done 终态 → 服务端关流（不再裸挂）。
    expect(raw.end).toHaveBeenCalled();
  });
});

describe('jobSseHandler 建流瞬间 job 已终态（Codex P0-1：补终态帧关流，不留只剩心跳的悬挂连接）', () => {
  it('completed → snapshot 后补 done(completed,result) 并关流', async () => {
    const { db } = setup([
      makeJob('j1', {
        owner_user_id: 'u1',
        status: 'completed',
        progress: { percent: 100, phrase: '完成', subtasks: [] },
        result: { ok: true },
      }),
    ]);
    const { req, reply, raw } = makeReqReply({ jobId: 'j1', userId: 'u1', db, hot: makeHot() });
    await jobSseHandler().call(undefined as never, req as never, reply as never);
    const out = raw.writes.join('');
    expect(out).toContain('event: state_snapshot');
    expect(out).toContain('event: done');
    expect(out).toContain('"status":"completed"');
    expect(out).toContain('"ok":true');
    // done 终态 → 服务端关流（不再裸挂只剩心跳）。
    expect(raw.end).toHaveBeenCalled();
  });

  it('failed → 先 error(ErrorEnvelope) 再 done(failed,error) 并关流', async () => {
    const { db } = setup([
      makeJob('j1', {
        owner_user_id: 'u1',
        status: 'failed',
        progress: { percent: 30, phrase: 'x', subtasks: [] },
        error: { userMessage: '导入失败了', retriable: true, action: 'retry', traceId: 't1' },
      }),
    ]);
    const { req, reply, raw } = makeReqReply({ jobId: 'j1', userId: 'u1', db, hot: makeHot() });
    await jobSseHandler().call(undefined as never, req as never, reply as never);
    const out = raw.writes.join('');
    expect(out).toContain('event: error');
    expect(out).toContain('导入失败了');
    expect(out).toContain('event: done');
    expect(out).toContain('"status":"failed"');
    // error 帧在 done 帧之前（失败先 error 后 done，脊柱 §5.3）。
    expect(out.indexOf('event: error')).toBeLessThan(out.indexOf('event: done'));
    expect(raw.end).toHaveBeenCalled();
  });

  it('cancelled → 补 done(cancelled) 并关流', async () => {
    const { db } = setup([
      makeJob('j1', {
        owner_user_id: 'u1',
        status: 'cancelled',
        progress: { percent: 10, phrase: 'x', subtasks: [] },
      }),
    ]);
    const { req, reply, raw } = makeReqReply({ jobId: 'j1', userId: 'u1', db, hot: makeHot() });
    await jobSseHandler().call(undefined as never, req as never, reply as never);
    const out = raw.writes.join('');
    expect(out).toContain('event: done');
    expect(out).toContain('"status":"cancelled"');
    expect(raw.end).toHaveBeenCalled();
  });

  it('running（非终态）→ 不补终态帧、流保持开放（建流不关，等订阅续流）', async () => {
    const { db } = setup([
      makeJob('j1', {
        owner_user_id: 'u1',
        status: 'running',
        progress: { percent: 40, phrase: 'x', subtasks: [] },
      }),
    ]);
    const { req, reply, raw } = makeReqReply({ jobId: 'j1', userId: 'u1', db, hot: makeHot() });
    await jobSseHandler().call(undefined as never, req as never, reply as never);
    const out = raw.writes.join('');
    expect(out).toContain('event: state_snapshot');
    expect(out).not.toContain('event: done');
    expect(raw.end).not.toHaveBeenCalled(); // 流保持开放
    reqRawClose(req);
  });
});

describe('jobSseHandler 终态恰好一次 done（Codex P0-1 集中编排：三路径各发一次、无双 done、无悬挂）', () => {
  /** 统计输出里 `event: done` 出现次数（双 done 回归守门）。 */
  function countDone(out: string): number {
    return out.split('event: done').length - 1;
  }

  it('路径① Last-Event-ID 窗口内 replay 命中终态 done → 仅发一次 done、不重订阅、不补帧', async () => {
    // 建流瞬间 DB 已 completed；redis 窗口内 replay 回放到终态 done（这是会重复 done 的旧 bug 场景）。
    const { db } = setup([
      makeJob('j1', {
        owner_user_id: 'u1',
        status: 'completed',
        progress: { percent: 100, phrase: '完成', subtasks: [] },
        result: { ok: true },
      }),
    ]);
    // 窗口内（lastEventId=3000-0 命中流首条之后）replay 出 progress + 终态 done。
    const hot = makeHot([
      ['3000-0', ['event', 'progress', 'data', JSON.stringify({ percent: 100 })]],
      ['3001-0', ['event', 'done', 'data', JSON.stringify({ status: 'completed' })]],
    ]);
    const { req, reply, raw } = makeReqReply({
      jobId: 'j1',
      userId: 'u1',
      db,
      hot,
      lastEventId: '3000-0',
    });
    await jobSseHandler().call(undefined as never, req as never, reply as never);
    const out = raw.writes.join('');
    // 窗口内续传：不重推 snapshot；replay 到 done 即关流。
    expect(out).not.toContain('event: state_snapshot');
    expect(out).toContain('id: 3001-0');
    expect(countDone(out)).toBe(1); // 恰好一次 done（无 route 补的第二个 done）
    expect(raw.end).toHaveBeenCalled();
  });

  it('路径② snapshot 阶段 DB 已终态（无窗口）→ snapshot 后仅补一次 done、关流、不订阅', async () => {
    const { db } = setup([
      makeJob('j1', {
        owner_user_id: 'u1',
        status: 'completed',
        progress: { percent: 100, phrase: '完成', subtasks: [] },
        result: { ok: true },
      }),
    ]);
    // 订阅源里即便有“迟到的” done，也不应被读到（终态路径不启动 subscribe）。
    const hot = makeHot(
      [],
      [['9000-0', ['event', 'done', 'data', JSON.stringify({ status: 'completed' })]]],
    );
    const { req, reply, raw } = makeReqReply({ jobId: 'j1', userId: 'u1', db, hot });
    await jobSseHandler().call(undefined as never, req as never, reply as never);
    // 等一拍：若错误地启动了 subscribe，迟到 done 会被 push 进来（这正是要排除的双 done）。
    await new Promise((r) => setTimeout(r, 10));
    const out = raw.writes.join('');
    expect(out).toContain('event: state_snapshot');
    expect(countDone(out)).toBe(1); // 仅 terminalFrames 补的那一个；subscribe 未启动
    expect(out).not.toContain('id: 9000-0'); // 终态路径不订阅，迟到帧不混入
    expect(raw.end).toHaveBeenCalled();
  });

  it('路径③ running 在线收终态 done（subscribe）→ 仅发一次 done、关流', async () => {
    const { db } = setup([
      makeJob('j1', {
        owner_user_id: 'u1',
        status: 'running',
        progress: { percent: 50, phrase: 'x', subtasks: [] },
      }),
    ]);
    const hot = makeHot(
      [],
      [
        ['4000-0', ['event', 'progress', 'data', JSON.stringify({ percent: 80 })]],
        ['4001-0', ['event', 'done', 'data', JSON.stringify({ status: 'completed' })]],
      ],
    );
    const { req, reply, raw } = makeReqReply({ jobId: 'j1', userId: 'u1', db, hot });
    await jobSseHandler().call(undefined as never, req as never, reply as never);
    await waitFor(() => raw.writes.join('').includes('event: done'));
    const out = raw.writes.join('');
    expect(out).toContain('event: state_snapshot');
    expect(out).toContain('id: 4001-0');
    expect(countDone(out)).toBe(1); // 在线 done 一次
    expect(raw.end).toHaveBeenCalled();
  });
});

describe('jobSseHandler 时序消除 TOCTOU（Codex P0-1：先取 latestId 锚点、再读 snapshot/status）', () => {
  it('snapshot 取数在 latestId 之后：latestId 之后 XADD 的帧由订阅捕获，不漏中间帧', async () => {
    // 建流前流里已有一条历史 latestId=1500-0（latestId 锚点）；snapshot 在其后读。
    const hot = makeHot(
      [['1500-0', ['event', 'progress', 'data', JSON.stringify({ percent: 50 })]]], // 历史 → latestId=1500-0
      [
        // latestId 之后 worker XADD 的中间帧 + 终态 done：必须由订阅从 1500-0 之后捕获，不漏。
        ['1600-0', ['event', 'progress', 'data', JSON.stringify({ percent: 80 })]],
        ['1700-0', ['event', 'done', 'data', JSON.stringify({ status: 'completed' })]],
      ],
    );
    const { db } = setup([
      makeJob('j1', {
        owner_user_id: 'u1',
        status: 'running', // 建流瞬间仍 running（snapshot 不早于 latestId 锚点）
        progress: { percent: 50, phrase: 'x', subtasks: [] },
      }),
    ]);
    // 断言取数顺序：latestId（xrevrange）必须在 snapshot SELECT（status,progress,result,error）之前。
    const order: string[] = [];
    const origXrev = hot.xrevrange.bind(hot);
    hot.xrevrange = async () => {
      order.push('latestId');
      return origXrev();
    };
    const origQuery = db.query.bind(db);
    // @ts-expect-error 测试夹具：包裹 query 记录 snapshot 取数顺序。
    db.query = async (sql: string, params?: unknown[]) => {
      if (sql.includes('SELECT status, progress, result, error FROM jobs')) order.push('snapshot');
      return origQuery(sql, params ?? []);
    };
    const { req, reply, raw } = makeReqReply({ jobId: 'j1', userId: 'u1', db, hot });
    await jobSseHandler().call(undefined as never, req as never, reply as never);
    await waitFor(() => raw.writes.join('').includes('event: done'));
    const out = raw.writes.join('');
    // latestId 锚点先于 snapshot 取数（TOCTOU 消除：snapshot 不早于锚点）。
    expect(order.indexOf('latestId')).toBeLessThan(order.indexOf('snapshot'));
    // latestId 之后的中间帧 + done 都由订阅捕获，不漏。
    expect(out).toContain('id: 1600-0');
    expect(out).toContain('"percent":80');
    expect(out).toContain('event: done');
    expect(raw.end).toHaveBeenCalled();
  });
});

/** 轮询等待条件成立（订阅 push 是异步微任务，最多等约 1s）。 */
async function waitFor(cond: () => boolean, timeoutMs = 1_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** 触发客户端断开清理（避免心跳 timer 泄漏到下个测试）。 */
function reqRawClose(req: { raw: EventEmitter }): void {
  req.raw.emit('close');
}

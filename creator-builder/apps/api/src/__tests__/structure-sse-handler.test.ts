// 结构化 SSE handler 真流自检（40 §3/§4.D，Codex P0-1）：
//   建流前 owner 校验（404/403 HTTP，不走 error 帧）+ 连接即 state_snapshot（从 structure_state 重建，
//   含 done/generating/stuck/failed + attempts）+ Last-Event-ID 补发 + live subscribe（映射 active job 流）+
//   具名 heartbeat（startSseStream 内）+ 统一终态闸（非 running 不 subscribe、终态补 done 关流）。
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { structureSseHandler, STRUCTURE_ACTIVATION_POLL_MS } from '../routes/_sse.js';
import type { Queryable, QueryResultLike } from '../jobs/types.js';

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

/** 假 redisHot：同 job-sse 测的口径（latestId/replaySince/subscribe）。 */
function makeHot(
  entries: Array<[string, string[]]> = [],
  subscribeFrames: Array<[string, string[]]> = [],
) {
  let drained = false;
  const conn = {
    xread: async (...args: unknown[]) => {
      const key = args[3] as string;
      if (drained || subscribeFrames.length === 0) return null;
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

interface SseFakeOpts {
  /** version → { creatorUserId, structureState } */
  versions?: Record<string, { creatorUserId: string; structureState: unknown }>;
  /** 该 version 的 active/历史 structure job（最近一条）。 */
  job?: { versionId: string; ownerUserId: string; id: string; status: string };
}

/** 忠实假 PG：仅实现 structureSseHandler 用到的三条 SQL。 */
class SseFakeDb implements Queryable {
  constructor(private readonly opts: SseFakeOpts) {}
  async query<R = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<QueryResultLike<R>> {
    // 1) owner 校验：SELECT c.creator_user_id ... FROM capability_versions v JOIN capabilities c WHERE v.id=$1
    if (
      sql.includes('creator_user_id') &&
      sql.includes('FROM capability_versions v') &&
      sql.includes('JOIN capabilities c') &&
      !sql.includes('structure_state')
    ) {
      const v = this.opts.versions?.[params[0] as string];
      return {
        rows: v ? ([{ creator_user_id: v.creatorUserId }] as R[]) : [],
        rowCount: v ? 1 : 0,
      };
    }
    // 2) active job 映射：SELECT id, status FROM jobs WHERE type='structure' AND owner_user_id=$2 AND subject_ref->>'versionId'=$1 ...
    if (sql.includes('FROM jobs') && sql.includes("subject_ref->>'versionId'")) {
      const versionId = params[0] as string;
      const owner = params[1] as string;
      const j = this.opts.job;
      const match = j && j.versionId === versionId && j.ownerUserId === owner;
      return {
        rows: match ? ([{ id: j!.id, status: j!.status }] as R[]) : [],
        rowCount: match ? 1 : 0,
      };
    }
    // 3) snapshot 取数：SELECT structure_state FROM capability_versions WHERE id=$1
    if (sql.includes('SELECT structure_state FROM capability_versions WHERE id = $1')) {
      const v = this.opts.versions?.[params[0] as string];
      return {
        rows: v ? ([{ structure_state: v.structureState }] as R[]) : [],
        rowCount: v ? 1 : 0,
      };
    }
    throw new Error(`SseFakeDb: unhandled SQL: ${sql.replace(/\s+/g, ' ').slice(0, 120)}`);
  }
}

function makeReqReply(opts: {
  versionId: string;
  userId?: string;
  db: Queryable;
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
    params: { versionId: opts.versionId },
    auth: opts.userId ? { userId: opts.userId } : undefined,
    headers,
    raw: reqRaw,
    server: { infra: { db: opts.db, redisHot: opts.hot } },
  };
  return { req, reply, raw, sent, reqRaw };
}

/** 软字段混合态 structure_state（done/generating/stuck/failed + attempts；硬字段 locked）。 */
function mixedStructureState(versionId: string) {
  return {
    versionId,
    fields: [
      { field: 'name', status: 'done', value: '需求炼金师' },
      { field: 'tagline', status: 'generating' },
      { field: 'role', status: 'stuck', stuckMs: 13000 },
      {
        field: 'goal',
        status: 'failed',
        attempts: 2,
        error: {
          userMessage: '这个字段没生成出来，可重试、改输入或转人工。',
          retriable: true,
          action: 'escalate',
          traceId: 't-1',
          details: { field: 'goal', attempts: 2 },
        },
      },
      { field: 'instructions', status: 'pending' },
      { field: 'skill_set', status: 'pending', value: [] },
      { field: 'starter_prompts', status: 'pending', value: [] },
      { field: 'id', status: 'locked', value: 'cap-1' },
      { field: 'version', status: 'locked', value: '0.1.0' },
      { field: 'status', status: 'locked', value: 'draft' },
    ],
    doneCount: 1,
    totalCount: 7,
  };
}

function reqRawClose(req: { raw: EventEmitter }): void {
  req.raw.emit('close');
}
async function waitFor(cond: () => boolean, timeoutMs = 1_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/**
 * 抽取所有 `done` 帧 payload 的 status（按发出顺序）。精确守门「无合成 done failed」用——
 *   不能用裸 out.toContain('"status":"failed"')（snapshot 里软字段态本身可能含 status:failed，会误判）。
 */
function doneStatuses(out: string): string[] {
  const statuses: string[] = [];
  const lines = out.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === 'event: done') {
      const dataLine = lines[i + 1] ?? '';
      const m = /^data: (.*)$/.exec(dataLine);
      if (m) {
        try {
          const payload = JSON.parse(m[1]) as { status?: string };
          if (payload.status) statuses.push(payload.status);
        } catch {
          /* ignore malformed */
        }
      }
    }
  }
  return statuses;
}

describe('structureSseHandler 建流前 owner 校验（脊柱 §11.C）', () => {
  it('version 不存在 → 404 HTTP（不建流）', async () => {
    const db = new SseFakeDb({ versions: {} });
    const { req, reply, sent, raw } = makeReqReply({
      versionId: 'nope',
      userId: 'u1',
      db,
      hot: makeHot(),
    });
    await structureSseHandler().call(undefined as never, req as never, reply as never);
    expect(sent.code).toBe(404);
    expect(raw.writeHead).not.toHaveBeenCalled();
  });

  it('非 owner → 403 HTTP（不建流、不走 error 帧）', async () => {
    const db = new SseFakeDb({
      versions: { v1: { creatorUserId: 'owner', structureState: mixedStructureState('v1') } },
    });
    const { req, reply, sent, raw } = makeReqReply({
      versionId: 'v1',
      userId: 'attacker',
      db,
      hot: makeHot(),
    });
    await structureSseHandler().call(undefined as never, req as never, reply as never);
    expect(sent.code).toBe(403);
    expect(raw.writeHead).not.toHaveBeenCalled();
  });
});

describe('structureSseHandler 连接即 state_snapshot（从 structure_state 重建，§3.1）', () => {
  it('owner 命中、无 active job → snapshot 含各软字段 done/generating/stuck/failed + attempts + 硬字段 locked；流保持开放', async () => {
    const db = new SseFakeDb({
      versions: { v1: { creatorUserId: 'u1', structureState: mixedStructureState('v1') } },
      // 无 structure job（尚未发起）。
    });
    const { req, reply, raw } = makeReqReply({ versionId: 'v1', userId: 'u1', db, hot: makeHot() });
    await structureSseHandler().call(undefined as never, req as never, reply as never);
    expect(raw.writeHead).toHaveBeenCalledWith(
      200,
      expect.objectContaining({ 'Content-Type': 'text/event-stream' }),
    );
    const out = raw.writes.join('');
    expect(out).toContain('event: state_snapshot');
    expect(out).toContain('"kind":"structure"');
    // 各软字段态全回显（断点续传不打回从头）。
    expect(out).toContain('"status":"done"');
    expect(out).toContain('"status":"generating"');
    expect(out).toContain('"status":"stuck"');
    expect(out).toContain('"stuckMs":13000');
    expect(out).toContain('"status":"failed"');
    expect(out).toContain('"attempts":2');
    expect(out).toContain('"status":"locked"'); // 硬字段。
    // 无 active job → 不补终态、流保持开放（等用户发起结构化后重连续上）。
    expect(out).not.toContain('event: done');
    expect(raw.end).not.toHaveBeenCalled();
    reqRawClose(req);
  });
});

describe('structureSseHandler 真流：映射 active job 流 live subscribe（Codex P0-1）', () => {
  it('running active job → snapshot 后从锚点订阅 events:job:{jobId}，把 worker 字段流帧实时下发，done 终态关流', async () => {
    const db = new SseFakeDb({
      versions: { v1: { creatorUserId: 'u1', structureState: mixedStructureState('v1') } },
      job: { versionId: 'v1', ownerUserId: 'u1', id: 'sjob-1', status: 'running' },
    });
    // worker 后续推来的字段流帧（field_done / item-appended / done）由假 xread 一次性吐出。
    const hot = makeHot(
      [], // 空历史 → snapshot 路径，latestId='0-0'
      [
        [
          '100-0',
          [
            'event',
            'field_done',
            'data',
            JSON.stringify({ field: 'tagline', value: '一句话卖点' }),
          ],
        ],
        [
          '101-0',
          [
            'event',
            'item-appended',
            'data',
            JSON.stringify({ field: 'skill_set', itemIndex: 0, value: '拆需求' }),
          ],
        ],
        ['102-0', ['event', 'done', 'data', JSON.stringify({ status: 'completed' })]],
      ],
    );
    const { req, reply, raw } = makeReqReply({ versionId: 'v1', userId: 'u1', db, hot });
    await structureSseHandler().call(undefined as never, req as never, reply as never);
    await waitFor(() => raw.writes.join('').includes('event: done'));
    const out = raw.writes.join('');
    expect(out).toContain('event: state_snapshot'); // 首帧。
    // 真流：worker 字段流帧实时下发（修复前这些只写 events:job 收不到）。
    expect(out).toContain('event: field_done');
    expect(out).toContain('"field":"tagline"');
    expect(out).toContain('event: item-appended');
    expect(out).toContain('id: 102-0');
    expect(out).toContain('event: done');
    expect(raw.end).toHaveBeenCalled(); // done 终态关流。
  });

  it('Last-Event-ID 窗口内 → 从 active job 流补增量、不重推 snapshot', async () => {
    const db = new SseFakeDb({
      versions: { v1: { creatorUserId: 'u1', structureState: mixedStructureState('v1') } },
      job: { versionId: 'v1', ownerUserId: 'u1', id: 'sjob-1', status: 'running' },
    });
    const hot = makeHot([
      ['200-0', ['event', 'field_done', 'data', JSON.stringify({ field: 'name', value: 'x' })]],
      ['201-0', ['event', 'field_done', 'data', JSON.stringify({ field: 'role', value: 'y' })]],
    ]);
    const { req, reply, raw } = makeReqReply({
      versionId: 'v1',
      userId: 'u1',
      db,
      hot,
      lastEventId: '200-0',
    });
    await structureSseHandler().call(undefined as never, req as never, reply as never);
    const out = raw.writes.join('');
    expect(out).toContain('id: 201-0');
    expect(out).toContain('"field":"role"');
    expect(out).not.toContain('event: state_snapshot'); // 窗口内不重推 snapshot。
    reqRawClose(req);
  });
});

describe('structureSseHandler 字段级 error 非 job 终态（Codex r7 P1：errorIsTerminal=false 接线）', () => {
  /** 软字段级失败 ErrorEnvelope（40 §3.4：details.field ∈ SoftFieldKey；Job 整体可继续）。 */
  const fieldErrorEnvelope = {
    error: {
      userMessage: '这个字段没生成出来，可重试、改输入或转人工。',
      retriable: true,
      action: 'escalate',
      traceId: 't-1',
      details: { field: 'goal', attempts: 2 },
    },
  };

  it('running active job：worker 推字段级 error 帧后 Job 继续 → error 透传、不合成 done failed、续收 field_done/done', async () => {
    const db = new SseFakeDb({
      versions: { v1: { creatorUserId: 'u1', structureState: mixedStructureState('v1') } },
      job: { versionId: 'v1', ownerUserId: 'u1', id: 'sjob-1', status: 'running' },
    });
    // worker 真流：字段级 error（软字段失败）→ 其它字段成功 field_done → 整 Job done completed。
    const hot = makeHot(
      [], // 空历史 → snapshot 路径
      [
        ['100-0', ['event', 'error', 'data', JSON.stringify(fieldErrorEnvelope)]],
        [
          '101-0',
          [
            'event',
            'field_done',
            'data',
            JSON.stringify({ field: 'tagline', value: '一句话卖点' }),
          ],
        ],
        ['102-0', ['event', 'done', 'data', JSON.stringify({ status: 'completed' })]],
      ],
    );
    const { req, reply, raw } = makeReqReply({ versionId: 'v1', userId: 'u1', db, hot });
    await structureSseHandler().call(undefined as never, req as never, reply as never);
    await waitFor(() => raw.writes.join('').includes('event: done'));
    const out = raw.writes.join('');
    // 字段级 error 透传给前端（不被吞、不裸露 code）。
    expect(out).toContain('event: error');
    expect(out).toContain('"field":"goal"');
    // 关键：字段级 error 没把流提前收口 —— 后续真流帧仍下发（Job 继续）。
    expect(out).toContain('event: field_done');
    expect(out).toContain('"field":"tagline"');
    expect(out).toContain('id: 102-0');
    // 终态由 done(completed) 决定；不存在被合成的 done failed（注意 snapshot 里 goal 字段态本身含
    //   "status":"failed"，故不能裸 not.toContain；精确断言 done 帧 payload 为 completed、无 done failed）。
    expect(out).toContain('event: done');
    expect(doneStatuses(out)).toEqual(['completed']); // 恰一帧 done 且为 completed（无合成 done failed）
    expect(raw.end).toHaveBeenCalled(); // 由 done 关流
  });

  it('Last-Event-ID 窗口内 replay 到字段级 error（Job 仍 running）→ 不收口、继续从 active job 流 subscribe 续收', async () => {
    const db = new SseFakeDb({
      versions: { v1: { creatorUserId: 'u1', structureState: mixedStructureState('v1') } },
      job: { versionId: 'v1', ownerUserId: 'u1', id: 'sjob-1', status: 'running' },
    });
    // 历史里含字段级 error（断线前 worker 已发）；重连 replay 到它。subscribe 续收后续 done。
    const hot = makeHot(
      [
        ['200-0', ['event', 'field_done', 'data', JSON.stringify({ field: 'name', value: 'x' })]],
        ['201-0', ['event', 'error', 'data', JSON.stringify(fieldErrorEnvelope)]],
      ],
      [['202-0', ['event', 'done', 'data', JSON.stringify({ status: 'completed' })]]],
    );
    const { req, reply, raw } = makeReqReply({
      versionId: 'v1',
      userId: 'u1',
      db,
      hot,
      lastEventId: '200-0',
    });
    await structureSseHandler().call(undefined as never, req as never, reply as never);
    await waitFor(() => raw.writes.join('').includes('event: done'));
    const out = raw.writes.join('');
    // replay 到字段级 error：透传、不重推 snapshot、不合成 done failed。
    expect(out).toContain('id: 201-0');
    expect(out).toContain('event: error');
    expect(out).not.toContain('event: state_snapshot'); // 窗口内不重推 snapshot
    // 关键：replay 到字段级 error 后仍 live subscribe 续收后续 done（修复前会被提前收口）。
    expect(out).toContain('id: 202-0');
    expect(doneStatuses(out)).toEqual(['completed']); // 恰一帧 done 且为 completed（无合成 done failed）
    expect(raw.end).toHaveBeenCalled();
  });
});

/**
 * 可变 job 的假 PG（BUG-1 connect-先于-job）：job 查询读 mutable holder.job——
 *   连接时 holder.job=undefined（无 job）→ 建流走「等待路径」；测试随后把 job 写进 holder，
 *   下一轮接管轮询应查到它并接管（subscribe / 补 done）。owner / snapshot SQL 同 SseFakeDb。
 */
class MutableJobDb implements Queryable {
  constructor(
    private readonly versions: Record<string, { creatorUserId: string; structureState: unknown }>,
    private readonly holder: {
      job?: { versionId: string; ownerUserId: string; id: string; status: string };
    },
  ) {}
  async query<R = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<QueryResultLike<R>> {
    if (
      sql.includes('creator_user_id') &&
      sql.includes('FROM capability_versions v') &&
      sql.includes('JOIN capabilities c') &&
      !sql.includes('structure_state')
    ) {
      const v = this.versions[params[0] as string];
      return {
        rows: v ? ([{ creator_user_id: v.creatorUserId }] as R[]) : [],
        rowCount: v ? 1 : 0,
      };
    }
    if (sql.includes('FROM jobs') && sql.includes("subject_ref->>'versionId'")) {
      const versionId = params[0] as string;
      const owner = params[1] as string;
      const j = this.holder.job;
      const match = j && j.versionId === versionId && j.ownerUserId === owner;
      return {
        rows: match ? ([{ id: j!.id, status: j!.status }] as R[]) : [],
        rowCount: match ? 1 : 0,
      };
    }
    if (sql.includes('SELECT structure_state FROM capability_versions WHERE id = $1')) {
      const v = this.versions[params[0] as string];
      return {
        rows: v ? ([{ structure_state: v.structureState }] as R[]) : [],
        rowCount: v ? 1 : 0,
      };
    }
    throw new Error(`MutableJobDb: unhandled SQL: ${sql.replace(/\s+/g, ' ').slice(0, 120)}`);
  }
}

describe('structureSseHandler connect-先于-job 接管（BUG-1：等待路径轮询接管，不靠重连）', () => {
  it('连接时无 job（走等待路径，仅 snapshot）→ 随后创建 running job → 接管轮询查到并下发 field/done 帧（非永久空心跳）', async () => {
    // 关键不变量：建流【瞬间】holder.job 必须为空——否则连接时 lookupStructureJob 命中、走普通 subscribe 路径，
    //   就不会挂 awaitActivation 钩子，测不到 BUG-1。job 仅在 handler 返回【之后】才置入（模拟 connect-先于-job）。
    const holder: { job?: { versionId: string; ownerUserId: string; id: string; status: string } } =
      {};
    const db = new MutableJobDb(
      { v1: { creatorUserId: 'u1', structureState: mixedStructureState('v1') } },
      holder,
    );
    // job 出现后 worker 推的字段流帧（field_done → done completed）。
    const hot = makeHot(
      [], // 空历史 → snapshot 路径，latestId='0-0'
      [
        [
          '100-0',
          [
            'event',
            'field_done',
            'data',
            JSON.stringify({ field: 'tagline', value: '一句话卖点' }),
          ],
        ],
        ['101-0', ['event', 'done', 'data', JSON.stringify({ status: 'completed' })]],
      ],
    );
    const { req, reply, raw } = makeReqReply({ versionId: 'v1', userId: 'u1', db, hot });
    // handler 同步段（connect-time lookup）此刻 holder.job=空 → 走等待路径、挂 awaitActivation 钩子。
    await structureSseHandler().call(undefined as never, req as never, reply as never);
    // 连接首帧仍是 snapshot，且【尚无 done】（无 job → 流保持开放，非提前收口）。
    const initial = raw.writes.join('');
    expect(initial).toContain('event: state_snapshot');
    expect(initial).not.toContain('event: done');
    // connect 后用户发起结构化 → job 出现（handler 已返回，流处于「snapshot + 等待轮询」状态）。
    //   接管轮询在后续 tick 查到该 job 并接管（不依赖客户端重连）。
    holder.job = { versionId: 'v1', ownerUserId: 'u1', id: 'sjob-late', status: 'running' };
    // 接管轮询节拍为 STRUCTURE_ACTIVATION_POLL_MS(1s)：首个 tick 在 ~1s 才命中 job。
    //   等待预算给到 4×poll(4s)，留足并行测试 CPU 争用下的调度抖动余量（默认 1s 与 1s 节拍是死磕，会偶发 waitFor timeout）。
    await waitFor(
      () => raw.writes.join('').includes('event: done'),
      STRUCTURE_ACTIVATION_POLL_MS * 4,
    );
    const out = raw.writes.join('');
    // 接管不重推 snapshot（等待期已发首帧）：snapshot 恰一帧。
    expect(out.split('event: state_snapshot').length - 1).toBe(1);
    // 关键：job 在 connect 后出现，流接管并实时下发 worker 字段流帧（修复前永久空心跳、收不到）。
    expect(out).toContain('event: field_done');
    expect(out).toContain('"field":"tagline"');
    expect(out).toContain('id: 101-0');
    expect(doneStatuses(out)).toEqual(['completed']); // done 收尾、流关闭（非永久心跳）。
    expect(raw.end).toHaveBeenCalled();
  });

  it('连接时无 job → 一个 poll 节拍后才出现 job（多轮轮询）→ 接管下发 done', async () => {
    const holder: { job?: { versionId: string; ownerUserId: string; id: string; status: string } } =
      {};
    const db = new MutableJobDb(
      { v1: { creatorUserId: 'u1', structureState: mixedStructureState('v1') } },
      holder,
    );
    const hot = makeHot(
      [],
      [['100-0', ['event', 'done', 'data', JSON.stringify({ status: 'completed' })]]],
    );
    const { req, reply, raw } = makeReqReply({ versionId: 'v1', userId: 'u1', db, hot });
    await structureSseHandler().call(undefined as never, req as never, reply as never);
    // 首轮无 job → 仅 snapshot、无 done（流保持开放等待，非永久收口）。
    const initial = raw.writes.join('');
    expect(initial).toContain('event: state_snapshot');
    expect(initial).not.toContain('event: done');
    // 满一个 poll 节拍后 job 才被创建（确保走【第二轮】轮询接管，证明多轮重查有效）。
    setTimeout(() => {
      holder.job = { versionId: 'v1', ownerUserId: 'u1', id: 'sjob-later', status: 'running' };
    }, STRUCTURE_ACTIVATION_POLL_MS + 100);
    await waitFor(() => raw.writes.join('').includes('event: done'), 5_000);
    const out = raw.writes.join('');
    expect(doneStatuses(out)).toEqual(['completed']); // 接管后 done 收尾。
    expect(raw.end).toHaveBeenCalled();
  });

  it('连接时无 job → 出现时已是终态（completed）→ 接管补 done 关流、绝不 subscribe', async () => {
    const holder: { job?: { versionId: string; ownerUserId: string; id: string; status: string } } =
      {};
    const db = new MutableJobDb(
      { v1: { creatorUserId: 'u1', structureState: mixedStructureState('v1') } },
      holder,
    );
    // 订阅源里即便有迟到帧也不应被读到（终态接管不订阅）。
    const hot = makeHot(
      [],
      [['9-0', ['event', 'done', 'data', JSON.stringify({ status: 'completed' })]]],
    );
    const { req, reply, raw } = makeReqReply({ versionId: 'v1', userId: 'u1', db, hot });
    // connect-time 无 job → 等待路径。job 在 handler 返回后才出现，且已是终态（等待期极快跑完）。
    await structureSseHandler().call(undefined as never, req as never, reply as never);
    holder.job = { versionId: 'v1', ownerUserId: 'u1', id: 'sjob-fast', status: 'completed' };
    // 终态接管同样要等首个 poll tick(~1s)；预算给 4×poll(4s)，避免并行负载下与 1s 节拍死磕偶发超时。
    await waitFor(
      () => raw.writes.join('').includes('event: done'),
      STRUCTURE_ACTIVATION_POLL_MS * 4,
    );
    const out = raw.writes.join('');
    expect(out).toContain('event: state_snapshot');
    expect(doneStatuses(out)).toEqual(['completed']); // 恰一帧 done(completed)。
    expect(out).not.toContain('id: 9-0'); // 终态接管不订阅，迟到帧不混入。
    expect(raw.end).toHaveBeenCalled();
  });
});

describe('structureSseHandler 统一终态闸（非 running 不 subscribe、补 done 关流）', () => {
  it('active job 已 completed → snapshot 后补 done 关流、不订阅（迟到帧不混入）', async () => {
    const db = new SseFakeDb({
      versions: { v1: { creatorUserId: 'u1', structureState: mixedStructureState('v1') } },
      job: { versionId: 'v1', ownerUserId: 'u1', id: 'sjob-1', status: 'completed' },
    });
    // 订阅源里即便有迟到 done，也不应被读到（终态不订阅）。
    const hot = makeHot(
      [],
      [['9-0', ['event', 'done', 'data', JSON.stringify({ status: 'completed' })]]],
    );
    const { req, reply, raw } = makeReqReply({ versionId: 'v1', userId: 'u1', db, hot });
    await structureSseHandler().call(undefined as never, req as never, reply as never);
    await new Promise((r) => setTimeout(r, 10));
    const out = raw.writes.join('');
    expect(out).toContain('event: state_snapshot');
    expect(out).toContain('event: done');
    expect(out).toContain('"status":"completed"');
    expect(out.split('event: done').length - 1).toBe(1); // 恰好一次 done。
    expect(out).not.toContain('id: 9-0'); // 终态不订阅，迟到帧不混入。
    expect(raw.end).toHaveBeenCalled();
  });

  it('active job failed → snapshot 后补 done(failed) 关流', async () => {
    const db = new SseFakeDb({
      versions: { v1: { creatorUserId: 'u1', structureState: mixedStructureState('v1') } },
      job: { versionId: 'v1', ownerUserId: 'u1', id: 'sjob-1', status: 'failed' },
    });
    const { req, reply, raw } = makeReqReply({ versionId: 'v1', userId: 'u1', db, hot: makeHot() });
    await structureSseHandler().call(undefined as never, req as never, reply as never);
    const out = raw.writes.join('');
    expect(out).toContain('event: done');
    expect(out).toContain('"status":"failed"');
    expect(raw.end).toHaveBeenCalled();
  });
});

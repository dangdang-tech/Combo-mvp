// B-14/B-15 · consumer-core 单测（脊柱 §11.D 连续安全前缀水位 + §3.3 同事务 + §4 毒丸）。
//   关键覆盖：
//     - 水位连续前缀正确性：中间有未提交 xid（>= xmin）时不漏不跳（停在首条 unsafe，之后即使有 safe 也不抢跑）。
//     - 大 id 事务先提交、小 id 事务后提交：不漏读低 seq 晚提交事件（不在 SQL 过滤 xid 的核心收益）。
//     - notify 毒丸：重试到上限落 dead_events + cursor 跳过；幂等重放不重复落死信。
//     - lifecycle 毒丸：卡住停 cursor、不进 dead_events、不跳过。
//     - cursor 与处理同事务（处理失败时 cursor 不前进）。
import { describe, it, expect } from 'vitest';
import {
  runOnce,
  type ConsumerTopicConfig,
  type FetchedEvent,
} from '../platform/events/consumer-core.js';
import type { TxPool, Tx, TxConn } from '../platform/events/db-tx.js';

/** 一行 outbox（内存模型）。 */
interface OutboxRow {
  seq: number;
  event_id: string;
  topic: string;
  payload: unknown;
  xid: number;
}

/** 一行 dead_events（内存模型）。next_retry_at = 退避到点的 epoch ms（undefined/NULL = 无，不参与退避/补投）。 */
interface DeadRow {
  topic: string;
  outbox_seq: number;
  attempts: number;
  status: string;
  next_retry_at?: number;
  resolved_at?: number;
}

/** 内存事件库（outbox + cursors + dead_events），驱动 mock TxPool。 */
class MemDb {
  outbox: OutboxRow[] = [];
  cursors = new Map<string, { last_seq: number; last_event_id?: string }>(); // key=consumer|cursorTopic
  dead = new Map<string, DeadRow>(); // key=consumer|event_id
  xmin = Number.MAX_SAFE_INTEGER; // 已提交水位（所有 xid < xmin 已确定）
  /** mock DB now()（epoch ms），退避窗判断用；测试可推进它模拟时钟到点。 */
  now = 0;

  cursorKey(consumer: string, topic: string): string {
    return `${consumer}|${topic}`;
  }

  query<R = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): { rows: R[]; rowCount?: number } {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (s.startsWith('BEGIN') || s.startsWith('COMMIT') || s.startsWith('ROLLBACK')) {
      return { rows: [] };
    }
    if (s.includes('SELECT last_seq FROM consumer_cursors')) {
      const [consumer, cursorTopic] = params as [string, string];
      const c = this.cursors.get(this.cursorKey(consumer, cursorTopic));
      return { rows: c ? ([{ last_seq: c.last_seq }] as R[]) : [] };
    }
    if (s.includes('pg_snapshot_xmin')) {
      return { rows: [{ xmin: this.xmin }] as R[] };
    }
    // 合并流取批：topic = ANY($1) AND seq > $2 ORDER BY seq LIMIT $3。
    if (s.includes('FROM outbox_events') && s.includes('topic = ANY($1)')) {
      const [topics, cursorSeq, batch] = params as [string[], number, number];
      const set = new Set(topics);
      const rows = this.outbox
        .filter((r) => set.has(r.topic) && r.seq > cursorSeq)
        .sort((a, b) => a.seq - b.seq)
        .slice(0, batch);
      return { rows: rows as unknown as R[] };
    }
    // resolveDeadEvent（成功处理后清理死信）：UPDATE dead_events SET status='resolved' ... WHERE status <> 'resolved'。
    if (s.includes("SET status = 'resolved'")) {
      const [consumer, eventId] = params as [string, string];
      const key = `${consumer}|${eventId}`;
      const d = this.dead.get(key);
      if (d && d.status !== 'resolved') {
        d.status = 'resolved';
        d.resolved_at = this.now;
        d.next_retry_at = undefined;
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
    if (s.includes('INSERT INTO consumer_cursors')) {
      const [consumer, cursorTopic, seq, eventId] = params as [string, string, number, string];
      this.cursors.set(this.cursorKey(consumer, cursorTopic), {
        last_seq: seq,
        last_event_id: eventId,
      });
      return { rows: [] };
    }
    // P1-5 退避窗判断：retrying 行且 next_retry_at > now() → backing_off=true。
    if (s.includes('AS backing_off')) {
      const [consumer, eventId] = params as [string, string];
      const d = this.dead.get(`${consumer}|${eventId}`);
      const backingOff =
        !!d &&
        d.status === 'retrying' &&
        d.next_retry_at !== undefined &&
        d.next_retry_at > this.now;
      return { rows: [{ backing_off: backingOff }] as R[] };
    }
    if (s.includes('SELECT attempts FROM dead_events')) {
      const [consumer, eventId] = params as [string, string];
      const d = this.dead.get(`${consumer}|${eventId}`);
      return { rows: d ? ([{ attempts: d.attempts }] as R[]) : [] };
    }
    if (s.includes('INSERT INTO dead_events')) {
      // params: consumer, topic, event_id, outbox_seq, payload, last_error, attempts, [delayMs]
      const [consumer, topic, eventId, seq, , , attempts, delayMs] = params as [
        string,
        string,
        string,
        number,
        unknown,
        unknown,
        number,
        string?,
      ];
      // 两种 INSERT：recordRetry（status='retrying' + 重排 next_retry_at）/ deadLetterAndSkip（status='dead' + next_retry_at=NULL）。
      const isRetrying = s.includes("'retrying'");
      const key = `${consumer}|${eventId}`;
      const existing = this.dead.get(key);
      // 忠实复刻 ON CONFLICT DO UPDATE（只更新 SQL 列出的列；其余列保留——本模型整行替换但逐列计算新值）。
      if (isRetrying) {
        // recordRetry：DO UPDATE SET attempts=$7, status='retrying', next_retry_at=now()+delay（含 resolved_at 不动）。
        this.dead.set(key, {
          topic,
          outbox_seq: seq,
          attempts,
          status: 'retrying',
          next_retry_at: delayMs !== undefined ? this.now + Number(delayMs) : undefined,
          resolved_at: existing?.resolved_at,
        });
      } else {
        // deadLetterAndSkip（Codex P1-new）：DO UPDATE SET attempts=existing.attempts+1, status='dead',
        //   next_retry_at=NULL, resolved_at=NULL, topic/outbox_seq/payload=EXCLUDED。
        //   关键：冲突进 dead 必清 next_retry_at（否则残留退避到点会被 sweeper 自动补投，破坏「dead 后跳过」）。
        this.dead.set(key, {
          topic,
          outbox_seq: seq,
          attempts: existing ? existing.attempts + 1 : attempts,
          status: 'dead',
          next_retry_at: undefined, // = NULL：dead 不参与退避窗/自动补投
          resolved_at: undefined, // = NULL
        });
      }
      return { rows: [] };
    }
    // sweeper.redriveDeadEvents 领取：UPDATE ... WHERE status='dead' AND next_retry_at IS NOT NULL AND next_retry_at <= now()。
    //   用于断言「dead 行 next_retry_at=NULL → 不被自动补投领取」。
    if (s.includes("SET status = 'retrying'") && s.includes('next_retry_at <= now()')) {
      const limit = (params[0] as number) ?? 50;
      const claimable = [...this.dead.entries()]
        .filter(
          ([, d]) =>
            d.status === 'dead' && d.next_retry_at !== undefined && d.next_retry_at <= this.now,
        )
        .slice(0, limit);
      for (const [, d] of claimable) d.status = 'retrying';
      return { rows: claimable.map(([k, d]) => ({ id: k, ...d })) };
    }
    throw new Error(`MemDb: unhandled SQL: ${s.slice(0, 80)}`);
  }

  txPool(): TxPool {
    return {
      connect: (): Promise<TxConn> =>
        Promise.resolve({
          query: (sql: string, p?: unknown[]) => Promise.resolve(this.query(sql, p)) as never,
          release: () => undefined,
        }),
    };
  }
}

function notifyCfg(
  db: MemDb,
  process: ConsumerTopicConfig['process'],
  overrides: Partial<ConsumerTopicConfig> = {},
): ConsumerTopicConfig {
  return {
    consumerName: 'NotifyConsumer',
    topics: ['notify.import_completed'],
    cursorTopic: 'notify.import_completed',
    process,
    maxAttempts: 3,
    ...overrides,
  };
}

/** MarketplaceProjection 合并流配置（capability.published + unpublished，单 cursor）。 */
function lifecycleCfg(
  process: ConsumerTopicConfig['process'],
  overrides: Partial<ConsumerTopicConfig> = {},
): ConsumerTopicConfig {
  return {
    consumerName: 'MarketplaceProjection',
    topics: ['capability.published', 'capability.unpublished'],
    cursorTopic: 'capability.*',
    process,
    ...overrides,
  };
}

describe('consumer-core 水位连续安全前缀（脊柱 §11.D）', () => {
  it('全部已提交（xid < xmin）→ 顺序处理全批，cursor 推到末尾', async () => {
    const db = new MemDb();
    db.xmin = 100;
    db.outbox = [
      {
        seq: 1,
        event_id: 'e1',
        topic: 'notify.import_completed',
        payload: { traceId: 't' },
        xid: 10,
      },
      {
        seq: 2,
        event_id: 'e2',
        topic: 'notify.import_completed',
        payload: { traceId: 't' },
        xid: 11,
      },
      {
        seq: 3,
        event_id: 'e3',
        topic: 'notify.import_completed',
        payload: { traceId: 't' },
        xid: 12,
      },
    ];
    const seen: number[] = [];
    const r = await runOnce(
      db.txPool(),
      notifyCfg(db, async (_tx, e: FetchedEvent) => {
        seen.push(e.seq);
      }),
    );
    expect(seen).toEqual([1, 2, 3]);
    expect(r.processed).toBe(3);
    expect(db.cursors.get('NotifyConsumer|notify.import_completed')?.last_seq).toBe(3);
  });

  it('中间有未提交 xid（>= xmin）→ 停在首条 unsafe，之后即使有 safe 也不抢跑（不漏不跳）', async () => {
    const db = new MemDb();
    db.xmin = 50;
    // seq2 的 xid=60 >= xmin（in-flight）；seq3 的 xid=20 < xmin（已提交但 seq 在 unsafe 之后）。
    db.outbox = [
      { seq: 1, event_id: 'e1', topic: 'notify.import_completed', payload: {}, xid: 10 },
      { seq: 2, event_id: 'e2', topic: 'notify.import_completed', payload: {}, xid: 60 },
      { seq: 3, event_id: 'e3', topic: 'notify.import_completed', payload: {}, xid: 20 },
    ];
    const seen: number[] = [];
    const r = await runOnce(
      db.txPool(),
      notifyCfg(db, async (_tx, e: FetchedEvent) => {
        seen.push(e.seq);
      }),
    );
    // 只处理 seq1；遇 seq2(unsafe) break；seq3 即便 safe 也不抢跑（保序）。
    expect(seen).toEqual([1]);
    expect(r.processed).toBe(1);
    expect(db.cursors.get('NotifyConsumer|notify.import_completed')?.last_seq).toBe(1);
  });

  it('大 id 先提交、小 id 后提交：低 seq 晚提交事件不漏读（下一轮 xmin 推进后带上）', async () => {
    const db = new MemDb();
    // 第一轮：seq1(xid=70) 仍 in-flight（>= xmin=50），seq2(xid=40) 已提交但在其后。
    db.xmin = 50;
    db.outbox = [
      { seq: 1, event_id: 'e1', topic: 'notify.import_completed', payload: {}, xid: 70 },
      { seq: 2, event_id: 'e2', topic: 'notify.import_completed', payload: {}, xid: 40 },
    ];
    const seen: number[] = [];
    const proc = async (_tx: Tx, e: FetchedEvent): Promise<void> => {
      seen.push(e.seq);
    };
    const r1 = await runOnce(db.txPool(), notifyCfg(db, proc));
    // 第一轮：seq1 unsafe → 一条都不处理（停在 seq1），cursor 仍 0。
    expect(seen).toEqual([]);
    expect(r1.processed).toBe(0);
    expect(db.cursors.get('NotifyConsumer|notify.import_completed')?.last_seq).toBeUndefined();

    // 第二轮：seq1 事务已提交（xmin 推进到 80）→ 从 cursor 0 重新带上 seq1、seq2，按 seq 序处理。
    db.xmin = 80;
    const r2 = await runOnce(db.txPool(), notifyCfg(db, proc));
    expect(seen).toEqual([1, 2]); // 低 seq 晚提交的 e1 没被漏掉
    expect(r2.processed).toBe(2);
    expect(db.cursors.get('NotifyConsumer|notify.import_completed')?.last_seq).toBe(2);
  });
});

describe('consumer-core 毒丸策略（§4）', () => {
  it('notify 毒丸：连续失败到 maxAttempts → 落 dead_events + cursor 跳过该条，继续后续', async () => {
    const db = new MemDb();
    db.xmin = 100;
    db.outbox = [
      {
        seq: 1,
        event_id: 'bad',
        topic: 'notify.import_completed',
        payload: { traceId: 't' },
        xid: 1,
      },
      {
        seq: 2,
        event_id: 'good',
        topic: 'notify.import_completed',
        payload: { traceId: 't' },
        xid: 2,
      },
    ];
    const failing: ConsumerTopicConfig['process'] = async (_tx, e) => {
      if (e.eventId === 'bad') throw new Error('boom');
    };
    const alerts: string[] = [];
    const cfg = notifyCfg(db, failing, { maxAttempts: 3, onAlert: (i) => alerts.push(i.kind) });

    // 退避窗会写 next_retry_at = now + delayMs；每轮把时钟推到「远超上一轮退避到点」再跑（模拟退避到点）。
    const advanceClockPastBackoff = (): void => {
      db.now += 10 * 30 * 60_000; // 远超任何 delayMs（退避封顶 30min）→ 不再 backing_off
    };

    // 轮1：bad 第1次失败（attempts 0→1，未达上限）→ 本轮停在 bad（cursor 不前进）+ 写退避窗。
    let r = await runOnce(db.txPool(), cfg);
    expect(r.processed).toBe(0);
    expect(r.deadLettered).toBe(0);
    expect(db.cursors.get('NotifyConsumer|notify.import_completed')?.last_seq).toBeUndefined();
    expect(db.dead.get('NotifyConsumer|bad')?.status).toBe('retrying');

    // 轮2：退避到点（推进 mock 时钟越过 next_retry_at）→ attempts 1→2，未达上限 → 仍停。
    advanceClockPastBackoff();
    r = await runOnce(db.txPool(), cfg);
    expect(db.dead.get('NotifyConsumer|bad')?.attempts).toBe(2);

    // 轮3：退避到点 → attempts 2 → 2+1=3 >= maxAttempts → 落 dead + 跳过 → 继续处理 good。
    advanceClockPastBackoff();
    const seen: string[] = [];
    const cfg3 = notifyCfg(
      db,
      async (_tx, e) => {
        if (e.eventId === 'bad') throw new Error('boom');
        seen.push(e.eventId);
      },
      { maxAttempts: 3, onAlert: (i) => alerts.push(i.kind) },
    );
    r = await runOnce(db.txPool(), cfg3);
    expect(r.deadLettered).toBe(1);
    expect(db.dead.get('NotifyConsumer|bad')?.status).toBe('dead');
    expect(seen).toContain('good'); // 跳过死信后继续处理后续
    expect(db.cursors.get('NotifyConsumer|notify.import_completed')?.last_seq).toBe(2);
    expect(alerts).toContain('poison_dead');
  });

  it('lifecycle 毒丸：失败 → 卡住停 cursor、不进 dead_events、不跳过（保上架顺序）', async () => {
    const db = new MemDb();
    db.xmin = 100;
    db.outbox = [
      {
        seq: 1,
        event_id: 'pub1',
        topic: 'capability.published',
        payload: { traceId: 't' },
        xid: 1,
      },
      {
        seq: 2,
        event_id: 'pub2',
        topic: 'capability.published',
        payload: { traceId: 't' },
        xid: 2,
      },
    ];
    const alerts: string[] = [];
    const cfg = lifecycleCfg(
      async () => {
        throw new Error('projection failed');
      },
      { onAlert: (i) => alerts.push(i.kind) },
    );
    const r = await runOnce(db.txPool(), cfg);
    expect(r.stuck).toBe(true);
    expect(r.deadLettered).toBe(0);
    expect(db.dead.size).toBe(0); // lifecycle 不进死信
    expect(db.cursors.get('MarketplaceProjection|capability.*')?.last_seq).toBeUndefined(); // 卡住停 cursor
    expect(alerts).toContain('lifecycle_stuck');
  });

  it('非阻塞①（Codex r5）：retrying 事件后续处理成功 → dead_events 行标 resolved（不悬留）', async () => {
    const db = new MemDb();
    db.xmin = 100;
    db.now = 1_000;
    db.outbox = [
      {
        seq: 1,
        event_id: 'flaky',
        topic: 'notify.import_completed',
        payload: { traceId: 't' },
        xid: 1,
      },
    ];
    let calls = 0;
    // 第一次失败（写 retrying 死信），退避到点后第二次成功。
    const proc: ConsumerTopicConfig['process'] = async () => {
      calls += 1;
      if (calls === 1) throw new Error('transient');
    };
    const cfg = notifyCfg(db, proc, { maxAttempts: 5, backoffBaseMs: 30_000 });

    // 轮1：失败 → 写 retrying 死信行。
    await runOnce(db.txPool(), cfg);
    const afterFail = db.dead.get('NotifyConsumer|flaky')!;
    expect(afterFail.status).toBe('retrying');
    expect(afterFail.resolved_at).toBeUndefined();

    // 轮2：退避到点 → 处理成功 → 同事务把死信标 resolved（清退避、不再补投）。
    db.now = 40_000; // 越过 next_retry_at
    const r = await runOnce(db.txPool(), cfg);
    expect(r.processed).toBe(1);
    const resolved = db.dead.get('NotifyConsumer|flaky')!;
    expect(resolved.status).toBe('resolved'); // 成功后死信不悬留
    expect(resolved.resolved_at).toBe(40_000);
    expect(resolved.next_retry_at).toBeUndefined();
    expect(db.cursors.get('NotifyConsumer|notify.import_completed')?.last_seq).toBe(1);
  });

  it('非阻塞①：从没进过死信的成功事件 → resolveDeadEvent 0 行（无害，不报错）', async () => {
    const db = new MemDb();
    db.xmin = 100;
    db.outbox = [
      { seq: 1, event_id: 'clean', topic: 'notify.import_completed', payload: {}, xid: 1 },
    ];
    const r = await runOnce(
      db.txPool(),
      notifyCfg(db, async () => undefined),
    );
    expect(r.processed).toBe(1);
    expect(db.dead.has('NotifyConsumer|clean')).toBe(false); // 无死信行，UPDATE 0 行无害
  });

  it('cursor 与处理同事务：处理成功才推 cursor（成功路径 cursor=该 seq）', async () => {
    const db = new MemDb();
    db.xmin = 100;
    db.outbox = [{ seq: 5, event_id: 'e5', topic: 'notify.import_completed', payload: {}, xid: 1 }];
    await runOnce(
      db.txPool(),
      notifyCfg(db, async () => undefined),
    );
    expect(db.cursors.get('NotifyConsumer|notify.import_completed')?.last_seq).toBe(5);
  });
});

describe('P0-2 · MarketplaceProjection lifecycle 合并流（单 cursor 保全局 seq 顺序）', () => {
  it('published/unpublished 交错按全局 seq 顺序处理，且只推进一条合并 cursor', async () => {
    const db = new MemDb();
    db.xmin = 100;
    // 上架/下架交错，跨两个子 topic；合并流必须严格按 seq(1..4) 顺序处理。
    db.outbox = [
      {
        seq: 1,
        event_id: 'pub1',
        topic: 'capability.published',
        payload: { traceId: 't' },
        xid: 1,
      },
      {
        seq: 2,
        event_id: 'unpub1',
        topic: 'capability.unpublished',
        payload: { traceId: 't' },
        xid: 2,
      },
      {
        seq: 3,
        event_id: 'pub2',
        topic: 'capability.published',
        payload: { traceId: 't' },
        xid: 3,
      },
      {
        seq: 4,
        event_id: 'unpub2',
        topic: 'capability.unpublished',
        payload: { traceId: 't' },
        xid: 4,
      },
    ];
    const seen: Array<{ seq: number; topic: string }> = [];
    const r = await runOnce(
      db.txPool(),
      lifecycleCfg(async (_tx, e) => {
        seen.push({ seq: e.seq, topic: e.topic });
      }),
    );
    // 合并流：严格全局 seq 顺序（不按子 topic 分别推进，否则上架/下架会乱序）。
    expect(seen.map((x) => x.seq)).toEqual([1, 2, 3, 4]);
    expect(r.processed).toBe(4);
    // 单 cursor 行（cursorTopic='capability.*'）推到合并流末尾；不存在按子 topic 拆的 cursor 行。
    expect(db.cursors.get('MarketplaceProjection|capability.*')?.last_seq).toBe(4);
    expect(db.cursors.get('MarketplaceProjection|capability.published')).toBeUndefined();
    expect(db.cursors.get('MarketplaceProjection|capability.unpublished')).toBeUndefined();
  });

  it('合并流取批跨两个 topic（topic IN）：只属于本 consumer 的 topic 进流，notify 不混入', async () => {
    const db = new MemDb();
    db.xmin = 100;
    db.outbox = [
      { seq: 1, event_id: 'pub1', topic: 'capability.published', payload: {}, xid: 1 },
      { seq: 2, event_id: 'n1', topic: 'notify.import_completed', payload: {}, xid: 2 }, // 不属于 lifecycle 流
      { seq: 3, event_id: 'unpub1', topic: 'capability.unpublished', payload: {}, xid: 3 },
    ];
    const seen: string[] = [];
    const r = await runOnce(
      db.txPool(),
      lifecycleCfg(async (_tx, e) => {
        seen.push(e.eventId);
      }),
    );
    // notify.import_completed 不在 topics=[capability.*] 集合里 → 不被合并流取到。
    expect(seen).toEqual(['pub1', 'unpub1']);
    expect(r.processed).toBe(2);
    expect(db.cursors.get('MarketplaceProjection|capability.*')?.last_seq).toBe(3);
  });
});

describe('P1-new · retrying 冲突进 dead 必清 next_retry_at（毒丸不被自动补投，Codex P1-new）', () => {
  it('达上限从 retrying 冲突进 dead 后：dead 行 next_retry_at=NULL → sweeper 补投领取查不到、不再自动补投', async () => {
    const db = new MemDb();
    db.xmin = 100;
    db.now = 1_000;
    db.outbox = [
      {
        seq: 1,
        event_id: 'poison',
        topic: 'notify.import_completed',
        payload: { traceId: 't' },
        xid: 1,
      },
    ];
    const failing: ConsumerTopicConfig['process'] = async () => {
      throw new Error('boom');
    };
    const cfg = notifyCfg(db, failing, { maxAttempts: 3, backoffBaseMs: 30_000 });
    const advancePastBackoff = (): void => {
      db.now += 10 * 30 * 60_000; // 远超任何退避到点
    };

    // 轮1：失败 → retrying，写了 next_retry_at（退避到点）。
    await runOnce(db.txPool(), cfg);
    const afterR1 = db.dead.get('NotifyConsumer|poison')!;
    expect(afterR1.status).toBe('retrying');
    expect(afterR1.next_retry_at).toBeGreaterThan(db.now); // 退避窗内

    // 轮2：退避到点 → 再失败 → 仍 retrying（attempts 2），next_retry_at 重排。
    advancePastBackoff();
    await runOnce(db.txPool(), cfg);
    expect(db.dead.get('NotifyConsumer|poison')?.status).toBe('retrying');

    // 轮3：退避到点 → 达上限 → 从 retrying 冲突进 dead。
    advancePastBackoff();
    await runOnce(db.txPool(), cfg);
    const dead = db.dead.get('NotifyConsumer|poison')!;
    expect(dead.status).toBe('dead');
    // 关键断言（旧 bug 这里会残留上一轮退避到点）：dead 行 next_retry_at = NULL。
    expect(dead.next_retry_at).toBeUndefined();

    // sweeper.redriveDeadEvents 领取语义（status='dead' AND next_retry_at IS NOT NULL AND next_retry_at<=now()）：
    //   即便时钟已远超历史退避到点，next_retry_at=NULL 的 dead 行也【查不到】→ 不被自动补投（待人工/显式排期）。
    advancePastBackoff();
    const claim = db.query(
      `UPDATE dead_events SET status = 'retrying' WHERE status='dead' AND next_retry_at IS NOT NULL AND next_retry_at <= now() RETURNING *`,
      [50],
    );
    expect(claim.rows).toEqual([]); // 毒丸不被捡起自动补投
  });
});

describe('P1-5 · notify/metering 退避真生效（next_retry_at 主循环检查）', () => {
  it('退避窗内（next_retry_at > now()）停在该条不立即重试、不推进 cursor；到点才重试', async () => {
    const db = new MemDb();
    db.xmin = 100;
    db.now = 1_000; // 起始时钟
    db.outbox = [
      {
        seq: 1,
        event_id: 'bad',
        topic: 'notify.import_completed',
        payload: { traceId: 't' },
        xid: 1,
      },
    ];
    let attempts = 0;
    const proc: ConsumerTopicConfig['process'] = async () => {
      attempts += 1;
      throw new Error('boom');
    };
    const cfg = notifyCfg(db, proc, { maxAttempts: 5, backoffBaseMs: 30_000 });

    // 轮1：第1次失败 → 写 retrying + next_retry_at = now(1000)+30000 = 31000。
    await runOnce(db.txPool(), cfg);
    expect(attempts).toBe(1);
    expect(db.dead.get('NotifyConsumer|bad')?.status).toBe('retrying');
    expect(db.dead.get('NotifyConsumer|bad')?.next_retry_at).toBe(31_000);

    // 轮2：时钟未到点（now 仍 1000 < 31000）→ 退避窗内 → 不再调用 process（attempts 不增）、cursor 不前进。
    await runOnce(db.txPool(), cfg);
    expect(attempts).toBe(1); // 没有 1s 立即重试（退避生效）
    expect(db.dead.get('NotifyConsumer|bad')?.attempts).toBe(1);
    expect(db.cursors.get('NotifyConsumer|notify.import_completed')?.last_seq).toBeUndefined();

    // 轮3：推进时钟越过 next_retry_at → 退避到点 → 才重试（attempts 增到 2）。
    db.now = 31_001;
    await runOnce(db.txPool(), cfg);
    expect(attempts).toBe(2); // 到点后重试发生
  });

  it('退避到点后处理成功 → 推进 cursor、清退避停判（不再卡）', async () => {
    const db = new MemDb();
    db.xmin = 100;
    db.now = 0;
    let calls = 0;
    db.outbox = [
      { seq: 1, event_id: 'flaky', topic: 'notify.import_completed', payload: {}, xid: 1 },
      { seq: 2, event_id: 'ok2', topic: 'notify.import_completed', payload: {}, xid: 2 },
    ];
    // 第一次失败、之后成功（模拟瞬时故障恢复）。
    const proc: ConsumerTopicConfig['process'] = async (_tx, e) => {
      if (e.eventId === 'flaky' && calls === 0) {
        calls += 1;
        throw new Error('transient');
      }
      calls += 1;
    };
    const cfg = notifyCfg(db, proc, { maxAttempts: 5, backoffBaseMs: 30_000 });

    // 轮1：flaky 第1次失败 → 退避窗（next_retry_at=30000），停在 flaky（cursor 不前进、ok2 不抢跑）。
    await runOnce(db.txPool(), cfg);
    expect(db.cursors.get('NotifyConsumer|notify.import_completed')?.last_seq).toBeUndefined();

    // 轮2：退避未到（now=0）→ 仍停（不重试）。
    await runOnce(db.txPool(), cfg);
    expect(db.cursors.get('NotifyConsumer|notify.import_completed')?.last_seq).toBeUndefined();

    // 轮3：退避到点（now 越过 30000）→ flaky 重试成功 → 继续处理 ok2 → cursor 推到末尾。
    db.now = 30_001;
    const r = await runOnce(db.txPool(), cfg);
    expect(r.processed).toBe(2);
    expect(db.cursors.get('NotifyConsumer|notify.import_completed')?.last_seq).toBe(2);
  });
});

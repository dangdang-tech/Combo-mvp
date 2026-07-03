// B-16 §6.3 · sweeper-core 单测：outbox 滞留告警 + dead_events 补投。
//   - scanOutboxStall：按 topic 报滞留数，逐 topic 告警。
//   - redriveDeadEvents：领取（标 retrying）→ 重放成功标 resolved；失败退回 dead + attempts++ + 重排退避。
import { describe, it, expect, vi } from 'vitest';
import {
  scanOutboxStall,
  redriveDeadEvents,
  type RedrivableDeadEvent,
} from '../platform/events/sweeper-core.js';
import type { QueryableDb } from '../platform/events/db-tx.js';

function scriptedDb(
  handler: (sql: string, params?: unknown[]) => { rows: unknown[]; rowCount?: number },
): {
  db: QueryableDb;
  calls: Array<{ sql: string; params?: unknown[] }>;
} {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  const db: QueryableDb = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      return handler(sql, params) as never;
    }),
  };
  return { db, calls };
}

describe('scanOutboxStall (§6.3 outbox 滞留告警)', () => {
  it('按 topic 报滞留数，逐 topic 触发告警', async () => {
    const { db } = scriptedDb(() => ({
      rows: [
        { topic: 'notify.import_completed', stalled_count: 3, oldest_seq: 10 },
        { topic: 'capability.published', stalled_count: 1, oldest_seq: 22 },
      ],
    }));
    const alerts: string[] = [];
    const reports = await scanOutboxStall({
      db,
      thresholdMs: 60_000,
      onAlert: (i) => alerts.push(i.topic),
    });
    expect(reports).toHaveLength(2);
    expect(reports[0]).toEqual({
      topic: 'notify.import_completed',
      stalledCount: 3,
      oldestSeq: 10,
    });
    expect(alerts).toEqual(['notify.import_completed', 'capability.published']);
  });

  it('无滞留 → 空报表、不告警', async () => {
    const { db } = scriptedDb(() => ({ rows: [] }));
    const alerts: string[] = [];
    const reports = await scanOutboxStall({
      db,
      thresholdMs: 1000,
      onAlert: () => alerts.push('x'),
    });
    expect(reports).toEqual([]);
    expect(alerts).toEqual([]);
  });

  it('未注入 topicToCursorTopic → 退化为 cursor.topic = outbox.topic 直比（向后兼容）', async () => {
    const { db, calls } = scriptedDb(() => ({ rows: [] }));
    await scanOutboxStall({ db, thresholdMs: 1000 });
    const sql = calls[0]?.sql ?? '';
    expect(sql).toContain('c.topic = o.topic'); // 直比口径
    expect(sql).not.toContain('topic_map'); // 无映射表
    expect(calls[0]?.params).toEqual(['1000']);
  });

  it('注入 topicToCursorTopic（P1）→ 用映射表把 lifecycle 翻成合并 cursor "capability.*" 比对，不误报', async () => {
    const { db, calls } = scriptedDb(() => ({ rows: [] }));
    await scanOutboxStall({
      db,
      thresholdMs: 1000,
      topicToCursorTopic: {
        'capability.published': 'capability.*',
        'capability.unpublished': 'capability.*',
        'notify.import_completed': 'notify.import_completed',
      },
    });
    const sql = calls[0]?.sql ?? '';
    const params = calls[0]?.params ?? [];
    // 走映射表路径：内联 VALUES + 按 cursorTopic 比对（COALESCE 兜底 outbox 自身 topic）。
    expect(sql).toContain('topic_map');
    expect(sql).toContain('c.topic = COALESCE(m.cursor_topic, o.topic)');
    expect(sql).not.toContain('c.topic = o.topic'); // 不再直比
    // 阈值 + 映射 (topic, cursorTopic) 对参数化（防注入）。
    expect(params[0]).toBe('1000');
    expect(params).toContain('capability.published');
    expect(params).toContain('capability.*');
    expect(params).toContain('notify.import_completed');
  });
});

describe('redriveDeadEvents (§6.3 死信补投)', () => {
  function deadRow(id: string, eventId: string): Record<string, unknown> {
    return {
      id,
      consumer_name: 'NotifyConsumer',
      topic: 'notify.import_completed',
      event_id: eventId,
      outbox_seq: 5,
      payload: { recipientId: 'u1' },
    };
  }

  it('领取（标 retrying SKIP LOCKED）→ 重放成功 → 标 resolved', async () => {
    const updates: string[] = [];
    const { db } = scriptedDb((sql) => {
      if (sql.includes("SET status = 'retrying'")) return { rows: [deadRow('d1', 'e1')] };
      updates.push(sql);
      return { rows: [] };
    });
    const redrive = vi.fn(async (_de: RedrivableDeadEvent) => true);
    const r = await redriveDeadEvents({ db, redrive });
    expect(r).toEqual({ attempted: 1, resolved: 1, failed: 0 });
    expect(redrive).toHaveBeenCalledOnce();
    expect(updates.some((u) => u.includes("SET status = 'resolved'"))).toBe(true);
  });

  it('重放失败 → 退回 dead + attempts++ + 重排 next_retry_at', async () => {
    const updates: string[] = [];
    const { db } = scriptedDb((sql) => {
      if (sql.includes("SET status = 'retrying'")) return { rows: [deadRow('d2', 'e2')] };
      updates.push(sql);
      return { rows: [] };
    });
    const alerts: string[] = [];
    const r = await redriveDeadEvents({
      db,
      redrive: async () => false,
      onAlert: (m) => alerts.push(m),
    });
    expect(r).toEqual({ attempted: 1, resolved: 0, failed: 1 });
    const reschedule = updates.find((u) => u.includes('attempts = attempts + 1'))!;
    expect(reschedule).toContain('next_retry_at = now()');
    expect(reschedule).toContain("status = 'dead'");
    expect(alerts).toHaveLength(1);
  });

  it('redrive 抛错被吞 → 视作失败、退回 dead（不崩 sweeper 循环）', async () => {
    const { db } = scriptedDb((sql) =>
      sql.includes("SET status = 'retrying'") ? { rows: [deadRow('d3', 'e3')] } : { rows: [] },
    );
    const r = await redriveDeadEvents({
      db,
      redrive: async () => {
        throw new Error('processor exploded');
      },
    });
    expect(r.failed).toBe(1);
    expect(r.resolved).toBe(0);
  });

  it('无可补投死信 → attempted=0', async () => {
    const { db } = scriptedDb(() => ({ rows: [] }));
    const r = await redriveDeadEvents({ db, redrive: async () => true });
    expect(r).toEqual({ attempted: 0, resolved: 0, failed: 0 });
  });
});

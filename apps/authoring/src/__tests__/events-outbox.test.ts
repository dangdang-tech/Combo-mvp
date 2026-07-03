// B-13 · emitInTx 单测：与业务同事务写一行 outbox；event_id ON CONFLICT 幂等；event_id 模板。
import { describe, it, expect, vi } from 'vitest';
import { emitInTx, eventIdFor } from '../platform/events/outbox.js';
import type { Tx } from '../platform/events/db-tx.js';

function mockTx(rows: Array<{ seq: number } | undefined>): {
  tx: Tx;
  calls: Array<{ sql: string; params?: unknown[] }>;
} {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  let i = 0;
  const tx: Tx = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      const r = rows[i++];
      return { rows: r ? [r] : [] } as never;
    }),
  };
  return { tx, calls };
}

describe('emitInTx (B-13 outbox 同事务写入)', () => {
  it('写入一行：INSERT…ON CONFLICT(event_id) DO NOTHING RETURNING seq；inserted=true 带 seq', async () => {
    const { tx, calls } = mockTx([{ seq: 42 }]);
    const res = await emitInTx(tx, {
      eventId: 'published:v1:hashA',
      topic: 'capability.published',
      aggregateId: 'cap-1',
      payload: { capabilityId: 'cap-1', traceId: 'tr-1' },
      traceId: 'tr-1',
    });
    expect(res).toEqual({ inserted: true, seq: 42 });
    expect(calls[0]!.sql).toContain('INSERT INTO outbox_events');
    expect(calls[0]!.sql).toContain('ON CONFLICT (event_id) DO NOTHING');
    expect(calls[0]!.sql).toContain('RETURNING seq');
    // payload 以 JSON 串入参（jsonb 列）。
    expect(calls[0]!.params?.[0]).toBe('published:v1:hashA');
    expect(calls[0]!.params?.[3]).toBe(JSON.stringify({ capabilityId: 'cap-1', traceId: 'tr-1' }));
  });

  it('event_id 已存在（ON CONFLICT 0 行）→ inserted=false（生产侧幂等，重试不重复写）', async () => {
    const { tx } = mockTx([undefined]);
    const res = await emitInTx(tx, {
      eventId: 'import_done:job-1:0',
      topic: 'notify.import_completed',
      aggregateId: 'job-1',
      payload: { jobId: 'job-1' },
    });
    expect(res).toEqual({ inserted: false });
  });

  it('event_id 模板符合 §2.3 规约', () => {
    expect(eventIdFor.capabilityPublished('v1', 'h')).toBe('published:v1:h');
    expect(eventIdFor.capabilityUnpublished('c1', 100)).toBe('unpublished:c1:100');
    expect(eventIdFor.importCompleted('j1', 2)).toBe('import_done:j1:2');
    expect(eventIdFor.extractCompleted('j1', 0)).toBe('extract_done:j1:0');
    expect(eventIdFor.publishCompleted('v9')).toBe('publish_done:v9');
    expect(eventIdFor.reviewDecided('c1', 3)).toBe('review:c1:3');
  });
});

// B-14/B-35 · processor 单测：MarketplaceProjection（capability.*）+ NotifyConsumer（notify.*）。
//   - projection：published → upsert listing（card 源自版本 manifest）；unpublished → 软删 delisted；
//     被发布版不存在 → 抛错（lifecycle 卡住等人工，不放错状态）。
//   - notify：落站内通知（dedupe=event_id）+ 通道（inapp sent / lark,email pending）；重放 dedupe 命中不重复建通道。
import { describe, it, expect, vi } from 'vitest';
import { marketplaceProjection } from '../events/marketplace-projection.js';
import { notifyConsumer } from '../events/notify-consumer.js';
import type { Tx } from '../events/db-tx.js';
import type { FetchedEvent } from '../events/consumer-core.js';

function recordingTx(
  handler: (sql: string, params?: unknown[]) => { rows: unknown[]; rowCount?: number },
): {
  tx: Tx;
  calls: Array<{ sql: string; params?: unknown[] }>;
} {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  const tx: Tx = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      return handler(sql, params) as never;
    }),
  };
  return { tx, calls };
}

const baseOccurred = '2026-06-16T00:00:00.000Z';

describe('MarketplaceProjection (capability.*)', () => {
  it('capability.published → upsert listing（INSERT…SELECT manifest、ON CONFLICT(capability_id)）', async () => {
    const { tx, calls } = recordingTx(() => ({ rows: [], rowCount: 1 }));
    const evt: FetchedEvent = {
      seq: 1,
      eventId: 'published:v1:h',
      topic: 'capability.published',
      payload: {
        capabilityId: 'cap-1',
        versionId: 'v1',
        slug: 'my-cap',
        manifestHash: 'h',
        reviewStatus: 'alpha_pending',
        isRollback: false,
        ownerUserId: 'u1',
        traceId: 'tr-1',
        occurredAt: baseOccurred,
      },
      xid: 1,
    };
    await marketplaceProjection(tx, evt);
    expect(calls[0]!.sql).toContain('INSERT INTO marketplace_listings');
    expect(calls[0]!.sql).toContain('v.capability_id'); // INSERT…SELECT 源自版本
    expect(calls[0]!.sql).toContain('jsonb_build_object'); // 组装 MarketCard 投影（B-28）
    expect(calls[0]!.sql).toContain('to_tsvector'); // search_tsv 全文检索源（§5）
    expect(calls[0]!.sql).toContain('ON CONFLICT (capability_id)');
    // 封面版本级冻结（r3 P1）：读被展示版自身 cover_source（旧版兜 glyph），不再固定写 glyph/NULL。
    expect(calls[0]!.sql).toContain("COALESCE(v.cover_source, 'glyph')");
    // 守 visibility（Codex#5/r3 P1）：读被展示版自身冻结 v.visibility（非 mutable publications），CASE unlisted → status='unlisted'。
    expect(calls[0]!.sql).not.toContain('JOIN publications pub');
    expect(calls[0]!.sql).toContain(
      "WHEN COALESCE(v.visibility, 'public') = 'unlisted' THEN 'unlisted'",
    );
    expect(calls[0]!.params).toEqual(['cap-1', 'v1', 'my-cap', 'alpha_pending']);
  });

  it('守 visibility（Codex#5/r3 P1）：被展示版冻结 unlisted 投成 status=unlisted、public 投成 reviewStatus（不把私享投进公开市集）', async () => {
    // 数据型 mock：按 INSERT…SELECT 的 CASE 语义（读被展示版自身冻结 v.visibility），据 seeded 版本冻结 visibility
    //   计算 listing.status，落库验证。回退到上一版时按上一版冻结的 visibility（被展示版自身值，r3 P1）。
    function projectionDb(versionVisibility: 'public' | 'unlisted') {
      const listing: { status?: string } = {};
      const tx: Tx = {
        query: vi.fn(async (sql: string, params?: unknown[]) => {
          if (sql.includes('INSERT INTO marketplace_listings')) {
            // CASE WHEN COALESCE(v.visibility,'public')='unlisted' THEN 'unlisted' ELSE $4(reviewStatus) END
            listing.status =
              versionVisibility === 'unlisted' ? 'unlisted' : (params?.[3] as string);
            return { rows: [], rowCount: 1 } as never;
          }
          return { rows: [], rowCount: 0 } as never;
        }),
      };
      return { tx, listing };
    }
    const evt = (reviewStatus: 'alpha_pending' | 'published'): FetchedEvent => ({
      seq: 1,
      eventId: `published:v1:${reviewStatus}`,
      topic: 'capability.published',
      payload: {
        capabilityId: 'cap-1',
        versionId: 'v1',
        slug: 'my-cap',
        manifestHash: 'h',
        reviewStatus,
        isRollback: false,
        ownerUserId: 'u1',
        traceId: 'tr',
        occurredAt: baseOccurred,
      },
      xid: 1,
    });

    // unlisted → status=unlisted（不进公开 listing），无论 reviewStatus。
    const a = projectionDb('unlisted');
    await marketplaceProjection(a.tx, evt('published'));
    expect(a.listing.status).toBe('unlisted');

    // public → 按 reviewStatus（alpha_pending / published 进公开市集）。
    const b = projectionDb('public');
    await marketplaceProjection(b.tx, evt('alpha_pending'));
    expect(b.listing.status).toBe('alpha_pending');
  });

  it('capability.published 但版本不存在（0 行）→ 抛错（lifecycle 卡住等人工，不放错状态）', async () => {
    const { tx } = recordingTx(() => ({ rows: [], rowCount: 0 }));
    const evt: FetchedEvent = {
      seq: 1,
      eventId: 'published:v1:h',
      topic: 'capability.published',
      payload: {
        capabilityId: 'cap-x',
        versionId: 'v-missing',
        slug: 's',
        manifestHash: 'h',
        reviewStatus: 'published',
        isRollback: false,
        ownerUserId: 'u1',
        traceId: 'tr',
        occurredAt: baseOccurred,
      },
      xid: 1,
    };
    await expect(marketplaceProjection(tx, evt)).rejects.toThrow();
  });

  it('capability.unpublished → 软删 status=delisted', async () => {
    const { tx, calls } = recordingTx(() => ({ rows: [], rowCount: 1 }));
    const evt: FetchedEvent = {
      seq: 2,
      eventId: 'unpublished:cap-1:1',
      topic: 'capability.unpublished',
      payload: {
        capabilityId: 'cap-1',
        reason: 'review_rejected_no_prev',
        ownerUserId: 'u1',
        traceId: 'tr',
        occurredAt: baseOccurred,
      },
      xid: 1,
    };
    await marketplaceProjection(tx, evt);
    expect(calls[0]!.sql).toContain("status = 'delisted'");
    expect(calls[0]!.params).toEqual(['cap-1']);
  });
});

describe('NotifyConsumer (notify.*)', () => {
  it('import_completed → 站内通知（dedupe=event_id）+ 三通道（inapp sent / lark,email pending）', async () => {
    const { tx, calls } = recordingTx((sql) => {
      if (sql.includes('INSERT INTO notifications')) return { rows: [{ id: 'notif-1' }] };
      return { rows: [] };
    });
    const evt: FetchedEvent = {
      seq: 1,
      eventId: 'import_done:job-1:0',
      topic: 'notify.import_completed',
      payload: {
        recipientId: 'u1',
        link: '/creator/builder?step=import',
        traceId: 'tr',
        occurredAt: baseOccurred,
        jobId: 'job-1',
        attemptNo: 0,
        snapshotId: 'snap-1',
        segmentCount: 12,
      },
      xid: 1,
    };
    await notifyConsumer(tx, evt);
    const notifInsert = calls.find((c) => c.sql.includes('INSERT INTO notifications'))!;
    expect(notifInsert.sql).toContain('ON CONFLICT (recipient_id, dedupe_key) DO NOTHING');
    expect(notifInsert.params?.[0]).toBe('u1'); // recipient
    expect(notifInsert.params?.[5]).toBe('import_done:job-1:0'); // dedupe_key = event_id
    const channelInserts = calls.filter((c) => c.sql.includes('INSERT INTO notification_channels'));
    expect(channelInserts).toHaveLength(3);
    const channels = channelInserts.map((c) => c.params?.[1]);
    expect(channels).toEqual(['inapp', 'lark', 'email']);
    // inapp 落库即 sent；lark/email pending。
    expect(channelInserts.find((c) => c.params?.[1] === 'inapp')!.params?.[2]).toBe('sent');
    expect(channelInserts.find((c) => c.params?.[1] === 'lark')!.params?.[2]).toBe('pending');
  });

  it('重放 dedupe 命中（通知已存在，0 行 RETURNING）→ 不重复建通道（幂等）', async () => {
    const { tx, calls } = recordingTx((sql) => {
      if (sql.includes('INSERT INTO notifications')) return { rows: [] }; // ON CONFLICT 命中
      return { rows: [] };
    });
    const evt: FetchedEvent = {
      seq: 1,
      eventId: 'publish_done:v1',
      topic: 'notify.publish_completed',
      payload: {
        recipientId: 'u1',
        link: '/x',
        traceId: 'tr',
        occurredAt: baseOccurred,
        versionId: 'v1',
        capabilityId: 'cap-1',
        reviewStatus: 'alpha_pending',
      },
      xid: 1,
    };
    await notifyConsumer(tx, evt);
    expect(calls.filter((c) => c.sql.includes('INSERT INTO notification_channels'))).toHaveLength(
      0,
    );
  });

  it('review_decided rejected 带 rejectReason → 人话正文含原因（禁错误码）', async () => {
    const { tx, calls } = recordingTx((sql) =>
      sql.includes('INSERT INTO notifications') ? { rows: [{ id: 'n9' }] } : { rows: [] },
    );
    const evt: FetchedEvent = {
      seq: 1,
      eventId: 'review:cap-1:1',
      topic: 'notify.review_decided',
      payload: {
        recipientId: 'u1',
        link: '/x',
        traceId: 'tr',
        occurredAt: baseOccurred,
        capabilityId: 'cap-1',
        versionId: 'v1',
        decision: 'rejected',
        rejectReason: '描述与能力不符',
      },
      xid: 1,
    };
    await notifyConsumer(tx, evt);
    const notif = calls.find((c) => c.sql.includes('INSERT INTO notifications'))!;
    expect(notif.params?.[3]).toContain('描述与能力不符'); // body
    expect(notif.params?.[2]).toBe('评审未通过'); // title
  });
});

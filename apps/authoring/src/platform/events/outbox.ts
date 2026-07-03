// B-13 · outbox 写入助手（70 §2）。业务变更与 outbox 行【同一 PG 事务】写入 → 不丢不重。
//   - emitInTx(tx, evt)：在调用方已开启的事务句柄上 INSERT outbox_events 一行。
//     event_id 业务幂等键（§2.3 模板）+ UNIQUE 兜底 → 同一业务事件即便重试只一行（ON CONFLICT DO NOTHING）。
//   - seq（IDENTITY）/ xid（pg_current_xact_id()）/ created_at 由 DB 生成，记提交序水位（§2.2）。
// 硬规则③：发布成功必发事件、事件存在必发布成功——靠 emitInTx 与业务写入同事务（绝不另起事务）。
import type { OutboxTopic } from '@cb/shared';
import type { Tx } from './db-tx.js';

/** 一条待写入 outbox 的事件（payload 已是可序列化对象，含 traceId 贯穿）。 */
export interface OutboxEmit<P = unknown> {
  /** 业务幂等键（§2.3 模板，如 `published:{versionId}:{manifestHash}`）。同一事件只一行。 */
  eventId: string;
  topic: OutboxTopic;
  /** 聚合根 id（capabilityId/jobId/versionId/batchId）。 */
  aggregateId: string;
  payload: P;
  traceId?: string;
}

/** emitInTx 结果：是否真正写入（false = event_id 已存在，被 ON CONFLICT 去重，幂等无害）。 */
export interface EmitResult {
  inserted: boolean;
  /** 写入行的 seq（仅 inserted=true 时有值；用于排障/测试断言）。 */
  seq?: number;
}

/**
 * 在【调用方已开启的事务】内写一条 outbox_events（B-13，70 §2.1）。
 *   - 必须传业务事务的 tx（与业务行变更同连接同事务），不在内部开/提交事务。
 *   - ON CONFLICT (event_id) DO NOTHING：生产侧幂等，重试不产生重复事件行。
 *   - seq/xid/created_at 由 DB 默认生成（IDENTITY / pg_current_xact_id() / now()）。
 */
export async function emitInTx<P>(tx: Tx, evt: OutboxEmit<P>): Promise<EmitResult> {
  const res = await tx.query<{ seq: string | number }>(
    `INSERT INTO outbox_events (event_id, topic, aggregate_id, payload, trace_id)
     VALUES ($1, $2, $3, $4::jsonb, $5)
     ON CONFLICT (event_id) DO NOTHING
     RETURNING seq`,
    [evt.eventId, evt.topic, evt.aggregateId, JSON.stringify(evt.payload), evt.traceId ?? null],
  );
  const row = res.rows[0];
  if (!row) return { inserted: false };
  return { inserted: true, seq: Number(row.seq) };
}

// ---------- event_id 生成规约（§2.3，生产侧幂等键模板，集中收口避免各域漂移） ----------

export const eventIdFor = {
  /** capability.published：同版本同 manifest 只发一次（重发布=新版本=新 manifestHash）。 */
  capabilityPublished: (versionId: string, manifestHash: string): string =>
    `published:${versionId}:${manifestHash}`,
  /** capability.unpublished：同一下架动作不重复（按时间桶幂等）。 */
  capabilityUnpublished: (capabilityId: string, atEpochBucket: number | string): string =>
    `unpublished:${capabilityId}:${atEpochBucket}`,
  /** notify.import_completed：同 attempt 只通知一次；重入队新 attempt 视作新事件。 */
  importCompleted: (jobId: string, attemptNo: number): string =>
    `import_done:${jobId}:${attemptNo}`,
  /** notify.extract_completed：同上。 */
  extractCompleted: (jobId: string, attemptNo: number): string =>
    `extract_done:${jobId}:${attemptNo}`,
  /** notify.publish_completed：单条发布完成一次。 */
  publishCompleted: (versionId: string): string => `publish_done:${versionId}`,
  /** notify.review_decided：每轮评审决定通知一次。 */
  reviewDecided: (capabilityId: string, reviewRound: number | string): string =>
    `review:${capabilityId}:${reviewRound}`,
} as const;

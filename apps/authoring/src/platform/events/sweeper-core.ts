// B-16 §6.3 · sweeper outbox 滞留巡查 + dead_events 补投（70 §6.3）。纯逻辑，注入 Queryable + 回调。
//   §6.2 job 对账（fencing 重入队）由 jobs/sweeper-reconcile.ts 实现（worker/jobs 域），本模块不重复。
//   §6.4 orphan 清理涉真 S3，留集成（诚实推迟）。本模块只承担事件管道侧的滞留告警 + 死信补投。
//   不承担 consumer 保序（脊柱 §6.2 / B-16）。
import type { QueryableDb } from './db-tx.js';

/** §6.3 outbox 滞留巡查输入。 */
export interface StallScanDeps {
  db: QueryableDb;
  /** 滞留阈值毫秒（写入已久仍未被任一活跃 consumer 越过）。 */
  thresholdMs: number;
  /**
   * outbox topic → consumer_cursors.topic（cursorTopic）映射（P1 修复）。
   *   滞留判定须把 outbox 行与【该 topic 实际写入的 cursor 行】比对：
   *     - lifecycle（capability.published/unpublished）的 cursor topic 是合并字面量 `capability.*`（P0-2），
   *       不是 outbox 自身 topic；用 `cursor.topic = outbox.topic` 直比会把已消费的 capability.* 误报滞留。
   *     - notify 子 topic 的 cursor topic 即自身。
   *   通常由 registry.topicToCursorTopic() 注入（与 consumer-core 的 cursorTopic 同一真源）。
   *   缺省（未注入）= 退化为「cursor.topic = outbox.topic」直比（向后兼容；lifecycle 会误报，故生产须注入）。
   */
  topicToCursorTopic?: Record<string, string>;
  onAlert?: (info: StallReport) => void;
}

/** 一行滞留巡查结果（按 topic 计未越过 cursor 的滞留事件数）。 */
export interface StallReport {
  topic: string;
  stalledCount: number;
  oldestSeq: number;
}

/**
 * §6.3 outbox 投递滞留巡查（告警）：写入已久（created_at < now()-threshold）且 seq 超过
 *   该 topic 所有活跃 consumer cursor 的 max(last_seq) 的 outbox 行 = 滞留。
 *   lifecycle 滞留只告警不自动补（避免乱序补造成市集状态错乱，贯穿-26）；本函数只产出告警报表。
 */
export async function scanOutboxStall(deps: StallScanDeps): Promise<StallReport[]> {
  // outbox topic → cursorTopic 映射（P1）：把每个 outbox 行与【它实际写入的 cursor 行】比对。
  //   注入 map：用 LEFT JOIN 一张内联 VALUES 映射表把 outbox.topic 翻译成 cursorTopic（lifecycle→'capability.*'）；
  //            未在映射表中的 topic 退化为自身（COALESCE）。
  //   未注入：退化为「cursor.topic = outbox.topic」直比（向后兼容；lifecycle 会误报，生产须注入映射）。
  const map = deps.topicToCursorTopic;
  const entries = map ? Object.entries(map) : [];

  let sql: string;
  const params: unknown[] = [String(deps.thresholdMs)];
  if (entries.length > 0) {
    // 内联 VALUES 映射表：($2,$3),($4,$5),...（topic, cursor_topic）。参数化防注入。
    const tuples = entries.map((_e, i) => `($${2 + i * 2}, $${3 + i * 2})`).join(', ');
    for (const [topic, cursorTopic] of entries) params.push(topic, cursorTopic);
    sql = `WITH topic_map(topic, cursor_topic) AS (VALUES ${tuples})
     SELECT o.topic,
            count(*)   AS stalled_count,
            min(o.seq) AS oldest_seq
     FROM outbox_events o
     LEFT JOIN topic_map m ON m.topic = o.topic
     WHERE o.created_at < now() - ($1 || ' milliseconds')::interval
       AND o.seq > COALESCE(
             (SELECT max(c.last_seq) FROM consumer_cursors c
               WHERE c.topic = COALESCE(m.cursor_topic, o.topic)),
             0)
     GROUP BY o.topic`;
  } else {
    sql = `SELECT o.topic,
            count(*)   AS stalled_count,
            min(o.seq) AS oldest_seq
     FROM outbox_events o
     WHERE o.created_at < now() - ($1 || ' milliseconds')::interval
       AND o.seq > COALESCE(
             (SELECT max(c.last_seq) FROM consumer_cursors c WHERE c.topic = o.topic),
             0)
     GROUP BY o.topic`;
  }

  const res = await deps.db.query<{
    topic: string;
    stalled_count: string | number;
    oldest_seq: string | number;
  }>(sql, params);
  const reports: StallReport[] = res.rows.map((r) => ({
    topic: r.topic,
    stalledCount: Number(r.stalled_count),
    oldestSeq: Number(r.oldest_seq),
  }));
  for (const rep of reports) deps.onAlert?.(rep);
  return reports;
}

/** §6.3 dead_events 补投输入。 */
export interface RedriveDeps {
  db: QueryableDb;
  /** 重放一条死信（按 event_id 幂等，重放安全）；返回是否成功。 */
  redrive: (deadEvent: RedrivableDeadEvent) => Promise<boolean>;
  /** 单轮最多补投条数（默认 50）。 */
  limit?: number;
  onAlert?: (msg: string) => void;
}

export interface RedrivableDeadEvent {
  id: string;
  consumerName: string;
  topic: string;
  eventId: string;
  outboxSeq: number;
  payload: unknown;
}

/** 补投结果统计。 */
export interface RedriveResult {
  attempted: number;
  resolved: number;
  failed: number;
}

/**
 * §6.3 dead_events 自动补投：status='dead' AND next_retry_at<=now() 的 notify/metering 死信。
 *   先标 retrying（领取，防多实例重复补——sweeper 单活 + UPDATE…RETURNING + SKIP LOCKED 原子领取），
 *   重放成功 → status='resolved'；失败 → 退回 dead + attempts++ + 重排 next_retry_at（下轮再补）。
 *   lifecycle 不在 dead_events（卡住等人工），故本函数天然不触及 lifecycle。
 */
export async function redriveDeadEvents(deps: RedriveDeps): Promise<RedriveResult> {
  const limit = deps.limit ?? 50;
  const claimed = await deps.db.query<{
    id: string;
    consumer_name: string;
    topic: string;
    event_id: string;
    outbox_seq: string | number;
    payload: unknown;
  }>(
    `UPDATE dead_events
     SET status = 'retrying'
     WHERE id IN (
       SELECT id FROM dead_events
       WHERE status = 'dead' AND next_retry_at IS NOT NULL AND next_retry_at <= now()
       ORDER BY next_retry_at ASC
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id, consumer_name, topic, event_id, outbox_seq, payload`,
    [limit],
  );

  const result: RedriveResult = { attempted: claimed.rows.length, resolved: 0, failed: 0 };
  for (const row of claimed.rows) {
    const de: RedrivableDeadEvent = {
      id: row.id,
      consumerName: row.consumer_name,
      topic: row.topic,
      eventId: row.event_id,
      outboxSeq: Number(row.outbox_seq),
      payload: row.payload,
    };
    let ok = false;
    try {
      ok = await deps.redrive(de);
    } catch {
      ok = false;
    }
    if (ok) {
      await deps.db.query(
        `UPDATE dead_events SET status = 'resolved', resolved_at = now() WHERE id = $1`,
        [de.id],
      );
      result.resolved += 1;
    } else {
      await deps.db.query(
        `UPDATE dead_events
         SET status = 'dead',
             attempts = attempts + 1,
             next_retry_at = now() + (LEAST(1800000, 30000 * power(2, attempts)) || ' milliseconds')::interval
         WHERE id = $1`,
        [de.id],
      );
      result.failed += 1;
      deps.onAlert?.(`dead event redrive failed (rescheduled)`);
    }
  }
  return result;
}

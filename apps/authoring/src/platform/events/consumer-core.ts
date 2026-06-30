// B-14/B-15 · consumer 顺序拉取框架（70 §3/§4，唯一权威水位算法 = 脊柱 §11.D）。
//   - 连续安全前缀水位：SQL 不过滤 xid，应用层顺序扫描，遇首条 xid >= xmin 立即停（§11.D）。
//   - cursor 推进与事件处理【同一事务】（at-least-once + event_id 幂等 = effectively-once，§3.3）。
//   - 毒丸按 topic class（§4.1）：
//       lifecycle（capability.*）= 重试 + 卡住停 cursor + 告警，不进 dead_events、不跳过（保上架顺序）。
//       notify/metering        = 重试 N 次 → dead_events + cursor 跳过该条 + 告警（不阻塞后续）。
// 本模块是纯逻辑（注入 Tx + processor），无 PG/Redis 也能 mock 单测。
import { TOPIC_CLASS, type OutboxTopic, type TopicClass, type ErrorBody } from '@cb/shared';
import { withTransaction, type Tx, type TxPool } from './db-tx.js';

/** 拉取到的一条 outbox 行（消费侧最小视图）。 */
export interface FetchedEvent {
  seq: number;
  eventId: string;
  topic: OutboxTopic;
  payload: unknown;
  /** 写入事务 id（xid8，pg 以字符串回传 bigint）；与 xmin 比较走数值。 */
  xid: number;
}

/** processor：在【同一事务 tx】内执行事件副作用（投影/通知）；幂等（ON CONFLICT）。 */
export type EventProcessor = (tx: Tx, evt: FetchedEvent) => Promise<void>;

/**
 * 单个 consumer cursor 的消费配置（70 §3.4 / 脊柱 §11.D）。
 *
 * 一条配置 = 一个 consumer cursor 行（key = (consumerName, cursorTopic)）+ 一个【合并 topic 集合】。
 *   - NotifyConsumer：每个 notify 子 topic 一条配置（topics=[该 topic]、cursorTopic=该 topic）
 *     → 按 (consumer_name, topic) 拆多行游标，某子 topic 毒丸不卡其它（§4.1）。
 *   - MarketplaceProjection（lifecycle）：capability.published/unpublished 合成【一条】配置
 *     （topics=[capability.published, capability.unpublished]、cursorTopic=合并流 key）
 *     → 按 `topic IN (...) AND seq > cursor ORDER BY seq` 拉【合并流】、单 cursor 单调推进，
 *     保上架/下架严格全局 seq 顺序（不能按子 topic 拆游标，否则破坏合并流顺序）。
 *
 * 不变量：同一配置的所有 topics 必须同 class（合并流仅用于同 class 的 lifecycle 流）。
 */
export interface ConsumerTopicConfig {
  consumerName: string;
  /** 本配置消费的 topic 集合（合并流；notify 单元素，lifecycle 多元素合并）。 */
  topics: OutboxTopic[];
  /** consumer_cursors 行的 topic 列值（单 cursor key；合并流用稳定的合并 key）。 */
  cursorTopic: string;
  process: EventProcessor;
  /** 每批拉取上限（默认 100）。 */
  batchSize?: number;
  /** notify/metering 毒丸重试上限（默认 3，§4.2）。lifecycle 忽略此值（不入死信）。 */
  maxAttempts?: number;
  /** 退避基数毫秒（默认 30_000，§4.2）。 */
  backoffBaseMs?: number;
  /** 告警回调（lifecycle 卡住 / 毒丸落死信时调；不抛错、不阻塞）。 */
  onAlert?: (info: AlertInfo) => void;
}

export interface AlertInfo {
  kind: 'lifecycle_stuck' | 'poison_dead';
  consumerName: string;
  topic: OutboxTopic;
  eventId: string;
  seq: number;
  attempts: number;
  error: ErrorBody;
}

/** 一轮 runOnce 的统计（排障/测试断言/sweeper 滞留判断）。 */
export interface RunResult {
  /** 本轮成功处理并提交 cursor 的事件数。 */
  processed: number;
  /** 本轮落 dead_events 并跳过的事件数（notify/metering）。 */
  deadLettered: number;
  /** 是否因 lifecycle 毒丸卡住（cursor 停在卡住条，未前进）。 */
  stuck: boolean;
  /** 本轮结束时 cursor 的 last_seq。 */
  cursorSeq: number;
}

const DEFAULT_BATCH = 100;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BACKOFF_BASE_MS = 30_000;
const BACKOFF_CAP_MS = 30 * 60_000;

/**
 * 配置的 class（§4.1）：取首个 topic 的 class。合并流不变量保证所有 topics 同 class，
 * 故首个 topic 的 class 即整条配置的毒丸语义（lifecycle / notify / metering）。
 */
function classOf(cfg: ConsumerTopicConfig): TopicClass {
  const first = cfg.topics[0];
  return first ? TOPIC_CLASS[first] : 'notify';
}

/** 读 cursor.last_seq（按 cursorTopic 单行游标；缺行视作 0：从头消费）。 */
async function readCursorSeq(tx: Tx, consumerName: string, cursorTopic: string): Promise<number> {
  const res = await tx.query<{ last_seq: string | number }>(
    `SELECT last_seq FROM consumer_cursors WHERE consumer_name = $1 AND topic = $2`,
    [consumerName, cursorTopic],
  );
  const row = res.rows[0];
  return row ? Number(row.last_seq) : 0;
}

/** 取已提交水位 xmin（§11.D 第 1 步）：所有 xid < xmin 的事务已确定提交/回滚。 */
async function readXmin(tx: Tx): Promise<number> {
  const res = await tx.query<{ xmin: string | number }>(
    `SELECT pg_snapshot_xmin(pg_current_snapshot()) AS xmin`,
  );
  return Number(res.rows[0]?.xmin ?? 0);
}

/**
 * 权威取批（§11.D / 70 §3.2 权威 SQL）：**SQL 不过滤 xid**，把可能 unsafe 的行也读进来，
 * 水位裁剪交应用层连续前缀停判（下方 runOnce）。在 SQL 过滤 xid 会漏读低 seq 晚提交事件。
 *
 * 合并流：`topic IN (...) AND seq > cursor ORDER BY seq`。lifecycle（capability.*）多 topic 走此
 * 一条合并流、单 cursor 推进，保全局 seq 严格顺序（上架/下架不乱序）；notify 单 topic 退化为单元素 IN。
 */
async function fetchBatch(
  tx: Tx,
  topics: OutboxTopic[],
  cursorSeq: number,
  batch: number,
): Promise<FetchedEvent[]> {
  // $1=topics(数组 = ANY), $2=cursorSeq, $3=batch。ANY($1) 等价 topic IN (...)，参数化防注入。
  const res = await tx.query<{
    seq: string | number;
    event_id: string;
    topic: OutboxTopic;
    payload: unknown;
    xid: string | number;
  }>(
    `SELECT seq, event_id, topic, payload, xid
     FROM outbox_events
     WHERE topic = ANY($1)
       AND seq > $2
     ORDER BY seq ASC
     LIMIT $3`,
    [topics, cursorSeq, batch],
  );
  return res.rows.map((r) => ({
    seq: Number(r.seq),
    eventId: r.event_id,
    topic: r.topic,
    payload: r.payload,
    xid: Number(r.xid),
  }));
}

/**
 * cursor 推进（与处理副作用同事务）。upsert：首次无行则插入。
 * cursorTopic = consumer_cursors.topic 列值（单 cursor key）；合并流多 topic 共用同一 cursorTopic。
 */
async function advanceCursor(
  tx: Tx,
  consumerName: string,
  cursorTopic: string,
  seq: number,
  eventId: string,
): Promise<void> {
  await tx.query(
    `INSERT INTO consumer_cursors (consumer_name, topic, last_seq, last_event_id, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (consumer_name, topic)
     DO UPDATE SET last_seq = EXCLUDED.last_seq,
                   last_event_id = EXCLUDED.last_event_id,
                   updated_at = now()`,
    [consumerName, cursorTopic, seq, eventId],
  );
}

/**
 * notify/metering 毒丸落 dead_events（§4.3）+ 跳过该条（cursor 越过）。同一事务：写死信 + 推 cursor。
 * uq_dead_event(consumer_name,event_id) → ON CONFLICT 幂等（at-least-once 重放不重复落死信）。
 */
async function deadLetterAndSkip(
  cfg: ConsumerTopicConfig,
  tx: Tx,
  evt: FetchedEvent,
  attempts: number,
  error: ErrorBody,
): Promise<void> {
  // 冲突分支（上一轮已写 retrying 行，本轮达上限转 dead，Codex P1-new）：
  //   必须 next_retry_at = NULL（dead = 不自动补投、待人工/显式排期，70 §4.3 注释）。
  //   旧 bug：retrying 行冲突进 dead 时没清 next_retry_at，残留的退避到点会让 sweeper.redriveDeadEvents
  //   （status='dead' AND next_retry_at <= now()）立刻把刚跳过的毒丸自动补投 → 破坏「dead 后跳过/待人工」。
  //   同时 resolved_at=NULL（保证不是历史 resolved 残留），并同步 payload/topic/outbox_seq（以本次真值为准）。
  await tx.query(
    `INSERT INTO dead_events
       (consumer_name, topic, event_id, outbox_seq, payload, last_error, attempts, status, next_retry_at, resolved_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, 'dead', NULL, NULL)
     ON CONFLICT (consumer_name, event_id)
     DO UPDATE SET attempts = dead_events.attempts + 1,
                   last_error = EXCLUDED.last_error,
                   topic = EXCLUDED.topic,
                   outbox_seq = EXCLUDED.outbox_seq,
                   payload = EXCLUDED.payload,
                   status = 'dead',
                   next_retry_at = NULL,
                   resolved_at = NULL`,
    [
      cfg.consumerName,
      evt.topic,
      evt.eventId,
      evt.seq,
      JSON.stringify(evt.payload),
      JSON.stringify(error),
      attempts,
    ],
  );
  // 跳过该条：cursor 越过死信条，继续处理后续（notify 单条失败不阻塞其它，§4.1）。
  // 用 cfg.cursorTopic（单 cursor key），死信表仍记 evt.topic（真实子 topic）。
  await advanceCursor(tx, cfg.consumerName, cfg.cursorTopic, evt.seq, evt.eventId);
}

/**
 * 成功处理后清理死信（70 §6.3 / §4.4）：把该事件残留的 dead_events 行标 `resolved`（+ resolved_at）。
 *   - 处理成功 = 这条不再是毒丸 → 不应继续以 retrying/dead 悬留（否则「未入账 N 条」虚高、sweeper 还会去补投）。
 *   - WHERE 限 status <> 'resolved'：幂等（已 resolved 不重复写），且 0 行（从没进过死信 / lifecycle）= 无害。
 *   - 与「处理副作用 + cursor 推进」同事务：原子，绝不出现「处理成功但死信仍挂」的不一致（§3.3）。
 */
async function resolveDeadEvent(tx: Tx, consumerName: string, eventId: string): Promise<void> {
  await tx.query(
    `UPDATE dead_events
        SET status = 'resolved',
            resolved_at = now(),
            next_retry_at = NULL
      WHERE consumer_name = $1
        AND event_id = $2
        AND status <> 'resolved'`,
    [consumerName, eventId],
  );
}

/** 把任意抛出物收敛成人话 ErrorBody（禁堆栈，§4.4 / 脊柱 §3）；不暴露原始报错。 */
function toErrorBody(err: unknown, traceId: string): ErrorBody {
  return {
    userMessage: '事件处理失败，已记录待补投。',
    retriable: true,
    action: 'retry',
    traceId,
  };
}

/**
 * 跑一轮消费（B-14 主循环单步，便于测试与 sweeper 触发）。流程严格遵 §11.D：
 *   1) 一事务内读 cursor + xmin + 取批（无 xid 过滤）。
 *   2) 顺序扫描：xid < xmin 安全 → 同事务处理 + 推 cursor；遇首条 xid >= xmin 立即 break。
 *   3) 处理失败：
 *        lifecycle → 不进死信、不跳过、cursor 停在卡住条之前 → break（stuck=true）+ 告警。
 *        notify/metering → 重试上限内本轮 break（等下轮退避后重试，简化为达上限才落死信）；
 *          达 maxAttempts → 落 dead_events + 跳过 + 告警。
 *
 * 注：每条事件的「处理副作用 + cursor 推进」在【同一子事务】提交（§3.3）。这里以「每条一事务」
 *     实现 effectively-once；连续安全前缀的「停判」在应用层循环里做（不在 SQL）。
 */
export async function runOnce(pool: TxPool, cfg: ConsumerTopicConfig): Promise<RunResult> {
  const batch = cfg.batchSize ?? DEFAULT_BATCH;
  const maxAttempts = cfg.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const cls = classOf(cfg);

  // 取批在独立只读事务里做（拿一致的 xmin 快照 + 连续批）。合并流按 cfg.topics（topic IN）拉，
  // 单 cursor（cfg.cursorTopic）推进 → lifecycle 多 topic 保全局 seq 顺序。
  const { cursorSeq, xmin, events } = await withTransaction(pool, async (tx) => {
    const c = await readCursorSeq(tx, cfg.consumerName, cfg.cursorTopic);
    const x = await readXmin(tx);
    const e = await fetchBatch(tx, cfg.topics, c, batch);
    return { cursorSeq: c, xmin: x, events: e };
  });

  const result: RunResult = {
    processed: 0,
    deadLettered: 0,
    stuck: false,
    cursorSeq,
  };

  for (const evt of events) {
    // §11.D 第 3 步：遇首条 xid >= xmin（可能 in-flight）立即停，不处理它、不抢跑其后行。
    if (evt.xid >= xmin) break;

    // P1-5（§4.2 退避真生效）：notify/metering 处理前先看是否在退避窗内。
    //   上一轮失败写了 dead_events.status='retrying' + next_retry_at；若 next_retry_at > now()，
    //   说明退避未到 → **停在该条不处理、不推进 cursor**（下轮 1s 轮询时再判，到时才重试）。
    //   保序前提下顺序消费：停在本条 = 后续行同样不抢跑（与 lifecycle 卡住语义一致）。
    //   lifecycle 不入 dead_events，故 isBackingOff 永远 false（不影响 lifecycle 路径）。
    if (cls !== 'lifecycle' && (await isBackingOff(pool, cfg.consumerName, evt.eventId))) {
      break;
    }

    const traceId = (evt.payload as { traceId?: string })?.traceId ?? evt.eventId;
    try {
      // 每条：处理副作用 + cursor 推进，同一事务（§3.3，effectively-once）。
      //   成功后顺手把该事件残留的 dead_events 行标 resolved（70 §6.3：重放/重试成功 → status='resolved'，
      //   不再悬留 retrying/dead，「未入账 N 条」据此归零）。同事务原子：处理成功 = 死信已消，绝不出现
      //   「处理成功但死信还挂着」的不一致。lifecycle 不入 dead_events，此 UPDATE 0 行（无害）。
      await withTransaction(pool, async (tx) => {
        await cfg.process(tx, evt);
        await advanceCursor(tx, cfg.consumerName, cfg.cursorTopic, evt.seq, evt.eventId);
        await resolveDeadEvent(tx, cfg.consumerName, evt.eventId);
      });
      result.processed += 1;
      result.cursorSeq = evt.seq;
    } catch (err) {
      const errorBody = toErrorBody(err, traceId);
      if (cls === 'lifecycle') {
        // lifecycle：卡住等人工，不进死信、不跳过、cursor 停在卡住条之前（§4.1）。
        cfg.onAlert?.({
          kind: 'lifecycle_stuck',
          consumerName: cfg.consumerName,
          topic: evt.topic,
          eventId: evt.eventId,
          seq: evt.seq,
          attempts: 0,
          error: errorBody,
        });
        result.stuck = true;
        break;
      }
      // notify/metering：达重试上限 → 落 dead_events + 跳过；否则本轮停（等下轮退避重试）。
      const attempts = await currentAttempts(pool, cfg.consumerName, evt.eventId);
      if (attempts + 1 >= maxAttempts) {
        await withTransaction(pool, async (tx) => {
          await deadLetterAndSkip(cfg, tx, evt, attempts + 1, errorBody);
        });
        cfg.onAlert?.({
          kind: 'poison_dead',
          consumerName: cfg.consumerName,
          topic: evt.topic,
          eventId: evt.eventId,
          seq: evt.seq,
          attempts: attempts + 1,
          error: errorBody,
        });
        result.deadLettered += 1;
        result.cursorSeq = evt.seq;
        // 跳过后继续处理本批后续行（notify 单条失败不阻塞其它）。
        continue;
      }
      // 未达上限：记一次失败计数（落 retrying 死信行计数），本轮在该条停（下轮退避后重试）。
      await withTransaction(pool, async (tx) => {
        await recordRetry(cfg, tx, evt, attempts + 1, errorBody);
      });
      break;
    }
  }

  return result;
}

/** 查某事件当前已累计的失败次数（dead_events 计数，未达上限时累加重试）。 */
async function currentAttempts(
  pool: TxPool,
  consumerName: string,
  eventId: string,
): Promise<number> {
  return withTransaction(pool, async (tx) => {
    const res = await tx.query<{ attempts: string | number }>(
      `SELECT attempts FROM dead_events WHERE consumer_name = $1 AND event_id = $2`,
      [consumerName, eventId],
    );
    return res.rows[0] ? Number(res.rows[0].attempts) : 0;
  });
}

/**
 * P1-5 · 退避窗判断（§4.2）：该事件是否有 status='retrying' 且 next_retry_at > now() 的死信行。
 *   true = 尚在退避窗（不能立即重试）；false = 无 retrying 行 / 退避已到（可重试）。
 *   now() 比较走 DB（与写入 next_retry_at 同一时钟，避免应用/DB 时钟漂移误判），mock 单测可注入。
 */
async function isBackingOff(pool: TxPool, consumerName: string, eventId: string): Promise<boolean> {
  return withTransaction(pool, async (tx) => {
    const res = await tx.query<{ backing_off: boolean }>(
      `SELECT (next_retry_at IS NOT NULL AND next_retry_at > now()) AS backing_off
       FROM dead_events
       WHERE consumer_name = $1 AND event_id = $2 AND status = 'retrying'`,
      [consumerName, eventId],
    );
    return res.rows[0]?.backing_off === true;
  });
}

/** 记一次重试（未达上限）：dead_events 行 status='retrying' + attempts 累加 + 退避 next_retry_at。 */
async function recordRetry(
  cfg: ConsumerTopicConfig,
  tx: Tx,
  evt: FetchedEvent,
  attempts: number,
  error: ErrorBody,
): Promise<void> {
  const base = cfg.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
  const delayMs = Math.min(base * 2 ** Math.max(0, attempts - 1), BACKOFF_CAP_MS);
  await tx.query(
    `INSERT INTO dead_events
       (consumer_name, topic, event_id, outbox_seq, payload, last_error, attempts, status, next_retry_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, 'retrying', now() + ($8 || ' milliseconds')::interval)
     ON CONFLICT (consumer_name, event_id)
     DO UPDATE SET attempts = $7,
                   last_error = EXCLUDED.last_error,
                   status = 'retrying',
                   next_retry_at = EXCLUDED.next_retry_at`,
    [
      cfg.consumerName,
      evt.topic,
      evt.eventId,
      evt.seq,
      JSON.stringify(evt.payload),
      JSON.stringify(error),
      attempts,
      String(delayMs),
    ],
  );
}

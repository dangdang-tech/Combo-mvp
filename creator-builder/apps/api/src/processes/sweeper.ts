// sweeper 进程：job 对账（fencing 重入队）+ orphan 清理 + outbox 滞留补投（B-16）。
//   全局单实例（redis_hot 锁，§6.1）：拿到锁才进循环；拿不到待命（崩溃后 TTL 到期另一实例接管）。
//   本期实装：job 对账（reconcileJobsOnce：过期 running 换 fence 重入队，§6.2）、
//             outbox 滞留告警 + dead_events 补投（§6.3，事件管道侧，events/sweeper-core）。
//   诚实推迟：orphan 清理（§6.4，依赖 ObjectStore 列举/删除真集成）。
import { hostname } from 'node:os';
import { loadEnv } from '../config/env.js';
import { getPool } from '../infra/db.js';
import { getHotRedis } from '../infra/redis.js';
import { createRedisLock, LOCK_KEYS } from '../infra/lock.js';
import { createBullQueuePort } from '../infra/queue.js';
import { reconcileJobsOnce, pgTypeLookup, type ReEnqueue } from '../jobs/sweeper-reconcile.js';
import {
  scanOutboxStall,
  redriveDeadEvents,
  routeForTopic,
  topicToCursorTopic,
  withTransaction,
  asTxPool,
  type RedrivableDeadEvent,
} from '../events/index.js';

/** outbox 滞留告警阈值（写入超过此时长仍未被任一活跃 consumer 越过即告警，§6.3）。 */
const OUTBOX_STALL_THRESHOLD_MS = 60_000;

/** 巡查周期（毫秒）。 */
const SWEEP_INTERVAL_MS = 10_000;
/** 单活锁 TTL（须 > 巡查周期，周期续期）。 */
const LOCK_TTL_MS = 30_000;

function main(): void {
  const env = loadEnv();
  const db = getPool(env);
  const txPool = asTxPool(db);
  const lock = createRedisLock(getHotRedis(env));
  const instanceId = `${hostname()}#${process.pid}`;

  // 对账重入队用 QueuePort（带 fence 重新触发 BullMQ）。sweeper 配了 redis_queue 才能重入；
  // 未配则降级（只换 fence 不重入，下一轮仍可补——诚实：缺队列时重入队推迟）。
  const queue = createBullQueuePort(env);
  const reEnqueue: ReEnqueue = {
    enqueue: (jobType, jobId, fenceToken) => queue.enqueue(jobType, jobId as never, fenceToken),
  };
  const typeLookup = pgTypeLookup(db);

  let lockToken: string | undefined;
  let running = false;

  async function tick(): Promise<void> {
    if (running) return; // 防重入（上一轮未完）。
    running = true;
    try {
      // 单活：未持锁先抢；抢到才巡查（§6.1）。持锁则续期。
      if (!lockToken) {
        const acquired = await lock.acquire(LOCK_KEYS.sweeper, LOCK_TTL_MS);
        if (!acquired) return; // 别的实例在跑（待命，不巡查）。
        lockToken = acquired.token;
        console.log(`[sweeper] acquired single-active lock (instance=${instanceId})`);
      } else {
        const renewed = await lock.renew(LOCK_KEYS.sweeper, lockToken, LOCK_TTL_MS);
        if (!renewed) {
          // 续期失败（TTL 已过被别人抢）→ 放弃本实例持锁，下一轮重抢。
          lockToken = undefined;
          return;
        }
      }

      // —— job 对账（§6.2）：过期 running 换 fence 重入队 ——
      const res = await reconcileJobsOnce(db, reEnqueue, typeLookup).catch((err) => {
        console.error(`[sweeper] job 对账失败（仅告警，不影响在线请求）：${String(err)}`);
        return { reclaimed: 0, reEnqueued: 0, requeued: 0, requeuedQueued: 0 };
      });
      if (res.reclaimed > 0 || res.requeuedQueued > 0) {
        console.log(
          `[sweeper] 对账：重入队 ${res.reEnqueued} 条（过期 running ${res.reclaimed}、停滞 queued 补投 ${res.requeuedQueued}）`,
        );
      }

      // —— outbox 滞留告警（§6.3）：写入已久仍未被任一活跃 consumer 越过 → 告警（仅日志，外发推迟）——
      await scanOutboxStall({
        db,
        thresholdMs: OUTBOX_STALL_THRESHOLD_MS,
        // P1：按 topic→cursorTopic 映射比对（lifecycle 用合并 cursor 'capability.*'），不误报已消费 lifecycle。
        topicToCursorTopic: topicToCursorTopic(),
        onAlert: (info) =>
          console.warn(
            `[sweeper][alert] outbox 滞留 topic=${info.topic} 滞留=${info.stalledCount} 最早 seq=${info.oldestSeq}`,
          ),
      }).catch((err) => console.error(`[sweeper] outbox 滞留巡查失败（仅告警）：${String(err)}`));

      // —— dead_events 补投（§6.3）：可补投死信按 event_id 幂等重放（lifecycle 不在死信，天然不触及）——
      await redriveDeadEvents({
        db,
        redrive: (de) => redriveOne(txPool, de),
        onAlert: (msg) => console.warn(`[sweeper][alert] ${msg}`),
      }).catch((err) => console.error(`[sweeper] 死信补投失败（仅告警）：${String(err)}`));

      // —— 诚实推迟：orphan 清理（§6.4，ObjectStore 列举/删除真集成）——
    } finally {
      running = false;
    }
  }

  console.log(
    `[sweeper] booted; duties: job 对账（实装）/ orphan 清理（推迟）/ outbox 滞留补投（推迟）; ` +
      `interval=${SWEEP_INTERVAL_MS}ms`,
  );
  const timer = setInterval(() => void tick(), SWEEP_INTERVAL_MS);
  // 启动即跑一轮（不等首个周期）。
  void tick();

  const shutdown = (): void => {
    clearInterval(timer);
    void (async () => {
      if (lockToken) await lock.release(LOCK_KEYS.sweeper, lockToken).catch(() => undefined);
      process.exit(0);
    })();
  };
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, shutdown);
}

/** 补投一条死信（§6.3）：按 topic 找回 processor，同事务内重放副作用（event_id 幂等，重放安全）。 */
async function redriveOne(
  txPool: ReturnType<typeof asTxPool>,
  de: RedrivableDeadEvent,
): Promise<boolean> {
  const route = routeForTopic(de.topic);
  if (!route) return false; // 无 processor（冻结 topic）→ 不补投
  try {
    await withTransaction(txPool, async (tx) => {
      await route.process(tx, {
        seq: de.outboxSeq,
        eventId: de.eventId,
        topic: de.topic as never,
        payload: de.payload,
        xid: 0, // 重放不参与水位（已是确定提交的历史事件）
      });
    });
    return true;
  } catch {
    return false;
  }
}

main();

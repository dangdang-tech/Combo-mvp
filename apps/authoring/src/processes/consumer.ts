// consumer 进程：outbox 顺序消费（MarketplaceProjection + NotifyConsumer，B-14/B-15/B-35）。
//   - 启动级单实例防重（PG advisory lock，§3.1）：每个 consumer 一把锁，拿不到该 consumer 不消费。
//   - 连续安全前缀水位（§11.D）+ cursor 与处理同事务（§3.3）+ 按 topic 毒丸（§4）由 events 模块实现。
//   - 轮询循环：周期对每个活跃 (consumer, topic) 配置跑 runOnce；无 Docker 也能起进程（连不上即空转/退出）。
import { loadEnv } from '../platform/config/env.js';
import { getPool } from '../platform/infra/db.js';
import {
  asTxPool,
  asLockablePool,
  tryAcquireAdvisoryLock,
  runOnce,
  type AdvisoryLock,
  type ConsumerTopicConfig,
} from '../platform/events/index.js';
import { buildConsumerConfigs, CONSUMER_NAMES } from './event-routes.js';

const POLL_INTERVAL_MS = 1_000;

/** 本期需要拿锁的 consumer 名（MeteringConsumer 本期不启动，不拿锁、不消费）。 */
const ACTIVE_CONSUMER_NAMES = [CONSUMER_NAMES.marketplace, CONSUMER_NAMES.notify];

async function main(): Promise<void> {
  const env = loadEnv();
  const pool = getPool(env);
  const txPool = asTxPool(pool);
  const lockablePool = asLockablePool(pool);

  // 启动级单实例防重：每个 active consumer 取一把 advisory lock；拿不到 → 该 consumer 不消费（degraded）。
  const heldLocks: AdvisoryLock[] = [];
  const activeConsumers = new Set<string>();
  for (const name of ACTIVE_CONSUMER_NAMES) {
    try {
      const lock = await tryAcquireAdvisoryLock(lockablePool, `consumer:${name}`);
      if (lock.acquired) {
        heldLocks.push(lock);
        activeConsumers.add(name);
        console.log(`[consumer] acquired advisory lock for ${name}`);
      } else {
        console.warn(
          `[consumer] ${name} lock held elsewhere; this instance degraded (not consuming)`,
        );
      }
    } catch (err) {
      console.warn(`[consumer] ${name} lock attempt failed (DB unreachable?); degraded`, err);
    }
  }

  // 只对拿到锁的 consumer 跑配置（保序：单实例 + 锁）。
  const configs = buildConsumerConfigs((info) => {
    // 告警（飞书/日志，经 O-06 通道）：lifecycle 卡住 / 毒丸落死信。本期落日志（诚实推迟外发）。
    console.warn(
      `[consumer][alert] ${info.kind} consumer=${info.consumerName} topic=${info.topic} eventId=${info.eventId}`,
    );
  }).filter((c) => activeConsumers.has(c.consumerName));

  if (configs.length === 0) {
    console.warn('[consumer] no active consumer configs (all locks held elsewhere or DB down)');
  } else {
    console.log(
      `[consumer] booted; consuming cursors: ${configs
        .map((c) => `${c.cursorTopic}[${c.topics.join('+')}]`)
        .join(', ')}`,
    );
  }

  let stopped = false;
  const loop = async (): Promise<void> => {
    while (!stopped) {
      for (const cfg of configs) {
        try {
          await pollConsumer(txPool, cfg);
        } catch (err) {
          // 单 cursor 异常不拖垮整循环（连不上 DB 等）；下轮重试。
          console.warn(`[consumer] poll error cursor=${cfg.cursorTopic}`, err);
        }
      }
      await sleep(POLL_INTERVAL_MS);
    }
  };
  void loop();

  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      stopped = true;
      void Promise.allSettled(heldLocks.map((l) => l.release())).finally(() => process.exit(0));
    });
  }
}

/** 跑一个 topic 的多轮 runOnce 直到本批耗尽（processed=0 且未卡住 → 本轮无新事件，停）。 */
async function pollConsumer(
  txPool: ReturnType<typeof asTxPool>,
  cfg: ConsumerTopicConfig,
): Promise<void> {
  // 连续推进：一直跑到本轮没有新可处理事件（避免 1s 间隔下大批积压消费过慢）。
  // stuck（lifecycle 卡住）或 processed=0 且 deadLettered=0 → 本轮无进展，退出等下次 poll。
  for (;;) {
    const r = await runOnce(txPool, cfg);
    if (r.stuck) break;
    if (r.processed === 0 && r.deadLettered === 0) break;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
  console.error('[consumer] fatal', err);
  process.exit(1);
});

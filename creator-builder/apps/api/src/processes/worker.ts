// worker 进程：BullMQ job processor（import/extract/structure/publish_batch）。
//   每个已注册 JobType 一条 BullMQ Worker（队列 cb:{type}，连 redis_queue）。job 触发 → runJob 通用 runner：
//     领租约（fence）→ 跑 handler（受保护持久化 + redis_hot 推帧）→ 受保护落终态。
//   写库铁律（脊柱 §11.A）：runner/repo 内所有写回带 WHERE id=:jobId AND fence_token=:fence AND status='running'。
//   handler 由 3B-3E 经 registerHandler 注册；本期注册表可空（执行框架就绪、诚实标推迟具体 handler）。
import { Worker, type ConnectionOptions } from 'bullmq';
import { hostname } from 'node:os';
import type { JobType } from '@cb/shared';
import { ACTIVE_JOB_TYPES } from '@cb/shared';
import { loadEnv, type Env } from '../config/env.js';
import { getPool } from '../infra/db.js';
import { getHotRedis } from '../infra/redis.js';
import { RedisEventStream } from '../sse/event-stream.js';
import { getHandler, missingActiveHandlers, registeredTypes } from '../jobs/registry.js';
import { runJob } from '../jobs/runner.js';
// 副作用导入：3B-3E 的 handler 模块在此 import 时自注册。
import '../jobs/handlers/index.js'; // 3B import handler 自注册（B-19）；extract/structure/publish_batch 落位后在 index 内追加。

/** 整体超时分级（脊柱 §6 / 70 §8.3 LLM 40/45/60/180s）。runner 兜底超时按类型选档。 */
const TIMEOUT_BY_TYPE: Record<JobType, number> = {
  import: 600_000, // 导入可长（拉取/抹敏/切段）；细粒度续期防 sweeper 误判
  extract: 300_000,
  structure: 300_000,
  publish_batch: 180_000,
  evaluate: 60_000, // 冻结，不注册
  runtime_gen: 60_000, // 冻结，不注册
};

function connectionFor(env: Env): ConnectionOptions {
  const url = new URL(env.REDIS_QUEUE_URL);
  return {
    host: url.hostname,
    port: Number(url.port) || 6379,
    ...(url.password ? { password: url.password } : {}),
    db: url.pathname.length > 1 ? Number(url.pathname.slice(1)) : 0,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  };
}

function main(): void {
  const env = loadEnv();
  const db = getPool(env);
  const bridge = new RedisEventStream(getHotRedis(env));
  const leaseOwner = `${hostname()}#${process.pid}`;

  const missing = missingActiveHandlers();
  if (missing.length > 0) {
    // 诚实标推迟：缺 handler 的类型不起 Worker（不裸崩、不空转）；3B-3E 落位后自动启。
    console.warn(
      `[worker] 未注册 handler（暂不消费，待对应模块落位）：${missing.join(', ')}；` +
        `已注册：${registeredTypes().join(', ') || '（无）'}`,
    );
  }

  const workers: Worker[] = [];
  // 仅对【已注册 handler 且属本期四类】的类型起 Worker（脊柱 §6.3）。
  const startable = (ACTIVE_JOB_TYPES as readonly JobType[]).filter((t) => getHandler(t));
  for (const type of startable) {
    const worker = new Worker(
      `cb:${type}`,
      async (job) => {
        const handler = getHandler(type);
        if (!handler) return; // 防御：注册表运行期被清（不应发生）。
        // job.data.fenceToken 仅入队时记录、对账用；真正写库的 fence 取领租约时 DB 返回值（脊柱 §6.2），不取入队值。
        //   被 reclaimExpired 接管的行：claimLease 只接管租约、返回 reclaim 设定的 fence，绝不再 +1（Codex P1-r5：
        //   attempt 不跳号、执行 fence 与 BullMQ 触发 id 对齐、不出现 N+2）。
        const { jobId } = job.data as { jobId: string };
        const traceId = (job.data as { traceId?: string }).traceId ?? job.id ?? jobId;
        const outcome = await runJob(db, bridge, handler, jobId, {
          leaseOwner,
          traceId,
          timeoutMs: TIMEOUT_BY_TYPE[type],
          slowAfterMs: 30_000,
        });
        // outcome 仅用于 BullMQ 完成态/日志；jobs 表才是状态真源（脊柱 §6.1）。
        // fenced_out / not_claimed 不抛错（正常控制流，§11.A）：BullMQ 视作成功，不重试触发。
        return outcome;
      },
      {
        connection: connectionFor(env),
        concurrency: 1, // 单 job 单执行（fence 兜并发，但限并发降资源争用）。
      },
    );
    worker.on('failed', (job, err) => {
      // runner 已把业务失败落 jobs.failed（人话）；这里只记 BullMQ 框架级失败（连接/反序列化）。
      console.error(`[worker] bullmq job failed type=${type} id=${job?.id}: ${String(err)}`);
    });
    workers.push(worker);
  }

  console.log(
    `[worker] booted; leaseOwner=${leaseOwner}; ` +
      `active workers: ${startable.join(', ') || '（无——handler 待注册）'}`,
  );

  const shutdown = (): void => {
    void Promise.allSettled(workers.map((w) => w.close())).finally(() => process.exit(0));
  };
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, shutdown);

  // 无可启动 Worker 时保持进程存活（可启动性验证；handler 落位后重启即消费）。
  if (workers.length === 0) {
    const keepAlive = setInterval(() => {}, 1 << 30);
    for (const sig of ['SIGINT', 'SIGTERM'] as const)
      process.on(sig, () => {
        clearInterval(keepAlive);
      });
  }
}

main();

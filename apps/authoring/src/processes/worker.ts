// worker 进程：BullMQ job processor（import/extract/structure/publish_batch）。
//   每个已注册 JobType 一条 BullMQ Worker（队列名=jobType + prefix=QUEUE_PREFIX，连 redis_queue）。job 触发 → runJob 通用 runner：
//     领租约（fence）→ 跑 handler（受保护持久化 + redis_hot 推帧）→ 受保护落终态。
//   写库铁律（脊柱 §11.A）：runner/repo 内所有写回带 WHERE id=:jobId AND fence_token=:fence AND status='running'。
//   handler 由 3B-3E 经 registerHandler 注册；本期注册表可空（执行框架就绪、诚实标推迟具体 handler）。
import { Worker, type ConnectionOptions } from 'bullmq';
import { hostname } from 'node:os';
import pino, { type Logger } from 'pino';
import type { JobType } from '@cb/shared';
import { ACTIVE_JOB_TYPES, QUEUE_PREFIX } from '@cb/shared';
import { loadEnv, type Env } from '../platform/config/env.js';
import { getPool } from '../platform/infra/db.js';
import { getHotRedis } from '../platform/infra/redis.js';
import { RedisEventStream } from '../platform/sse/event-stream.js';
import { getHandler, missingActiveHandlers, registeredTypes } from '../platform/jobs/registry.js';
import { runJob } from '../platform/jobs/runner.js';
// 副作用导入：register-handlers 在此 import 时自注册全部 JobHandler（B-19；extract/structure/publish_batch）。
import './register-handlers.js';

/** 整体超时分级（脊柱 §6 / 70 §8.3 LLM 40/45/60/180s）。runner 兜底超时按类型选档。 */
const TIMEOUT_BY_TYPE: Record<JobType, number> = {
  import: 600_000, // 导入可长（拉取/抹敏/切段）；细粒度续期防 sweeper 误判
  extract: 300_000,
  structure: 300_000,
  publish_batch: 180_000,
  evaluate: 60_000, // 冻结，不注册
  runtime_gen: 60_000, // 冻结，不注册
};

/**
 * worker 进程的结构化 logger（pino，写 stdout/stderr）。
 *   worker 是独立进程、无 Fastify，必须自带 logger，否则 runner 的 log?.* 全是 no-op，
 *   job 失败的内部 code/堆栈完全不落 docker logs（排障只能进容器复现）——本次修复的核心。
 *   formatters.log 直透对象（与 app.ts 一致，按 traceId 串联）。开发期走 pino-pretty 易读。
 */
function buildWorkerLogger(env: Env): Logger {
  return pino({
    // env.LOG_LEVEL 在正常启动经 zod .default('info') 必有值；但部分测试以裁剪过的 env 桩调 main()
    //   （只给 REDIS_QUEUE_URL），LOG_LEVEL 为 undefined 会让 pino 抛 "default level:undefined ..."。
    //   兜底回 'info'（与 env schema 默认一致），保证 worker 进程任何入口都不因 logger 构造裸崩。
    level: env.LOG_LEVEL ?? 'info',
    base: { svc: 'worker' },
    formatters: { log: (obj) => obj },
    ...(env.NODE_ENV === 'development' ? { transport: { target: 'pino-pretty' } } : {}),
  });
}

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
  const log = buildWorkerLogger(env);
  const db = getPool(env);
  const bridge = new RedisEventStream(getHotRedis(env));
  const leaseOwner = `${hostname()}#${process.pid}`;

  const missing = missingActiveHandlers();
  if (missing.length > 0) {
    // 诚实标推迟：缺 handler 的类型不起 Worker（不裸崩、不空转）；3B-3E 落位后自动启。
    log.warn(
      { missing, registered: registeredTypes() },
      'worker: some active job types have no registered handler (not consuming, awaiting module landing)',
    );
  }

  const workers: Worker[] = [];
  // 仅对【已注册 handler 且属本期四类】的类型起 Worker（脊柱 §6.3）。
  const startable = (ACTIVE_JOB_TYPES as readonly JobType[]).filter((t) => getHandler(t));
  for (const type of startable) {
    // 队列名只留 jobType（禁含 ':'）；prefix=QUEUE_PREFIX 必须与生产端 Queue 完全一致，否则 job 入队但收不到。
    const worker = new Worker(
      type,
      async (job) => {
        const handler = getHandler(type);
        if (!handler) return; // 防御：注册表运行期被清（不应发生）。
        // job.data.fenceToken 仅入队时记录、对账用；真正写库的 fence 取领租约时 DB 返回值（脊柱 §6.2），不取入队值。
        //   被 reclaimExpired 接管的行：claimLease 只接管租约、返回 reclaim 设定的 fence，绝不再 +1（Codex P1-r5：
        //   attempt 不跳号、执行 fence 与 BullMQ 触发 id 对齐、不出现 N+2）。
        const { jobId } = job.data as { jobId: string };
        const traceId = (job.data as { traceId?: string }).traceId ?? job.id ?? jobId;
        const outcome = await runJob(
          db,
          bridge,
          handler,
          jobId,
          {
            leaseOwner,
            traceId,
            timeoutMs: TIMEOUT_BY_TYPE[type],
            slowAfterMs: 30_000,
          },
          log, // 注入 logger：让 runner 把 job 失败/fence-out 的内部 code+堆栈结构化落 stdout/stderr。
        );
        // outcome 仅用于 BullMQ 完成态/日志；jobs 表才是状态真源（脊柱 §6.1）。
        // fenced_out / not_claimed 不抛错（正常控制流，§11.A）：BullMQ 视作成功，不重试触发。
        return outcome;
      },
      {
        prefix: QUEUE_PREFIX, // 与生产端 Queue 一致的命名空间（Redis key `${QUEUE_PREFIX}:<type>:...`）。
        connection: connectionFor(env),
        concurrency: 1, // 单 job 单执行（fence 兜并发，但限并发降资源争用）。
      },
    );
    worker.on('failed', (job, err) => {
      // runner 已把业务失败落 jobs.failed（人话 + 内部日志）；这里记 BullMQ 框架级失败（连接/反序列化）
      //   及【重试耗尽】（attemptsMade >= attempts）——结构化落内部错误 message/stack + jobId/jobType/attempt/traceId，
      //   让 docker logs 直接可见，不必进容器复现。注意：这是服务端内部诊断日志，绝不外泄客户端。
      const data = (job?.data ?? {}) as { jobId?: string; traceId?: string };
      const attemptsMade = job?.attemptsMade ?? 0;
      const maxAttempts = job?.opts?.attempts ?? 1;
      log.error(
        {
          jobType: type,
          bullJobId: job?.id,
          jobId: data.jobId,
          traceId: data.traceId ?? job?.id,
          attempt: attemptsMade,
          maxAttempts,
          retriesExhausted: attemptsMade >= maxAttempts,
          err, // pino err 序列化器：带 message + stack（内部诊断）。
        },
        'bullmq job failed (framework-level / retries exhausted)',
      );
    });
    workers.push(worker);
  }

  log.info(
    { leaseOwner, activeWorkers: startable },
    `worker booted; active workers: ${startable.join(', ') || '(none — handlers pending)'}`,
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

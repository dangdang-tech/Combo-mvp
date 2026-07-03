// B-10/B-11 · BullMQ 队列封装（实现 shared QueuePort）。
//   - BullMQ 触发 jobId = **attempt 级唯一**（`${业务jobId}#${fenceToken}`，Codex P0-new）：
//       业务 jobId 放 data；同一业务 job 的重入队（sweeper 换 fence 后）产生【新触发】，
//       绝不命中旧触发的去重而被吞（旧 bug：用业务 jobId 作 BullMQ jobId，旧 job 未清时 add 命中去重不创建新触发，
//       reconcileJobsOnce 仍记成功，过期 running 永久无主）。
//       同 attempt（同 fenceToken）重复 add 仍幂等去重（第二道闸保留），但换 fence 必产生新触发。
//   - 分隔符用 '#' 而非 ':'（Codex P0-2nd）：BullMQ 5.78.1 对 **custom jobId** 同样禁冒号——
//       job.js validateOptions：jobId 含 ':' 且 split(':').length!==3 即抛 `Custom Id cannot contain :`，
//       两段 id（如 `job-1:1`）split 长度 2 必崩，job 入队即崩、主链路全断。'#' 不在被拒之列、
//       不与 jobId/fenceToken 自身字符冲突，故安全（详见 bullJobId 注释）。
//   - fenceToken 随 job data 入队（worker 写库的 fence 取领租约时 DB 换发值，入队值仅记录/对账，脊柱 §11.A）。
//   - PG jobs 表是状态唯一真源，BullMQ 只触发执行（脊柱 §6.1）。
//   - 取消/完成时按【业务 jobId】清理其【所有 attempt 触发】（扫队列里 data.jobId 匹配的所有 job，逐个 remove）。
// 骨架阶段：惰性建 Queue（不连 Redis 直到首次 enqueue），可 tsc/单测/启动冒烟无 Docker。
// 连接以 URL 形式传给 BullMQ（避免 BullMQ 自带 ioredis 与 workspace ioredis 的类型双实例冲突）。
import { Queue, type ConnectionOptions, type Job } from 'bullmq';
import type { JobId, JobType, QueuePort, TraceId } from '@cb/shared';
import { ACTIVE_JOB_TYPES, QUEUE_PREFIX } from '@cb/shared';
import type { Env } from '../config/env.js';

/**
 * BullMQ custom jobId 分隔符（Codex P0-2nd）。
 *   不能用 ':'：BullMQ 5.78.1 对 custom jobId 校验「含 ':' 且 split(':').length!==3 即抛
 *   `Custom Id cannot contain :`」（node_modules/.pnpm/bullmq@5.78.1/.../classes/job.js validateOptions）——
 *   两段 id（`job-1:1`，split 长度 2）必崩。'#' 不在被拒之列（校验只针对 ':'），也不与 jobId（UUID/ULID）
 *   或 fenceToken（数字）自身字符冲突，故选 '#'。本组件只【构造】此 id 当作 BullMQ 去重键，
 *   不反向解析它取回 jobId/fenceToken（业务 jobId/fence 走 job.data，见 enqueue）——故分隔符无解析侧需同步。
 */
export const BULL_JOB_ID_SEP = '#';

/**
 * BullMQ 触发 jobId（attempt 级唯一，Codex P0-new）：业务 jobId + fenceToken（用 BULL_JOB_ID_SEP 连接）。
 *   每次重入队 fence 必 +1（reclaimExpired），故触发 id 必不同 → 不被 BullMQ jobId 去重吞掉 → 产生新触发。
 *   同 attempt 内重复入队（同 fenceToken）= 同触发 id → 仍被去重（保留第二道幂等闸语义）。
 */
export function bullJobId(jobId: JobId, fenceToken: number): string {
  return `${jobId}${BULL_JOB_ID_SEP}${fenceToken}`;
}

/** BullMQ 连接配置（noeviction + AOF 的 redis_queue；maxRetriesPerRequest=null 是 BullMQ 硬要求）。 */
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

/** 仅四类有 processor（脊柱 §6.3）。用 string[] 视角做成员判定（避免 tuple 收窄参数类型）。 */
const ACTIVE_TYPES: readonly string[] = ACTIVE_JOB_TYPES;

/** 每个 JobType 一条队列（本期注册 import/extract/structure/publish_batch；后两类不注册）。 */
const queues = new Map<JobType, Queue>();

function queueFor(env: Env, jobType: JobType): Queue {
  let q = queues.get(jobType);
  if (!q) {
    // 队列名只留 jobType（禁含 ':'，BullMQ queue-base 会校验抛错）；命名空间走 prefix 选项。
    //   Redis key 仍是 `${QUEUE_PREFIX}:<jobType>:...`（原意保留）；prefix 必须与消费端 Worker 完全一致。
    q = new Queue(jobType, {
      prefix: QUEUE_PREFIX,
      connection: connectionFor(env),
      defaultJobOptions: {
        // 失败重试 ≤2（脊柱 §3.1：≤2 后才落终态错误信封）；退避指数。
        attempts: 3,
        backoff: { type: 'exponential', delay: 2_000 },
        removeOnComplete: { age: 3_600 },
        removeOnFail: { age: 86_400 },
      },
    });
    queues.set(jobType, q);
  }
  return q;
}

/**
 * 扫一条队列里所有 data.jobId 匹配给定业务 jobId 的 BullMQ job（含各 attempt 触发）。
 *   BullMQ 不按 data 建索引，故取「未完成 + 已完成/失败保留窗内」各态 job 后按 data.jobId 过滤。
 *   用于取消/完成时清理该业务 job 的所有 attempt 触发（attempt 级触发 id 后，getJob(业务jobId) 已找不到）。
 */
async function jobsForBusinessId(q: Queue, businessJobId: string): Promise<Job[]> {
  // 覆盖会“占位/可能再跑”的态：waiting/delayed/active/paused/prioritized + 保留窗内 completed/failed。
  const candidates = await q.getJobs(
    [
      'waiting',
      'delayed',
      'active',
      'paused',
      'prioritized',
      'completed',
      'failed',
      'waiting-children',
    ],
    0,
    -1,
  );
  return candidates.filter(
    (j) => (j?.data as { jobId?: string } | undefined)?.jobId === businessJobId,
  );
}

/**
 * BullMQ 实现的 QueuePort。
 *   - enqueue：BullMQ 触发 jobId = attempt 级唯一（bullJobId），业务 jobId/fence 放 data（Codex P0-new）。
 *   - remove：按业务 jobId 清理其所有 attempt 触发（fence 换新后旧执行已无法回写，但旧触发占位须清掉）。
 */
export function createBullQueuePort(env: Env): QueuePort {
  return {
    async enqueue(
      jobType: JobType,
      jobId: JobId,
      fenceToken: number,
      traceId?: TraceId,
    ): Promise<void> {
      if (!ACTIVE_TYPES.includes(jobType)) {
        // 仅四类有 processor（脊柱 §6.3）；其余拒绝入队（防误派）。
        throw new Error(`job type not registered: ${jobType}`);
      }
      // attempt 级触发 id：换 fence 必产生新触发（不被旧触发去重吞掉）；同 fence 重入仍幂等（第二道闸，脊柱 §4）。
      await queueFor(env, jobType).add(
        jobType,
        { jobId, fenceToken, ...(traceId ? { traceId } : {}) },
        { jobId: bullJobId(jobId, fenceToken) },
      );
    },
    async remove(jobId: JobId): Promise<void> {
      // 取消/完成语义（脊柱 §6.1）：从【全部活动 job 类型】的队列移除该业务 job 的【所有 attempt 触发】
      //   （fence 换新后旧执行已无法回写，但旧 BullMQ 触发若不清会一直占位/可被重投，故按 data.jobId 全清）。
      //   遍历 ACTIVE_JOB_TYPES 而非仅 queues.values()（Codex P1-r4）：冷启动/重启后本进程没预先实例化
      //   过这条业务 job 所属类型的队列（queues map 为空/缺该类型），若只扫进程内已建队列，取消会清不掉
      //   重启前 BullMQ 里已有的 attempt 触发 → worker 仍会被重投。queueFor 惰性建队列（仅连 Redis，不跑
      //   processor），故按类型补建后扫全队列各态即可清到（业务 jobId 只属一种类型，多扫几条空队列无害）。
      await Promise.allSettled(
        ACTIVE_JOB_TYPES.map(async (type) => {
          const q = queueFor(env, type);
          const jobs = await jobsForBusinessId(q, jobId);
          await Promise.allSettled(jobs.map((j) => j.remove()));
        }),
      );
    },
  };
}

/** 优雅关闭所有队列。 */
export async function closeQueues(): Promise<void> {
  await Promise.allSettled([...queues.values()].map((q) => q.close()));
  queues.clear();
}

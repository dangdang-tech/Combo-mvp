// B-16 · sweeper job 对账（脊柱 §6.2 / 70 §6.2）。
//   仅 lease_until 过期的 running job（worker 死/卡）→ reclaimExpired 换 fence + attempt_no+1（单条原子 UPDATE，§11.A）
//   → 以新 fence 重新入 BullMQ。旧 worker 即便复活，写入带旧 fence → 0 行 → 安全退出（脊柱 §6.2 铁律），不双写。
//   lease 未过期绝不抢；cancelled/终态不被重入（reclaimExpired 条件限 status='running'）。
import type { JobType } from '@cb/shared';
import type { Queryable } from './types.js';
import { reclaimExpired, requeuePending, staleQueued } from './repo.js';

/**
 * 停滞 queued 补投阈值（Codex P1-r2）：建后入队失败被吞、停留超过此时长仍 queued 无主的 job → 补投。
 *   须显著大于「在线建 job 到 BullMQ 触发 worker 领租约」的正常时延（避免误补刚建的健康 queued）。
 */
export const STALE_QUEUED_THRESHOLD_MS = 60_000;

/** 重入队回调：sweeper 不直连业务队列时由调用方注入（worker/api 持 QueuePort）。 */
export interface ReEnqueue {
  enqueue(jobType: JobType, jobId: string, fenceToken: number): Promise<void>;
}

/** 对账需要的 job 类型查询（reclaimExpired 只返 id/fence/attempt，重入队需 type）。 */
export interface JobTypeLookup {
  typeOf(jobId: string): Promise<JobType | undefined>;
}

export interface ReconcileResult {
  /** 本轮新接管（换 fence + attempt+1）的过期 running job 数。 */
  reclaimed: number;
  /** 本轮成功（重新）入 BullMQ 的 job 数（含新接管的 + 上一轮入队失败补入的 + 停滞 queued 补投的）。 */
  reEnqueued: number;
  /** 本轮补入队（running 被接管后入队失败、本轮用既有 fence 补入）成功的数（reEnqueued 的子集，便于观测）。 */
  requeued: number;
  /** 本轮停滞 queued 补投（建后入队失败被吞、长时间 queued 无主、用既有 fence 补投）成功的数（Codex P1-r2）。 */
  requeuedQueued: number;
}

/**
 * 跑一轮 job 对账（Codex P0-3 修复后）。
 *   1. requeuePending：上一轮已被接管（换过 fence）但【入队失败】、至今 running 无主的 job，
 *      用【既有 fence】补入 BullMQ（不再 +1 fence/attempt，不乱跳）。补成功后由 worker claimLease 接管。
 *   2. reclaimExpired：把【worker 持租后死/卡】的过期 running job 换 fence + attempt+1（单条原子 UPDATE，并发安全）。
 *   3. 对每条新接管的 job：以【新 fence】重新入 BullMQ（jobId 去重 + 带 fence）。
 *      入队失败不阻断其它条（记日志由调用方）；新 fence 已落库 + lease_until 置为已过去 →
 *      下一轮被 requeuePending 扫到补入队（幂等，绝不永久无主）。
 *   重入队用对应 fence：旧执行回写带旧 fence → 0 行安全退出，新 attempt 用新 fence 接管，绝不双写。
 *
 *   补入队先于接管：先消化历史欠账（避免无主 job 堆积），再处理新到期的。两个谓词互斥
 *   （requeuePending 限 lease_owner IS NULL，reclaimExpired 限 lease_owner IS NOT NULL），同一 job 同轮不重复处理。
 */
export async function reconcileJobsOnce(
  db: Queryable,
  reEnqueue: ReEnqueue,
  typeLookup: JobTypeLookup,
  limit = 50,
  staleQueuedThresholdMs = STALE_QUEUED_THRESHOLD_MS,
): Promise<ReconcileResult> {
  // 1. 补入队：上一轮换了 fence 但入队失败的无主 running job（用既有 fence，不再换）。
  const pending = await requeuePending(db, limit);
  let requeued = 0;
  for (const job of pending) {
    const type = await typeLookup.typeOf(job.id);
    if (!type) continue; // 查不到类型（极少：并发删）→ 跳过，下一轮再补。
    try {
      await reEnqueue.enqueue(type, job.id, job.fenceToken);
      requeued += 1;
    } catch {
      // 仍失败：fence/attempt 不变（不乱跳），下一轮 requeuePending 仍命中继续补（幂等）。
    }
  }

  // 2. 停滞 queued 补投（Codex P1-r2 防御纵深）：建后入队失败被吞、长时间仍 queued 无主的 job，
  //    用【既有 fence】补投 BullMQ（绝不换 fence/attempt——claimLease 领时再换）。消除「永久 queued 裸转圈」。
  const stale = await staleQueued(db, staleQueuedThresholdMs, limit);
  let requeuedQueued = 0;
  for (const job of stale) {
    const type = await typeLookup.typeOf(job.id);
    if (!type) continue; // 查不到类型 → 跳过，下一轮再补。
    try {
      await reEnqueue.enqueue(type, job.id, job.fenceToken);
      requeuedQueued += 1;
    } catch {
      // 仍失败：job 仍 queued 无主，下一轮 staleQueued 仍命中继续补（幂等，不放弃）。
    }
  }

  // 3. 接管：worker 持租后死/卡的过期 running job，换 fence + attempt+1。
  const reclaimed = await reclaimExpired(db, limit);
  let reEnqueuedNew = 0;
  for (const job of reclaimed) {
    const type = await typeLookup.typeOf(job.id);
    if (!type) continue; // 查不到类型（极少：并发删）→ 跳过；lease_until 已置过去，下一轮 requeuePending 补。
    try {
      await reEnqueue.enqueue(type, job.id, job.fenceToken);
      reEnqueuedNew += 1;
    } catch {
      // 入队失败：新 fence 已落库 + lease_until 已置为已过去（非 NULL）→
      // 下一轮被 requeuePending 扫到补入队（幂等，不再永久无主，Codex P0-3 核心修复）。
    }
  }

  return {
    reclaimed: reclaimed.length,
    reEnqueued: requeued + requeuedQueued + reEnqueuedNew,
    requeued,
    requeuedQueued,
  };
}

/** 基于 PG 的 typeOf 实现（sweeper 用）。 */
export function pgTypeLookup(db: Queryable): JobTypeLookup {
  return {
    async typeOf(jobId: string): Promise<JobType | undefined> {
      const res = await db.query<{ type: JobType }>('SELECT type FROM jobs WHERE id = $1', [jobId]);
      return res.rows[0]?.type;
    },
  };
}

// B-04 · Redis 双实例端口（70 §8.1）。redis_queue（BullMQ）/ redis_hot（streams/lock/限流）。
import type { JobId, TraceId } from '../core/ids.js';
import type { JobType } from '../core/jobs.js';

/** redis_queue：BullMQ 抽象（app 层用）。jobId 去重 + 带 fence。 */
export interface QueuePort {
  enqueue(jobType: JobType, jobId: JobId, fenceToken: number, traceId?: TraceId): Promise<void>;
  remove(jobId: JobId): Promise<void>;
}

/** redis_hot streams：SSE 源 + outbox 桥接不冲突。 */
export interface EventStreamPort {
  /** 返回 entry id（= SSE id，Last-Event-ID 用）。 */
  xadd(streamKey: string, frame: { event: string; data: unknown }): Promise<string>;
}

/** redis_hot 锁：sweeper 单活、consumer lease 备选。 */
export interface LockPort {
  acquire(key: string, ttlMs: number): Promise<{ token: string } | null>;
  renew(key: string, token: string, ttlMs: number): Promise<boolean>;
  release(key: string, token: string): Promise<void>;
}

/** Redis 双实例 env 名（70 §8.1）。 */
export const REDIS_ENV = {
  queueUrl: 'REDIS_QUEUE_URL',
  hotUrl: 'REDIS_HOT_URL',
} as const;

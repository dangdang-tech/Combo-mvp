// B-06 · 限流(并发/速率)。70 §8.3 行为契约①：预算闸(成本上限 + 匿名按 token 限流)。
//   生产应落 redis_hot 滑窗计数(70 §8.1：限流计数在 redis_hot)；本期提供进程内令牌桶兜底，
//   并保留 redis_hot 接入点(诚实推迟：跨实例一致限流留 Phase 5/6 接 redis_hot Lua 滑窗)。
import type { LlmRateLimiter, LlmClock } from './types.js';
import { realClock } from './types.js';

/** 进程内令牌桶配置。 */
export interface TokenBucketOptions {
  /** 每窗口允许的调用数(速率)。 */
  ratePerWindow: number;
  /** 窗口长度(ms)。 */
  windowMs: number;
  clock?: LlmClock;
}

interface BucketState {
  /** 当前可用令牌(浮点，按时间线性补充)。 */
  tokens: number;
  /** 上次补充时间(ms)。 */
  lastRefill: number;
}

/**
 * 进程内令牌桶限流(每 key 一桶)。线性补充：每 windowMs 恢复 ratePerWindow 个令牌。
 * 命中限流时返回建议等待秒数(到下一个令牌可用)。
 * 注意：仅单进程内有效；多副本/跨实例一致限流需 redis_hot(见 createRedisRateLimiter 诚实推迟说明)。
 */
export function createTokenBucketLimiter(opts: TokenBucketOptions): LlmRateLimiter {
  const clock = opts.clock ?? realClock;
  const { ratePerWindow, windowMs } = opts;
  const refillPerMs = ratePerWindow / windowMs;
  const buckets = new Map<string, BucketState>();

  return {
    async acquire(key: string): Promise<{ allowed: boolean; retryAfterSec?: number }> {
      const now = clock.now();
      let b = buckets.get(key);
      if (!b) {
        b = { tokens: ratePerWindow, lastRefill: now };
        buckets.set(key, b);
      }
      // 线性补充(封顶 ratePerWindow)。
      const elapsed = Math.max(0, now - b.lastRefill);
      b.tokens = Math.min(ratePerWindow, b.tokens + elapsed * refillPerMs);
      b.lastRefill = now;

      if (b.tokens >= 1) {
        b.tokens -= 1;
        return { allowed: true };
      }
      // 距离补满 1 个令牌还需的毫秒数 → 秒(向上取整，至少 1s)。
      const msToNext = (1 - b.tokens) / refillPerMs;
      const retryAfterSec = Math.max(1, Math.ceil(msToNext / 1000));
      return { allowed: false, retryAfterSec };
    },
  };
}

/** 永远放行的限流器(限流关闭时用，如本地冒烟/无预算闸场景)。 */
export const noopRateLimiter: LlmRateLimiter = {
  acquire: async () => ({ allowed: true }),
};

/**
 * redis_hot 滑窗限流(诚实推迟)：本期未接真 redis_hot，避免无 Redis 直跑时强连。
 * Phase 5/6 落 redis_hot Lua 原子滑窗(70 §8.1：限流计数在 redis_hot)实现跨实例一致限流。
 * 现回落进程内令牌桶，行为正确但不跨副本一致——诚实标注。
 */
export function createRedisRateLimiter(): LlmRateLimiter {
  // TODO(Phase 5/6): redis_hot ZADD/ZREMRANGEBYSCORE 滑窗 + Lua 原子判定。
  return createTokenBucketLimiter({ ratePerWindow: 60, windowMs: 60_000 });
}

// B-04 · redis_hot 分布式锁（实现 shared LockPort，70 §8.1）。
//   sweeper 单活（§6.1）、consumer 启动级防重备选（§3.1）。
//   acquire：SET key token NX PX ttl（不存在才置 + TTL）；renew：仅持锁者续 TTL（Lua CAS）；release：仅持锁者删（Lua CAS）。
//   崩溃后 TTL 到期自动释放 → 另一实例接管（lease 语义，永不死锁）。
import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { LockPort } from '@cb/shared';

// 仅当 value 匹配本实例 token 才续期（防误续别人的锁）。返回 1=续成功。
const RENEW_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
else
  return 0
end`;

// 仅当 value 匹配本实例 token 才删除（防误删别人 TTL 到期后新持有者的锁）。
const RELEASE_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
else
  return 0
end`;

/** redis_hot 锁实现。token 是本实例随机标识（CAS 用，防误续/误删）。 */
export function createRedisLock(redis: Redis): LockPort {
  return {
    async acquire(key: string, ttlMs: number): Promise<{ token: string } | null> {
      const token = randomUUID();
      const res = await redis.set(key, token, 'PX', ttlMs, 'NX');
      return res === 'OK' ? { token } : null;
    },
    async renew(key: string, token: string, ttlMs: number): Promise<boolean> {
      const res = (await redis.eval(RENEW_LUA, 1, key, token, String(ttlMs))) as number;
      return res === 1;
    },
    async release(key: string, token: string): Promise<void> {
      await redis.eval(RELEASE_LUA, 1, key, token).catch(() => undefined);
    },
  };
}

/** 单活循环 key 约定（70 §6.1 / §3.1）。 */
export const LOCK_KEYS = {
  sweeper: 'sweeper:lock',
  consumer: (name: string): string => `consumer:lock:${name}`,
} as const;

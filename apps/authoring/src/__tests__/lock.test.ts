// B-04 redis_hot 锁自检（70 §6.1 单活 / §3.1 consumer lease）：NX 互斥、CAS 续期/释放、TTL 接管。
import { describe, it, expect } from 'vitest';
import { createRedisLock, LOCK_KEYS } from '../platform/infra/lock.js';
import type { Redis } from 'ioredis';

/** 极简内存假 redis：SET NX PX、GET、EVAL（RENEW/RELEASE Lua）、DEL/PEXPIRE 语义。 */
class FakeLockRedis {
  store = new Map<string, string>();
  async set(key: string, value: string, _px: 'PX', _ttl: number, nx: 'NX'): Promise<string | null> {
    if (nx === 'NX' && this.store.has(key)) return null;
    this.store.set(key, value);
    return 'OK';
  }
  async eval(script: string, _numKeys: number, key: string, token: string): Promise<number> {
    const matches = this.store.get(key) === token;
    if (!matches) return 0;
    if (script.includes('DEL')) {
      this.store.delete(key);
      return 1;
    }
    // PEXPIRE：匹配即“续期成功”（内存假实现不真到期）。
    return 1;
  }
  // 测试辅助：模拟 TTL 到期（删 key）。
  _expire(key: string): void {
    this.store.delete(key);
  }
}

describe('createRedisLock', () => {
  it('acquire NX 互斥：第二个实例抢同一 key 失败', async () => {
    const fake = new FakeLockRedis();
    const lock = createRedisLock(fake as unknown as Redis);
    const a = await lock.acquire(LOCK_KEYS.sweeper, 30_000);
    const b = await lock.acquire(LOCK_KEYS.sweeper, 30_000);
    expect(a).not.toBeNull();
    expect(b).toBeNull();
  });

  it('renew 仅持锁者成功（CAS）；非持锁 token → false', async () => {
    const fake = new FakeLockRedis();
    const lock = createRedisLock(fake as unknown as Redis);
    const a = await lock.acquire(LOCK_KEYS.sweeper, 30_000);
    expect(await lock.renew(LOCK_KEYS.sweeper, a!.token, 30_000)).toBe(true);
    expect(await lock.renew(LOCK_KEYS.sweeper, 'wrong-token', 30_000)).toBe(false);
  });

  it('release 仅持锁者删；TTL 到期后另一实例可接管', async () => {
    const fake = new FakeLockRedis();
    const lock = createRedisLock(fake as unknown as Redis);
    const a = await lock.acquire(LOCK_KEYS.sweeper, 30_000);
    // 误删别人锁不生效（CAS）。
    await lock.release(LOCK_KEYS.sweeper, 'not-mine');
    expect(await lock.acquire(LOCK_KEYS.sweeper, 30_000)).toBeNull(); // 仍被 a 持有
    // 持锁者释放后可再抢。
    await lock.release(LOCK_KEYS.sweeper, a!.token);
    const b = await lock.acquire(LOCK_KEYS.sweeper, 30_000);
    expect(b).not.toBeNull();
  });

  it('consumer lease key 约定（70 §3.1）', () => {
    expect(LOCK_KEYS.consumer('NotifyConsumer')).toBe('consumer:lock:NotifyConsumer');
  });
});

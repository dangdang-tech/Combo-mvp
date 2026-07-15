import type { Redis } from 'ioredis';
import type { TurnGateStore } from '../../modules/agent/turn-gate.js';
import type { Env } from '../config/env.js';
import { getRedis, getRedisSubscriber } from './redis.js';

const INTERRUPT_CHANNEL = 'rt:turn:interrupt';
const gateKey = (sessionId: string): string => `rt:turn:gate:${sessionId}`;
const interruptKey = (sessionId: string): string => `rt:turn:intr:${sessionId}`;

const RENEW_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return {0, 0} end
redis.call('PEXPIRE', KEYS[1], ARGV[2])
if redis.call('GET', KEYS[2]) then
  redis.call('DEL', KEYS[2])
  return {1, 1}
end
return {1, 0}`;

const RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0`;

export function createRedisTurnGateStore(env: Env): TurnGateStore {
  const redis: Redis = getRedis(env);
  const subscriber: Redis = getRedisSubscriber(env);
  const listeners = new Set<(sessionId: string) => void>();
  let subscribed = false;

  return {
    async acquire(sessionId, owner, ttlMs) {
      const acquired = (await redis.set(gateKey(sessionId), owner, 'PX', ttlMs, 'NX')) === 'OK';
      if (acquired) await redis.del(interruptKey(sessionId));
      return acquired;
    },
    async renewAndReadInterrupt(sessionId, owner, ttlMs) {
      const result = (await redis.eval(
        RENEW_SCRIPT,
        2,
        gateKey(sessionId),
        interruptKey(sessionId),
        owner,
        ttlMs,
      )) as [number, number];
      return { owned: result[0] === 1, interrupted: result[1] === 1 };
    },
    async release(sessionId, owner) {
      await redis.eval(RELEASE_SCRIPT, 1, gateKey(sessionId), owner);
    },
    async isHeld(sessionId) {
      return (await redis.exists(gateKey(sessionId))) === 1;
    },
    async requestInterrupt(sessionId, flagTtlMs) {
      await redis.set(interruptKey(sessionId), '1', 'PX', flagTtlMs);
      await redis.publish(INTERRUPT_CHANNEL, sessionId);
    },
    subscribeInterrupts(cb) {
      listeners.add(cb);
      if (!subscribed) {
        subscribed = true;
        subscriber.on('message', (channel: string, sessionId: string) => {
          if (channel === INTERRUPT_CHANNEL) listeners.forEach((listener) => listener(sessionId));
        });
        void subscriber.subscribe(INTERRUPT_CHANNEL).catch(() => undefined);
      }
      return () => listeners.delete(cb);
    },
  };
}

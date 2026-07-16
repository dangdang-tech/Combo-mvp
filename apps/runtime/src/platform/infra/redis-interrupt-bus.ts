import type { Env } from '../config/env.js';
import { getRedis, getRedisSubscriber } from './redis.js';

const INTERRUPT_CHANNEL = 'rt:turn:interrupt';
const logFailure = (operation: string, err: unknown): void => {
  process.stderr.write(
    `[redis-interrupt-bus] ${operation} failed: ${err instanceof Error ? err.message : String(err)}\n`,
  );
};
export interface InterruptBus {
  publish(sessionId: string): void;
  subscribe(cb: (sessionId: string) => void): () => void;
}
export function createInterruptBus(): InterruptBus {
  const listeners = new Set<(sessionId: string) => void>();
  return {
    publish(sessionId) {
      listeners.forEach((listener) => listener(sessionId));
    },
    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}
export function createRedisInterruptBus(env: Env): InterruptBus {
  const listeners = new Set<(sessionId: string) => void>();
  let subscribed = false;
  return {
    publish(sessionId) {
      void getRedis(env)
        .publish(INTERRUPT_CHANNEL, sessionId)
        .catch((err) => logFailure('publish', err));
    },
    subscribe(cb) {
      listeners.add(cb);
      if (!subscribed) {
        subscribed = true;
        const subscriber = getRedisSubscriber(env);
        subscriber.on('message', (channel, sessionId) => {
          if (channel === INTERRUPT_CHANNEL) listeners.forEach((listener) => listener(sessionId));
        });
        void subscriber.subscribe(INTERRUPT_CHANNEL).catch((err) => logFailure('subscribe', err));
      }
      return () => listeners.delete(cb);
    },
  };
}

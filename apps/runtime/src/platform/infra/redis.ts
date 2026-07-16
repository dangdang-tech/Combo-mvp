// Redis 双连接：普通命令与订阅各用一个惰性单例，模块导入时不发起连接。
import { Redis } from 'ioredis';
import type { Env } from '../config/env.js';

let general: Redis | undefined;
let subscriber: Redis | undefined;

function createClient(env: Env): Redis {
  return new Redis(env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 2 });
}

export function getRedis(env: Env): Redis {
  general ??= createClient(env);
  return general;
}

export function getRedisSubscriber(env: Env): Redis {
  subscriber ??= createClient(env);
  return subscriber;
}

export async function pingRedis(env: Env): Promise<boolean> {
  try {
    return (await getRedis(env).ping()) === 'PONG';
  } catch {
    return false;
  }
}

export async function closeRedis(): Promise<void> {
  await Promise.all([
    general?.quit().catch(() => undefined),
    subscriber?.quit().catch(() => undefined),
  ]);
  general = undefined;
  subscriber = undefined;
}

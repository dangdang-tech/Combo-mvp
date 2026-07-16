import type { Env } from '../config/env.js';
import { getRedis, getRedisSubscriber } from './redis.js';

export interface PublishedStreamEvent {
  /** Redis Stream 条目 id，也是 SSE 断点续传锚点。 */
  id: string;
  event: Record<string, unknown>;
}

export interface SessionEventBus {
  publish(sessionId: string, event: PublishedStreamEvent): void;
  /** 订阅某会话的实时事件；返回退订函数。 */
  subscribe(sessionId: string, fn: (event: PublishedStreamEvent) => void): () => void;
}

export function createSessionEventBus(): SessionEventBus {
  const listeners = new Map<string, Set<(event: PublishedStreamEvent) => void>>();
  return {
    publish(sessionId, event) {
      const set = listeners.get(sessionId);
      if (!set) return;
      for (const fn of set) {
        try {
          fn(event);
        } catch {
          // 单个订阅者异常不影响其他订阅者与发布方。
        }
      }
    },
    subscribe(sessionId, fn) {
      let set = listeners.get(sessionId);
      if (!set) {
        set = new Set();
        listeners.set(sessionId, set);
      }
      set.add(fn);
      return () => {
        set.delete(fn);
        if (set.size === 0) listeners.delete(sessionId);
      };
    },
  };
}

const eventChannel = (sessionId: string): string => `rt:sess:evt:${sessionId}`;

/** Redis 发布订阅负责跨实例直播，每个进程在共享订阅连接上按会话扇出。 */
export function createRedisSessionEventBus(env: Env): SessionEventBus {
  const redis = getRedis(env);
  const subscriber = getRedisSubscriber(env);
  const listeners = new Map<string, Set<(event: PublishedStreamEvent) => void>>();

  subscriber.on('message', (channel: string, payload: string) => {
    const set = listeners.get(channel);
    if (!set) return;
    try {
      const parsed = JSON.parse(payload) as PublishedStreamEvent;
      if (typeof parsed.id !== 'string' || typeof parsed.event !== 'object' || !parsed.event)
        return;
      for (const listener of set) listener(parsed);
    } catch {
      // 非法直播消息只丢弃；Redis Stream 仍可在补读时恢复事件。
    }
  });

  return {
    publish(sessionId, event) {
      void redis.publish(eventChannel(sessionId), JSON.stringify(event)).catch(() => undefined);
    },
    subscribe(sessionId, fn) {
      const channel = eventChannel(sessionId);
      let set = listeners.get(channel);
      if (!set) {
        set = new Set();
        listeners.set(channel, set);
        void subscriber.subscribe(channel).catch(() => listeners.delete(channel));
      }
      set.add(fn);
      return () => {
        const current = listeners.get(channel);
        current?.delete(fn);
        if (current?.size === 0) {
          listeners.delete(channel);
          void subscriber.unsubscribe(channel).catch(() => undefined);
        }
      };
    },
  };
}

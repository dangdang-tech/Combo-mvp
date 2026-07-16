import type { Redis } from 'ioredis';
import {
  EVENT_STREAM_MAXLEN,
  EVENT_STREAM_TTL_MS,
  type SessionEventLog,
  type StreamEventEntry,
} from '../../modules/agent/event-log.js';
import type { Env } from '../config/env.js';
import { getRedis } from './redis.js';

const eventKey = (sessionId: string): string => `rt:sess:evt:${sessionId}`;

export function createRedisSessionEventLog(env: Env): SessionEventLog {
  const redis: Redis = getRedis(env);
  return {
    async append(sessionId, event) {
      const pipeline = redis.pipeline();
      pipeline.xadd(
        eventKey(sessionId),
        'MAXLEN',
        '~',
        EVENT_STREAM_MAXLEN,
        '*',
        'event',
        JSON.stringify(event),
      );
      pipeline.pexpire(eventKey(sessionId), EVENT_STREAM_TTL_MS);
      const results = await pipeline.exec();
      const first = results?.[0];
      if (!first || first[0] || typeof first[1] !== 'string')
        throw first?.[0] ?? new Error('XADD failed');
      return first[1];
    },
    async rangeAfter(sessionId, afterId, count) {
      const start = afterId === '0-0' ? '-' : `(${afterId}`;
      const rows = await redis.xrange(eventKey(sessionId), start, '+', 'COUNT', count);
      return rows.flatMap(([id, fields]): StreamEventEntry[] => {
        const eventIndex = fields.indexOf('event');
        const rawEvent = fields[eventIndex + 1];
        if (eventIndex < 0 || rawEvent === undefined) return [];
        const event = JSON.parse(rawEvent) as Record<string, unknown>;
        return [{ id, event }];
      });
    },
  };
}

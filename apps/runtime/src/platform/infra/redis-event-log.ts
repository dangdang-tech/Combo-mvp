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
const terminalKey = (sessionId: string, runId: string): string =>
  `rt:sess:terminal:${sessionId}:${runId}`;

// The marker and XADD live in one Redis script. A retry of the same terminal is
// idempotent; a competing terminal for the same run fails before a second XADD.
const APPEND_TERMINAL_SCRIPT = `
local existing = redis.call('GET', KEYS[2])
if existing then
  local separator = string.find(existing, '|', 1, true)
  if not separator then
    return redis.error_reply('TERMINAL_MARKER_INVALID')
  end
  local previous = string.sub(existing, separator + 1)
  if previous ~= ARGV[1] then
    return redis.error_reply('TERMINAL_EVENT_CONFLICT')
  end
  redis.call('PEXPIRE', KEYS[1], ARGV[3])
  redis.call('PEXPIRE', KEYS[2], ARGV[3])
  return string.sub(existing, 1, separator - 1)
end
local id = redis.call('XADD', KEYS[1], 'MAXLEN', '~', ARGV[2], '*', 'event', ARGV[1])
redis.call('PEXPIRE', KEYS[1], ARGV[3])
redis.call('SET', KEYS[2], id .. '|' .. ARGV[1], 'PX', ARGV[3])
return id
`;

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
    async appendTerminal(sessionId, runId, event) {
      const result = await redis.eval(
        APPEND_TERMINAL_SCRIPT,
        2,
        eventKey(sessionId),
        terminalKey(sessionId, runId),
        JSON.stringify(event),
        String(EVENT_STREAM_MAXLEN),
        String(EVENT_STREAM_TTL_MS),
      );
      if (typeof result !== 'string') throw new Error('terminal XADD failed');
      return result;
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

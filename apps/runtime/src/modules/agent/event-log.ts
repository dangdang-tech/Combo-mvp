export const EVENT_STREAM_MAXLEN = 20_000;
export const EVENT_STREAM_TTL_MS = 21_600_000;

export interface StreamEventEntry {
  id: string;
  event: Record<string, unknown>;
}

export interface SessionEventLog {
  append(sessionId: string, event: Record<string, unknown>): Promise<string>;
  rangeAfter(sessionId: string, afterId: string, count: number): Promise<StreamEventEntry[]>;
}

const STREAM_ID = /^(\d+)-(\d+)$/;

export function compareStreamIds(a: string, b: string): number {
  const left = STREAM_ID.exec(a);
  const right = STREAM_ID.exec(b);
  if (!left || !right) throw new Error('invalid Redis Stream id');
  const milliseconds = BigInt(left[1]!) - BigInt(right[1]!);
  if (milliseconds !== 0n) return milliseconds < 0n ? -1 : 1;
  const sequence = BigInt(left[2]!) - BigInt(right[2]!);
  return sequence === 0n ? 0 : sequence < 0n ? -1 : 1;
}

export function normalizeStreamId(raw: string | undefined): string {
  return raw && STREAM_ID.test(raw) ? raw : '0-0';
}

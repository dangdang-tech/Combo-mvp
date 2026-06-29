// B-12 · worker→api 进度桥（redis_hot Streams，70 §8.1 / 脊柱 §5）。
//   worker 进程 XADD 帧到 events:{kind}:{id}；api 进程 SSE 端点把它按 12 帧协议下发。
//   - publish：XADD（MAXLEN ~ 上限裁剪窗口），entry id = SSE id（Last-Event-ID 续传锚点）。
//   - replaySince：XRANGE (lastId, +]，判定是否仍在窗口内（超窗 = 该 id 已被 MAXLEN 裁掉 → 走 snapshot 重置）。
//   stream key 形如 events:job:{jobId}；XADD 用「* 」自动生成单调 entry id（ms-seq，时间有序）。
// redis_hot 用 allkeys-lru：流条目尽力而为、超窗即重置（snapshot 是真源），不影响断点续传正确性（脊柱 §5.4）。
import type { Redis } from 'ioredis';
import type { EventStreamPort, SSEEventType, SSEFrame } from '@cb/shared';
import type { ReplayResult } from '../plugins/sse.js';
import type { JobEventBridge } from '../jobs/types.js';

/** 每条 job 流保留的最大条目数（MAXLEN ~ 近似裁剪；超窗的旧 id 重连走 snapshot，脊柱 §5.4）。 */
export const STREAM_MAXLEN = 1_000;

/** 流条目 TTL（秒）：任务完成后流不必长留（snapshot/jobs.progress 才是恢复真源）。 */
export const STREAM_TTL_SEC = 3_600;

/** job 流 key（kind=job，脊柱 §9 流类型）。structure 流另走 events:structure:{versionId}（Phase 3 结构化接）。 */
export function jobStreamKey(jobId: string): string {
  return `events:job:${jobId}`;
}

/** 把 ioredis XRANGE 的返回 [id, [f1,v1,f2,v2,...]] 解析成 SSEFrame。 */
function parseEntry(id: string, fields: string[]): SSEFrame | null {
  let event: string | undefined;
  let data: string | undefined;
  for (let i = 0; i + 1 < fields.length; i += 2) {
    if (fields[i] === 'event') event = fields[i + 1];
    else if (fields[i] === 'data') data = fields[i + 1];
  }
  if (!event) return null;
  let payload: unknown = undefined;
  if (data !== undefined) {
    try {
      payload = JSON.parse(data);
    } catch {
      payload = data;
    }
  }
  return { id, event: event as SSEEventType, payload };
}

/**
 * redis_hot Streams 事件桥。同时实现 EventStreamPort（端口契约，70 §8.1）与 JobEventBridge（worker 侧）。
 *   - api 进程：用 replaySince 做 Last-Event-ID 窗口补发（SSE 端点 opts.replaySince 注入）。
 *   - worker 进程：用 publish 把 progress/subtask/item/field/done/error 帧推上来。
 */
export class RedisEventStream implements EventStreamPort, JobEventBridge {
  constructor(private readonly redis: Redis) {}

  /** XADD 一帧到任意流 key（EventStreamPort）。返回 entry id（= SSE id）。 */
  async xadd(streamKey: string, frame: { event: string; data: unknown }): Promise<string> {
    const id = await this.redis.xadd(
      streamKey,
      'MAXLEN',
      '~',
      String(STREAM_MAXLEN),
      '*',
      'event',
      frame.event,
      'data',
      JSON.stringify(frame.data),
    );
    // 流首次创建后续期 TTL（尽力而为；流不是恢复真源）。
    await this.redis.expire(streamKey, STREAM_TTL_SEC).catch(() => undefined);
    return id ?? '';
  }

  /** worker 推一帧到 job 流（JobEventBridge）。失败吞掉不抛（推流尽力而为，jobs.progress 才是真源）。 */
  async publish(
    jobId: string,
    frame: { event: SSEEventType; payload: unknown },
  ): Promise<string | null> {
    try {
      return await this.xadd(jobStreamKey(jobId), { event: frame.event, data: frame.payload });
    } catch {
      return null; // 推流失败不阻断 worker（已落 jobs.progress；前端可靠靠 snapshot）。
    }
  }

  /**
   * 流当前最新 entry id（XREVRANGE + COUNT 1）。无条目（流不存在/为空）→ '0-0'（从头读，等价订阅全部后续）。
   *   SSE 建流走 snapshot 路径时，先取此 id，再 loadSnapshot，再从此 id 起 XREAD BLOCK 持续订阅——
   *   gap-free：此 id 之后 XADD 的帧必被订阅捕获；snapshot 与订阅间可能重叠一两帧（前端按 percent/状态幂等吸收，不漏即可）。
   */
  async latestId(jobId: string): Promise<string> {
    try {
      const raw = (await this.redis.xrevrange(jobStreamKey(jobId), '+', '-', 'COUNT', 1)) as Array<
        [string, string[]]
      >;
      return raw[0]?.[0] ?? '0-0';
    } catch {
      return '0-0'; // 拿不到 → 从头订阅（保守，宁可重叠不漏，绝不裸转圈）。
    }
  }

  /**
   * 持续订阅 job 流（Codex P0-1 核心）：从 fromId 起 `XREAD BLOCK <ms> STREAMS key <id>` 循环，
   * 每读到新帧调 onFrame（SSE 端点据此 push 给在线连接），实时下发 worker 后续 progress/subtask/item/field/done/error 帧。
   *   - 用【独立 duplicate 连接】：XREAD BLOCK 会独占连接，绝不能占用共享 redisHot。
   *   - signal.abort（客户端断开 / 收到终态帧后由调用方触发）→ 跳出循环 + quit/disconnect 独立连接，清理 reader（防泄漏）。
   *   - 异常（连接抖动等）→ 短暂退避后重试，仍受 signal 控制；不抛给调用方（推流尽力而为，snapshot/jobs.progress 才是真源）。
   *   返回的 Promise 在订阅结束（abort）后 resolve。
   */
  async subscribe(
    jobId: string,
    fromId: string,
    onFrame: (frame: SSEFrame) => void,
    signal: AbortSignal,
    blockMs = 15_000,
  ): Promise<void> {
    if (signal.aborted) return;
    const key = jobStreamKey(jobId);
    // 独立阻塞连接：XREAD BLOCK 独占，不碰共享 redisHot（否则会阻塞别的 redisHot 调用）。
    const conn = this.redis.duplicate();
    let lastId = fromId;
    const onAbort = (): void => {
      // 强制中断阻塞中的 XREAD：断开独立连接（quit 在 BLOCK 中可能不返回，用 disconnect 立即断）。
      conn.disconnect();
    };
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      while (!signal.aborted) {
        let res: Array<[string, Array<[string, string[]]>]> | null = null;
        try {
          res = (await conn.xread('BLOCK', blockMs, 'STREAMS', key, lastId)) as Array<
            [string, Array<[string, string[]]>]
          > | null;
        } catch {
          if (signal.aborted) break;
          // 连接抖动：短退避后重试（仍受 signal 控制；连接被 disconnect 后 ioredis 会自动重连）。
          await delay(200, signal);
          continue;
        }
        if (!res) continue; // BLOCK 超时无新帧：继续等（心跳由 SSE 插件单独发，这里只管业务帧）。
        for (const [, entries] of res) {
          for (const [id, fields] of entries) {
            lastId = id; // 推进游标，下轮从此 id 之后读。
            const f = parseEntry(id, fields);
            if (f) onFrame(f);
          }
        }
      }
    } finally {
      signal.removeEventListener('abort', onAbort);
      // 清理独立连接（防连接泄漏）。disconnect 幂等。
      try {
        conn.disconnect();
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * Last-Event-ID 窗口补发（脊柱 §5.4）。XRANGE (lastEventId, +] 取该 id 之后的增量。
   *   判定在窗口内的口径：lastEventId 不早于流当前最小 id（XINFO FIRST-ENTRY）。
   *     - 流为空 / 最小 id 已 > lastEventId（被 MAXLEN 裁掉）→ 超窗 → inWindow=false → 调用方走 snapshot 重置。
   *     - 否则 inWindow=true，返回 (lastEventId, +] 增量帧（exclusive 用 '(' 前缀）。
   */
  async replaySince(jobId: string, lastEventId: string): Promise<ReplayResult> {
    const key = jobStreamKey(jobId);
    try {
      // 流最早条目：判超窗。XINFO STREAM → first-entry。
      const info = (await this.redis.xinfo('STREAM', key)) as unknown[];
      const firstEntryId = extractFirstEntryId(info);
      // 流为空或拿不到首条 → 视为超窗（保守，走 snapshot 重置，绝不漏）。
      if (!firstEntryId) return { inWindow: false, frames: [] };
      // lastEventId 早于流最早条目 → 它之后的部分可能已被裁 → 超窗。
      if (compareStreamId(lastEventId, firstEntryId) < 0) return { inWindow: false, frames: [] };

      // (lastEventId, +]：exclusive 起点用 '(' 前缀（Redis 6.2+ XRANGE 支持）。
      const raw = (await this.redis.xrange(key, `(${lastEventId}`, '+')) as Array<
        [string, string[]]
      >;
      const frames: SSEFrame[] = [];
      for (const [id, fields] of raw) {
        const f = parseEntry(id, fields);
        if (f) frames.push(f);
      }
      return { inWindow: true, frames };
    } catch {
      // 流不存在 / Redis 异常 → 保守超窗（走 snapshot 重置，永不裸转圈、永不漏）。
      return { inWindow: false, frames: [] };
    }
  }
}

/** 从 XINFO STREAM 扁平数组里取 first-entry 的 id（[..., 'first-entry', [id, [fields...]], ...]）。 */
function extractFirstEntryId(info: unknown[]): string | undefined {
  for (let i = 0; i + 1 < info.length; i += 2) {
    if (info[i] === 'first-entry') {
      const entry = info[i + 1];
      if (Array.isArray(entry) && typeof entry[0] === 'string') return entry[0];
    }
  }
  return undefined;
}

/**
 * 比较两个 Redis Stream id（'ms-seq'）。a<b → 负；a==b → 0；a>b → 正。
 *   缺 seq 视为 0（'1718' == '1718-0'）。用于「lastEventId 是否早于流最早条目」的超窗判定。
 */
export function compareStreamId(a: string, b: string): number {
  const [ams, aseq] = splitId(a);
  const [bms, bseq] = splitId(b);
  if (ams !== bms) return ams < bms ? -1 : 1;
  if (aseq !== bseq) return aseq < bseq ? -1 : 1;
  return 0;
}
function splitId(id: string): [bigint, bigint] {
  const [ms, seq] = id.split('-');
  return [safeBig(ms), safeBig(seq)];
}
function safeBig(s: string | undefined): bigint {
  if (!s) return 0n;
  try {
    return BigInt(s);
  } catch {
    return 0n;
  }
}

/** 可被 signal 提前唤醒的 sleep（订阅重试退避用；abort 时立即 resolve，不挂住关流）。 */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (typeof t.unref === 'function') t.unref();
    const onAbort = (): void => {
      clearTimeout(t);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

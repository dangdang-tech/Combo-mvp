// SSE 插件。永不裸转圈的核心机制：
//   真实 text/event-stream 流：握手 + 连接即 state_snapshot + 心跳 + Last-Event-ID 恢复协议。
//   - 帧格式：id:（= Redis Stream entry id，Last-Event-ID 用）/ event: / data:。
//   - 连接首帧：Last-Event-ID 仍在窗口内 → 从该 id 之后补发增量（不重推 snapshot）；
//     超窗 / 无 Last-Event-ID → 先推 state_snapshot 全量重置，再续流。
//   - 心跳发【具名 heartbeat 帧】+ data:{ts}（不是不可观测的 SSE comment）——前端 EventSource
//     收得到具名事件、watchdog 据此复位，空业务流不反复重连。
//   鉴权统一同源 Cookie、建流前 HTTP 失败——由路由 requireSseAuth preHandler 守，不在本插件。
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  SSE_HEARTBEAT_INTERVAL_MS,
  TRACE_ID_HEADER,
  TRACEPARENT_HEADER,
  type SSEEventType,
  type SSEFrame,
  type StateSnapshotPayload,
} from '@cb/shared';
import { currentTraceparent } from '../observability/node.js';

/** 取 Last-Event-ID（fetch-event-source 重连自动带此头）。 */
export function getLastEventId(req: FastifyRequest): string | undefined {
  const h = req.headers['last-event-id'];
  if (typeof h === 'string' && h.length > 0) return h;
  if (Array.isArray(h) && h.length > 0) return h[0];
  return undefined;
}

/** 单帧写入：标准 SSE 格式（id/event/data）。 */
export function writeSseFrame(
  reply: FastifyReply,
  frame: { id?: string; event: SSEEventType; payload: unknown },
): void {
  const lines: string[] = [];
  if (frame.id) lines.push(`id: ${frame.id}`);
  lines.push(`event: ${frame.event}`);
  lines.push(`data: ${JSON.stringify(frame.payload)}`);
  lines.push('', ''); // 帧间空行
  reply.raw.write(lines.join('\n'));
}

/** 具名 heartbeat 帧。不带 id（不进 Last-Event-ID 续传序，纯探活）。 */
function writeHeartbeat(reply: FastifyReply): void {
  writeSseFrame(reply, { event: 'heartbeat', payload: { ts: Date.now() } });
}

/**
 * Last-Event-ID 窗口补发结果。
 *   - inWindow=true：id 仍在 Stream 窗口内，frames 是该 id 之后的增量（不重推 snapshot）。
 *   - inWindow=false：超窗（id 已被裁剪）→ 调用方先推 snapshot 再续流。
 */
export interface ReplayResult {
  inWindow: boolean;
  frames: SSEFrame[];
}

/** 建流入参：首帧 snapshot 取数 + 可选 Last-Event-ID 窗口补发 + 持续订阅 + 终态补帧。 */
export interface SseStreamOptions {
  /** 计算首帧 state_snapshot 全量。 */
  loadSnapshot: () => Promise<StateSnapshotPayload>;
  /** Last-Event-ID（重连补发用）。 */
  lastEventId?: string;
  /** Last-Event-ID 窗口补发：返回是否在窗口内 + 窗口内增量帧。缺省 = 视为超窗（走 snapshot 重置）。 */
  replaySince?: (lastEventId: string) => Promise<ReplayResult>;
  /**
   * 持续订阅业务流：建流后从 fromId 起持续读 Redis Stream，把 worker 后续帧经 onFrame 实时
   * push 给在线连接。fromId：窗口内 resume → 最后一帧 replayed id；snapshot 路径 → 建流前抓取的
   * 流最新 id（gap-free：之后的帧必被订阅捕获）。signal 在客户端断开或收到终态帧时 abort。
   */
  subscribe?: (args: {
    fromId: string;
    onFrame: (frame: SSEFrame) => void;
    signal: AbortSignal;
  }) => void | Promise<void>;
  /** 订阅起点 id（snapshot 路径用）：建流前由调用方抓取的流最新 id。 */
  subscribeFromId?: string;
  /**
   * 建流瞬间 DB 已是终态时应补发的终态帧序列（succeeded→[done]；failed→[error, done]）。
   * 返回非空 = DB 已终态：写完 snapshot 后一次性补发、由 done 帧触发关流，且不再启动 live subscribe。
   * 返回空 / 未提供 = 非终态（running）→ 正常 snapshot + live subscribe。
   */
  terminalFrames?: () => Array<{ event: SSEEventType; payload: unknown }>;
  /** 心跳间隔覆盖（默认 SSE_HEARTBEAT_INTERVAL_MS）。 */
  heartbeatMs?: number;
}

/** 已建立的 SSE 流句柄。 */
export interface SseStreamHandle {
  push: (frame: { id?: string; event: SSEEventType; payload: unknown }) => void;
  stop: () => void;
}

/**
 * 启动一条 SSE 流：写 SSE 响应头 → 按 Last-Event-ID 协议下发首帧 → 启心跳 → 返回句柄。
 *
 * 建流是一条明确顺序的状态机（统一终态闸）：
 *   ① 锚点：订阅起点 subscribeFromId（调用方建流前抓取的流最新 id；窗口内 resume 改用最后一帧 replayed id）。
 *   ② snapshot/status：调用方在锚点之后读的最新 DB 快照（loadSnapshot）与终态判定（terminalFrames）。
 *   ③ 发首帧：窗口内 replay → 补发增量；否则 → state_snapshot 重置。
 *   ④ replay 帧里若含 done / error，记为「已发终态轨迹」。
 *   ⑤ 统一终态闸（subscribe 之前）：terminal = (DB 已终态) OR (已发 error 轨迹)。若 terminal：
 *      确保终态帧【恰好发一次】——replay 没发过就按 DB 状态补发（含 Last-Event-ID 恰等于 done id
 *      导致增量为空的边角），并保证必以一个 done 收尾，然后 stop 关流，绝不 subscribe。
 *   ⑥ 否则（running）：从锚点 live subscribe，收到 done 帧 → stop 关流。
 *
 * 保证：任何非 running 路径都不 subscribe、终态帧恰好一次、无悬挂心跳、无双 done。
 */
export async function startSseStream(
  req: FastifyRequest,
  reply: FastifyReply,
  opts: SseStreamOptions,
): Promise<SseStreamHandle> {
  // SSE 响应头：text/event-stream、关代理缓冲、长连。
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // nginx 关缓冲
    [TRACE_ID_HEADER]: req.id,
    [TRACEPARENT_HEADER]: currentTraceparent(req.id),
  });
  // 防止 fastify 继续接管这个已 hijack 的响应。
  reply.hijack();

  const interval = opts.heartbeatMs ?? SSE_HEARTBEAT_INTERVAL_MS;
  const heartbeat = setInterval(() => {
    if (!reply.raw.writableEnded) writeHeartbeat(reply);
  }, interval);
  // 心跳定时器不应阻止进程退出。
  if (typeof heartbeat.unref === 'function') heartbeat.unref();

  // 订阅生命周期：客户端断开 / 收到终态 done 帧 → abort → 订阅 reader 清理、断独立连接（防泄漏）。
  const subAbort = new AbortController();

  let stopped = false;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    clearInterval(heartbeat);
    if (!subAbort.signal.aborted) subAbort.abort();
    if (!reply.raw.writableEnded) reply.raw.end();
  };

  // 终态帧轨迹（终态闸据此「恰好一次」补发，杜绝双 done / 漏发收尾 done）。
  let errorEmitted = false;
  let doneEmitted = false;
  const push = (frame: { id?: string; event: SSEEventType; payload: unknown }): void => {
    if (stopped || reply.raw.writableEnded) return;
    writeSseFrame(reply, frame);
    if (frame.event === 'error') errorEmitted = true;
    // done 是唯一关流信号；error 帧不在此关流（失败序列先 error 后紧跟 done）。
    if (frame.event === 'done') {
      doneEmitted = true;
      stop();
    }
  };

  // 客户端断开 → 清理（防泄漏：含订阅独立连接）。
  req.raw.on('close', stop);

  // —— ①③④ 首帧协议 ——
  let resumedInWindow = false;
  let subscribeFromId = opts.subscribeFromId ?? '0-0';
  if (opts.lastEventId && opts.replaySince) {
    const replay = await opts.replaySince(opts.lastEventId);
    if (replay.inWindow) {
      resumedInWindow = true;
      for (const f of replay.frames) {
        // 经 push 写：replay 到 done 即触发 stop，并记录 done/error 已发（终态闸据此不重发）。
        push({ id: f.id, event: f.event, payload: f.payload });
      }
      // 续订从「补发的最后一帧 id」之后开始；无新帧则从 lastEventId 之后（衔接无缝、不漏不重）。
      subscribeFromId = replay.frames.at(-1)?.id ?? opts.lastEventId;
    }
  }
  if (!resumedInWindow) {
    // 超窗 / 无 Last-Event-ID → 先 state_snapshot 重置。合成帧的 id = 订阅锚点：前端把它当
    // Last-Event-ID 重连 → replaySince 从锚点之后补增量，与 live subscribe 起点一致（不重不漏）。
    const snapshot = await opts.loadSnapshot();
    writeSseFrame(reply, { id: subscribeFromId, event: 'state_snapshot', payload: snapshot });
  }

  // —— ⑤ 统一终态闸（subscribe 之前）——
  if (!doneEmitted) {
    const dbTerminalFrames = (!stopped && opts.terminalFrames?.()) || [];
    const terminal = dbTerminalFrames.length > 0 || errorEmitted;
    if (terminal) {
      // 已发过 error 就丢掉补发序列里的前导 error（避免重复）；合成帧 id = 订阅锚点。
      const backfill = errorEmitted
        ? dbTerminalFrames.filter((f) => f.event !== 'error')
        : dbTerminalFrames;
      for (const frame of backfill) push({ id: subscribeFromId, ...frame });
      // 结构性兜底：终态闸只要判定 terminal，就必以一个 done 收尾（不依赖 terminalFrames()
      // 一定含 done 的调用方约定）。done 触发 stop，下面的 subscribe 必早退。
      if (!doneEmitted) push({ id: subscribeFromId, event: 'done', payload: { status: 'failed' } });
    }
  }

  // —— ⑥ 持续订阅业务流：仅 running（非终态）才订阅。终态闸已 stop，此处早退不订阅。——
  if (!stopped && opts.subscribe) {
    // 不 await：订阅是长循环，与本握手解耦；其内部异常吞掉（推流尽力而为，snapshot 才是真源）。
    void Promise.resolve(
      opts.subscribe({ fromId: subscribeFromId, onFrame: (f) => push(f), signal: subAbort.signal }),
    ).catch(() => undefined);
  }

  return { push, stop };
}

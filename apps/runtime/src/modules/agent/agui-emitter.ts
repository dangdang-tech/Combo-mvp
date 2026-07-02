// AG-UI 线协议 emitter：把一个回合发成标准 AG-UI 事件流（SSE）。
//   用 @ag-ui/encoder 的 EventEncoder 编 `data: {json}\n\n`；事件形态用 @ag-ui/core 的 EventType。
//   AG-UI 客户端有顺序状态机（verifyEvents）：RUN_STARTED 必须最先；TEXT_MESSAGE_* 同 messageId 配对；
//   RUN_FINISHED 不能在消息未关闭时发；RUN_ERROR 是终态、其后不得再发。调用方须遵守。
import { EventEncoder } from '@ag-ui/encoder';
import { EventType } from '@ag-ui/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { TRACE_ID_HEADER, TRACEPARENT_HEADER } from '@cb/shared';
import { currentTraceparent } from '../../platform/observability/node.js';

type EncodableEvent = Parameters<EventEncoder['encode']>[0];

export interface AguiEmitter {
  runStarted: () => void;
  textStart: (messageId: string) => void;
  textContent: (messageId: string, delta: string) => void;
  textEnd: (messageId: string) => void;
  /** STATE_DELTA：RFC 6902 JSON Patch 增量改 agent 共享状态（产物面板就挂在这）。 */
  stateDelta: (ops: unknown[]) => void;
  stateSnapshot: (snapshot: unknown) => void;
  /** 终态：报错。其后不得再发任何事件。 */
  runError: (message: string) => void;
  /** 终态：成功收尾。 */
  runFinished: () => void;
  /** 等待所有异步事件写入完成。HTTP 直写 emitter 为 no-op。 */
  flush: () => Promise<void>;
  end: () => void;
  signal: AbortSignal;
}

export function startAguiStream(
  req: FastifyRequest,
  reply: FastifyReply,
  args: { threadId: string; runId: string },
): AguiEmitter {
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    [TRACE_ID_HEADER]: req.id,
    [TRACEPARENT_HEADER]: currentTraceparent(req.id),
  });
  reply.hijack();

  const encoder = new EventEncoder();
  const abort = new AbortController();
  let closed = false;

  const write = (event: Record<string, unknown>): void => {
    if (closed || reply.raw.writableEnded) return;
    reply.raw.write(encoder.encode(event as unknown as EncodableEvent));
  };

  const end = (): void => {
    if (closed) return;
    closed = true;
    if (!abort.signal.aborted) abort.abort();
    if (!reply.raw.writableEnded) reply.raw.end();
  };

  req.raw.on('close', end);

  return {
    runStarted: () =>
      write({ type: EventType.RUN_STARTED, threadId: args.threadId, runId: args.runId }),
    textStart: (messageId) =>
      write({
        type: EventType.TEXT_MESSAGE_START,
        threadId: args.threadId,
        runId: args.runId,
        messageId,
        role: 'assistant',
      }),
    textContent: (messageId, delta) =>
      write({
        type: EventType.TEXT_MESSAGE_CONTENT,
        threadId: args.threadId,
        runId: args.runId,
        messageId,
        delta,
      }),
    textEnd: (messageId) =>
      write({
        type: EventType.TEXT_MESSAGE_END,
        threadId: args.threadId,
        runId: args.runId,
        messageId,
      }),
    stateDelta: (ops) =>
      write({
        type: EventType.STATE_DELTA,
        threadId: args.threadId,
        runId: args.runId,
        delta: ops,
      }),
    stateSnapshot: (snapshot) =>
      write({
        type: EventType.STATE_SNAPSHOT,
        threadId: args.threadId,
        runId: args.runId,
        snapshot,
      }),
    runError: (message) =>
      write({ type: EventType.RUN_ERROR, threadId: args.threadId, runId: args.runId, message }),
    runFinished: () =>
      write({ type: EventType.RUN_FINISHED, threadId: args.threadId, runId: args.runId }),
    flush: async () => undefined,
    end,
    signal: abort.signal,
  };
}

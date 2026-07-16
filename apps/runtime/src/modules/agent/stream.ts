// GET /runtime/sessions/:id/stream 的 SSE handler。
//   会话级长流：先补发 Redis Stream 中 Last-Event-ID 之后的事件，再切发布订阅实时；
//   订阅先于补发挂上（无缝隙），重叠帧按 id 单调去重。心跳 15s；客户端断开即关流。
//   帧格式：id:（Redis Stream id）+ @ag-ui/encoder 编码的 data:（AG-UI 标准事件）。
import type { FastifyRequest, RouteHandlerMethod } from 'fastify';
import { EventEncoder } from '@ag-ui/encoder';
import {
  ErrorCode,
  SSE_HEARTBEAT_INTERVAL_MS,
  TRACE_ID_HEADER,
  TRACEPARENT_HEADER,
} from '@cb/shared';
import { sendError } from '../../platform/http/_helpers.js';
import { currentTraceparent } from '../../platform/observability/node.js';
import type { PublishedStreamEvent } from '../../platform/infra/event-bus.js';
import { getSession } from '../session/repo.js';
import { compareStreamIds, normalizeStreamId } from './event-log.js';

/** 取 Last-Event-ID（EventSource/fetch-event-source 重连自动带此头），非法/缺失 → 0。 */
export function resolveAfterId(req: FastifyRequest): string {
  const h = req.headers['last-event-id'];
  const raw = Array.isArray(h) ? h[0] : h;
  return normalizeStreamId(typeof raw === 'string' ? raw : undefined);
}

export function sessionStreamHandler(): RouteHandlerMethod {
  return async function (req, reply) {
    const userId = req.auth?.userId;
    if (!userId) return sendError(req, reply, ErrorCode.UNAUTHENTICATED);
    const { id: sessionId } = req.params as { id: string };

    let session;
    try {
      session = await getSession(req.server.infra.db, sessionId, userId);
    } catch (err) {
      req.log.error({ err, traceId: req.id }, 'stream: read session failed');
      return sendError(req, reply, ErrorCode.INTERNAL);
    }
    if (!session) return sendError(req, reply, ErrorCode.NOT_FOUND);

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // nginx 关缓冲
      [TRACE_ID_HEADER]: req.id,
      [TRACEPARENT_HEADER]: currentTraceparent(req.id),
    });
    reply.hijack();

    const encoder = new EventEncoder();
    let lastSentId = resolveAfterId(req);
    let closed = false;

    const send = (e: PublishedStreamEvent): void => {
      // id 单调去重：补发与实时订阅的重叠帧在此收口（只增不回退）。
      if (closed || reply.raw.writableEnded || compareStreamIds(e.id, lastSentId) <= 0) return;
      lastSentId = e.id;
      reply.raw.write(`id: ${e.id}\n`);
      reply.raw.write(encoder.encode(e.event as Parameters<EventEncoder['encode']>[0]));
    };

    // ① 先挂实时订阅（缓冲），补发期间产生的新事件不丢。
    let replaying = true;
    const buffered: PublishedStreamEvent[] = [];
    const unsubscribe = req.server.infra.bus.subscribe(sessionId, (e) => {
      if (replaying) buffered.push(e);
      else send(e);
    });

    let fallbackInFlight = false;
    const fallbackRead = async (): Promise<void> => {
      if (fallbackInFlight || closed || reply.raw.writableEnded) return;
      fallbackInFlight = true;
      try {
        for (;;) {
          const batch = await req.server.infra.eventLog.rangeAfter(sessionId, lastSentId, 500);
          for (const row of batch) send(row);
          if (batch.length < 500) break;
        }
      } catch (err) {
        req.log.error({ err, traceId: req.id }, 'stream: fallback replay failed');
      } finally {
        fallbackInFlight = false;
      }
    };

    const heartbeat = setInterval(() => {
      if (!closed && !reply.raw.writableEnded) {
        reply.raw.write(`event: heartbeat\ndata: {"ts":${Date.now()}}\n\n`);
        void fallbackRead();
      }
    }, SSE_HEARTBEAT_INTERVAL_MS);
    if (typeof heartbeat.unref === 'function') heartbeat.unref();

    const stop = (): void => {
      if (closed) return;
      closed = true;
      unsubscribe();
      clearInterval(heartbeat);
      if (!reply.raw.writableEnded) reply.raw.end();
    };
    req.raw.on('close', stop);

    // ② 补发日志里 Last-Event-ID 之后的事件（分批直到取尽）。
    try {
      for (;;) {
        const batch = await req.server.infra.eventLog.rangeAfter(sessionId, lastSentId, 500);
        for (const row of batch) send(row);
        if (batch.length < 500) break;
      }
    } catch (err) {
      req.log.error({ err, traceId: req.id }, 'stream: replay failed');
      stop();
      return reply;
    }

    // ③ 排空缓冲，切实时。
    replaying = false;
    for (const e of buffered) send(e);
    buffered.length = 0;

    return reply;
  };
}

// GET /tasks/:taskId/events 的 SSE handler。
//   建流前：owner 校验（HTTP 失败，不走 error 帧）；requireSseAuth（同源 Cookie）已由路由守。
//   首帧 state_snapshot 从 tasks.meta.progress 读全量；断线 Last-Event-ID 窗口内补增量；
//   心跳 15s（startSseStream 内）；建流瞬间已终态 → 补终态帧关流，不留悬挂连接。
import type { FastifyRequest, RouteHandlerMethod } from 'fastify';
import {
  ErrorCode,
  PIPELINE_SUBTASKS,
  errorBodyFor,
  type ErrorBody,
  type ProgressView,
  type SSEEventType,
  type StateSnapshotPayload,
} from '@cb/shared';
import { sendError } from '../../platform/http/_helpers.js';
import { getLastEventId, startSseStream } from '../../platform/sse/sse.js';
import { RedisEventStream } from '../../platform/sse/event-stream.js';
import { readTaskCore } from './repo.js';

/** 把 meta.progress（可能为空/部分）规整成合法 ProgressView（永不裸转圈：至少 0% + 标准子任务清单）。 */
export function normalizeProgress(p: Partial<ProgressView> | undefined): ProgressView {
  return {
    percent: typeof p?.percent === 'number' ? p.percent : 0,
    phrase: typeof p?.phrase === 'string' ? p.phrase : '等待上传内容…',
    ...(typeof p?.done === 'number' ? { done: p.done } : {}),
    ...(typeof p?.total === 'number' ? { total: p.total } : {}),
    ...(typeof p?.unit === 'string' ? { unit: p.unit } : {}),
    subtasks: Array.isArray(p?.subtasks)
      ? p.subtasks
      : PIPELINE_SUBTASKS.map((s) => ({ key: s.key, label: s.label, status: 'pending' as const })),
    ...(typeof p?.slow === 'boolean' ? { slow: p.slow } : {}),
  };
}

/** 建流瞬间任务已终态时补发的终态帧（与 worker 落终态时推的帧同形态）。 */
function terminalFramesFor(
  status: 'succeeded' | 'failed',
  lastError: ErrorBody | null,
  traceId: string,
): Array<{ event: SSEEventType; payload: unknown }> {
  if (status === 'succeeded') return [{ event: 'done', payload: { status } }];
  // last_error 理应存在（失败路径必写）；缺失时兜一个通用信封，不裸发空 error。
  const body = lastError ?? errorBodyFor(ErrorCode.INTERNAL, traceId).body;
  const envelope = { error: body };
  return [
    { event: 'error', payload: envelope },
    { event: 'done', payload: { status, error: envelope } },
  ];
}

export function taskEventsHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply) {
    const { taskId } = req.params as { taskId: string };
    const userId = req.auth?.userId;
    if (!userId) return sendError(req, reply, ErrorCode.UNAUTHENTICATED);

    const stream = new RedisEventStream(req.server.infra.redisHot);

    // 时序关键：先取流最新 id（订阅锚点），再读 DB 快照——保证快照不早于锚点，
    // 锚点之后 XADD 的帧必被订阅捕获（不漏）；快照与订阅重叠一两帧由前端按 percent 幂等吸收。
    const subscribeFromId = await stream.latestId(taskId).catch(() => '0-0');

    let core;
    try {
      core = await readTaskCore(req.server.infra.db, taskId);
    } catch (err) {
      req.log.error({ err, traceId: req.id }, 'task sse: read task failed');
      return sendError(req, reply, ErrorCode.INTERNAL);
    }
    // 不存在与非本人同样 404（不暴露存在性）。
    if (!core || core.ownerUserId !== userId) return sendError(req, reply, ErrorCode.NOT_FOUND);

    const progress = normalizeProgress(
      (core.meta as { progress?: Partial<ProgressView> }).progress,
    );
    const status = core.status;

    await startSseStream(req, reply, {
      lastEventId: getLastEventId(req),
      loadSnapshot: async (): Promise<StateSnapshotPayload> => ({ progress }),
      replaySince: (lastEventId) => stream.replaySince(taskId, lastEventId),
      subscribeFromId,
      subscribe: ({ fromId, onFrame, signal }) => stream.subscribe(taskId, fromId, onFrame, signal),
      terminalFrames: () =>
        status === 'running' ? [] : terminalFramesFor(status, core.lastError, req.id),
    });
    return reply;
  };
}

// B-11 · 取消 job handler（POST /jobs/:jobId/cancel）。脊柱 §6.1 取消语义。
//   走同一 fence：标 cancelled + 换 fence_token（旧执行因 fence 不匹配再也无法回写）→ BullMQ remove
//   → 已生成产物保留（硬规则③）。requireAuth + requireIdempotency 已由路由 preHandler 守。
//   owner 校验内联进 cancelJob 的 WHERE（owner_user_id=$2）；非 owner/不存在 → 0 行 → 404（不暴露存在性）。
import type { FastifyReply, FastifyRequest, RouteHandlerMethod } from 'fastify';
import { buildError, ErrorCode, type JobView } from '@cb/shared';
import { cancelJob } from '../platform/jobs/repo.js';
import { jobStreamKey, RedisEventStream } from '../platform/sse/event-stream.js';

/**
 * 取消 handler 工厂。成功 → 200 + 取消后 JobView 摘要；不可取消（已终态/不存在/非本人）→ 404。
 *   - cancelJob 单条原子 UPDATE（标 cancelled + 换 fence），0 行 = 不可取消。
 *   - 换 fence 后 BullMQ remove（取消触发，脊柱 §6.1）；推 done(cancelled) 帧让在线页面即时收尾（永不裸转圈）。
 */
export function jobCancelHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const { jobId } = req.params as { jobId: string };
    const userId = req.auth?.userId;
    if (!userId) {
      reply.code(401).send(buildError(ErrorCode.UNAUTHENTICATED, req.id));
      return reply;
    }

    let cancelled: { fenceToken: number } | null;
    try {
      cancelled = await cancelJob(req.server.infra.db, jobId, userId);
    } catch (err) {
      req.log.error({ err, jobId, traceId: req.id }, 'cancel job failed');
      reply.code(500).send(buildError(ErrorCode.INTERNAL, req.id));
      return reply;
    }

    if (!cancelled) {
      // 不存在 / 非本人 / 已终态：统一 404（不暴露存在性，10-auth §6.3）。
      reply.code(404).send(buildError(ErrorCode.NOT_FOUND, req.id));
      return reply;
    }

    // 换 fence 后从 BullMQ 移除该 job（取消触发，脊柱 §6.1）；失败不阻断取消（fence 已让旧执行失效）。
    try {
      await req.server.infra.queue.remove(jobId as never);
    } catch (err) {
      req.log.warn({ err, jobId }, 'queue remove after cancel failed (fence already invalidated)');
    }

    // 推 done(cancelled) 帧让在线 SSE 流即时收尾（关页也不裸转圈）；尽力而为。
    try {
      const stream = new RedisEventStream(req.server.infra.redisHot);
      await stream.publish(jobId, { event: 'done', payload: { status: 'cancelled' } });
    } catch {
      /* 推流失败不影响取消结果（jobs.status=cancelled 是真源） */
    }
    void jobStreamKey; // 显式引用（保留 key 约定一致性）。

    const view: Pick<JobView, 'id' | 'status'> = { id: jobId, status: 'cancelled' };
    reply.code(200).send({ data: view });
    return reply;
  };
}

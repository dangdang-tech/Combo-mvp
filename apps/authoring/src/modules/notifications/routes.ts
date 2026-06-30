// 70 · 通知域路由（B-35，70 §5.4）。NotifyConsumer 产物的读写。
//   - 通知读 / 未读数：requireAuth + handler owner 校验（recipient_id = ctx.userId，只看自己）。
//   - 标已读 / 全部已读：requireAuth + requireIdempotency（写命令带 key，重复回放无害）。
//   - 越权读他人 → NOT_FOUND（不暴露存在性，§5.4）；失败一律 ErrorEnvelope（绝不裸露错误码）。
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  IdempotencyScope,
  buildError,
  ErrorCode,
  DEFAULT_PAGE_LIMIT,
  type NotificationView,
  type Paginated,
  type Envelope,
} from '@cb/shared';
import { requireAuth } from '../../platform/middleware/auth.js';
import { requireIdempotency } from '../../platform/middleware/idempotency.js';
import { registerEndpoints, type EndpointDecl } from '../../platform/http/_helpers.js';
import { listNotifications, markRead, markAllRead, unreadCount } from './repo.js';

/** 取已鉴权 userId（requireAuth 已保证存在；缺失则 401 兜底）。 */
function requireUserId(req: FastifyRequest, reply: FastifyReply): string | null {
  const userId = req.auth?.userId;
  if (!userId) {
    reply.code(401).send(buildError(ErrorCode.UNAUTHENTICATED, req.id));
    return null;
  }
  return userId;
}

/** GET /notifications — 本人通知 cursor 分页（Paginated<NotificationView>，不返 total）。 */
async function handleList(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const userId = requireUserId(req, reply);
  if (!userId) return;
  const q = req.query as { cursor?: string; limit?: string; filter?: string; order?: string };
  const limit = q.limit ? Number(q.limit) : DEFAULT_PAGE_LIMIT;
  if (q.limit && (!Number.isFinite(limit) || limit < 1 || limit > 100)) {
    reply.code(400).send(buildError(ErrorCode.VALIDATION_FAILED, req.id));
    return;
  }
  const order = q.order === 'asc' ? 'asc' : 'desc';
  const filter = q.filter === 'unread' ? 'unread' : 'all';
  try {
    const result = await listNotifications(req.server.infra.db, {
      recipientId: userId,
      ...(q.cursor ? { cursor: q.cursor } : {}),
      limit,
      filter,
      order,
    });
    const body: Paginated<NotificationView> = {
      data: result.items,
      meta: {
        traceId: req.id,
        page: { nextCursor: result.nextCursor, hasMore: result.nextCursor !== null, limit, order },
      },
    };
    reply.code(200).send(body);
  } catch {
    reply.code(500).send(buildError(ErrorCode.INTERNAL, req.id));
  }
}

/** POST /notifications/:notificationId/read — 标已读（幂等，Envelope<NotificationView>）。 */
async function handleRead(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const userId = requireUserId(req, reply);
  if (!userId) return;
  const { notificationId } = req.params as { notificationId: string };
  try {
    const view = await markRead(req.server.infra.db, userId, notificationId);
    if (!view) {
      // 不存在或非本人：NOT_FOUND（不暴露存在性，§5.4）。
      reply.code(404).send(buildError(ErrorCode.NOT_FOUND, req.id));
      return;
    }
    const body: Envelope<NotificationView> = { data: view, meta: { traceId: req.id } };
    reply.code(200).send(body);
  } catch {
    reply.code(500).send(buildError(ErrorCode.INTERNAL, req.id));
  }
}

/** POST /notifications/read-all — 全部已读（幂等，Envelope<{updated}>；第二次 updated:0）。 */
async function handleReadAll(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const userId = requireUserId(req, reply);
  if (!userId) return;
  try {
    const updated = await markAllRead(req.server.infra.db, userId);
    const body: Envelope<{ updated: number }> = { data: { updated }, meta: { traceId: req.id } };
    reply.code(200).send(body);
  } catch {
    reply.code(500).send(buildError(ErrorCode.INTERNAL, req.id));
  }
}

/** GET /notifications/unread-count — 本人未读数（Envelope<{unread}>，铃铛红点轮询用）。 */
async function handleUnreadCount(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const userId = requireUserId(req, reply);
  if (!userId) return;
  try {
    const unread = await unreadCount(req.server.infra.db, userId);
    const body: Envelope<{ unread: number }> = { data: { unread }, meta: { traceId: req.id } };
    reply.code(200).send(body);
  } catch {
    reply.code(500).send(buildError(ErrorCode.INTERNAL, req.id));
  }
}

export const NOTIFICATION_ENDPOINTS: EndpointDecl[] = [
  { method: 'GET', url: '/notifications', preHandlers: [requireAuth()], handler: handleList },
  {
    method: 'POST',
    url: '/notifications/:notificationId/read',
    preHandlers: [requireAuth(), requireIdempotency(IdempotencyScope.NOTIFICATION_READ)],
    handler: handleRead,
  },
  {
    method: 'POST',
    url: '/notifications/read-all',
    preHandlers: [requireAuth(), requireIdempotency(IdempotencyScope.NOTIFICATION_READ_ALL)],
    handler: handleReadAll,
  },
  {
    method: 'GET',
    url: '/notifications/unread-count',
    preHandlers: [requireAuth()],
    handler: handleUnreadCount,
  },
];

export async function registerNotificationRoutes(scoped: FastifyInstance): Promise<void> {
  registerEndpoints(scoped, NOTIFICATION_ENDPOINTS);
}

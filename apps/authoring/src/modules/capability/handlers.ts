// 能力项域 HTTP handler：薄壳——校验入参、调 repo、包响应信封。
// owner 校验收在 repo SQL（owner_user_id 条件），非本人与不存在同样 404（不暴露存在性）。
import { randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest, RouteHandlerMethod } from 'fastify';
import {
  DEFAULT_PAGE_LIMIT,
  ErrorCode,
  InvalidCursorError,
  MAX_PAGE_LIMIT,
  decodeIdCursor,
  encodeIdCursor,
  type CapabilityView,
  type Envelope,
  type Paginated,
  type PublishResult,
} from '@cb/shared';
import { sendError } from '../../platform/http/_helpers.js';
import {
  listCapabilityViews,
  publishCapability,
  readCapabilityView,
  unpublishCapability,
} from './repo.js';

/** 分享令牌：crypto 随机、URL 安全（base64url，无需转义可进路径/查询串）。 */
export function generateShareToken(): string {
  return randomBytes(24).toString('base64url');
}

// ───────────────────────────── GET /capabilities?taskId= ─────────────────────────────

export function listCapabilitiesHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const userId = req.auth?.userId;
    if (!userId) return sendError(req, reply, ErrorCode.UNAUTHENTICATED);

    const q = (req.query ?? {}) as { taskId?: string; cursor?: string; limit?: string };
    const limitRaw = q.limit !== undefined ? Number(q.limit) : DEFAULT_PAGE_LIMIT;
    if (!Number.isInteger(limitRaw) || limitRaw < 1 || limitRaw > MAX_PAGE_LIMIT) {
      return sendError(req, reply, ErrorCode.VALIDATION_FAILED);
    }
    let cursorId: string | undefined;
    if (q.cursor !== undefined) {
      try {
        cursorId = decodeIdCursor(q.cursor);
      } catch (err) {
        if (err instanceof InvalidCursorError) {
          return sendError(req, reply, ErrorCode.VALIDATION_FAILED);
        }
        throw err;
      }
    }

    let page;
    try {
      page = await listCapabilityViews(req.server.infra.db, {
        ownerUserId: userId,
        ...(q.taskId ? { taskId: q.taskId } : {}),
        limit: limitRaw,
        ...(cursorId !== undefined ? { cursorId } : {}),
      });
    } catch (err) {
      req.log.error({ err, traceId: req.id }, 'list capabilities failed');
      return sendError(req, reply, ErrorCode.INTERNAL);
    }

    const last = page.items.at(-1);
    const body: Paginated<CapabilityView> = {
      data: page.items,
      meta: {
        traceId: req.id,
        page: {
          nextCursor: page.hasMore && last ? encodeIdCursor(last.id) : null,
          hasMore: page.hasMore,
          limit: limitRaw,
          order: 'desc',
        },
      },
    };
    reply.code(200).send(body);
    return reply;
  };
}

// ───────────────────────────── GET /capabilities/:capabilityId ─────────────────────────────

export function getCapabilityHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const userId = req.auth?.userId;
    if (!userId) return sendError(req, reply, ErrorCode.UNAUTHENTICATED);
    const { capabilityId } = req.params as { capabilityId: string };

    let view: CapabilityView | null;
    try {
      view = await readCapabilityView(req.server.infra.db, capabilityId, userId);
    } catch (err) {
      req.log.error({ err, traceId: req.id }, 'read capability failed');
      return sendError(req, reply, ErrorCode.INTERNAL);
    }
    if (!view) return sendError(req, reply, ErrorCode.NOT_FOUND);
    const body: Envelope<CapabilityView> = { data: view, meta: { traceId: req.id } };
    reply.code(200).send(body);
    return reply;
  };
}

// ───────────────────────────── POST /capabilities/:capabilityId/publish ─────────────────────────────

export function publishHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const userId = req.auth?.userId;
    if (!userId) return sendError(req, reply, ErrorCode.UNAUTHENTICATED);
    const { capabilityId } = req.params as { capabilityId: string };

    let result: PublishResult | null;
    try {
      result = await publishCapability(req.server.infra.db, {
        capabilityId,
        ownerUserId: userId,
        shareToken: generateShareToken(),
      });
    } catch (err) {
      req.log.error({ err, traceId: req.id }, 'publish capability failed');
      return sendError(req, reply, ErrorCode.INTERNAL);
    }
    if (!result) return sendError(req, reply, ErrorCode.NOT_FOUND);
    const body: Envelope<PublishResult> = { data: result, meta: { traceId: req.id } };
    reply.code(200).send(body);
    return reply;
  };
}

// ───────────────────────────── POST /capabilities/:capabilityId/unpublish ─────────────────────────────

export function unpublishHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const userId = req.auth?.userId;
    if (!userId) return sendError(req, reply, ErrorCode.UNAUTHENTICATED);
    const { capabilityId } = req.params as { capabilityId: string };

    let result: PublishResult | null;
    try {
      result = await unpublishCapability(req.server.infra.db, {
        capabilityId,
        ownerUserId: userId,
      });
    } catch (err) {
      req.log.error({ err, traceId: req.id }, 'unpublish capability failed');
      return sendError(req, reply, ErrorCode.INTERNAL);
    }
    if (!result) return sendError(req, reply, ErrorCode.NOT_FOUND);
    const body: Envelope<PublishResult> = { data: result, meta: { traceId: req.id } };
    reply.code(200).send(body);
    return reply;
  };
}

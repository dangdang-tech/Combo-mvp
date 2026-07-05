// 能力域 HTTP handler：薄壳——调 loader、包响应信封。
import type { FastifyReply, FastifyRequest, RouteHandlerMethod } from 'fastify';
import { ErrorCode, type Envelope, type ErrorCodeValue } from '@cb/shared';
import { sendError } from '../../platform/http/_helpers.js';
import {
  listTrialCapabilities,
  type LoadCapabilityResult,
  type TrialCapabilityItem,
} from './loader.js';

/** loader 非 ok 结果 → 统一错误信封（session 端点也复用这份映射）。 */
export function sendLoadFailure(
  req: FastifyRequest,
  reply: FastifyReply,
  result: Exclude<LoadCapabilityResult, { kind: 'ok' }>,
): FastifyReply {
  const mapping: Record<typeof result.kind, { code: ErrorCodeValue; userMessage?: string }> = {
    not_found: { code: ErrorCode.NOT_FOUND },
    unsupported_version: {
      code: ErrorCode.STATE_CONFLICT,
      userMessage: '这个能力的格式比当前试用服务更新，暂时无法试用，请等待服务升级。',
    },
    invalid_definition: { code: ErrorCode.INTERNAL },
  };
  const m = mapping[result.kind];
  return sendError(req, reply, m.code, m.userMessage ? { userMessage: m.userMessage } : undefined);
}

// ───────────────────────────── GET /runtime/capabilities ─────────────────────────────

export function listCapabilitiesHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const userId = req.auth?.userId;
    if (!userId) return sendError(req, reply, ErrorCode.UNAUTHENTICATED);

    let items: TrialCapabilityItem[];
    try {
      items = await listTrialCapabilities(req.server.infra.db, userId);
    } catch (err) {
      req.log.error({ err, traceId: req.id }, 'list trial capabilities failed');
      return sendError(req, reply, ErrorCode.INTERNAL);
    }
    const body: Envelope<TrialCapabilityItem[]> = { data: items, meta: { traceId: req.id } };
    reply.code(200).send(body);
    return reply;
  };
}

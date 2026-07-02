// 统一错误信封（复用 @cb/shared 脊柱）：对外只发 envelope（无 code/堆栈），code 仅进日志。
import type { FastifyReply } from 'fastify';
import { buildErrorWithCode, ErrorCode, httpStatusFor, type ErrorCodeValue } from '@cb/shared';

export function sendError(
  reply: FastifyReply,
  code: ErrorCodeValue,
  traceId: string,
): FastifyReply {
  const { envelope } = buildErrorWithCode(code, traceId);
  return reply.code(httpStatusFor(code)).send(envelope);
}

export function notFound(reply: FastifyReply, traceId: string): FastifyReply {
  return sendError(reply, ErrorCode.NOT_FOUND, traceId);
}

export function badRequest(reply: FastifyReply, traceId: string): FastifyReply {
  return sendError(reply, ErrorCode.VALIDATION_FAILED, traceId);
}

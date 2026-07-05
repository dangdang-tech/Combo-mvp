// 产物域 HTTP handler：内容回读（owner 校验后从 MinIO 读回，带正确 Content-Type）。
import type { FastifyReply, FastifyRequest, RouteHandlerMethod } from 'fastify';
import { ErrorCode } from '@cb/shared';
import { sendError } from '../../platform/http/_helpers.js';
import { ARTIFACT_BUCKET, contentTypeFor, readArtifactForOwner } from './repo.js';

// ───────────────────────────── GET /runtime/artifacts/:id/content ─────────────────────────────

export function artifactContentHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const userId = req.auth?.userId;
    if (!userId) return sendError(req, reply, ErrorCode.UNAUTHENTICATED);
    const { id } = req.params as { id: string };

    let row;
    try {
      row = await readArtifactForOwner(req.server.infra.db, id, userId);
    } catch (err) {
      req.log.error({ err, traceId: req.id }, 'read artifact failed');
      return sendError(req, reply, ErrorCode.INTERNAL);
    }
    if (!row) return sendError(req, reply, ErrorCode.NOT_FOUND);

    let content: string;
    try {
      content = await req.server.infra.objectStore.getObjectText(ARTIFACT_BUCKET, row.storageKey);
    } catch (err) {
      req.log.error({ err, traceId: req.id }, 'read artifact content from object store failed');
      return sendError(req, reply, ErrorCode.DEPENDENCY_UNAVAILABLE);
    }
    reply.code(200).type(contentTypeFor(row.kind)).send(content);
    return reply;
  };
}

// 00 · 草稿生命周期 API handler（脊柱 §8，开工总纲 §5.0；Codex phase4c P0-2）。
//   鉴权/幂等已由 routes/drafts.ts preHandler 守：
//     · POST /drafts：requireRole('creator') + requireIdempotency(draft.create)（草稿是创作者向导基线，仅 creator）。
//     · GET  /drafts/:draftId：requireAuth（读自己的草稿，handler 内据 owner_user_id 守门）。
//   owner 守卫在 repo 层内联（owner_user_id + status='active'）——非本人/不存在/已终态 → 404（不暴露存在性，10-auth §6.3）。
//   对外失败一律 ErrorEnvelope（人话 userMessage + action + traceId，绝不裸露 code/堆栈，脊柱 §11.B / D1）。
import type { FastifyReply, FastifyRequest, RouteHandlerMethod } from 'fastify';
import {
  buildError,
  ErrorCode,
  CreateDraftBodySchema,
  type Envelope,
  type DraftView,
} from '@cb/shared';
import { createDraft, readDraftView } from './repo.js';

function requireUserId(req: FastifyRequest, reply: FastifyReply): string | null {
  const userId = req.auth?.userId;
  if (!userId) {
    reply.code(401).send(buildError(ErrorCode.UNAUTHENTICATED, req.id));
    return null;
  }
  return userId;
}

// ===========================================================================
// POST /drafts — 草稿 bootstrap（fresh flow 续传基线）
// ===========================================================================

/**
 * 新建一行草稿（§8 bootstrap）。201 Envelope<DraftView>（含 draftId）——前端拿 draftId 贯穿后续
 *   snapshot/extract/version/capability/batch 全部回填同一 draft（断点续传基线）。
 *   幂等：preHandler requireIdempotency(draft.create) 兜重复点新建（回放同一 draftId，不重复建行）。
 */
export function createDraftHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const userId = requireUserId(req, reply);
    if (!userId) return reply;

    const parsed = CreateDraftBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      reply.code(422).send(
        buildError(ErrorCode.VALIDATION_FAILED, req.id, {
          userMessage: '草稿标题不合法，去掉或换一个再试。',
          action: 'change_input',
        }),
      );
      return reply;
    }

    let view: DraftView;
    try {
      view = await createDraft(req.server.infra.db, {
        ownerUserId: userId,
        ...(parsed.data.title !== undefined ? { title: parsed.data.title } : {}),
      });
    } catch (err) {
      req.log.error({ err, traceId: req.id }, 'create draft failed');
      reply.code(500).send(
        buildError(ErrorCode.INTERNAL, req.id, {
          userMessage: '新建草稿没成功，请重试。',
          action: 'retry',
          retriable: true,
        }),
      );
      return reply;
    }

    const body: Envelope<DraftView> = { data: view, meta: { traceId: req.id } };
    reply.code(201).send(body);
    return reply;
  };
}

// ===========================================================================
// GET /drafts/:draftId — 读完整 DraftView（续传 hydrate）
// ===========================================================================

/**
 * 读完整 DraftView（§8.4 续传）。200 Envelope<DraftView>（step/selection/snapshot/extract/version/capability/batch）。
 *   owner 守卫（repo 内联 owner_user_id + status='active'）：非本人/不存在/已终态 → 404（不暴露存在性）。
 */
export function getDraftHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const userId = requireUserId(req, reply);
    if (!userId) return reply;
    const { draftId } = req.params as { draftId: string };

    let view: DraftView | null;
    try {
      view = await readDraftView(req.server.infra.db, { draftId, ownerUserId: userId });
    } catch (err) {
      req.log.error({ err, traceId: req.id }, 'read draft failed');
      reply.code(500).send(
        buildError(ErrorCode.INTERNAL, req.id, {
          userMessage: '读取草稿没成功，请重试。',
          action: 'retry',
          retriable: true,
        }),
      );
      return reply;
    }

    if (!view) {
      reply.code(404).send(
        buildError(ErrorCode.NOT_FOUND, req.id, {
          userMessage: '没找到这条草稿，可能已被放弃或不存在。',
          action: 'change_input',
        }),
      );
      return reply;
    }

    const body: Envelope<DraftView> = { data: view, meta: { traceId: req.id } };
    reply.code(200).send(body);
    return reply;
  };
}

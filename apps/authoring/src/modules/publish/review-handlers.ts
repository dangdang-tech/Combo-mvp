// 50 · 评审域 API handler（B-30 Alpha 人工评审 + 拒绝分流 + 创作者侧只读发布态）。50-step5-publish §2.6。
//   - reviewDecisionHandler（POST /publications/:capabilityId/review）：reviewer 守卫已在 preHandler
//     （requireReviewer：reviewer 角色 + 禁创作者自审，§2.6 / Codex#7）；本 handler 跑裁决单事务（approve/reject）。
//   - getPublicationHandler（GET /publications/:capabilityId）：创作者只读 PublicationView（owner 守门），
//     含 reviewStatus/rejectReason/rejectedVersionId（发布页拒绝提示 + 重试/编辑入口，发布-31）。
//   对外失败一律 ErrorEnvelope（人话 userMessage + action + traceId，绝不裸露 code/堆栈，脊柱 §11.B / D1）。
//   裁决是事务、非长任务 → 同步返回 200（不裸转圈）。
import type { FastifyReply, FastifyRequest, RouteHandlerMethod } from 'fastify';
import {
  buildError,
  ErrorCode,
  ReviewBodySchema,
  type Envelope,
  type PublicationView,
} from '@cb/shared';
import { asTxPool } from '../../platform/events/db-tx.js';
import { PublishError } from './repo.js';
import { readPublicationForReview, reviewDecideInTx, type ReviewOutcome } from './review-repo.js';
import { readPublicationView, derivePublicationDisplayState } from './publication-repo.js';

function requireUserId(req: FastifyRequest, reply: FastifyReply): string | null {
  const userId = req.auth?.userId;
  if (!userId) {
    reply.code(401).send(buildError(ErrorCode.UNAUTHENTICATED, req.id));
    return null;
  }
  return userId;
}

/** 据内部 code 落对应人话信封（对外不含 code，D1）。 */
function replyError(
  req: FastifyRequest,
  reply: FastifyReply,
  code: (typeof ErrorCode)[keyof typeof ErrorCode],
  http: number,
  overrides?: {
    userMessage?: string;
    action?: 'retry' | 'change_input' | 'escalate' | 'wait' | 'none';
    details?: Record<string, unknown>;
  },
): FastifyReply {
  reply.code(http).send(buildError(code, req.id, overrides ?? {}));
  return reply;
}

// ===========================================================================
// §2.6.1 · POST /publications/:capabilityId/review — 评审裁决（人工，B-30）
// ===========================================================================

/**
 * 评审裁决（§2.6.1）。reviewer 守卫已在 preHandler（角色 + 禁自审）。同步事务：
 *   approve → published（清 Alpha 徽章）；reject → 标被裁决版 review_rejected + 按可回退性回退/下架（两线分明，Codex#8）。
 *   防重：preHandler requireIdempotency(publish.review) + 事务守门（review_status='alpha_pending' 才裁决）。
 *   非 alpha_pending（已裁决）→ 409 STATE_CONFLICT；reject 缺原因 → 400 VALIDATION_FAILED；不存在 → 404。
 */
export function reviewDecisionHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    // reviewer 守卫已注入 auth；此处兜底取 userId（无 → 401，理论不可达）。
    const userId = requireUserId(req, reply);
    if (!userId) return reply;
    const { capabilityId } = req.params as { capabilityId: string };

    const parsed = ReviewBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      // reject 缺 rejectReason / decision 枚举不对 → 400 change_input（拒绝需要填写原因，§2.6.1）。
      return replyError(req, reply, ErrorCode.VALIDATION_FAILED, 400, {
        userMessage: '裁决参数不完整：拒绝需要填写原因。',
        action: 'change_input',
      });
    }
    const body = parsed.data;

    // 读评审前置态（被裁决版 + owner + slug + 上一 published 版 + manifest_hash）。
    let pub;
    try {
      pub = await readPublicationForReview(req.server.infra.db, capabilityId);
    } catch {
      return replyError(req, reply, ErrorCode.INTERNAL, 500, {
        userMessage: '服务开小差了，请重试。',
        action: 'retry',
      });
    }
    if (!pub) {
      return replyError(req, reply, ErrorCode.NOT_FOUND, 404, {
        userMessage: '没找到对应能力，可能已被删除。',
        action: 'change_input',
      });
    }
    // 非 alpha_pending（已裁决）→ 409（这条已评审过了，§2.6.1）。前置快速失败（事务守门兜底）。
    if (pub.reviewStatus !== 'alpha_pending') {
      return replyError(req, reply, ErrorCode.STATE_CONFLICT, 409, {
        userMessage: '这条已评审过了。',
        action: 'none',
      });
    }

    let outcome: ReviewOutcome;
    try {
      outcome = await reviewDecideInTx(asTxPool(req.server.infra.db), {
        capabilityId: pub.capabilityId,
        decision: body.decision,
        ...(body.decision === 'reject' ? { rejectReason: body.rejectReason } : {}),
        reviewedVersionId: pub.currentVersionId,
        ownerUserId: pub.ownerUserId,
        slug: pub.slug,
        manifestHash: pub.manifestHash,
        prevVersionId: pub.prevVersionId,
        prevManifestHash: pub.prevManifestHash,
        prevVisibility: pub.prevVisibility,
        traceId: req.id,
      });
    } catch (err) {
      if (err instanceof PublishError && err.code === ErrorCode.STATE_CONFLICT) {
        // 并发：事务守门命中已裁决（review_status≠alpha_pending）→ 409，不重复回退/上架。
        return replyError(req, reply, ErrorCode.STATE_CONFLICT, 409, {
          userMessage: '这条已评审过了。',
          action: 'none',
        });
      }
      return replyError(req, reply, ErrorCode.INTERNAL, 500, {
        userMessage: '服务开小差了，请重试。',
        action: 'retry',
      });
    }

    // 裁决后回读最新 PublicationView 返回（与创作者侧三处展示一致，发布-31）。
    let view;
    try {
      view = await readPublicationView(req.server.infra.db, capabilityId);
    } catch {
      view = null;
    }
    if (!view) {
      // 理论不可达（刚裁决过）：兜底据 outcome 拼最小视图，绝不裸转圈/裸错误。
      const fallback: PublicationView = buildFallbackView(pub, outcome);
      reply
        .code(200)
        .send({ data: fallback, meta: { traceId: req.id } } as Envelope<PublicationView>);
      return reply;
    }
    const { ownerUserId: _owner, ...publicView } = view;
    reply
      .code(200)
      .send({ data: publicView, meta: { traceId: req.id } } as Envelope<PublicationView>);
    return reply;
  };
}

/** 裁决后回读失败时的最小兜底视图（不裸转圈；权威仍以下次 GET 为准）。 */
function buildFallbackView(
  pub: { capabilityId: string; slug: string },
  outcome: ReviewOutcome,
): PublicationView {
  const reviewStatus: PublicationView['reviewStatus'] =
    outcome.decision === 'approve'
      ? 'published'
      : 'rolledBackToVersionId' in outcome
        ? 'published'
        : 'review_rejected';
  const currentVersionId =
    outcome.decision === 'approve'
      ? outcome.currentVersionId
      : 'rolledBackToVersionId' in outcome
        ? outcome.rolledBackToVersionId
        : outcome.rejectedVersionId;
  const rejectedVersionId = outcome.decision === 'reject' ? outcome.rejectedVersionId : undefined;
  const view: PublicationView = {
    capabilityId: pub.capabilityId,
    currentVersionId,
    slug: pub.slug,
    shareToken: '',
    visibility: 'public',
    reviewStatus,
    publishedAt: new Date().toISOString(),
    // 单一真源派生（与正常读路径同一函数，兜底视图也不裸露内部码，Codex#r3 P1）。原因以下次权威 GET 为准，
    //   此兜底（理论不可达：刚裁决过回读失败）不带 reason，只给徽章/可重发，避免裸转圈/裸错误。
    displayState: derivePublicationDisplayState({ reviewStatus, rejectedVersionId }),
  };
  if (rejectedVersionId) view.rejectedVersionId = rejectedVersionId;
  return view;
}

// ===========================================================================
// §2.6.2 · GET /publications/:capabilityId — 查发布态（创作者只读，B-30）
// ===========================================================================

/**
 * 创作者侧只读发布态（§2.6.2）。owner 守门（404 不存在 / 403 非本人）。
 *   返回 PublicationView（reviewStatus/rejectReason/rejectedVersionId/rejectedAt），
 *   供发布页拒绝提示 + 重试/编辑入口（reviewStatus=review_rejected 时前端按 rejectedVersionId 走
 *   40 端点 A 派生新 draft 编辑重发，闭环，§2.6.2 / Codex#4-r3）。三处单一真源（发布-31）。
 */
export function getPublicationHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const userId = requireUserId(req, reply);
    if (!userId) return reply;
    const { capabilityId } = req.params as { capabilityId: string };

    let view;
    try {
      view = await readPublicationView(req.server.infra.db, capabilityId);
    } catch {
      return replyError(req, reply, ErrorCode.INTERNAL, 500, {
        userMessage: '服务开小差了，请重试。',
        action: 'retry',
      });
    }
    if (!view) {
      return replyError(req, reply, ErrorCode.NOT_FOUND, 404, {
        userMessage: '没找到对应能力，可能已被删除。',
        action: 'change_input',
      });
    }
    if (view.ownerUserId !== userId) {
      return replyError(req, reply, ErrorCode.FORBIDDEN, 403, {
        userMessage: '你没有权限查看这个能力。',
        action: 'escalate',
      });
    }

    const { ownerUserId: _owner, ...publicView } = view;
    const out: Envelope<PublicationView> = { data: publicView, meta: { traceId: req.id } };
    reply.code(200).send(out);
    return reply;
  };
}

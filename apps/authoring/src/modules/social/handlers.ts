// B-34 · 社交域 API handler（follow/unfollow/like/unlike，60-dashboard-profile §3）。
//   鉴权/幂等已由 routes/dashboard.ts preHandler 守（requireAuth【任意已登录用户，脊柱 §11.F】+
//     requireIdempotency(social.follow/unfollow/like/unlike)；POST 与 DELETE 都带 key、不豁免 DELETE）。
//   business 校验在 handler 内（§3.5）：自己不能关注自己（422 SOCIAL_SELF_FOLLOW），与鉴权角色无关。
//   去重写入 + 冗余计数维护在 social-repo 单事务内（UNIQUE 去重键 + ON CONFLICT + 同事务计数）。
//   对外失败一律 ErrorEnvelope（人话 userMessage + action + retriable + traceId，绝不含 code，脊柱 §11.B / D1）。
//   幂等回放（重复 POST/DELETE）由中间件承担；本 handler 即便被真实执行第二次（key 失效边界），
//     repo 的 ON CONFLICT/0-row-DELETE 也保证「不重复增减计数」（计数正确 + 幂等双保险）。
import type { FastifyReply, FastifyRequest, RouteHandlerMethod } from 'fastify';
import {
  buildError,
  ErrorCode,
  type Envelope,
  type FollowResult,
  type LikeResult,
} from '@cb/shared';
import { asTxPool } from '../../platform/events/db-tx.js';
import {
  follow,
  unfollow,
  like,
  unlike,
  SocialTargetNotFound,
  SocialSelfLike,
} from './repo.js';

/** 取已鉴权 userId（requireAuth 已保证存在；缺失则 401 兜底，绝不裸露）。 */
function requireUserId(req: FastifyRequest, reply: FastifyReply): string | null {
  const userId = req.auth?.userId;
  if (!userId) {
    reply.code(401).send(buildError(ErrorCode.UNAUTHENTICATED, req.id));
    return null;
  }
  return userId;
}

/** 目标不存在 → 404（不暴露存在性，§3.5）。 */
function reply404(req: FastifyRequest, reply: FastifyReply): FastifyReply {
  reply.code(404).send(
    buildError(ErrorCode.NOT_FOUND, req.id, {
      userMessage: '对象不存在，可能已被删除。',
      action: 'change_input',
    }),
  );
  return reply;
}

/** 自赞 → 422 SOCIAL_SELF_FOLLOW（禁自赞，与「关注自己」同口径，§3.5）。 */
function reply422SelfLike(req: FastifyRequest, reply: FastifyReply): FastifyReply {
  reply.code(422).send(
    buildError(ErrorCode.SOCIAL_SELF_FOLLOW, req.id, {
      userMessage: '不能点赞自己的能力。',
      action: 'change_input',
    }),
  );
  return reply;
}

/** 内部异常 → 500 人话可重试（绝不甩堆栈/DB 报错，脊柱 §11.B）。 */
function reply500(req: FastifyRequest, reply: FastifyReply): FastifyReply {
  reply.code(500).send(
    buildError(ErrorCode.INTERNAL, req.id, {
      userMessage: '服务开小差了，请重试。',
      action: 'retry',
    }),
  );
  return reply;
}

// ===========================================================================
// §3.1 · POST /creators/:creatorId/follows — 关注
// ===========================================================================

/** 关注创作者。自己关注自己 → 422 SOCIAL_SELF_FOLLOW（§3.5）。成功/已关注回放 → 200 Envelope<FollowResult>。 */
export function followHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const userId = requireUserId(req, reply);
    if (!userId) return reply;
    const { creatorId } = req.params as { creatorId: string };

    // 自己不能关注自己（requireAuth 通过后由 handler 判定，与角色无关，§3.5）。
    if (userId === creatorId) {
      reply.code(422).send(
        buildError(ErrorCode.SOCIAL_SELF_FOLLOW, req.id, {
          userMessage: '不能关注自己。',
          action: 'change_input',
        }),
      );
      return reply;
    }

    try {
      const outcome = await follow(asTxPool(req.server.infra.db), userId, creatorId);
      const data: FollowResult = {
        creatorId,
        following: true, // 成功/重复关注回放统一 following:true（§3.1）。
        followersCount: outcome.followersCount,
      };
      const body: Envelope<FollowResult> = { data, meta: { traceId: req.id } };
      reply.code(200).send(body);
      return reply;
    } catch (err) {
      if (err instanceof SocialTargetNotFound) return reply404(req, reply);
      return reply500(req, reply);
    }
  };
}

// ===========================================================================
// §3.2 · DELETE /creators/:creatorId/follows — 取关
// ===========================================================================

/** 取关创作者。重复取关回放 → 200 Envelope<FollowResult>（following:false，计数不重复减）。 */
export function unfollowHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const userId = requireUserId(req, reply);
    if (!userId) return reply;
    const { creatorId } = req.params as { creatorId: string };

    try {
      const outcome = await unfollow(asTxPool(req.server.infra.db), userId, creatorId);
      const data: FollowResult = {
        creatorId,
        following: false,
        followersCount: outcome.followersCount,
      };
      const body: Envelope<FollowResult> = { data, meta: { traceId: req.id } };
      reply.code(200).send(body);
      return reply;
    } catch (err) {
      if (err instanceof SocialTargetNotFound) return reply404(req, reply);
      return reply500(req, reply);
    }
  };
}

// ===========================================================================
// §3.3 · POST /capabilities/:capabilityId/likes — 点赞能力
// ===========================================================================

/** 点赞能力。能力不存在 → 404。成功/已赞回放 → 200 Envelope<LikeResult>（liked:true）。 */
export function likeHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const userId = requireUserId(req, reply);
    if (!userId) return reply;
    const { capabilityId } = req.params as { capabilityId: string };

    try {
      const outcome = await like(asTxPool(req.server.infra.db), userId, capabilityId);
      const data: LikeResult = {
        capabilityId,
        liked: true,
        likesCount: outcome.likesCount,
      };
      const body: Envelope<LikeResult> = { data, meta: { traceId: req.id } };
      reply.code(200).send(body);
      return reply;
    } catch (err) {
      if (err instanceof SocialSelfLike) return reply422SelfLike(req, reply);
      if (err instanceof SocialTargetNotFound) return reply404(req, reply);
      return reply500(req, reply);
    }
  };
}

// ===========================================================================
// §3.4 · DELETE /capabilities/:capabilityId/likes — 取消点赞
// ===========================================================================

/** 取消点赞。重复取消回放 → 200 Envelope<LikeResult>（liked:false，计数不重复减）。 */
export function unlikeHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const userId = requireUserId(req, reply);
    if (!userId) return reply;
    const { capabilityId } = req.params as { capabilityId: string };

    try {
      const outcome = await unlike(asTxPool(req.server.infra.db), userId, capabilityId);
      const data: LikeResult = {
        capabilityId,
        liked: false,
        likesCount: outcome.likesCount,
      };
      const body: Envelope<LikeResult> = { data, meta: { traceId: req.id } };
      reply.code(200).send(body);
      return reply;
    } catch (err) {
      if (err instanceof SocialSelfLike) return reply422SelfLike(req, reply);
      if (err instanceof SocialTargetNotFound) return reply404(req, reply);
      return reply500(req, reply);
    }
  };
}

// 50 · 发布域 API handler（B-27 发布门 + B-28 发布 API/市集卡投影）。50-step5-publish §2.1/§2.2。
//   鉴权/幂等已由 routes/publish.ts preHandler 守（requireRole('creator') + requireIdempotency(publish.version)；
//     market-card/preview 走 optionalIdempotency 豁免——带请求体只读、不写库）。owner 校验在 handler 内据 creator_user_id 做。
//   对外失败一律 ErrorEnvelope（人话 userMessage + action + traceId，绝不裸露 code/堆栈，脊柱 §11.B / D1）。
//   发布门是事务、非长任务 → 同步返回 200（前端「发布中…」由请求 pending 表达，落明确成功/失败、不裸转圈，发布-17）。
import type { FastifyReply, FastifyRequest, RouteHandlerMethod } from 'fastify';
import {
  buildError,
  ErrorCode,
  PublishVersionBodySchema,
  MarketCardPreviewBodySchema,
  type Envelope,
  type PublishResult,
  type MarketCard,
} from '@cb/shared';
import { asTxPool } from '../events/db-tx.js';
import { publishOne } from '../publish/publish-one.js';
import { PublishError, readVersionForPublish } from '../publish/publish-repo.js';
import { buildMarketCard, primaryPriceMicros, USAGE_PLACEHOLDERS } from '../publish/market-card.js';

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
// §2.1 · POST /versions/:versionId/publish — 发布单个能力（B-27/B-28）
// ===========================================================================

/**
 * 发布单个能力（§2.1）。同步事务：成功 200 Envelope<PublishResult>（含即时市集卡），失败人话信封。
 *   闸序（publishOne 内）：owner → 状态机（draft 才发；published→ALREADY_PUBLISHED；其它→STATE_CONFLICT）
 *   → 必填校验（缺 → 422 PUBLISH_MISSING_FIELDS + details.missingFields）→ 发布门单事务（§1.2）。
 *   防重：preHandler requireIdempotency(publish.version) + publications.capability_id UNIQ + 事务②守门（三道闸）。
 *   失败保留已编辑内容（发布-19）：仅返回 ErrorEnvelope，不清空封面/价格/名称（前端态承载）。
 */
export function publishVersionHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const userId = requireUserId(req, reply);
    if (!userId) return reply;
    const { versionId } = req.params as { versionId: string };

    const parsed = PublishVersionBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      // 入参格式不对（封面来源枚举/价格非负/可见性枚举等）→ 422 缺必填人话（去补齐）。
      return replyError(req, reply, ErrorCode.PUBLISH_MISSING_FIELDS, 422, {
        userMessage: '市集卡还差点内容：封面/价格/可见性要先设好，补齐后再发布。',
        action: 'change_input',
      });
    }

    let result: PublishResult;
    try {
      result = await publishOne(req.server.infra.db, asTxPool(req.server.infra.db), {
        versionId,
        ownerUserId: userId,
        cover: parsed.data.cover,
        tiers: parsed.data.tiers,
        visibility: parsed.data.visibility,
        traceId: req.id,
      });
    } catch (err) {
      if (err instanceof PublishError) {
        return replyPublishError(req, reply, err);
      }
      // 事务内部失败 / DB 抖动 → 500 人话可重试（发布-18：人话 + 重试，绝不甩堆栈）。
      return replyError(req, reply, ErrorCode.INTERNAL, 500, {
        userMessage: '服务开小差了，请重试。',
        action: 'retry',
      });
    }

    const body: Envelope<PublishResult> = {
      data: result,
      // usage 占位说明（装机量/评分上线后填充，发布-07 / 脊柱 §2.2）。
      meta: { traceId: req.id, placeholders: { ...USAGE_PLACEHOLDERS } },
    };
    reply.code(200).send(body);
    return reply;
  };
}

/** 把 PublishError(code) 映射到 HTTP + 人话信封（§2.1 错误用例表，绝不裸露 code）。 */
function replyPublishError(
  req: FastifyRequest,
  reply: FastifyReply,
  err: PublishError,
): FastifyReply {
  switch (err.code) {
    case ErrorCode.NOT_FOUND:
      return replyError(req, reply, ErrorCode.NOT_FOUND, 404, {
        userMessage: '没找到对应能力，可能已被删除。',
        action: 'change_input',
      });
    case ErrorCode.FORBIDDEN:
      return replyError(req, reply, ErrorCode.FORBIDDEN, 403, {
        userMessage: '你没有权限发布这个能力。',
        action: 'escalate',
      });
    case ErrorCode.ALREADY_PUBLISHED:
      return replyError(req, reply, ErrorCode.ALREADY_PUBLISHED, 409, {
        userMessage: '这个能力已发布过了，无需重复发布。',
        action: 'none',
      });
    case ErrorCode.STATE_CONFLICT:
      return replyError(req, reply, ErrorCode.STATE_CONFLICT, 409, {
        userMessage: '当前状态不支持发布，请基于被拒/旧版编辑生成新版本再发布。',
        action: 'change_input',
      });
    case ErrorCode.PUBLISH_MISSING_FIELDS: {
      const missingFields =
        (err as PublishError & { missingFields?: string[] }).missingFields ?? [];
      return replyError(req, reply, ErrorCode.PUBLISH_MISSING_FIELDS, 422, {
        userMessage: '市集卡还差点内容，补齐后再发布。',
        action: 'change_input',
        details: { missingFields },
      });
    }
    default:
      return replyError(req, reply, ErrorCode.INTERNAL, 500, {
        userMessage: '服务开小差了，请重试。',
        action: 'retry',
      });
  }
}

// ===========================================================================
// §2.2 · POST /versions/:versionId/market-card/preview — 市集卡预览（B-28，不写库）
// ===========================================================================

/**
 * 市集卡预览（§2.2）。无副作用（不写库）：读 manifest 软字段 + 创作者账号，套未持久化的封面/价格预览入参，
 *   组装一张 MarketCard 返回（与发布后展示一致，发布-01/03）。owner 守门（404/403）；
 *   软字段未生成完（结构化未完成）→ 409 STATE_CONFLICT（回上一步补全再预览，§2.2）。
 *   价格未设 → priceMicros null + display null（待填提示，发布-25）；封面缺 → glyph 默认（发布-25）。
 */
export function marketCardPreviewHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const userId = requireUserId(req, reply);
    if (!userId) return reply;
    const { versionId } = req.params as { versionId: string };

    const parsed = MarketCardPreviewBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return replyError(req, reply, ErrorCode.VALIDATION_FAILED, 400, {
        userMessage: '预览参数格式不对，调整后再试。',
        action: 'change_input',
      });
    }

    let row;
    try {
      row = await readVersionForPublish(req.server.infra.db, versionId);
    } catch {
      return replyError(req, reply, ErrorCode.INTERNAL, 500, {
        userMessage: '服务开小差了，请重试。',
        action: 'retry',
      });
    }
    if (!row) {
      return replyError(req, reply, ErrorCode.NOT_FOUND, 404, {
        userMessage: '没找到对应能力，可能已被删除。',
        action: 'change_input',
      });
    }
    if (row.creatorUserId !== userId) {
      return replyError(req, reply, ErrorCode.FORBIDDEN, 403, {
        userMessage: '你没有权限查看这个能力。',
        action: 'escalate',
      });
    }
    // 软字段尚未生成完（结构化未完成：name/tagline 任一空）→ 409（回上一步补全再预览，§2.2）。
    if (!row.manifest.name || !row.manifest.tagline) {
      return replyError(req, reply, ErrorCode.STATE_CONFLICT, 409, {
        userMessage: '能力说明书还没整理好，回上一步把字段补全再来预览。',
        action: 'change_input',
      });
    }

    const card: MarketCard = buildMarketCard({
      versionId: row.versionId,
      capabilityId: row.capabilityId,
      slug: row.slug,
      manifest: row.manifest,
      account: row.account,
      ...(parsed.data.cover ? { cover: parsed.data.cover } : {}),
      coverUrl: null,
      priceMicros: primaryPriceMicros(parsed.data.tiers),
    });

    const body: Envelope<MarketCard> = {
      data: card,
      // 装机量/评分占位（上线后真实数据填充，发布-07）。
      meta: { traceId: req.id, placeholders: { ...USAGE_PLACEHOLDERS } },
    };
    reply.code(200).send(body);
    return reply;
  };
}

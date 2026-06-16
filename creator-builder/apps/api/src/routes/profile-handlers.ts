// 60 · 个人主页聚合 API handler（B-33，全六分区 P0，60-dashboard-profile §2）。
//   鉴权：路由 optionalAuth（公开只读、访客同视图，主页-13）；viewerId 仅用于 Hero.viewerIsFollowing（登录态才有值）。
//   对外信任口径：只读不下钻、不带经营维度、钱/经营动作绝不外泄（主页-04/25/26）。
//   usage 类（总调用量/最热主题热度/作品墙调用次数）本期统一 null + meta.placeholders（决策②，脊柱 §2.2）。
//   对外失败一律 ErrorEnvelope（人话 userMessage + action + traceId，绝不裸露 code/堆栈，脊柱 §11.B / D1）。
//   creatorId 不存在/已注销 → 404 NOT_FOUND（不下钻、不暴露存在性，§2.7）；聚合失败 → 500 可重试（主页-16）。
import type { FastifyReply, FastifyRequest, RouteHandlerMethod } from 'fastify';
import {
  buildError,
  ErrorCode,
  InvalidCursorError,
  type Envelope,
  type Paginated,
  type CreatorProfile,
  type ProfileHeatmap,
  type ProfileNetwork,
  type DensityRankRow,
  type WorkCard,
} from '@cb/shared';
import {
  readCreatorProfile,
  readDensityPage,
  readHeatmap,
  readNetwork,
  readWorksPage,
  PROFILE_USAGE_PLACEHOLDER,
} from '../profile/profile-repo.js';

/** 404（creatorId 不存在/已注销）：不暴露存在性、不下钻（§2.7）。 */
function reply404(req: FastifyRequest, reply: FastifyReply): FastifyReply {
  reply.code(404).send(
    buildError(ErrorCode.NOT_FOUND, req.id, {
      userMessage: '没找到这个创作者，可能链接失效了。',
      action: 'change_input',
    }),
  );
  return reply;
}

/** 500 主聚合失败（主页-16，人话可重试，绝不裸露 code/堆栈）。 */
function reply500Aggregate(req: FastifyRequest, reply: FastifyReply): FastifyReply {
  reply.code(500).send(
    buildError(ErrorCode.PROFILE_AGGREGATE_FAILED, req.id, {
      userMessage: '内容没能加载，请重试。',
      action: 'retry',
    }),
  );
  return reply;
}

/** 500 单分区失败（主页-17，仅该分区局部错误+重试，整页不崩）。 */
function reply500Section(req: FastifyRequest, reply: FastifyReply): FastifyReply {
  reply.code(500).send(
    buildError(ErrorCode.PROFILE_SECTION_FAILED, req.id, {
      userMessage: '这个分区没能加载，请重试。',
      action: 'retry',
    }),
  );
  return reply;
}

/** 400 翻页参数失效（cursor/limit 越界，§2.7，回开头重试）。 */
function reply400Page(req: FastifyRequest, reply: FastifyReply): FastifyReply {
  reply.code(400).send(
    buildError(ErrorCode.VALIDATION_FAILED, req.id, {
      userMessage: '翻页参数失效了，回到开头重试。',
      action: 'change_input',
    }),
  );
  return reply;
}

/** 解析 limit（非法 → null，调用方 400）。 */
function parseLimit(raw: string | undefined, def: number, max: number): number | null {
  if (raw === undefined) return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > max) return null;
  return n;
}

// ===========================================================================
// §2.0 · GET /creators/:creatorId/profile — 主聚合（六分区首屏全量）
// ===========================================================================

/**
 * 主聚合（主页-01）。单次返回六分区全量首屏切片。公开只读、访客同视图（viewerId 仅切 Hero.viewerIsFollowing）。
 *   usage 占位（totalInvocations/hottestTopic.heatValue/作品墙 invocations）→ meta.placeholders（脊柱 §2.2）。
 */
export function getCreatorProfileHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const { creatorId } = req.params as { creatorId: string };
    const viewerId = req.auth?.userId ?? null;

    let result;
    try {
      result = await readCreatorProfile(req.server.infra.db, creatorId, viewerId);
    } catch {
      return reply500Aggregate(req, reply);
    }
    if (!result) return reply404(req, reply);

    const placeholders: Record<string, string> = {};
    for (const key of result.usagePlaceholderKeys) placeholders[key] = PROFILE_USAGE_PLACEHOLDER;

    const body: Envelope<CreatorProfile> = {
      data: result.profile,
      meta: { traceId: req.id, placeholders },
    };
    reply.code(200).send(body);
    return reply;
  };
}

// ===========================================================================
// §2.3 · GET /creators/:creatorId/capabilities?byDensity — 能力密度榜（cursor 分页）
// ===========================================================================

/**
 * 能力密度榜子端点（主页-05/06/08）。默认前 3，展开更多翻页。密度/段数/趋势真实（不依赖 usage，§2.3）。
 *   只读 readonly:true（无管理操作，主页-08）。byDensity 标记排序口径（默认即按密度，本期恒密度序）。
 */
export function getDensityHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const { creatorId } = req.params as { creatorId: string };
    const q = req.query as { cursor?: string; limit?: string; byDensity?: string };
    // 默认前 3（主页-05）；密度榜上限 50（§2.3）。
    const limit = parseLimit(q.limit, 3, 50);
    if (limit === null) return reply400Page(req, reply);

    let page;
    try {
      page = await readDensityPage(req.server.infra.db, creatorId, {
        ...(q.cursor ? { cursor: q.cursor } : {}),
        limit,
      });
    } catch (err) {
      // cursor 失效/畸形 → 400（非静默回首页、非 500，契约 60 §2.7 / Codex r1#2）。
      if (err instanceof InvalidCursorError) return reply400Page(req, reply);
      return reply500Section(req, reply);
    }
    if (!page) return reply404(req, reply);

    const body: Paginated<DensityRankRow> = {
      data: page.rows,
      meta: {
        traceId: req.id,
        page: { nextCursor: page.nextCursor, hasMore: page.hasMore, limit, order: 'desc' },
      },
    };
    reply.code(200).send(body);
    return reply;
  };
}

// ===========================================================================
// §2.4 · GET /creators/:creatorId/heatmap — 会话足迹热力图
// ===========================================================================

/**
 * 热力图子端点（主页-09/20）。近半年按天格子（range='year' 可整年）。只数量、绝不露会话原文（隐私硬约束）。
 *   按 session_segments.happened_at 聚合（不依赖 usage，决策⑥）。创作者关闭 → enabled:false + 空 cells（主页-20）。
 */
export function getHeatmapHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const { creatorId } = req.params as { creatorId: string };
    const q = req.query as { range?: string };
    const range: 'half_year' | 'year' = q.range === 'year' ? 'year' : 'half_year';

    let heatmap;
    try {
      heatmap = await readHeatmap(req.server.infra.db, creatorId, range);
    } catch {
      return reply500Section(req, reply);
    }
    if (!heatmap) return reply404(req, reply);

    const body: Envelope<ProfileHeatmap> = { data: heatmap, meta: { traceId: req.id } };
    reply.code(200).send(body);
    return reply;
  };
}

// ===========================================================================
// §2.5 · GET /creators/:creatorId/network — 能力网络缩略（session/tag 共现）
// ===========================================================================

/**
 * 能力网络缩略子端点（主页-10）。一次全量缩略边（session/tag 共现即时生成，不依赖 embedding，决策⑥）。
 *   thumbnailOnly:true 恒成立——仅缩略、无展开图谱入口（响应不含任何展开/完整图谱字段）。
 */
export function getNetworkHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const { creatorId } = req.params as { creatorId: string };

    let network;
    try {
      network = await readNetwork(req.server.infra.db, creatorId);
    } catch {
      return reply500Section(req, reply);
    }
    if (!network) return reply404(req, reply);

    const body: Envelope<ProfileNetwork> = { data: network, meta: { traceId: req.id } };
    reply.code(200).send(body);
    return reply;
  };
}

// ===========================================================================
// §2.6 · GET /creators/:creatorId/works — 作品墙（cursor 分页，B-30 过滤/回退）
// ===========================================================================

/**
 * 作品墙子端点（主页-11/12/19/22/23/24）。已发布卡网格（单源 publications 过滤/回退，决策④）。
 *   被拒下架不上墙（主页-23）；回退展示上一 published 版（主页-24）；alpha_pending 按公开口径（不暴露内部码，主页-19）。
 *   调用次数 invocations 恒 null + meta.placeholders（usage 占位，主页-11/19/24）；coverUrl/name 真实。
 */
export function getWorksHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const { creatorId } = req.params as { creatorId: string };
    const q = req.query as { cursor?: string; limit?: string };
    // 作品墙默认 24、上限 60（§2.6）。
    const limit = parseLimit(q.limit, 24, 60);
    if (limit === null) return reply400Page(req, reply);

    let page;
    try {
      page = await readWorksPage(req.server.infra.db, creatorId, {
        ...(q.cursor ? { cursor: q.cursor } : {}),
        limit,
      });
    } catch (err) {
      // cursor 失效/畸形 → 400（非静默回首页、非 500，契约 60 §2.7 / Codex r1#2）。
      if (err instanceof InvalidCursorError) return reply400Page(req, reply);
      return reply500Section(req, reply);
    }
    if (!page) return reply404(req, reply);

    const body: Paginated<WorkCard> = {
      data: page.cards,
      meta: {
        traceId: req.id,
        page: { nextCursor: page.nextCursor, hasMore: page.hasMore, limit, order: 'desc' },
        // 作品墙调用次数 usage 占位（主页-11/19/24，脊柱 §2.2）。
        placeholders: { invocations: PROFILE_USAGE_PLACEHOLDER },
      },
    };
    reply.code(200).send(body);
    return reply;
  };
}

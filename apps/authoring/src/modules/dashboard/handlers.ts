// 60 · 工作台聚合 API handler（B-32，60-dashboard-profile §1）。
//   鉴权（外壳首页-20）：preHandler requireAuth（routes/dashboard.ts）保证已登录；工作台是【本人经营后台】，
//     handler 取 req.auth.userId 作 owner，全部读按本人聚合（无 path 上的别人 id，天然 owner=本人，不下钻他人）。
//   时间范围（外壳首页-19）：range ∈ {7d,30d,all} 缺省 30d，照常解析/回显（三档切换不报错）；
//     本期对非占位真实维度生效（published 卡环比按 range 取上一区间基期）；usage 维度全占位（range 不改其值）。
//   对外失败一律 ErrorEnvelope（人话 userMessage + action + traceId，绝不裸露 code/堆栈，脊柱 §11.B / D1）。
//   聚合查询失败 → 500 DASHBOARD_AGGREGATE_FAILED（人话可重试，外壳首页-25）；range/cursor 非法 → 400（外壳首页-19）。
//   钱/成本/经营动作只在此域（私有）；usage 字段统一 null + meta.placeholders（决策②，非裸 0/非空错误/非转圈）。
import type { FastifyReply, FastifyRequest, RouteHandlerMethod } from 'fastify';
import { z } from 'zod';
import {
  buildError,
  ErrorCode,
  InvalidCursorError,
  type Envelope,
  type Paginated,
  type DashboardSummary,
  type DashboardMetrics,
  type TokenTrend,
  type DashboardCapabilityRow,
  type DraftView,
} from '@cb/shared';
import {
  countPublished,
  countPublishedCurrentWindow,
  countPublishedPrevWindow,
  listCapabilities,
  listDrafts,
} from './repo.js';
import {
  buildSummary,
  buildMetrics,
  buildTokenTrend,
  toDashboardCapabilityRow,
} from './dashboard-view.js';
import {
  SUMMARY_USAGE_PLACEHOLDERS,
  METRICS_USAGE_PLACEHOLDERS,
  TOKEN_TREND_USAGE_PLACEHOLDERS,
  CAPABILITY_ROW_USAGE_PLACEHOLDERS,
} from './usage-placeholders.js';

// ===========================================================================
// 请求侧 query 校验（请求参数校验，非响应契约；响应类型 import @cb/shared）
//   range 缺省 30d（§1）；分页 cursor/limit/order（脊柱 §2.3）；非法 → 400 VALIDATION_FAILED。
// ===========================================================================
const RangeQuerySchema = z.object({
  range: z.enum(['7d', '30d', 'all']).default('30d'),
});
const TokenTrendQuerySchema = z.object({
  range: z.enum(['7d', '30d', 'all']).default('30d'),
  metric: z.enum(['tokens', 'invocations']).default('tokens'),
});
const CapabilitiesQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  order: z.enum(['asc', 'desc']).default('desc'),
  range: z.enum(['7d', '30d', 'all']).default('30d'),
  status: z.enum(['all', 'alpha_pending', 'published', 'review_rejected', 'draft']).default('all'),
});
const DraftsQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  order: z.enum(['asc', 'desc']).default('desc'),
});

/** 取本人 userId（preHandler requireAuth 已保证，缺则 401 兜底，脊柱 §11.B）。 */
function requireUserId(req: FastifyRequest, reply: FastifyReply): string | null {
  const userId = req.auth?.userId;
  if (!userId) {
    reply.code(401).send(buildError(ErrorCode.UNAUTHENTICATED, req.id));
    return null;
  }
  return userId;
}

/** 400 入参非法（range/cursor 等，外壳首页-19，人话「换一档/回首页」）。 */
function reply400(req: FastifyRequest, reply: FastifyReply, userMessage: string): FastifyReply {
  reply
    .code(400)
    .send(buildError(ErrorCode.VALIDATION_FAILED, req.id, { userMessage, action: 'change_input' }));
  return reply;
}

/** 500 聚合失败（外壳首页-25，人话可重试，绝不裸堆栈）。 */
function reply500Aggregate(req: FastifyRequest, reply: FastifyReply): FastifyReply {
  reply.code(500).send(
    buildError(ErrorCode.DASHBOARD_AGGREGATE_FAILED, req.id, {
      userMessage: '经营数据没能加载，请重试。',
      action: 'retry',
    }),
  );
  return reply;
}

// ===========================================================================
// §1.1 · GET /dashboard/summary — 页头经营摘要（外壳首页-08）
// ===========================================================================

/**
 * 页头摘要（§1.1）。publishedCount 真实（本人 published 计数，与 metrics published 卡一致）；
 *   monthlyInvocations usage 占位 null + meta.placeholders（得体文案表达暂无，非裸 0）。
 */
export function dashboardSummaryHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const userId = requireUserId(req, reply);
    if (!userId) return reply;
    const parsed = RangeQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) return reply400(req, reply, '时间范围参数不对，换一档再试。');

    let publishedCount: number;
    try {
      publishedCount = await countPublished(req.server.infra.db, userId);
    } catch {
      return reply500Aggregate(req, reply);
    }

    const summary: DashboardSummary = buildSummary(publishedCount);
    const body: Envelope<DashboardSummary> = {
      data: summary,
      meta: { traceId: req.id, placeholders: { ...SUMMARY_USAGE_PLACEHOLDERS } },
    };
    reply.code(200).send(body);
    return reply;
  };
}

// ===========================================================================
// §1.2 · GET /dashboard/metrics — 四张大数字卡 + 环比（外壳首页-09/29）
// ===========================================================================

/**
 * 四卡 + 环比（§1.2）。published 卡真实值 + 真实环比（按 range 取上一区间基期，all 无基期 → 环比 null）；
 *   invocationsTotal/spendThisMonth/activeConsumers 三张 usage 卡 value/deltaPercent/deltaDirection 全 null + placeholders。
 */
export function dashboardMetricsHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const userId = requireUserId(req, reply);
    if (!userId) return reply;
    const parsed = RangeQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) return reply400(req, reply, '时间范围参数不对，换一档再试。');
    const { range } = parsed.data;

    // value=总已发布数；环比两侧用【同口径】窗口新增数（Codex#r3 P1：不与总数混口径，方向才正确）。
    let totalPublished: number;
    let currentWindowPublished: number | null;
    let prevWindowPublished: number | null;
    const nowMs = Date.now();
    try {
      totalPublished = await countPublished(req.server.infra.db, userId);
      currentWindowPublished = await countPublishedCurrentWindow(
        req.server.infra.db,
        userId,
        range,
        nowMs,
      );
      prevWindowPublished = await countPublishedPrevWindow(
        req.server.infra.db,
        userId,
        range,
        nowMs,
      );
    } catch {
      return reply500Aggregate(req, reply);
    }

    const metrics: DashboardMetrics = buildMetrics(
      range,
      totalPublished,
      currentWindowPublished,
      prevWindowPublished,
    );
    const body: Envelope<DashboardMetrics> = {
      data: metrics,
      meta: { traceId: req.id, placeholders: { ...METRICS_USAGE_PLACEHOLDERS } },
    };
    reply.code(200).send(body);
    return reply;
  };
}

// ===========================================================================
// §1.3 · GET /dashboard/token-trend — 每日 token 消耗趋势（外壳首页-10/26）
// ===========================================================================

/**
 * token 趋势（§1.3）。本期整图占位：points:[]、peak:null、empty:true + meta.placeholders["points"]。
 *   切换 metric（tokens/invocations）/range 照常返回（不报错）；区间无消耗 = empty:true（前端「暂无消耗」空态、不误标峰值）。
 */
export function dashboardTokenTrendHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const userId = requireUserId(req, reply);
    if (!userId) return reply;
    const parsed = TokenTrendQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) return reply400(req, reply, '时间范围参数不对，换一档再试。');
    const { range, metric } = parsed.data;

    const trend: TokenTrend = buildTokenTrend(range, metric);
    const body: Envelope<TokenTrend> = {
      data: trend,
      meta: { traceId: req.id, placeholders: { ...TOKEN_TREND_USAGE_PLACEHOLDERS } },
    };
    reply.code(200).send(body);
    return reply;
  };
}

// ===========================================================================
// §1.4 · GET /dashboard/capabilities — 能力体列表（外壳首页-11/14/15/30-B30）
// ===========================================================================

/**
 * 能力体列表（§1.4，cursor 分页）。本人名下能力，名称/简介/状态真实（状态经单一真源派生）；
 *   usage 三列（本月调用/消耗迷你图/收益）null + meta.placeholders；公开页动作与 Runtime 真源同口径；
 *   拒绝态出原因 + 可重试编辑（B-30 三处可见之一）。
 */
export function dashboardCapabilitiesHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const userId = requireUserId(req, reply);
    if (!userId) return reply;
    const parsed = CapabilitiesQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) return reply400(req, reply, '翻页或筛选参数失效了，回到第一页重试。');
    const { cursor, limit, order, status } = parsed.data;

    let result;
    try {
      result = await listCapabilities(req.server.infra.db, {
        ownerUserId: userId,
        ...(cursor !== undefined ? { cursor } : {}),
        limit,
        order,
        status,
      });
    } catch (err) {
      // cursor 失效/畸形 → 400（非静默错页、非 500，契约 60 §1.6 / Codex r1#2）。
      if (err instanceof InvalidCursorError) {
        return reply400(req, reply, '翻页参数失效了，回到第一页重试。');
      }
      return reply500Aggregate(req, reply);
    }

    const rows: DashboardCapabilityRow[] = result.rows.map(toDashboardCapabilityRow);
    const body: Paginated<DashboardCapabilityRow> = {
      data: rows,
      meta: {
        traceId: req.id,
        placeholders: { ...CAPABILITY_ROW_USAGE_PLACEHOLDERS },
        page: { nextCursor: result.nextCursor, hasMore: result.nextCursor !== null, limit, order },
      },
    };
    reply.code(200).send(body);
    return reply;
  };
}

// ===========================================================================
// §1.5 · GET /dashboard/drafts — 草稿与上传中条（外壳首页-16/17/23/33/34，F-15）
// ===========================================================================

/**
 * 草稿条（§1.5，cursor 分页）。真实数据（非 usage）：仅 status='active' 草稿，每条携 currentStep + 落点引用 +
 *   stepProgress.phrase（续传回精确断点）；多条逐条独立不串台；空态 data:[] + hasMore:false（外壳首页-23）。
 *   本域只读 drafts 表（不建任务、不发 SSE；续传 SSE 由 jobs/structure 流承载，§6）。
 */
export function dashboardDraftsHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const userId = requireUserId(req, reply);
    if (!userId) return reply;
    const parsed = DraftsQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) return reply400(req, reply, '翻页参数失效了，回到第一页重试。');
    const { cursor, limit, order } = parsed.data;

    let result;
    try {
      result = await listDrafts(req.server.infra.db, {
        ownerUserId: userId,
        ...(cursor !== undefined ? { cursor } : {}),
        limit,
        order,
      });
    } catch (err) {
      // cursor 失效/畸形 → 400（非静默错页、非 500，契约 60 §1.6 / Codex r1#2）。
      if (err instanceof InvalidCursorError) {
        return reply400(req, reply, '翻页参数失效了，回到第一页重试。');
      }
      return reply500Aggregate(req, reply);
    }

    const body: Paginated<DraftView> = {
      data: result.items,
      meta: {
        traceId: req.id,
        page: { nextCursor: result.nextCursor, hasMore: result.nextCursor !== null, limit, order },
      },
    };
    reply.code(200).send(body);
    return reply;
  };
}

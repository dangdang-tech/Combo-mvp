// 30 · 提取接入 API handler（B-22 列候选/详情/证据 + B-23 触发萃取/单候选重试）。30-step2-extract §2。
//   - 鉴权/幂等已由 routes/extract.ts preHandler 守（requireRole/requireAuth/requireIdempotency）。
//     幂等行为矩阵（回放/423/409）由 requireIdempotency 中间件在 preHandler 层完成；本 handler 只产首次 202。
//   - 对外失败一律 ErrorEnvelope（人话 userMessage + action + traceId，绝不裸露 code/堆栈，脊柱 §11.B / D1）。
//   - 触发/重试秒回完整 JobView 形态包络（jobId/status/eventsUrl），前端立连 SSE，永不裸转圈（硬规则①）。
//   - 单候选重试建【新 retry job + 新 eventsUrl】，绝不在已 terminal 的原萃取 job 流上追加（Codex#4）。
import type { FastifyReply, FastifyRequest, RouteHandlerMethod } from 'fastify';
import {
  buildError,
  ErrorCode,
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  type Envelope,
  type Paginated,
  type ExtractJobAccepted,
  type CandidateRetryAccepted,
  type CandidateView,
  type CandidateEvidenceView,
  type ConfidenceSummary,
} from '@cb/shared';
import { createFullExtractJob, createRetryJob, jobEventsUrl } from './create-extract-job.js';
import { listCandidates, getCandidateForOwner, listCandidateEvidence } from './candidates-repo.js';

function requireUserId(req: FastifyRequest, reply: FastifyReply): string | null {
  const userId = req.auth?.userId;
  if (!userId) {
    reply.code(401).send(buildError(ErrorCode.UNAUTHENTICATED, req.id));
    return null;
  }
  return userId;
}

/** 解析 cursor 分页公共参数（limit 非法 → 返回 null，调用方 400）。 */
function parsePage(
  q: { cursor?: string; limit?: string; order?: string },
  defaultOrder: 'asc' | 'desc',
): { cursor?: string; limit: number; order: 'asc' | 'desc' } | null {
  const limit = q.limit ? Number(q.limit) : DEFAULT_PAGE_LIMIT;
  if (q.limit && (!Number.isFinite(limit) || limit < 1 || limit > MAX_PAGE_LIMIT)) return null;
  const order = q.order === 'asc' ? 'asc' : q.order === 'desc' ? 'desc' : defaultOrder;
  return { ...(q.cursor ? { cursor: q.cursor } : {}), limit, order };
}

// ---------------------------------------------------------------------------
// B-23 触发萃取（POST /snapshots/{snapshotId}/extract）
// ---------------------------------------------------------------------------

/**
 * POST /snapshots/:snapshotId/extract — 对某去敏快照触发萃取 Job（§2.1，202 秒回 jobId + eventsUrl）。
 *   幂等已由 preHandler 守（连点/刷新只跑一次，提取-25）。owner + 就绪闸内联进建 job（受保护，§11.A）：
 *     - 快照不存在/非本人 → 404 NOT_FOUND（不暴露存在性）。
 *     - 快照属本人但无段可萃取（segment_count=0，导入未就绪）→ 409 EXTRACT_SNAPSHOT_NOT_READY。
 *   建 job + 入队后秒回 ExtractJobAccepted（jobId/snapshotId/status=queued/eventsUrl），前端立连 SSE（不裸转圈）。
 *   「识别不出能力」不是触发期错误——触发成功仍 202，空态由 SSE done(candidateCount=0) 表达（提取-26）。
 */
export function triggerExtractHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const userId = requireUserId(req, reply);
    if (!userId) return reply;
    const { snapshotId } = req.params as { snapshotId: string };

    // 草稿落点（P0，Codex r4）：本萃取由哪条草稿发起（body.draftId）。串进建 job 同一事务回填 drafts.extract_job_id +
    //   current_step='extract'（owner 守卫 + 单次写 + 永不倒退）——不再 handler 层 best-effort 独立写（续传指针绝不与 job 半落）。
    const rawDraftId = (req.body as { draftId?: unknown } | undefined)?.draftId;
    const draftId =
      typeof rawDraftId === 'string' && rawDraftId.length > 0 ? rawDraftId : undefined;

    let result;
    try {
      result = await createFullExtractJob(
        req.server.infra.db,
        req.server.infra.queue,
        snapshotId,
        userId,
        draftId,
        req.id,
      );
    } catch {
      // DB 异常：人话 503 可重试（绝不裸露原始报错，脊柱 §11.B）。
      reply.code(503).send(buildError(ErrorCode.DEPENDENCY_UNAVAILABLE, req.id));
      return reply;
    }

    if (result.kind === 'not_found') {
      reply.code(404).send(
        buildError(ErrorCode.NOT_FOUND, req.id, {
          userMessage: '没找到对应的原始数据，可能已被删除。',
          action: 'change_input',
        }),
      );
      return reply;
    }
    if (result.kind === 'not_ready') {
      // 快照未就绪/无段可萃取（导入未完成）。
      reply.code(409).send(buildError(ErrorCode.EXTRACT_SNAPSHOT_NOT_READY, req.id));
      return reply;
    }

    const data: ExtractJobAccepted = {
      jobId: result.job.jobId,
      snapshotId,
      status: 'queued',
      eventsUrl: jobEventsUrl(result.job.jobId),
    };
    const body: Envelope<ExtractJobAccepted> = { data, meta: { traceId: req.id } };
    reply.code(202).send(body);
    return reply;
  };
}

// ---------------------------------------------------------------------------
// B-22 列候选（GET /extract-jobs/{jobId}/candidates）
// ---------------------------------------------------------------------------

/**
 * GET /extract-jobs/:jobId/candidates — 列某次萃取的候选（§2.2）。owner + type=extract 守门（→ 404）。
 *   order 默认 asc（追加流，提取-30）；可选 ?status=ready,failed 多值过滤（缺省全部，含 failed 行，提取-17）。
 *   meta.confidenceSummary 是本端点对 Meta 的领域扩展（置信分布，仅 ready，提取-12）。
 */
export function listCandidatesHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const userId = requireUserId(req, reply);
    if (!userId) return reply;
    const { jobId } = req.params as { jobId: string };
    const q = req.query as { cursor?: string; limit?: string; order?: string; status?: string };
    const page = parsePage(q, 'asc');
    if (!page) {
      reply.code(400).send(buildError(ErrorCode.VALIDATION_FAILED, req.id));
      return reply;
    }
    try {
      const result = await listCandidates(req.server.infra.db, {
        extractJobId: jobId,
        ownerUserId: userId,
        ...(page.cursor ? { cursor: page.cursor } : {}),
        limit: page.limit,
        order: page.order,
        ...(q.status ? { status: q.status } : {}),
      });
      if (!result.ownsJob) {
        reply.code(404).send(buildError(ErrorCode.NOT_FOUND, req.id));
        return reply;
      }
      const meta: Paginated<CandidateView>['meta'] & { confidenceSummary?: ConfidenceSummary } = {
        traceId: req.id,
        page: {
          nextCursor: result.nextCursor,
          hasMore: result.nextCursor !== null,
          limit: page.limit,
          order: page.order,
        },
        ...(result.confidenceSummary ? { confidenceSummary: result.confidenceSummary } : {}),
      };
      const body: Paginated<CandidateView> = { data: result.items, meta };
      reply.code(200).send(body);
    } catch {
      reply.code(500).send(buildError(ErrorCode.INTERNAL, req.id));
    }
    return reply;
  };
}

// ---------------------------------------------------------------------------
// B-22 候选详情（GET /candidates/{candidateId}）
// ---------------------------------------------------------------------------

/** GET /candidates/:candidateId — 候选详情（§2.4，owner 守门，404 不暴露存在性）。 */
export function getCandidateHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const userId = requireUserId(req, reply);
    if (!userId) return reply;
    const { candidateId } = req.params as { candidateId: string };
    try {
      const view = await getCandidateForOwner(req.server.infra.db, candidateId, userId);
      if (!view) {
        reply.code(404).send(buildError(ErrorCode.NOT_FOUND, req.id));
        return reply;
      }
      const body: Envelope<CandidateView> = { data: view, meta: { traceId: req.id } };
      reply.code(200).send(body);
    } catch {
      reply.code(500).send(buildError(ErrorCode.INTERNAL, req.id));
    }
    return reply;
  };
}

// ---------------------------------------------------------------------------
// B-22 段级血缘证据下钻（GET /candidates/{candidateId}/evidence）
// ---------------------------------------------------------------------------

/**
 * GET /candidates/:candidateId/evidence — 段级血缘证据（§2.4）。owner 守门（→ 404）。
 *   cursor 分页，order 默认 asc；quote 是去敏后片段（提取-31）；条数 == segmentCount（提取-34）。
 */
export function listEvidenceHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const userId = requireUserId(req, reply);
    if (!userId) return reply;
    const { candidateId } = req.params as { candidateId: string };
    const q = req.query as { cursor?: string; limit?: string; order?: string };
    const page = parsePage(q, 'asc');
    if (!page) {
      reply.code(400).send(buildError(ErrorCode.VALIDATION_FAILED, req.id));
      return reply;
    }
    try {
      const result = await listCandidateEvidence(req.server.infra.db, {
        candidateId,
        ownerUserId: userId,
        ...(page.cursor ? { cursor: page.cursor } : {}),
        limit: page.limit,
        order: page.order,
      });
      if (!result.ownsCandidate) {
        reply.code(404).send(buildError(ErrorCode.NOT_FOUND, req.id));
        return reply;
      }
      const body: Paginated<CandidateEvidenceView> = {
        data: result.items,
        meta: {
          traceId: req.id,
          page: {
            nextCursor: result.nextCursor,
            hasMore: result.nextCursor !== null,
            limit: page.limit,
            order: page.order,
          },
        },
      };
      reply.code(200).send(body);
    } catch {
      reply.code(500).send(buildError(ErrorCode.INTERNAL, req.id));
    }
    return reply;
  };
}

// ---------------------------------------------------------------------------
// B-23 单候选重试（POST /candidates/{candidateId}/retry）
// ---------------------------------------------------------------------------

/**
 * POST /candidates/:candidateId/retry — 单候选重试（§2.3，B-23 核心，Codex#4）。
 *   幂等已由 preHandler 守（同候选独立 key，无连坐，重试在途 423）。owner + status=failed 闸内联进建库：
 *     - 候选不存在/非本人 → 404 NOT_FOUND。
 *     - 候选已 ready（无需重试）→ 409 CANDIDATE_ALREADY_READY。
 *   受理后候选立刻 failed→generating，**新建一个 retry job**（全新 fence/流），秒回 retryJobId + 新 eventsUrl，
 *   前端改连这条新流收回填（item-appended 同 candidateId + done），绝不在原萃取 job 的已 terminal 流上追加帧。
 */
export function retryCandidateHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const userId = requireUserId(req, reply);
    if (!userId) return reply;
    const { candidateId } = req.params as { candidateId: string };

    let result;
    try {
      result = await createRetryJob(
        req.server.infra.db,
        req.server.infra.queue,
        candidateId,
        userId,
        req.id,
      );
    } catch {
      reply.code(503).send(buildError(ErrorCode.DEPENDENCY_UNAVAILABLE, req.id));
      return reply;
    }

    if (result.kind === 'not_found') {
      reply.code(404).send(
        buildError(ErrorCode.NOT_FOUND, req.id, {
          userMessage: '没找到这一项，可能已刷新。',
          action: 'change_input',
        }),
      );
      return reply;
    }
    if (result.kind === 'already_ready') {
      reply.code(409).send(buildError(ErrorCode.CANDIDATE_ALREADY_READY, req.id));
      return reply;
    }
    if (result.kind === 'locked') {
      // 候选已 generating（重试/首轮萃取在途）→ 423 RESOURCE_LOCKED + action:'wait'（契约 §2.3，Codex r2#3）。
      reply.code(423).send(
        buildError(ErrorCode.RESOURCE_LOCKED, req.id, {
          userMessage: '这一项正在处理，请稍候。',
          action: 'wait',
        }),
      );
      return reply;
    }

    // 重试入队即 generating（行内进入「重试中」态）；前端连【新 retry job 流】收回填（非原萃取 job 流，Codex#4）。
    //   extractJobId 是原萃取 job 的只读引用（候选归属/列表寻址）；eventsUrl 指向【新 retry job】流。
    const data: CandidateRetryAccepted = {
      candidateId,
      extractJobId: result.job.extractJobId,
      retryJobId: result.job.retryJobId,
      status: 'generating',
      retryCount: result.job.retryCount,
      eventsUrl: jobEventsUrl(result.job.retryJobId),
    };
    const body: Envelope<CandidateRetryAccepted> = { data, meta: { traceId: req.id } };
    reply.code(202).send(body);
    return reply;
  };
}

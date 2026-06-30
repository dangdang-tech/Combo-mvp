// 50 · 批量发布域 API handler（B-29 无连坐 P0，50-step5-publish §2.3/§2.4/§2.5）。
//   鉴权/幂等已由 routes/publish.ts preHandler 守：
//     · 建批 POST /publish-batches：requireRole('creator') + requireIdempotency(publish_batch.create)（防重复建批，回放首次批次）。
//     · 查批 GET /publish-batches/{id}：requireAuth + handler owner 校验。
//     · 单 item 重试 POST .../items/{itemId}/retry：requireRole('creator') + requireIdempotency(publish_batch.item.retry)。
//   对外失败一律 ErrorEnvelope（人话 userMessage + action + traceId，绝不裸露 code/堆栈，脊柱 §11.B / D1）。
//   批量发布耗时 → 秒回 202 + jobId（前端立连 SSE GET /jobs/{jobId}/events 跟进度，永不裸转圈，硬规则①）。
//   单 item 失败【不走 HTTP 错误】，落 PublishBatchItemView.error + SSE item-appended（无连坐，§2.3 末注）。
import type { FastifyReply, FastifyRequest, RouteHandlerMethod } from 'fastify';
import {
  buildError,
  ErrorCode,
  CreatePublishBatchBodySchema,
  RetryBatchItemBodySchema,
  type Envelope,
  type PublishBatchView,
  type PublishBatchItemView,
} from '@cb/shared';
import { asTxPool } from '../../platform/events/db-tx.js';
import {
  createPublishBatchTx,
  readPublishBatchFull,
  retryBatchItemTx,
  PublishBatchError,
  type BatchItemPublishInput,
} from './batch-repo.js';
import { toBatchView, toBatchItemView } from './batch-view.js';

function requireUserId(req: FastifyRequest, reply: FastifyReply): string | null {
  const userId = req.auth?.userId;
  if (!userId) {
    reply.code(401).send(buildError(ErrorCode.UNAUTHENTICATED, req.id));
    return null;
  }
  return userId;
}

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

/** 批量发布 job SSE 流地址（前端连 GET /api/v1/jobs/{jobId}/events 跟进度，§2.3）。 */
export function batchEventsUrl(jobId: string): string {
  return `/api/v1/jobs/${jobId}/events`;
}

// ===========================================================================
// §2.3 · POST /publish-batches — 创建批量发布（无连坐 P0，202 + SSE）
// ===========================================================================

/**
 * 创建批量发布（§2.3）。建 publish_batch job + publish_batches + 每 item 一行（单事务）→ 入队 → 秒回 202 PublishBatchView。
 *   幂等：preHandler requireIdempotency(publish_batch.create) 防重复建批（回放首次批次，选择结构化-08）；
 *     每 item 独立 idempotencyKey（请求体内）→ publish_batch_items.idempotency_key UNIQ 兜单项不重复发布（无连坐第一道）。
 *   入参空 / 项缺 candidateId&versionId → 400 VALIDATION_FAILED（回上一步选，§2.3 错误用例）。
 *   入队失败【不删/不标 failed】——job 留 queued 交 staleQueued sweeper 补投（与导入/结构化同口径，不裸转圈）。
 */
export function createPublishBatchHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const userId = requireUserId(req, reply);
    if (!userId) return reply;

    const parsed = CreatePublishBatchBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      // items 空 / 项 candidateId·versionId 非恰好二选一（都缺 或 两者都给，schema refine）/ idempotencyKey 缺 → 400 去上一步选。
      return replyError(req, reply, ErrorCode.VALIDATION_FAILED, 400, {
        userMessage: '这批没有可发布的能力，回上一步选一下。',
        action: 'change_input',
      });
    }
    // 项级「candidateId / versionId 恰好二选一」防御（schema refine 已是单一真源，此处与之同口径兜底）：
    //   都缺 或 两者都给 都拒——两者都给会走 candidate 路径却因 existingVersionId 跳过 create、错配版本（B-29 P0）。
    const hasInvalid = parsed.data.items.some(
      (it) => [it.candidateId, it.versionId].filter((v) => v !== undefined).length !== 1,
    );
    if (hasInvalid) {
      return replyError(req, reply, ErrorCode.VALIDATION_FAILED, 400, {
        userMessage: '这批没有可发布的能力，回上一步选一下。',
        action: 'change_input',
      });
    }

    const items: BatchItemPublishInput[] = parsed.data.items.map((it) => ({
      ...(it.candidateId ? { candidateId: it.candidateId } : {}),
      ...(it.versionId ? { versionId: it.versionId } : {}),
      idempotencyKey: it.idempotencyKey,
      ...(it.cover ? { cover: it.cover } : {}),
      ...(it.tiers ? { tiers: it.tiers } : {}),
      ...(it.visibility ? { visibility: it.visibility } : {}),
    }));

    let created;
    try {
      created = await createPublishBatchTx(asTxPool(req.server.infra.db), {
        ownerUserId: userId,
        items,
        ...(parsed.data.draftId ? { draftId: parsed.data.draftId } : {}),
      });
    } catch (err) {
      // 请求内重复 idempotencyKey（或全局撞键）→ 建批已整事务回滚（不留 total 不符的卡死 batch）→ 人话冲突信封。
      if (err instanceof PublishBatchError) {
        return replyError(req, reply, err.code, 400, {
          userMessage: '这批里有重复的能力，去掉重复项再发一次。',
          action: 'change_input',
        });
      }
      return replyError(req, reply, ErrorCode.DEPENDENCY_UNAVAILABLE, 503, {
        userMessage: '系统正在恢复，请稍候再试。',
        action: 'wait',
      });
    }

    // 入队（失败不回滚、留 queued 交 sweeper 补投，不裸转圈）。
    try {
      await req.server.infra.queue.enqueue(
        'publish_batch',
        created.jobId as never,
        created.fenceToken,
      );
    } catch {
      req.log.warn(
        { jobId: created.jobId },
        'publish_batch enqueue failed (sweeper staleQueued will requeue)',
      );
    }

    // 秒回 202 全量 PublishBatchView（含 jobId 供前端立连 SSE；初始全 pending，进度可渲染，绝不裸转圈）。
    const full = await readPublishBatchFull(req.server.infra.db, created.batchId);
    const view: PublishBatchView = full
      ? toBatchView(full.batch, full.items)
      : {
          batchId: created.batchId,
          jobId: created.jobId,
          status: 'queued',
          total: created.total,
          processedCount: 0,
          publishedCount: 0,
          failedCount: 0,
          items: [],
        };
    const body: Envelope<PublishBatchView> = { data: view, meta: { traceId: req.id } };
    reply.code(202).send(body);
    return reply;
  };
}

// ===========================================================================
// §2.4 · GET /publish-batches/{batchId} — 查批次（恢复/轮询兜底）
// ===========================================================================

/**
 * 查批次（§2.4）。owner 守门（404 不暴露存在性 / 403 非本人）。SSE 是主路径；此端点供刷新/重进拉全量
 *   （与 SSE state_snapshot 互补，硬规则③：已发布的 item 不丢）。GET 天然幂等。
 */
export function getPublishBatchHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const userId = requireUserId(req, reply);
    if (!userId) return reply;
    const { batchId } = req.params as { batchId: string };

    let full;
    try {
      full = await readPublishBatchFull(req.server.infra.db, batchId);
    } catch {
      return replyError(req, reply, ErrorCode.INTERNAL, 500, {
        userMessage: '服务开小差了，请重试。',
        action: 'retry',
      });
    }
    if (!full) {
      return replyError(req, reply, ErrorCode.NOT_FOUND, 404, {
        userMessage: '没找到对应批次，可能已被删除。',
        action: 'change_input',
      });
    }
    if (full.batch.ownerUserId !== userId) {
      return replyError(req, reply, ErrorCode.FORBIDDEN, 403, {
        userMessage: '你没有权限查看这个批次。',
        action: 'escalate',
      });
    }

    const body: Envelope<PublishBatchView> = {
      data: toBatchView(full.batch, full.items),
      meta: { traceId: req.id },
    };
    reply.code(200).send(body);
    return reply;
  };
}

// ===========================================================================
// §2.5 · POST /publish-batches/{batchId}/items/{itemId}/retry — 单 item 重试（无连坐）
// ===========================================================================

/**
 * 单 item 重试（§2.5）。仅 `state=failed` 的 item 可重试；**不影响其余 item、不重建批次**（选择结构化-29）。
 *   可携新发布入参（修过封面/价格后重试，覆盖 subject）。受理后该 item 回 pending、批 job 换 fence 重激活续跑，202 回该 item 视图。
 *   幂等：preHandler requireIdempotency(publish_batch.item.retry) 防重复重试。
 *   item 非 failed（已 published / 在跑）→ 409 STATE_CONFLICT「这一项不需要重试」；非本人/不存在 → 403/404。
 *   「去补齐」（决策⑤ / F-14）：失败项 error.action='change_input' + missingFields，前端引导回结构化向导补字段后回此端点。
 */
export function retryPublishBatchItemHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const userId = requireUserId(req, reply);
    if (!userId) return reply;
    const { batchId, itemId } = req.params as { batchId: string; itemId: string };

    const parsed = RetryBatchItemBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return replyError(req, reply, ErrorCode.VALIDATION_FAILED, 400, {
        userMessage: '重试参数格式不对，调整后再试。',
        action: 'change_input',
      });
    }

    let outcome;
    try {
      outcome = await retryBatchItemTx(asTxPool(req.server.infra.db), {
        batchId,
        itemId,
        ownerUserId: userId,
        ...(parsed.data?.cover ? { cover: parsed.data.cover } : {}),
        ...(parsed.data?.tiers ? { tiers: parsed.data.tiers } : {}),
        ...(parsed.data?.visibility ? { visibility: parsed.data.visibility } : {}),
      });
    } catch {
      return replyError(req, reply, ErrorCode.DEPENDENCY_UNAVAILABLE, 503, {
        userMessage: '系统正在恢复，请稍候再试。',
        action: 'wait',
      });
    }

    if (outcome.kind === 'not_found') {
      return replyError(req, reply, ErrorCode.NOT_FOUND, 404, {
        userMessage: '没找到对应批次或这一项，可能已被删除。',
        action: 'change_input',
      });
    }
    if (outcome.kind === 'forbidden') {
      return replyError(req, reply, ErrorCode.FORBIDDEN, 403, {
        userMessage: '你没有权限操作这个批次。',
        action: 'escalate',
      });
    }
    if (outcome.kind === 'state_conflict') {
      // item 非 failed（已 published / 在跑）→ 不需要重试（§2.5 错误用例）。
      return replyError(req, reply, ErrorCode.STATE_CONFLICT, 409, {
        userMessage: '这一项不需要重试。',
        action: 'none',
      });
    }

    // 重新入队批 job（按重试换发的新 fence；失败留 queued 交 sweeper 补投，不裸转圈）。
    try {
      await req.server.infra.queue.enqueue(
        'publish_batch',
        outcome.jobId as never,
        outcome.fenceToken,
      );
    } catch {
      req.log.warn(
        { jobId: outcome.jobId },
        'publish_batch retry enqueue failed (sweeper staleQueued will requeue)',
      );
    }

    const view: PublishBatchItemView = toBatchItemView(outcome.item);
    const body: Envelope<PublishBatchItemView> = { data: view, meta: { traceId: req.id } };
    reply.code(202).send(body);
    return reply;
  };
}

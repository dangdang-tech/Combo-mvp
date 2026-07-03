// 20 · 导入接入 API handler（B-20 直传触发 + B-19 快照读）。20-step1-import §2/§5。
//   本机助手路径（B-21：connect/pair·script·upload·pair status）由 routes/import-connect.ts 单独承载，不在本文件。
//   - 鉴权/幂等已由 routes/import.ts preHandler 守（requireRole/requireAuth/requireIdempotency）。
//   - 对外失败一律 ErrorEnvelope（人话 userMessage + action + traceId，绝不裸露 code/堆栈，脊柱 §11.B / D1）。
//   - 文案口径硬约束（导入-04/05/29）：「完整上传 + 云端去敏」，绝不出现「数据不出本机/仅上传精简」。
import type { FastifyReply, FastifyRequest, RouteHandlerMethod } from 'fastify';
import {
  buildError,
  ErrorCode,
  PresignRequestSchema,
  CreateImportJobRequestSchema,
  DEFAULT_PAGE_LIMIT,
  type PresignResult,
  type JobView,
  type ImportJobSnapshotView,
  type SnapshotView,
  type SnapshotSegmentView,
  type SnapshotListItem,
  type Paginated,
  type Envelope,
} from '@cb/shared';
import { createImportJobFromManifest } from './create-job.js';
import { getSnapshotForOwner, listSnapshotSegments, listOwnerSnapshots } from './snapshot-repo.js';
import {
  evaluateManifestGate,
  persistUploadManifest,
  readJobViewForRecovery,
  readUploadManifest,
  type ExpectedPart,
} from './upload-manifest-repo.js';
import {
  readImportJobSnapshotForDraft,
  readImportJobSnapshotForOwner,
} from './job-recovery-repo.js';
import { asTxPool } from '../../platform/events/db-tx.js';

/** 原文对象 key 前缀（agora-raw 桶；直传路径按 owner+uploadId 隔离，create-job 据此 list 校验传齐）。 */
function rawPrefix(ownerUserId: string, uploadId: string): string {
  return `raw/${ownerUserId}/${uploadId}/`;
}
function rawPartKey(ownerUserId: string, uploadId: string, clientPartId: string): string {
  return `${rawPrefix(ownerUserId, uploadId)}${clientPartId}`;
}

function requireUserId(req: FastifyRequest, reply: FastifyReply): string | null {
  const userId = req.auth?.userId;
  if (!userId) {
    reply.code(401).send(buildError(ErrorCode.UNAUTHENTICATED, req.id));
    return null;
  }
  return userId;
}

// ---------------------------------------------------------------------------
// B-20 直传路径（presign + 触发 Job）
// ---------------------------------------------------------------------------

/** POST /import/uploads/presign — 申请分批直传预签名 URL（不写库、只签 URL，§2.1）。 */
export function presignHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const userId = requireUserId(req, reply);
    if (!userId) return reply;

    const parsed = PresignRequestSchema.safeParse(req.body);
    if (!parsed.success || parsed.data.parts.length === 0) {
      reply.code(400).send(
        buildError(ErrorCode.VALIDATION_FAILED, req.id, {
          userMessage: '上传内容有点问题，换个目录或文件再导入。',
          action: 'change_input',
        }),
      );
      return reply;
    }
    const { parts, source, totalBytes } = parsed.data;
    const uploadId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    try {
      const signed = await Promise.all(
        parts.map(async (p) => {
          const s3Key = rawPartKey(userId, uploadId, p.clientPartId);
          const { url } = await req.server.infra.objectStore.presignPut('agora-raw', s3Key, {
            contentType: 'application/octet-stream',
          });
          const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
          return { clientPartId: p.clientPartId, url, s3Key, expiresAt };
        }),
      );
      // 持久化 upload manifest（Codex P1-r2）：声明本次直传的 expected parts（clientPartId + s3Key + 可选 hash）。
      //   POST /import/jobs 据此判「所有 part 到齐才建 job」——直传与助手两路径走同一 manifest 完整性闸。
      //   断点续传重新 presign 同 uploadId → upsert 覆盖最新声明（不重复建行）。
      const expectedParts: ExpectedPart[] = parts.map((p, i) => ({
        clientPartId: p.clientPartId,
        s3Key: signed[i]!.s3Key,
        contentSha256: p.contentSha256 ?? null,
      }));
      await persistUploadManifest(req.server.infra.db, {
        ownerUserId: userId,
        uploadId,
        source,
        totalBytes,
        expectedParts,
      });
      const data: PresignResult = { uploadId, bucket: 'agora-raw', parts: signed };
      const body: Envelope<PresignResult> = { data, meta: { traceId: req.id } };
      reply.code(200).send(body);
    } catch {
      // S3 / DB 不可用：人话「系统正在恢复」（绝不裸露原始报错，§2.1 错误用例）。
      reply.code(503).send(buildError(ErrorCode.DEPENDENCY_UNAVAILABLE, req.id));
    }
    return reply;
  };
}

/** POST /import/jobs — 引用已上传对象触发导入 Job（阶段 A→B，§2.2，幂等已由 preHandler 守，导入-23）。 */
export function createJobHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const userId = requireUserId(req, reply);
    if (!userId) return reply;

    const parsed = CreateImportJobRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send(buildError(ErrorCode.VALIDATION_FAILED, req.id));
      return reply;
    }
    const { uploadId, source, draftId } = parsed.data;

    // manifest 完整性闸（Codex P1-r2）：先读 presign 落的 expected parts，再据桶里实际落地校验「全部到齐」才建 job。
    //   旧实现只按前缀 list()「有任意对象就建 job」→ N 分片传 1 片也进导入（违反闸；助手路径已有闸，直传补齐）。
    let manifest;
    try {
      manifest = await readUploadManifest(req.server.infra.db, userId, uploadId);
    } catch {
      reply.code(503).send(buildError(ErrorCode.DEPENDENCY_UNAVAILABLE, req.id));
      return reply;
    }
    if (!manifest) {
      // uploadId 不存在/非本人（presign 未发起或已被清）：人话引导重发（§2.2 NOT_FOUND）。
      reply.code(404).send(
        buildError(ErrorCode.NOT_FOUND, req.id, {
          userMessage: '上传会话已失效，重新发起导入。',
          action: 'change_input',
        }),
      );
      return reply;
    }

    // 恢复优先于完整性闸（Codex P1-r6 直传恢复短路，两路径统一口径）：
    //   manifest 已 consumed 且 job_id 已回写（终态/已兑换）→ **立即按 job_id 恢复既有 JobView 并返回**，
    //   绝不 list 桶、绝不过 manifest 闸——否则原文已被 GC/桶对象不可列时会误 404，丢掉「同 uploadId 恢复同一 job」。
    //   仅当**未 consumed** 时才下沉去校验桶对象完整性（manifest 闸）。
    if (manifest.consumedAt && manifest.jobId) {
      let rec;
      try {
        rec = await readJobViewForRecovery(req.server.infra.db, userId, manifest.jobId);
      } catch {
        reply.code(503).send(buildError(ErrorCode.DEPENDENCY_UNAVAILABLE, req.id));
        return reply;
      }
      if (rec) {
        // 秒回既有 job 的真实 JobView（幂等可恢复，非 404、不重复建、不依赖桶/闸）。
        const body: Envelope<JobView> = {
          data: {
            id: rec.jobId,
            type: 'import',
            status: rec.status,
            progress: rec.progress,
            attemptNo: rec.attemptNo,
            createdAt: rec.createdAt,
          },
          meta: { traceId: req.id },
        };
        reply.code(202).send(body);
        return reply;
      }
      // job 行已不存在（极端：被 GC，理论上 FK 阻止）→ 退回 404 引导重发。
      reply.code(404).send(
        buildError(ErrorCode.NOT_FOUND, req.id, {
          userMessage: '上传会话已失效，重新发起导入。',
          action: 'change_input',
        }),
      );
      return reply;
    }

    // 列桶里该 uploadId 前缀下实际落地的 key（与 manifest 的 expected s3Key 比对判齐）。
    let landedKeys: string[];
    try {
      const objs = await req.server.infra.objectStore.list(
        'agora-raw',
        rawPrefix(userId, uploadId),
      );
      landedKeys = objs.map((o) => o.key).filter((k) => k.length > 0);
    } catch {
      reply.code(503).send(buildError(ErrorCode.DEPENDENCY_UNAVAILABLE, req.id));
      return reply;
    }

    const gate = evaluateManifestGate(manifest, landedKeys);
    if (!gate.complete) {
      // 已兑换但 job_id 未回写（不变式下不应出现，单次 UPDATE 已硬保证 consumed ⇒ job_id；防御性兜底）：
      //   manifest 已 consumed 却无 job_id → 按 NOT_FOUND 引导（uploadId 失效，不重复建 job）。
      if (manifest.consumedAt) {
        reply.code(404).send(
          buildError(ErrorCode.NOT_FOUND, req.id, {
            userMessage: '上传会话已失效，重新发起导入。',
            action: 'change_input',
          }),
        );
        return reply;
      }
      // part 未传齐（阶段 A 没传完就触发）→ 409 STATE_CONFLICT，绝不建 job（§2.2 错误用例）。
      reply.code(409).send(
        buildError(ErrorCode.STATE_CONFLICT, req.id, {
          userMessage: '还有内容没传完，传完再开始导入。',
          action: 'change_input',
        }),
      );
      return reply;
    }

    // 原子兑换 manifest + 建 job + 入队（Codex P1-r5，取代旧「consume → createAndEnqueue → 失败删 job+503」）：
    //   · consume(置 consumed_at) + job INSERT + 回写 job_id 同一 PG 事务（要么都成、要么都不成，asTxPool(db) 同连接）。
    //   · enqueue 失败【不删/不标 failed】——job 留 queued 交 staleQueued sweeper 按既有 fence 补投（不裸转圈、不假转圈）。
    //   · 同一 uploadId 重试在 manifest 已 consumed 且 job_id 已回写时，恢复返回已存在 job 的 JobView（非 404、不重复建）。
    //   防同 uploadId 重复建：Idempotency-Key（preHandler）第一道；consumed_at 一次性兑换第二道（恢复回放）。
    let result;
    try {
      result = await createImportJobFromManifest(
        asTxPool(req.server.infra.db),
        req.server.infra.db,
        req.server.infra.queue,
        {
          ownerUserId: userId,
          uploadId,
          source,
          rawS3Keys: gate.rawS3Keys,
          traceId: req.id,
          ...(draftId ? { draftId } : {}),
        },
      );
    } catch {
      // 事务/DB 异常（兑换或建 job 整体回滚，manifest 未被 consume）：人话 503 可重试（manifest 仍可兑换）。
      reply.code(503).send(
        buildError(ErrorCode.DEPENDENCY_UNAVAILABLE, req.id, {
          userMessage: '系统正在恢复，请稍候再试。',
          action: 'wait',
          retriable: true,
        }),
      );
      return reply;
    }

    if (result.kind === 'created' || result.kind === 'recovered') {
      // 秒回【完整 JobView】（queued + 五项子任务 pending 进度 + attemptNo/createdAt），前端立即转订阅 SSE
      //   且初始态有进度可渲染，绝不裸转圈（Codex P1-7）。created.enqueued=false 时由 sweeper 补投，仍是真 queued 态。
      //   recovered：同 uploadId 重试回放已建 job 的真实状态/进度（幂等可恢复，Codex P1-r5）。
      const body: Envelope<JobView> = { data: result.view, meta: { traceId: req.id } };
      reply.code(202).send(body);
      return reply;
    }
    // gone（manifest 已兑换但 job 行已没，极端）/ not_consumed（并发竞态未恢复）→ 引导重发（不重复建 job）。
    reply.code(404).send(
      buildError(ErrorCode.NOT_FOUND, req.id, {
        userMessage: '上传会话已失效，重新发起导入。',
        action: 'change_input',
      }),
    );
    return reply;
  };
}

// ---------------------------------------------------------------------------
// B-19 快照读（统计四格 + 去敏报告 / 会话节选只读 / 用户快照列表）
// ---------------------------------------------------------------------------

/** GET /import/jobs/:jobId — 刷新恢复：按 jobId 读 import job 当前快照（owner 守门）。 */
export function getImportJobSnapshotHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const userId = requireUserId(req, reply);
    if (!userId) return reply;
    const { jobId } = req.params as { jobId: string };
    try {
      const view = await readImportJobSnapshotForOwner(req.server.infra.db, {
        jobId,
        ownerUserId: userId,
      });
      if (!view) {
        reply.code(404).send(buildError(ErrorCode.NOT_FOUND, req.id));
        return reply;
      }
      const body: Envelope<ImportJobSnapshotView> = { data: view, meta: { traceId: req.id } };
      reply.code(200).send(body);
    } catch {
      reply.code(500).send(buildError(ErrorCode.INTERNAL, req.id));
    }
    return reply;
  };
}

/** GET /import/jobs/active?draftId=... — 刷新恢复：按 draft 找最近 import job。 */
export function getActiveImportJobHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const userId = requireUserId(req, reply);
    if (!userId) return reply;
    const { draftId } = req.query as { draftId?: string };
    if (typeof draftId !== 'string' || draftId.length === 0) {
      reply.code(400).send(buildError(ErrorCode.VALIDATION_FAILED, req.id));
      return reply;
    }
    try {
      const view = await readImportJobSnapshotForDraft(req.server.infra.db, {
        draftId,
        ownerUserId: userId,
      });
      const body: Envelope<ImportJobSnapshotView | null> = {
        data: view,
        meta: { traceId: req.id },
      };
      reply.code(200).send(body);
    } catch {
      reply.code(500).send(buildError(ErrorCode.INTERNAL, req.id));
    }
    return reply;
  };
}

/** GET /snapshots/:snapshotId — 快照统计四格 + 去敏报告（§5.1，owner 守门，404 不暴露存在性）。 */
export function getSnapshotHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const userId = requireUserId(req, reply);
    if (!userId) return reply;
    const { snapshotId } = req.params as { snapshotId: string };
    try {
      const view = await getSnapshotForOwner(req.server.infra.db, snapshotId, userId);
      if (!view) {
        reply.code(404).send(buildError(ErrorCode.NOT_FOUND, req.id));
        return reply;
      }
      const body: Envelope<SnapshotView> = { data: view, meta: { traceId: req.id } };
      reply.code(200).send(body);
    } catch {
      reply.code(500).send(buildError(ErrorCode.INTERNAL, req.id));
    }
    return reply;
  };
}

/** GET /snapshots/:snapshotId/segments — 会话节选 cursor 分页（§5.2，只读，owner 守门）。 */
export function listSegmentsHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const userId = requireUserId(req, reply);
    if (!userId) return reply;
    const { snapshotId } = req.params as { snapshotId: string };
    const q = req.query as { cursor?: string; limit?: string; order?: string };
    const limit = q.limit ? Number(q.limit) : DEFAULT_PAGE_LIMIT;
    if (q.limit && (!Number.isFinite(limit) || limit < 1 || limit > 100)) {
      reply.code(400).send(buildError(ErrorCode.VALIDATION_FAILED, req.id));
      return reply;
    }
    const order = q.order === 'asc' ? 'asc' : 'desc';
    try {
      const result = await listSnapshotSegments(req.server.infra.db, {
        snapshotId,
        ownerUserId: userId,
        ...(q.cursor ? { cursor: q.cursor } : {}),
        limit,
        order,
      });
      if (!result.ownsSnapshot) {
        reply.code(404).send(buildError(ErrorCode.NOT_FOUND, req.id));
        return reply;
      }
      const body: Paginated<SnapshotSegmentView> = {
        data: result.items,
        meta: {
          traceId: req.id,
          page: {
            nextCursor: result.nextCursor,
            hasMore: result.nextCursor !== null,
            limit,
            order,
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

/** GET /snapshots — 当前用户快照列表（§5.3，重导后旧快照仍可查，cursor 分页）。 */
export function listSnapshotsHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const userId = requireUserId(req, reply);
    if (!userId) return reply;
    const q = req.query as { cursor?: string; limit?: string; order?: string };
    const limit = q.limit ? Number(q.limit) : DEFAULT_PAGE_LIMIT;
    if (q.limit && (!Number.isFinite(limit) || limit < 1 || limit > 100)) {
      reply.code(400).send(buildError(ErrorCode.VALIDATION_FAILED, req.id));
      return reply;
    }
    const order = q.order === 'asc' ? 'asc' : 'desc';
    try {
      const result = await listOwnerSnapshots(req.server.infra.db, {
        ownerUserId: userId,
        ...(q.cursor ? { cursor: q.cursor } : {}),
        limit,
        order,
      });
      const body: Paginated<SnapshotListItem> = {
        data: result.items,
        meta: {
          traceId: req.id,
          page: {
            nextCursor: result.nextCursor,
            hasMore: result.nextCursor !== null,
            limit,
            order,
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

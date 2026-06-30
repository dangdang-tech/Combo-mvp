// 40 · 结构化域 API handler（B-24 建体 + B-25 起结构化 + B-26 改/重生成软字段 + STEP③ 存草稿）。40-step3-4-structure §4。
//   鉴权/幂等已由 routes/structure.ts preHandler 守（requireRole('creator') + requireIdempotency；SSE 端点 D 走 _sse.ts）。
//     owner 校验在各 handler 内据资源 creator_user_id/owner_user_id 做（10-auth §6.3，非本人 403/404 不暴露存在性）。
//   对外失败一律 ErrorEnvelope（人话 userMessage + action + traceId，绝不裸露 code/堆栈，脊柱 §11.B / D1）。
//   起结构化/重生成秒回 202（jobId/eventsUrl/structureState），前端立连端点 D 跟字段流，永不裸转圈（硬规则①）。
//   硬字段改动一律拒（422 HARD_FIELD_LOCKED 人话）；已 published 改/重生成 → 409 STATE_CONFLICT「基于新版本编辑」（§2.4）。
import type { FastifyReply, FastifyRequest, RouteHandlerMethod } from 'fastify';
import {
  buildError,
  httpStatusFor,
  ErrorCode,
  CreateCapabilityBodySchema,
  PatchSelectionBodySchema,
  PatchManifestBodySchema,
  RegenerateFieldBodySchema,
  StartStructureBodySchema,
  SOFT_FIELD_KEYS,
  HARD_FIELD_KEYS,
  type Envelope,
  type CreateCapabilityResult,
  type ManifestView,
  type DraftView,
  type StartStructureResult,
  type RegenerateFieldResult,
  type SoftFieldKey,
} from '@cb/shared';
import { createCapability, CreateCapabilityError } from './create-capability.js';
import {
  readManifestView,
  patchManifestSoftFields,
  acquireRegenerateFieldJob,
  patchSelection,
} from './structure-edit-repo.js';
import { createStructureJob, structureEventsUrl } from './create-structure-job.js';
import { asTxPool } from '../../platform/events/db-tx.js';

/** 取 If-Match 请求头（弱 ETag 乐观锁，§4.E）。多值取首个；缺省 undefined（不做乐观锁）。 */
function getIfMatch(req: FastifyRequest): string | undefined {
  const h = req.headers['if-match'];
  if (typeof h === 'string' && h.length > 0) return h;
  if (Array.isArray(h) && h.length > 0) return h[0];
  return undefined;
}

function requireUserId(req: FastifyRequest, reply: FastifyReply): string | null {
  const userId = req.auth?.userId;
  if (!userId) {
    reply.code(401).send(buildError(ErrorCode.UNAUTHENTICATED, req.id));
    return null;
  }
  return userId;
}

/** 据内部 code 落对应 HTTP + 人话信封（对外不含 code，D1；code 仅查表取 http/缺省 action）。 */
function replyError(
  req: FastifyRequest,
  reply: FastifyReply,
  code: (typeof ErrorCode)[keyof typeof ErrorCode],
  overrides?: {
    userMessage?: string;
    action?: 'retry' | 'change_input' | 'escalate' | 'wait' | 'none';
  },
): FastifyReply {
  reply.code(httpStatusFor(code)).send(buildError(code, req.id, overrides ?? {}));
  return reply;
}

// ===========================================================================
// G · PATCH /drafts/:draftId/selection — STEP③ 显式存草稿（§4.G，B-24 续传）
// ===========================================================================

/**
 * STEP③ 存草稿：持久化 drafts.selection + current_step='select'（§4.G）。owner 守门（404/403）。
 *   选择切换本身纯前端不调本端点（§1.1(a)）；本端点是「保存草稿」/节流自动保存。幂等：最后写赢（PATCH 覆盖）。
 *   选择候选不合法（格式错）→ 400 VALIDATION_FAILED（change_input）。**不建任务、不调模型、不产生能力体**。
 */
export function patchSelectionHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const userId = requireUserId(req, reply);
    if (!userId) return reply;
    const { draftId } = req.params as { draftId: string };

    const parsed = PatchSelectionBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return replyError(req, reply, ErrorCode.VALIDATION_FAILED, {
        userMessage: '选择内容格式不对，重选一下再保存。',
        action: 'change_input',
      });
    }

    let result;
    try {
      result = await patchSelection(req.server.infra.db, {
        draftId,
        ownerUserId: userId,
        selection: parsed.data.selection,
      });
    } catch {
      return replyError(req, reply, ErrorCode.DEPENDENCY_UNAVAILABLE, {
        userMessage: '系统正在恢复，请稍候再试。',
        action: 'retry',
      });
    }

    if (result.kind === 'not_found') {
      return replyError(req, reply, ErrorCode.NOT_FOUND, {
        userMessage: '没找到对应草稿或候选，可能已被删除。',
        action: 'change_input',
      });
    }
    if (result.kind === 'forbidden') {
      return replyError(req, reply, ErrorCode.FORBIDDEN, {
        userMessage: '你没有权限修改这个草稿。',
      });
    }
    if (result.kind === 'invalid_selection') {
      // 候选校验失败（属本人/同 snapshot/ready 数量，§4.G / Codex P1-3）→ 400 人话（无 code）。
      return replyError(req, reply, ErrorCode.VALIDATION_FAILED, {
        userMessage: result.reason,
        action: 'change_input',
      });
    }
    const body: Envelope<DraftView> = { data: result.draft, meta: { traceId: req.id } };
    reply.code(200).send(body);
    return reply;
  };
}

// ===========================================================================
// A · POST /capabilities — 建能力体 draft 版本（三选一，§4.A，B-24/B-26）
// ===========================================================================

/**
 * 建能力体 draft 版本（§4.A）。三分支恰好三选一（Codex#7）由 CreateCapabilityBodySchema.refine 守（零个/多个 → 422）。
 *   幂等已由 preHandler（CAPABILITY_CREATE）守（连点/刷新只建一次、回放首次结果，验收 选择结构化-08）。
 *   201 Envelope<CreateCapabilityResult>（硬字段锁定填充 + 软字段空待结构化 + structure_state 软 pending/硬 locked）。
 */
export function createCapabilityHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const userId = requireUserId(req, reply);
    if (!userId) return reply;

    const parsed = CreateCapabilityBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      // 恰好三选一不满足（零个/多个 source）→ 422 VALIDATION_FAILED（change_input，Codex#7）。
      return replyError(req, reply, ErrorCode.VALIDATION_FAILED, {
        userMessage:
          '输入有点问题：来源候选 / 已有能力体 / 被拒版本要恰好选一个（不能不选、也不能多选），改一下再试。',
        action: 'change_input',
      });
    }

    let result: CreateCapabilityResult;
    try {
      result = await createCapability(
        req.server.infra.db,
        asTxPool(req.server.infra.db),
        parsed.data,
        { userId },
      );
    } catch (err) {
      if (err instanceof CreateCapabilityError) {
        // 业务错误据 code 落 HTTP + 人话；个别用例（如重复创建撞 slug，BUG-2）带 overrides 给更贴切人话/退路。
        //   overrides 仅 userMessage/action，对外仍不含 code（D1）；retriable 仍遵分类表（STATE_CONFLICT=false）。
        return replyError(req, reply, err.code, err.overrides);
      }
      // DB/事务异常：人话 503 可重试（绝不裸露原始报错，脊柱 §11.B）。
      return replyError(req, reply, ErrorCode.DEPENDENCY_UNAVAILABLE, {
        userMessage: '系统正在恢复，请稍候再试。',
        action: 'retry',
      });
    }

    const body: Envelope<CreateCapabilityResult> = { data: result, meta: { traceId: req.id } };
    reply.code(201).send(body);
    return reply;
  };
}

// ===========================================================================
// B · GET /versions/:versionId/manifest — 读 manifest（软硬分层 + structure_state，§4.B）
// ===========================================================================

/** 读 manifest（§4.B）。owner 守门（404 不暴露存在性 / 403 非本人）。GET 天然幂等。 */
export function getManifestHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const userId = requireUserId(req, reply);
    if (!userId) return reply;
    const { versionId } = req.params as { versionId: string };

    let result;
    try {
      result = await readManifestView(req.server.infra.db, versionId);
    } catch {
      reply.code(500).send(buildError(ErrorCode.INTERNAL, req.id));
      return reply;
    }
    if (result.kind === 'not_found') {
      return replyError(req, reply, ErrorCode.NOT_FOUND, {
        userMessage: '没找到对应版本，可能已被删除。',
        action: 'change_input',
      });
    }
    if (result.creatorUserId !== userId) {
      return replyError(req, reply, ErrorCode.FORBIDDEN, {
        userMessage: '你没有权限查看这个能力。',
      });
    }
    const body: Envelope<ManifestView> = { data: result.view, meta: { traceId: req.id } };
    // ETag 头（§4.E 乐观锁）：前端 PATCH 据此带 If-Match；并入 meta 供无头 client 取用。
    reply.header('ETag', result.etag);
    reply.code(200).send(body);
    return reply;
  };
}

// ===========================================================================
// C · POST /versions/:versionId/structure — 发起结构化 Job（§4.C，B-25/B-26）
// ===========================================================================

/**
 * 发起结构化 Job（§4.C）。owner + draft 闸（据 readManifestView 分类：不存在 404 / 非本人 403 / 非 draft 409）。
 *   建 jobs(type=structure, mode=full) + 入队，202 回 jobId/eventsUrl/structureState（前端立连端点 D）。
 *   同 version 已有未终态 job → 回放运行中 jobId（不重复跑，验收 选择结构化-26）。fields 子集续传只补未生成（贯穿-28）。
 *   证据不足（candidate_evidence 为空）在 worker 起步抛 STRUCTURE_NO_EVIDENCE（§4.C，本期触发期不预检，秒回受理后由字段流体现）。
 */
export function startStructureHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const userId = requireUserId(req, reply);
    if (!userId) return reply;
    const { versionId } = req.params as { versionId: string };

    const parsed = StartStructureBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return replyError(req, reply, ErrorCode.VALIDATION_FAILED, { action: 'change_input' });
    }
    const fields = parsed.data?.fields;

    // owner + draft 闸（据 readManifestView 分类，再建 job）。
    let manifestRes;
    try {
      manifestRes = await readManifestView(req.server.infra.db, versionId);
    } catch {
      reply.code(500).send(buildError(ErrorCode.INTERNAL, req.id));
      return reply;
    }
    if (manifestRes.kind === 'not_found') {
      return replyError(req, reply, ErrorCode.NOT_FOUND, {
        userMessage: '没找到对应版本，可能已被删除。',
        action: 'change_input',
      });
    }
    if (manifestRes.creatorUserId !== userId) {
      return replyError(req, reply, ErrorCode.FORBIDDEN, {
        userMessage: '你没有权限编辑这个能力。',
      });
    }
    if (manifestRes.status !== 'draft') {
      return replyError(req, reply, ErrorCode.STATE_CONFLICT, {
        userMessage: '当前状态不支持结构化（如已发布需建新版本）。',
        action: 'change_input',
      });
    }

    let job;
    try {
      job = await createStructureJob(req.server.infra.db, req.server.infra.queue, {
        versionId,
        ownerUserId: userId,
        ...(fields && fields.length > 0 ? { fields } : {}),
      });
    } catch {
      return replyError(req, reply, ErrorCode.DEPENDENCY_UNAVAILABLE, {
        userMessage: '系统正在恢复，请稍候再试。',
        action: 'wait',
      });
    }
    if (!job) {
      // 兜底（并发期被发布/删除）：状态冲突。
      return replyError(req, reply, ErrorCode.STATE_CONFLICT, {
        userMessage: '当前状态不支持结构化（如已发布需建新版本）。',
        action: 'change_input',
      });
    }

    const data: StartStructureResult = {
      jobId: job.jobId,
      versionId,
      eventsUrl: structureEventsUrl(versionId),
      structureState: manifestRes.view.structureState, // 受理即回当前状态（已生成不丢，§4.C）。
    };
    const body: Envelope<StartStructureResult> = { data, meta: { traceId: req.id } };
    reply.code(202).send(body);
    return reply;
  };
}

// ===========================================================================
// E · PATCH /versions/:versionId/manifest — 改软字段（§4.E，B-26）
// ===========================================================================

/**
 * 改单/多软字段（§4.E）。硬字段键出现 → 422 HARD_FIELD_LOCKED（人话）；空改动 → 400 VALIDATION_FAILED。
 *   仅 draft 可改（已 published → 409 STATE_CONFLICT「基于新版本编辑」，§2.4）；owner 守门。
 *   改 instructions → 系统重算 inputs.schema（硬字段仍锁定，§4.E 派生规则）。200 回改后 ManifestView。
 */
export function patchManifestHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const userId = requireUserId(req, reply);
    if (!userId) return reply;
    const { versionId } = req.params as { versionId: string };

    const raw = (req.body ?? {}) as Record<string, unknown>;
    // 硬字段键出现一律拒（§4.E：硬字段平台锁定，不可手改）。
    const hardKeys = HARD_FIELD_KEYS.filter((k) => Object.prototype.hasOwnProperty.call(raw, k));
    if (hardKeys.length > 0) {
      return replyError(req, reply, ErrorCode.HARD_FIELD_LOCKED, {
        userMessage: '这部分是平台锁定的，改不了；可改软字段间接影响。',
        action: 'change_input',
      });
    }

    const parsed = PatchManifestBodySchema.safeParse(raw);
    if (!parsed.success) {
      return replyError(req, reply, ErrorCode.VALIDATION_FAILED, {
        userMessage: '没有可保存的改动，或字段格式不对。',
        action: 'change_input',
      });
    }
    // 只取软字段（zod 已剔除未知键，但显式收敛防御）。
    const patch: Partial<Record<SoftFieldKey, string | string[]>> = {};
    for (const key of SOFT_FIELD_KEYS) {
      if (Object.prototype.hasOwnProperty.call(parsed.data, key)) {
        patch[key] = parsed.data[key] as string | string[];
      }
    }
    if (Object.keys(patch).length === 0) {
      return replyError(req, reply, ErrorCode.VALIDATION_FAILED, {
        userMessage: '没有可保存的改动，或字段格式不对。',
        action: 'change_input',
      });
    }

    let result;
    try {
      result = await patchManifestSoftFields(asTxPool(req.server.infra.db), {
        versionId,
        ownerUserId: userId,
        patch,
        // If-Match 乐观锁（§4.E）：缺省不做乐观锁（仍走锁内原子 patch 防丢字段）。
        ...(getIfMatch(req) !== undefined ? { ifMatch: getIfMatch(req) } : {}),
      });
    } catch {
      reply.code(500).send(buildError(ErrorCode.INTERNAL, req.id));
      return reply;
    }
    if (result.kind === 'not_found') {
      return replyError(req, reply, ErrorCode.NOT_FOUND, {
        userMessage: '没找到对应版本，可能已被删除。',
        action: 'change_input',
      });
    }
    if (result.kind === 'forbidden') {
      return replyError(req, reply, ErrorCode.FORBIDDEN, {
        userMessage: '你没有权限编辑这个能力。',
      });
    }
    if (result.kind === 'state_conflict') {
      return replyError(req, reply, ErrorCode.STATE_CONFLICT, {
        userMessage: '这个能力已发布，请基于新版本再编辑。',
        action: 'change_input',
      });
    }
    if (result.kind === 'precondition_failed') {
      // If-Match 乐观锁冲突（§4.E）：内容刚被改过，刷新重取后重试（412 PRECONDITION_FAILED）。
      return replyError(req, reply, ErrorCode.PRECONDITION_FAILED, {
        userMessage: '内容刚刚被改过了，请刷新后重试。',
        action: 'retry',
      });
    }
    const body: Envelope<ManifestView> = { data: result.view, meta: { traceId: req.id } };
    // 新 ETag 头（推进乐观锁锚点；前端拿新值续 If-Match）。
    reply.header('ETag', result.etag);
    reply.code(200).send(body);
    return reply;
  };
}

// ===========================================================================
// F · POST /versions/:versionId/manifest/fields/:field/regenerate — 单软字段重生成（§4.F，B-26）
// ===========================================================================

/**
 * 单软字段重生成（§4.F）。path field 必 ∈ 软字段（硬字段 → 422 HARD_FIELD_LOCKED）。仅 draft（已 published → 409）。
 *   只重生成该字段（structure_state 仅该字段置 generating，其余已生成软字段 + 硬字段不动、不清空，验收 选择结构化-14/17/26）。
 *   建/复用 structure job（mode=single-field，仅该 field），202 回 jobId/field/eventsUrl（前端连端点 D 按 field 过滤帧）。
 */
export function regenerateFieldHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const userId = requireUserId(req, reply);
    if (!userId) return reply;
    const { versionId, field } = req.params as { versionId: string; field: string };

    // path field 必须是软字段（硬字段/未知键 → 422 HARD_FIELD_LOCKED，§4.F path 约束）。
    if (!(SOFT_FIELD_KEYS as string[]).includes(field)) {
      return replyError(req, reply, ErrorCode.HARD_FIELD_LOCKED, {
        userMessage: '这部分是平台锁定的，不能重新生成。',
        action: 'change_input',
      });
    }
    const softField = field as SoftFieldKey;

    const parsed = RegenerateFieldBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return replyError(req, reply, ErrorCode.VALIDATION_FAILED, { action: 'change_input' });
    }

    // 受理：【取 version 锁（建 job）+ 置该字段 generating 同事务原子】（Codex r2 P1）。
    //   锁冲突（version 级唯一锁 / 字段已 generating）→ 整体回滚 → 423，structure_state 完全不变（字段未被置
    //   generating、attempts 未动）。跨调用累计 attempts（§3.4）在锁内读取、续算、透传给 worker（attemptsBefore）。
    let acq;
    try {
      acq = await acquireRegenerateFieldJob(asTxPool(req.server.infra.db), req.server.infra.queue, {
        versionId,
        ownerUserId: userId,
        field: softField,
      });
    } catch {
      return replyError(req, reply, ErrorCode.DEPENDENCY_UNAVAILABLE, {
        userMessage: '系统正在恢复，请稍候再试。',
        action: 'wait',
      });
    }
    if (acq.kind === 'not_found') {
      return replyError(req, reply, ErrorCode.NOT_FOUND, {
        userMessage: '没找到对应版本或字段。',
        action: 'change_input',
      });
    }
    if (acq.kind === 'forbidden') {
      return replyError(req, reply, ErrorCode.FORBIDDEN, {
        userMessage: '你没有权限编辑这个能力。',
      });
    }
    if (acq.kind === 'state_conflict') {
      return replyError(req, reply, ErrorCode.STATE_CONFLICT, {
        userMessage: '已发布版本不能重生成字段，请基于新版本编辑。',
        action: 'change_input',
      });
    }
    if (acq.kind === 'field_locked') {
      // 字段级硬锁（§4.F，Codex P1-4）：该字段已在生成中，不重复受理 → 423 RESOURCE_LOCKED（wait）。
      //   锁内判定 → 整体回滚 → structure_state 不变。
      return replyError(req, reply, ErrorCode.RESOURCE_LOCKED, {
        userMessage: '这个字段正在生成，请稍候。',
        action: 'wait',
      });
    }
    if (acq.kind === 'version_locked') {
      // version 级硬锁（§4.F，Codex P1-4 / r2 P1）：同 version 已有未终态 structure job（full 在跑/别字段 regen）。
      //   取锁（建 job）冲突 → 整体回滚 → structure_state 不变（字段未被置 generating）→ 423。
      return replyError(req, reply, ErrorCode.RESOURCE_LOCKED, {
        userMessage: '结构化正在进行，请稍候。',
        action: 'wait',
      });
    }

    const data: RegenerateFieldResult = {
      jobId: acq.jobId,
      field: softField,
      eventsUrl: structureEventsUrl(versionId), // 同一字段流，前端按 field 过滤帧（§4.F）。
    };
    const body: Envelope<RegenerateFieldResult> = { data, meta: { traceId: req.id } };
    reply.code(202).send(body);
    return reply;
  };
}

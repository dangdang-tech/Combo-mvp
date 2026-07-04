// 40 · 结构化域 B-26 编辑仓储 + STEP③ 选择草稿（40-step3-4-structure §4.E/§4.F/§4.G）。
//   与 structure-repo.ts（B-24 建体 + B-25 worker 受保护写）互补：本文件只管【创作者编辑态】的非 worker 写：
//     - PATCH 软字段（§4.E）：仅 draft 可改、仅软字段；改 instructions 派生重算 inputs.schema（仍锁定）；
//       已 published → state_conflict（需建新版本，§2.4）。单语句只改一次（§11.A：对父行单语句只改一次）。
//     - 单字段重生成受理（§4.F）：【锁获取 + 置 generating 同事务原子】——先在事务内尝试取 version 锁（建 job），
//       冲突即整体回滚 423（structure_state 不变）；仅锁获取成功才在同事务把该字段置 generating（其余不动、不清空）。
//     - STEP③ 存草稿（§4.G）：持久化 drafts.selection + current_step='select'，不建任务/不调模型/不产生能力体。
//   全部注入 Queryable（pg 子集），便于 mock，无真 PG。owner/状态闸内联进 WHERE（0 行 = 分类，不暴露存在性）。
import {
  applySoftFields,
  setFieldState,
  getFieldState,
  initialStructureState,
  isArrayField,
  buildStructureState,
  LOCKED_HARD_FIELDS,
} from './manifest.js';
import { readVersion, etagFromUpdatedAt, type VersionRow } from './repo.js';
import {
  insertStructureJobTx,
  isStructureVersionLockConflict,
  type StructureSubjectRef,
} from './create-structure-job.js';
import type { Queryable } from '../../platform/jobs/types.js';
import type { Tx, TxPool } from '../../platform/events/db-tx.js';
import { withTransaction } from '../../platform/events/db-tx.js';
import {
  type Manifest,
  type ManifestView,
  type StructureState,
  type SoftFieldKey,
  type SelectionDraft,
  type DraftView,
  type ErrorBody,
  selectionCandidateIds,
} from '@cb/shared';

// ---------------------------------------------------------------------------
// 读 manifest（§4.B）→ ManifestView（软硬分层 + structure_state 快照）
// ---------------------------------------------------------------------------

export type ReadManifestResult =
  | { kind: 'ok'; view: ManifestView; status: string; creatorUserId: string; etag: string }
  | { kind: 'not_found' };

/** 把 VersionRow 组成 ManifestView（locked=硬字段全集；structure_state 空则据 manifest 投影回显）。 */
function toManifestView(v: VersionRow): ManifestView {
  const structureState: StructureState =
    v.structureState && Array.isArray(v.structureState.fields) && v.structureState.fields.length > 0
      ? // doneCount/totalCount 从 fields 重算（不信库内存量值）：worker surgical 写只 patch fields、不刷新存量计数
        // （Codex r6 P1），计数以 fields 为唯一真源在读时派生（buildStructureState 同口径）。
        buildStructureState(v.id, (v.structureState as StructureState).fields)
      : initialStructureState(v.id, v.manifest);
  return {
    versionId: v.id,
    capabilityId: v.capabilityId,
    slug: v.slug,
    manifest: v.manifest,
    locked: LOCKED_HARD_FIELDS,
    structureState,
  };
}

/**
 * 读某版本 manifest（§4.B）。owner 由调用方据 creatorUserId 校验（非本人 → 403）。
 * 不存在 → not_found（调用方 404，不暴露存在性）。
 */
export async function readManifestView(
  db: Queryable,
  versionId: string,
): Promise<ReadManifestResult> {
  const v = await readVersion(db, versionId);
  if (!v) return { kind: 'not_found' };
  return {
    kind: 'ok',
    view: toManifestView(v),
    status: v.status,
    creatorUserId: v.creatorUserId,
    // ETag（据 updated_at 派生）：GET manifest 回此头，前端 PATCH 带回 If-Match 做乐观锁（§4.E）。
    etag: etagFromUpdatedAt(v.updatedAt),
  };
}

// ---------------------------------------------------------------------------
// PATCH 软字段（§4.E）
// ---------------------------------------------------------------------------

export type PatchManifestResult =
  | { kind: 'ok'; view: ManifestView; etag: string }
  | { kind: 'not_found' }
  | { kind: 'forbidden' }
  | { kind: 'state_conflict' }
  | { kind: 'precondition_failed' }; // If-Match 乐观锁冲突（412 PRECONDITION_FAILED，§4.E）

/** 锁行读到的 version 行（事务内 SELECT ... FOR UPDATE 的列子集）。 */
interface LockedVersionRow {
  capability_id: string;
  slug: string;
  status: string;
  creator_user_id: string;
  manifest: Manifest;
  structure_state: Partial<StructureState>;
  updated_at: string;
}

/**
 * 改单/多软字段（§4.E）：仅 draft 可改、仅软字段（硬字段键由 handler 在调用前拒绝 → 422 HARD_FIELD_LOCKED）。
 *   - applySoftFields 落软字段；改 instructions → 系统重算 inputs.schema/output.type（仍锁定，§4.E 派生规则）。
 *   - 已 published → state_conflict（需基于新版本编辑，§2.4）。
 *   - If-Match 乐观锁（Codex P1-5）：事务内 SELECT ... FOR UPDATE 锁行 → 校验当前 ETag（据 updated_at 派生）
 *     与 If-Match 一致；不一致 → precondition_failed（412）。**在锁内读最新 manifest 再 patch 再写回**（不写回调用方
 *     读到的旧整列），杜绝并发 PATCH 互相丢字段（只改被 patch 的软字段，其余字段从锁内最新值带走）。
 *   structure_state 据新 manifest 投影：改后的软字段 done 回显、未生成 pending、硬字段 locked（已生成不丢，硬规则③）。
 */
export async function patchManifestSoftFields(
  txPool: TxPool,
  args: {
    versionId: string;
    ownerUserId: string;
    patch: Partial<Record<SoftFieldKey, string | string[]>>;
    /** 客户端 If-Match 头（弱 ETag，缺省则不做乐观锁，仅 draft 闸 + 锁内原子 patch）。 */
    ifMatch?: string;
  },
): Promise<PatchManifestResult> {
  return withTransaction(txPool, async (tx: Tx) => {
    // 锁行读最新（FOR UPDATE）：并发 PATCH 串行化，杜绝两个 PATCH 各读旧整列、互相覆盖丢字段（Codex P1-5）。
    const res = await tx.query<LockedVersionRow>(
      `SELECT v.capability_id, c.slug, v.status, c.creator_user_id,
              v.manifest, v.structure_state, v.updated_at
         FROM capability_versions v
         JOIN capabilities c ON c.id = v.capability_id
        WHERE v.id = $1
        FOR UPDATE OF v`,
      [args.versionId],
    );
    const r = res.rows[0];
    if (!r) return { kind: 'not_found' };
    if (r.creator_user_id !== args.ownerUserId) return { kind: 'forbidden' };
    if (r.status !== 'draft') return { kind: 'state_conflict' };

    const currentUpdatedAt =
      typeof r.updated_at === 'string' ? r.updated_at : new Date(r.updated_at).toISOString();
    // If-Match 乐观锁：给了 If-Match 且与当前 ETag 不符 → 412（内容刚被改过，刷新后重试，§4.E）。
    if (args.ifMatch !== undefined && args.ifMatch !== etagFromUpdatedAt(currentUpdatedAt)) {
      return { kind: 'precondition_failed' };
    }

    // 在锁内最新 manifest 上 patch（不写回调用方旧整列；只动被 patch 的软字段，其余字段从锁内最新带走）。
    const manifest: Manifest = applySoftFields(r.manifest, args.patch);
    const structureState = projectStateAfterPatch(
      args.versionId,
      manifest,
      r.structure_state ?? {},
      args.patch,
    );

    // 锁内写回（同事务、同行已锁；updated_at=now() 推进 ETag，下一个 If-Match 据新 ETag 续）。
    await tx.query(
      `UPDATE capability_versions
          SET manifest = $2::jsonb, structure_state = $3::jsonb, updated_at = now()
        WHERE id = $1`,
      [args.versionId, JSON.stringify(manifest), JSON.stringify(structureState)],
    );
    // 回读新 updated_at 派生新 ETag（供响应 ETag 头；同事务可见）。
    const after = await tx.query<{ updated_at: string }>(
      `SELECT updated_at FROM capability_versions WHERE id = $1`,
      [args.versionId],
    );
    const newUpdatedAt = after.rows[0]?.updated_at ?? currentUpdatedAt;
    const etag = etagFromUpdatedAt(
      typeof newUpdatedAt === 'string' ? newUpdatedAt : new Date(newUpdatedAt).toISOString(),
    );

    return {
      kind: 'ok',
      etag,
      view: {
        versionId: args.versionId,
        capabilityId: r.capability_id,
        slug: r.slug,
        manifest,
        locked: LOCKED_HARD_FIELDS,
        structureState,
      },
    };
  });
}

/**
 * PATCH 后投影 structure_state：被改的软字段置 done（手填即已生成，回显终值）；其余沿用 manifest 投影。
 *   不连坐其它字段：未改的软字段若已落 failed/stuck 态（且本次未被 patch），保留其 status + error + attempts
 *   （改 A 字段不该抹掉 B 字段的失败重试历史，否则 B 的跨调用累计 attempts 被清零、§3.4 永不落错误态）。
 *   不丢运行中 partial（Codex r5 P1）：未被 patch 的【数组】字段若正 generating 且已落 partial value（active
 *   structure job 边生成边逐项落 structure_state、不落 manifest），也保留其 generating + value/attempts——
 *   否则结构化运行中 PATCH 其它软字段会从 manifest 投影把这些已浮现 partial 擦成空数组（已生成不丢，硬规则③）。
 */
function projectStateAfterPatch(
  versionId: string,
  manifest: Manifest,
  prev: Partial<StructureState>,
  patch: Partial<Record<SoftFieldKey, string | string[]>>,
): StructureState {
  let state = initialStructureState(versionId, manifest);
  const patchedKeys = new Set(Object.keys(patch) as SoftFieldKey[]);
  // 先保留未被 patch 的字段的已落 failed/stuck/generating(数组 partial) 态 + attempts（不连坐，§3.4 累计不丢）。
  //   failed/stuck 态【遮蔽】manifest 里的陈旧值：即使 manifest 仍有旧值（initialStructureState 投成 done），
  //   也保留 failed/stuck（否则「先 done、再 regen 失败、再 PATCH 别的字段」会把本字段打回 done、清掉 attempts）。
  const prevFields = Array.isArray(prev.fields) ? prev.fields : [];
  for (const pf of prevFields) {
    const key = pf.field as SoftFieldKey;
    if (patchedKeys.has(key)) continue; // 被 patch 的下面单独置 done。
    const pfErr = (pf as { error?: ErrorBody }).error;
    if (pf.status === 'failed' || pf.status === 'stuck') {
      state = setFieldState(state, key, {
        status: pf.status,
        ...(pf.value !== undefined ? { value: pf.value as string | string[] } : {}),
        ...(pfErr ? { error: pfErr } : {}),
        ...(typeof pf.attempts === 'number' ? { attempts: pf.attempts } : {}),
      });
      continue;
    }
    // 运行中数组 partial：保留 generating + 已落 partial value/attempts（Codex r5 P1，active job 续接不丢）。
    if (
      pf.status === 'generating' &&
      isArrayField(key) &&
      Array.isArray(pf.value) &&
      (pf.value as string[]).length > 0
    ) {
      state = setFieldState(state, key, {
        status: 'generating',
        value: pf.value as string[],
        ...(typeof pf.attempts === 'number' ? { attempts: pf.attempts } : {}),
      });
    }
  }
  // 被手动改的软字段标 done + 用新值（手填即已生成，回显终值；attempts 重置为 0 = 干净）。
  for (const key of patchedKeys) {
    const value = manifest[key];
    state = setFieldState(state, key, { status: 'done', value, attempts: 0 });
  }
  return state;
}

// ---------------------------------------------------------------------------
// 单字段重生成受理：锁获取（建 job 取 version 级唯一锁）+ 置 generating【同事务原子】（§4.F，其余不动）
// ---------------------------------------------------------------------------

export type AcquireRegenResult =
  | {
      kind: 'ok';
      jobId: string;
      structureState: StructureState;
      attempts: number;
      enqueued: boolean;
    }
  | { kind: 'not_found' }
  | { kind: 'forbidden' }
  | { kind: 'state_conflict' }
  | { kind: 'field_locked' } // 该字段已 generating（并发 regen 互斥，423 RESOURCE_LOCKED，Codex P1-4）
  | { kind: 'version_locked' }; // 同 version 已有未终态 structure job（version 级唯一锁冲突，423，Codex r2 P1）

/** 锁行读到的 version 行（事务内 SELECT ... FOR UPDATE 列子集，重生成受理用）。 */
interface LockedVersionRowForRegen {
  capability_id: string;
  status: string;
  creator_user_id: string;
  manifest: Manifest;
  structure_state: Partial<StructureState>;
}

/**
 * 单字段重生成受理（§4.F，Codex r2 P1：锁获取与置 generating【同事务原子】）。
 *
 *   旧实现先把字段写成 generating、再独立 INSERT job——若 version 级唯一锁冲突返回 423，已拒请求仍污染了
 *   structure_state（字段被错置 generating、attempts 被动）。本实现把【取 version 锁（建 job）+ 置 generating】
 *   绑进同一 PG 事务：
 *     1) SELECT ... FOR UPDATE 锁行读最新（owner/draft 闸 + 字段级 generating 判定，全在锁内）；
 *     2) 先在事务内尝试 INSERT structure job（命中 version 级唯一索引 uq_structure_job_active_version 即取锁）：
 *        - 唯一冲突 → 抛错 → withTransaction 整体 ROLLBACK → 返回 version_locked（structure_state 完全不变，423）；
 *     3) 仅 INSERT 成功（锁取到）才在【同事务】把该字段置 generating（续算 attempts）并写回；
 *     4) COMMIT 后再 best-effort 入队（入队失败留 queued 交 sweeper，不影响已落状态）。
 *
 *   字段级已 generating（别的 regen / full job 正写它）也在锁内判定 → ROLLBACK → field_locked（423）：既不重复
 *   受理、也不动 structure_state。draft 闸不符（已发布/并发被发布）→ state_conflict（不建 job、不置 generating）。
 *   attempts 跨调用累计（§3.4）：锁内读该字段已存 attempts 作起算基线（不清零），随结果回供路由透传 attemptsBefore；
 *     置 generating 时 setFieldState 默认保留已存 attempts（否则每次 regen 都全新 2 次预算、§3.4 永不落错误态）。
 */
export async function acquireRegenerateFieldJob(
  txPool: TxPool,
  queue: { enqueue(type: string, jobId: string, fence: number, traceId?: string): Promise<void> },
  args: { versionId: string; ownerUserId: string; field: SoftFieldKey; traceId?: string },
): Promise<AcquireRegenResult> {
  // —— 事务内：锁行 → 字段级闸 → 取 version 锁（建 job）→ 置 generating；任一拒因抛出令整体回滚（state 不变）——
  type TxOutcome =
    | { ok: true; jobId: string; structureState: StructureState; attempts: number }
    | {
        ok: false;
        kind: 'not_found' | 'forbidden' | 'state_conflict' | 'field_locked' | 'version_locked';
      };

  let outcome: TxOutcome;
  try {
    outcome = await withTransaction(txPool, async (tx: Tx): Promise<TxOutcome> => {
      // 1) 锁行读最新（FOR UPDATE）：owner/draft/字段级 generating 全在锁内判定，杜绝 TOCTOU。
      const res = await tx.query<LockedVersionRowForRegen>(
        `SELECT v.capability_id, v.status, c.creator_user_id, v.manifest, v.structure_state
           FROM capability_versions v
           JOIN capabilities c ON c.id = v.capability_id
          WHERE v.id = $1
          FOR UPDATE OF v`,
        [args.versionId],
      );
      const r = res.rows[0];
      if (!r) return { ok: false, kind: 'not_found' };
      if (r.creator_user_id !== args.ownerUserId) return { ok: false, kind: 'forbidden' };
      if (r.status !== 'draft') return { ok: false, kind: 'state_conflict' };

      // 基线 structure_state（已落则用之、否则据 manifest 投影），锁内判字段级 generating。
      const base: StructureState =
        r.structure_state &&
        Array.isArray(r.structure_state.fields) &&
        r.structure_state.fields.length > 0
          ? (r.structure_state as StructureState)
          : initialStructureState(args.versionId, r.manifest);
      // 字段级硬锁（Codex P1-4）：该字段已 generating → field_locked（423）；不建 job、不动 state（抛出 → 回滚）。
      if (getFieldState(base, args.field)?.status === 'generating') {
        throw new RegenRollback('field_locked');
      }
      // 该字段已存累计失败次数（跨调用累计起算基线；缺省 0）。
      const attempts = getFieldState(base, args.field)?.attempts ?? 0;

      // 2) 先取 version 级唯一锁（建 job）：命中 uq_structure_job_active_version → 抛唯一冲突 → 整体回滚。
      const subjectRef: StructureSubjectRef = {
        versionId: args.versionId,
        mode: 'single-field',
        field: args.field,
        ...(attempts > 0 ? { attemptsBefore: attempts } : {}),
      };
      let jobId: string | null;
      try {
        jobId = await insertStructureJobTx(tx, args.versionId, args.ownerUserId, subjectRef);
      } catch (err) {
        if (isStructureVersionLockConflict(err)) {
          // version 级锁冲突 → 抛出 → 整事务回滚（structure_state 完全不变，§4.F / Codex r2 P1）。
          throw new RegenRollback('version_locked');
        }
        throw err;
      }
      // jobId=null = draft 闸在 INSERT...SELECT 内未命中（并发被发布/删除）→ state_conflict（回滚，不置 generating）。
      if (!jobId) throw new RegenRollback('state_conflict');

      // 3) 仅锁取到才在【同事务】置 generating（续算 attempts；setFieldState 默认保留已存 attempts，§3.4）。
      const structureState = setFieldState(base, args.field, { status: 'generating' });
      await tx.query(
        `UPDATE capability_versions
            SET structure_state = $2::jsonb, updated_at = now()
          WHERE id = $1 AND status = 'draft'`,
        [args.versionId, JSON.stringify(structureState)],
      );
      return { ok: true, jobId, structureState, attempts };
    });
  } catch (err) {
    if (err instanceof RegenRollback) {
      // 事务已回滚（structure_state 不变）；映射受控拒因。
      return { kind: err.reason };
    }
    throw err;
  }

  if (!outcome.ok) return { kind: outcome.kind };

  // 4) COMMIT 后 best-effort 入队（失败留 queued 交 sweeper，不影响已落 generating 态；不裸转圈）。
  const enqueued = await safeEnqueue(queue, outcome.jobId, args.traceId);
  return {
    kind: 'ok',
    jobId: outcome.jobId,
    structureState: outcome.structureState,
    attempts: outcome.attempts,
    enqueued,
  };
}

/** 受控回滚信号：在事务回调内抛出，令 withTransaction 整体 ROLLBACK（structure_state 不被污染），再映射拒因。 */
class RegenRollback extends Error {
  constructor(readonly reason: 'state_conflict' | 'field_locked' | 'version_locked') {
    super(reason);
    this.name = 'RegenRollback';
  }
}

/** 入队（best-effort）：失败不抛（job 已建成 queued，交 staleQueued sweeper 补投，与 create-structure-job 同口径）。 */
async function safeEnqueue(
  queue: { enqueue(type: string, jobId: string, fence: number, traceId?: string): Promise<void> },
  jobId: string,
  traceId?: string,
): Promise<boolean> {
  try {
    await queue.enqueue('structure', jobId, 1, traceId);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// STEP③ 选择草稿持久化（§4.G）
// ---------------------------------------------------------------------------

export type SelectionPatchResult =
  | { kind: 'ok'; draft: DraftView }
  | { kind: 'not_found' }
  | { kind: 'forbidden' }
  | { kind: 'invalid_selection'; reason: string }; // 候选校验失败（属本人/同 snapshot/ready 数量，Codex P1-3）

interface DraftRow {
  id: string;
  owner_user_id: string;
  status: string;
  current_step: string;
  step_progress: unknown;
  title: string | null;
  snapshot_id: string | null;
  extract_job_id: string | null;
  selection: unknown;
  version_id: string | null;
  capability_id: string | null;
  created_at: string;
  updated_at: string;
}

function rowToDraftView(r: DraftRow): DraftView {
  const sp = (r.step_progress ?? {}) as { percent?: number; phrase?: string };
  return {
    id: r.id,
    status: r.status as DraftView['status'],
    currentStep: r.current_step as DraftView['currentStep'],
    stepProgress: {
      percent: typeof sp.percent === 'number' ? sp.percent : 0,
      phrase: typeof sp.phrase === 'string' ? sp.phrase : '选择中',
    },
    ...(r.title ? { title: r.title } : {}),
    ...(r.snapshot_id ? { snapshotId: r.snapshot_id } : {}),
    ...(r.extract_job_id ? { extractJobId: r.extract_job_id } : {}),
    ...(r.selection ? { selection: r.selection } : {}),
    ...(r.version_id ? { versionId: r.version_id } : {}),
    ...(r.capability_id ? { capabilityId: r.capability_id } : {}),
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}

/**
 * STEP③/STEP② 显式存草稿（§4.G）：持久化 selection + current_step='select' + step_progress「选择中」短语。
 *   owner 守门（不存在/非本人 → 404/403）。**不建任务、不调模型、不产生能力体**。幂等：同 draftId 重复保存覆盖（最后写赢）。
 *   候选校验（子集化 P0-1，§5.2/§5.3 / Codex P1-3）：保存前按候选表校验选中候选——
 *     · 属本人（owner_user_id = 当前用户）；· 同来源 snapshot（candidate.snapshot_id = draft.snapshot_id）；
 *     · 都是 ready；· 非空（schema .min(1) 兜，single 恒 1 个）。
 *   【放开】subset/all 不再要求 candidateIds == 该 snapshot 全部 ready 集——勾选任意子集（N<total）合法，
 *     「全部发布」只是 subset==全 ready 的特例（§5.3）。这修掉 STEP② 勾选子集写 selection→PATCH 400 卡死（Codex r6 P1）。
 *   不匹配 → invalid_selection（路由 400 VALIDATION_FAILED 人话，无 code）。绝不存「指向他人/跨快照/非 ready」的伪选择。
 */
export async function patchSelection(
  db: Queryable,
  args: { draftId: string; ownerUserId: string; selection: SelectionDraft },
): Promise<SelectionPatchResult> {
  // 1) 先读 draft（owner + snapshot_id；不存在/非本人 → 404/403，不暴露存在性）。
  const draftRes = await db.query<{ owner_user_id: string; snapshot_id: string | null }>(
    `SELECT owner_user_id, snapshot_id FROM drafts WHERE id = $1`,
    [args.draftId],
  );
  const draftMeta = draftRes.rows[0];
  if (!draftMeta) return { kind: 'not_found' };
  if (draftMeta.owner_user_id !== args.ownerUserId) return { kind: 'forbidden' };

  // 2) 候选校验（属本人 + 同 snapshot + ready 数量完全匹配，§4.G / Codex P1-3）。
  const invalid = await validateSelectionCandidates(db, {
    ownerUserId: args.ownerUserId,
    snapshotId: draftMeta.snapshot_id,
    selection: args.selection,
  });
  if (invalid) return { kind: 'invalid_selection', reason: invalid };

  // 3) 落库（owner 内联进 WHERE 兜底；幂等覆盖，最后写赢，§4.G）。
  const res = await db.query<DraftRow>(
    `UPDATE drafts
        SET selection = $3::jsonb,
            current_step = 'select',
            step_progress = jsonb_build_object('percent', 0, 'phrase', '选择中'),
            updated_at = now()
      WHERE id = $1 AND owner_user_id = $2
      RETURNING id, owner_user_id, status, current_step, step_progress, title,
                snapshot_id, extract_job_id, selection, version_id, capability_id,
                created_at, updated_at`,
    [args.draftId, args.ownerUserId, JSON.stringify(args.selection)],
  );
  const row = res.rows[0];
  if (row) return { kind: 'ok', draft: rowToDraftView(row) };
  // 0 行：不存在 or 非本人 → 轻查区分（§4.G 错误表 404/403）。
  const exists = await db.query<{ owner_user_id: string }>(
    `SELECT owner_user_id FROM drafts WHERE id = $1`,
    [args.draftId],
  );
  const owner = exists.rows[0]?.owner_user_id;
  if (owner === undefined) return { kind: 'not_found' };
  if (owner !== args.ownerUserId) return { kind: 'forbidden' };
  return { kind: 'not_found' };
}

/**
 * 候选选择校验（子集化 P0-1，§4.G / §5.2/§5.3 / Codex P1-3 / Codex r6 P1）。
 *   返回不匹配原因（人话短语，无 code）或 null（合法）。按候选表（capability_candidates）校验选中候选：
 *     · single：candidateId 须属本人、同 draft 来源 snapshot、status='ready'。
 *     · subset/all（兼容别名）：candidateIds 须【全】属本人 + 同 snapshot + ready，且非空、无重复——
 *       即 candidateIds ⊆ 本人该 snapshot 的 ready 候选集。【不再要求 == 全 ready】：勾选任意子集（N<total）
 *       合法（§5.2 批量勾选 N 项）；「全部发布」只是 subset==全 ready 的特例（§5.3），无需单独 mode、无需数量相等校验。
 *   去重 / 含他人 / 跨快照 / 非 ready / 不存在 → 拒（owner/snapshot/ready 内联进 WHERE，杜绝越权）。
 *   draft 无 snapshot_id（理论罕见，尚未关联快照）→ 无从校验来源，直接拒（不存伪选择）。
 */
async function validateSelectionCandidates(
  db: Queryable,
  args: { ownerUserId: string; snapshotId: string | null; selection: SelectionDraft },
): Promise<string | null> {
  const { selection } = args;
  if (!args.snapshotId) {
    return '这个草稿还没关联可选的候选来源，回上一步重新识别。';
  }
  // 规范化取候选集（single→[一个]，subset/all→原数组）：子集语义统一，不再按 mode 分叉数量校验。
  const ids = selectionCandidateIds(selection);
  // 去重防御（子集里重复 id 不合法）。
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length !== ids.length) {
    return '选择里有重复的候选，重选一下再保存。';
  }

  // 读这些 id 中【属本人 + 同 snapshot + ready】的集合（owner/snapshot/ready 内联进 WHERE，杜绝越权/跨快照/非 ready）。
  const matched = await db.query<{ id: string }>(
    `SELECT id FROM capability_candidates
      WHERE id = ANY($1::uuid[])
        AND owner_user_id = $2
        AND snapshot_id = $3
        AND status = 'ready'`,
    [uniqueIds, args.ownerUserId, args.snapshotId],
  );
  const matchedIds = new Set(matched.rows.map((r) => r.id));
  // 子集闸：选中的每个 id 都必须命中（⊆ 本人该 snapshot 的 ready 集；否则 = 含他人/跨快照/非 ready/不存在）。
  //   不再做「== 全 ready」数量校验：N<total 是合法子集（§5.2），「全部发布」是 N==total 特例（§5.3）。
  if (matchedIds.size !== uniqueIds.length) {
    return '选中的候选有不可用的（可能不属于你、来源不同或还没识别好），重选一下。';
  }
  return null;
}

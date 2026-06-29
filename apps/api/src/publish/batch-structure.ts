// 50 · B-29 扩展 · 批量「全部发布」candidate 编排单元（§5.3 一次性自动整理、批量发布）。
//   §5.3「全部发布」从 candidate 起：每 item 串 create→structure→publish 子任务，复用 3D/3E 现成逻辑【不重写】：
//     ① create：复用 3D create-capability（createCapability，sourceCandidateId 分支）建 draft 版本（自带单事务），回填 versionId。
//     ② structure：复用 3D 结构化生成（generateFieldWithRetry + manifest helpers）把 7 软字段一次性补齐进版本 manifest，
//        受保护落库（writeManifestAndStateProtected，fence 经【批 job】内联——批 job 即本编排的执行单元）。
//     ③ publish：交回批 handler 走 3E 发布门（publishOne），本模块只负责把 candidate 整理到「可发布版本」。
//   本模块只做「create + structure 整理到可发布版本」，返回 versionId；publish 由批 handler 续接（关注点分离）。
//
//   诚实简化（本期，§5.3 一次性自动整理）：
//     · 批内 candidate 的结构化是【整批一次性补齐】（非逐字段流式 SSE）——批进度按 item 粒度（structuring→publishing→
//       published）走，不在批流里发结构化 field_delta/item-appended（那是单条向导 STEP③④ 的字段流，§4.C）。
//       批 item 永不裸转圈：每 item 有 structuring/publishing/published 可见态 + 批 done/total 进度（硬规则①）。
//     · 结构化失败（某字段两次仍失败 / 无证据）→ 该 item 失败 +「去补齐」回向导（不连坐其余、可单独重试，决策⑤）。
//     · 已 create 出的版本即使本次结构化未补全也【不丢】（已生成不丢，硬规则③）：item 回填 versionId，
//       重试 / 单条向导可基于该版本继续补齐（retry 携 versionId 走单发布或再编排）。
import {
  SOFT_FIELD_KEYS,
  ErrorCode,
  buildError,
  type SoftFieldKey,
  type Manifest,
  type LlmGatewayPort,
  type ErrorBody,
} from '@cb/shared';
import type { Queryable } from '../jobs/types.js';
import type { Tx, TxPool } from '../events/db-tx.js';
import {
  createCapability,
  CreateCapabilityError,
  CreateCapabilityFencedError,
} from '../structure/create-capability.js';
import {
  readEvidenceForCandidate,
  writeManifestAndStateProtected,
} from '../structure/structure-repo.js';
import { applySoftField, manifestToStructureState, isArrayField } from '../structure/manifest.js';
import { generateFieldWithRetry, type GenContext } from '../structure/generate.js';

/** 编排结果：candidate 整理到可发布版本（成功）或带人话错误的失败（去补齐 / 重试）。 */
export type StructureItemOutcome =
  | { kind: 'ready'; versionId: string; capabilityId: string }
  | { kind: 'failed'; error: ErrorBody; missingFields: string[] | null; versionId?: string };

export interface BatchStructureDeps {
  db: Queryable;
  txPool: TxPool;
  gateway: LlmGatewayPort;
}

/**
 * create-capability 新建 versionId 的【同事务】受保护回填钩子（Codex r7 P1 原子窗口修）。
 *   在 create-capability 建体 INSERT 之后、本事务 COMMIT 之前【同 tx】被调，让 item.version_id 回填与建版【合成同一事务】：
 *     - 返回 true = fence 校验命中 + 回填成功 → 与建版同 COMMIT（版本与 item 指针同时落库）。
 *     - 返回 false = fence 校验未命中（被接管/换 fence/已终态，回填 0 行）→ create-capability 抛 fenced 信号回滚整事务
 *       （建版一并回滚，version 未提交）→ 编排按 fencedOut 收口。
 *   钩子内须只用传入的 tx 句柄（同一连接 = 同一事务）。如此「建版 + 回填」要么同提交、要么同回滚，
 *   绝不出现「已提交 version 但 item 无指针」的窗口（关掉 create COMMIT 后、回填前被接管致重复建版的原子性窗口）。
 */
export type OnVersionCreatedInTx = (
  tx: Tx,
  args: { versionId: string; capabilityId?: string },
) => Promise<boolean>;

/**
 * 把一个 candidate item 编排到「可发布版本」（create → structure），复用 3D 现成逻辑【不重写】。
 *   - jobId/fenceToken：本批 job 的执行 fence——结构化落库经它内联校验（writeManifestAndStateProtected：
 *     j.id=:jobId AND fence_token=:fence AND status='running'），被接管换 fence → 0 行 → 返回 fencedOut（批 handler 安全退出本项）。
 *   - 已 create 出的 versionId 即使结构化未补全也回带（已生成不丢）：失败 outcome 带 versionId，便于重试 / 单条续补。
 */
export async function structureCandidateItem(
  deps: BatchStructureDeps,
  args: {
    candidateId: string;
    ownerUserId: string;
    jobId: string;
    fenceToken: number;
    traceId: string;
    /** 已 create 过的版本（重试 / 续跑：跳过 create，直接结构化该版本，幂等不重复建体）。 */
    existingVersionId?: string;
    /**
     * create-capability 新建 versionId 的【同事务】受保护回填钩子（原子窗口修，Codex r7 P1）：
     *   在建版同事务内 fence 校验 + 回填 item.version_id；返回 false（被接管）→ 整事务回滚（version 未提交）→ 编排走 fencedOut。
     *   缺省（无回填能力）则建版后不回填（向后兼容 / 纯结构化测试，无原子窗口诉求）。
     */
    onVersionCreatedInTx?: OnVersionCreatedInTx;
  },
): Promise<StructureItemOutcome | { kind: 'fencedOut' }> {
  const { db, txPool } = deps;

  // —— ① create（复用 3D create-capability，sourceCandidateId 分支；自带单事务建 capabilities + capability_versions）——
  //   重试 / 续跑已 create 过 → 跳过（existingVersionId 直接结构化，幂等不重复建体）。
  let versionId = args.existingVersionId;
  let capabilityId: string | undefined;
  if (!versionId) {
    // —— ① create + item.version_id 回填【合成同一受保护事务】（原子窗口修，Codex r7 P1，方案 A）——
    //   旧实现：create-capability 独立事务 COMMIT 建版，再【另一独立事务】受保护回填 item.version_id——两笔之间有原子窗口：
    //     若 create COMMIT 后、回填前 job 被接管/lease 过期（fence 翻动），回填 0 行 → item 无 version_id 但版本已落库 →
    //     下个 attempt 据 candidate 复跑再 create → 重复建版（违「重试不重复建版」）。
    //   修法：把回填作为 onCreatedInTx 钩子传给 create-capability，在建版【同事务】内 fence 校验 + 回填；
    //     0 行（被接管）→ 钩子返 false → create-capability 抛 CreateCapabilityFencedError 回滚整事务（建版一并回滚、version 未提交）。
    //     如此「建版 + 回填」要么同 COMMIT、要么同 ROLLBACK，绝不出现「已提交 version 但 item 无指针」的窗口；
    //     接管后重试据 candidate 重新建（无残留半版，不重复建版）。
    try {
      const created = await createCapability(
        db,
        txPool,
        { sourceCandidateId: args.candidateId },
        { userId: args.ownerUserId },
        args.onVersionCreatedInTx
          ? {
              onCreatedInTx: async (tx, c) =>
                args.onVersionCreatedInTx!(tx, {
                  versionId: c.versionId,
                  capabilityId: c.capabilityId,
                }),
            }
          : undefined,
      );
      versionId = created.versionId;
      capabilityId = created.capabilityId;
    } catch (err) {
      // 同事务回填被 fence out（被接管）→ 整事务已回滚（version 未提交）→ 按 fencedOut 收口（下个 attempt 据 candidate 重建）。
      if (err instanceof CreateCapabilityFencedError) return { kind: 'fencedOut' };
      // create 失败（候选不存在/非本人/校验）→ 该 item 失败（人话 + 去上一步换候选），不连坐其余。
      return {
        kind: 'failed',
        error: createCapabilityErrorBody(err, args.traceId),
        missingFields: null,
      };
    }
  }

  // —— ② structure（复用 3D 结构化生成把 7 软字段一次性补齐进版本 manifest，受保护落库）——
  const res = await fillSoftFields(deps, {
    versionId,
    ownerUserId: args.ownerUserId,
    jobId: args.jobId,
    fenceToken: args.fenceToken,
    traceId: args.traceId,
  });
  if (res.kind === 'fencedOut') return { kind: 'fencedOut' };
  if (res.kind === 'failed') {
    // 结构化失败：已 create 的版本不丢（回带 versionId，重试 / 单条续补），item 失败 + 去补齐。
    return { kind: 'failed', error: res.error, missingFields: res.missingFields, versionId };
  }

  // create 成功但 capabilityId 未知（existingVersionId 路径）→ 由批 handler 经 publish-one 回填，结构化 ready 只需 versionId。
  return { kind: 'ready', versionId, capabilityId: capabilityId ?? res.capabilityId };
}

/**
 * 把版本的 7 软字段一次性补齐进 manifest（复用 3D generateFieldWithRetry + manifest helpers），受保护落库一次。
 *   - 直读证据（经 source_candidate_id；空 → STRUCTURE_NO_EVIDENCE：该 item 失败 + 去上一步补内容）。
 *   - 逐字段生成（顺序，后字段参考前字段，与 3D 同口径）；任一字段两次仍真抛（terminal）→ 该 item 结构化失败 + 去补齐。
 *     degraded（无 key / 上游不稳）走确定性兜底（不裸转圈/不裸 502，§10），不算失败。
 *   - 一次性受保护落库（writeManifestAndStateProtected，fence 经【批 job】内联；0 行 = 被接管 → fencedOut）。
 *   注：批内不发逐字段流式 SSE（那是单条向导 §4.C 的字段流）；批进度按 item 粒度（structuring→publishing）走（诚实简化）。
 */
async function fillSoftFields(
  deps: BatchStructureDeps,
  args: {
    versionId: string;
    ownerUserId: string;
    jobId: string;
    fenceToken: number;
    traceId: string;
  },
): Promise<
  | { kind: 'done'; manifest: Manifest; capabilityId: string }
  | { kind: 'failed'; error: ErrorBody; missingFields: string[] | null }
  | { kind: 'fencedOut' }
> {
  const { db, gateway } = deps;

  // 读版本（拿 manifest 起点 + 血缘 source_candidate_id + capabilityId）。
  const version = await readVersionForStructure(db, args.versionId);
  if (!version) {
    return { kind: 'failed', error: notFoundBody(args.traceId), missingFields: null };
  }
  // 已结构化 ready 短路（P0-1 重试幂等）：版本 7 软字段已全部补齐 → manifest 已 ready，无需再读证据/再生成。
  //   场景：candidate item 上一轮已 structure 到 ready 但发布门失败（瞬时），下一轮 existingVersionId 复跑——
  //   本版已结构化完整，不应因「证据已清弃」误判 noEvidence 失败；直接确认 ready（不重复落库、不重复建版）。
  if (SOFT_FIELD_KEYS.every((f) => hasValue(version.manifest, f))) {
    return { kind: 'done', manifest: version.manifest, capabilityId: version.capabilityId };
  }
  // 直读证据（经候选；空 → 无证据，该 item 失败 + 去上一步补内容，§4.C）。
  let evidence = {
    segments: [] as Awaited<ReturnType<typeof readEvidenceForCandidate>>['segments'],
  };
  if (version.sourceCandidateId) {
    evidence = await readEvidenceForCandidate(db, version.sourceCandidateId);
  }
  if (evidence.segments.length === 0) {
    return { kind: 'failed', error: noEvidenceBody(args.traceId), missingFields: null };
  }

  // 逐字段生成补齐进 manifest（顺序：后字段参考前字段，与 3D 同；degraded 走兜底不算失败）。
  let manifest = version.manifest;
  for (const field of SOFT_FIELD_KEYS) {
    // 已有非空值（续跑/重试已补部分）→ 跳过（已生成不丢，续传只补未生成，与 3D 同口径）。
    if (hasValue(manifest, field)) continue;
    const genCtx: GenContext = {
      generated: softGenerated(manifest),
      evidence,
      traceId: args.traceId,
      ownerUserId: args.ownerUserId,
    };
    const gen = await generateFieldWithRetry(gateway, field, genCtx, {
      onAttemptStart: async () => {}, // 批内不发逐字段流式帧（诚实简化：批进度按 item 粒度）。
      onScalarDelta: async () => {},
      onArrayItem: async () => {},
    });
    if (gen.kind === 'failed' && gen.terminal) {
      // 某字段两次仍真抛 → 该 item 结构化失败 + 去补齐（不连坐其余，可单独重试，决策⑤）。
      return {
        kind: 'failed',
        error: structureFieldFailedBody(args.traceId, field),
        missingFields: [field],
      };
    }
    if (gen.kind === 'ok') {
      manifest = applySoftField(manifest, field, gen.result.value);
    }
    // gen.failed 且非 terminal（罕见：累计未达上限但本轮预算用尽）——批内本轮就给确定性兜底，避免半成品发不出去。
    else {
      // 非 terminal 失败：批内一次性整理无后续 regen 入口，落确定性兜底（degraded 思路，不裸空）。
      const fallback = await fallbackField(deps, field, manifest, evidence, args);
      manifest = applySoftField(manifest, field, fallback);
    }
  }

  // 一次性受保护落库（manifest + structure_state 一致；fence 经【批 job】内联；0 行 = 被接管 → fencedOut）。
  const state = manifestToStructureState(args.versionId, manifest);
  const wrote = await writeManifestAndStateProtected(db, {
    jobId: args.jobId,
    fenceToken: args.fenceToken,
    versionId: args.versionId,
    manifest,
    state,
  });
  if (!wrote) return { kind: 'fencedOut' };

  return { kind: 'done', manifest, capabilityId: version.capabilityId };
}

/** 非 terminal 失败时的确定性兜底字段值（复用 generate 的兜底路径：degraded 思路，不裸空）。 */
async function fallbackField(
  deps: BatchStructureDeps,
  field: SoftFieldKey,
  manifest: Manifest,
  evidence: { segments: Awaited<ReturnType<typeof readEvidenceForCandidate>>['segments'] },
  args: { ownerUserId: string; traceId: string },
): Promise<string | string[]> {
  // 复用 generate（degraded 网关会走确定性兜底）；这里直接再调一次（roundBudget 已尽时已是兜底来源）。
  const genCtx: GenContext = {
    generated: softGenerated(manifest),
    evidence,
    traceId: args.traceId,
    ownerUserId: args.ownerUserId,
  };
  const gen = await generateFieldWithRetry(deps.gateway, field, genCtx, {
    onAttemptStart: async () => {},
    onScalarDelta: async () => {},
    onArrayItem: async () => {},
  });
  if (gen.kind === 'ok') return gen.result.value;
  // 仍失败：空骨架占位（数组空 / 单值空——发布门 missingFields 会挡 name/tagline 缺，转去补齐，不假成功）。
  return isArrayField(field) ? [] : '';
}

// ===========================================================================
// helpers
// ===========================================================================

interface StructureVersionRow {
  manifest: Manifest;
  sourceCandidateId: string | null;
  capabilityId: string;
  status: string;
}

/** 读版本（结构化起步：manifest + 血缘 + capabilityId + status）。不存在 → null。 */
async function readVersionForStructure(
  db: Queryable,
  versionId: string,
): Promise<StructureVersionRow | null> {
  const res = await db.query<{
    manifest: Manifest;
    source_candidate_id: string | null;
    capability_id: string;
    status: string;
  }>(
    `SELECT v.manifest, v.source_candidate_id, v.capability_id, v.status
       FROM capability_versions v
      WHERE v.id = $1`,
    [versionId],
  );
  const r = res.rows[0];
  if (!r) return null;
  return {
    manifest: r.manifest,
    sourceCandidateId: r.source_candidate_id,
    capabilityId: r.capability_id,
    status: r.status,
  };
}

function hasValue(manifest: Manifest, field: SoftFieldKey): boolean {
  const v = manifest[field];
  return isArrayField(field)
    ? Array.isArray(v) && v.length > 0
    : typeof v === 'string' && v.length > 0;
}

function softGenerated(manifest: Manifest): Partial<Record<SoftFieldKey, string | string[]>> {
  const out: Partial<Record<SoftFieldKey, string | string[]>> = {};
  for (const f of SOFT_FIELD_KEYS) {
    if (hasValue(manifest, f)) out[f] = manifest[f];
  }
  return out;
}

// —— 人话错误信封（绝不裸露 code/堆栈；与单发布/批 item 错误口径同源，§2）——

function createCapabilityErrorBody(err: unknown, traceId: string): ErrorBody {
  if (err instanceof CreateCapabilityError) {
    if (err.code === ErrorCode.NOT_FOUND) {
      return buildError(ErrorCode.NOT_FOUND, traceId, {
        userMessage: '没找到这条候选，可能已被删除，回上一步换一条。',
        action: 'change_input',
      }).error;
    }
    if (err.code === ErrorCode.FORBIDDEN) {
      return buildError(ErrorCode.FORBIDDEN, traceId, {
        userMessage: '你没有权限整理这条候选。',
        action: 'escalate',
      }).error;
    }
  }
  return buildError(ErrorCode.INTERNAL, traceId, {
    userMessage: '这一项没整理出来，稍后单独重试一下。',
    action: 'retry',
  }).error;
}

function noEvidenceBody(traceId: string): ErrorBody {
  return buildError(ErrorCode.STRUCTURE_NO_EVIDENCE, traceId, {
    userMessage: '这条会话内容不足，没法整理成能力，回上一步补点内容或换一条。',
    action: 'change_input',
  }).error;
}

function structureFieldFailedBody(traceId: string, field: SoftFieldKey): ErrorBody {
  return buildError(ErrorCode.PUBLISH_MISSING_FIELDS, traceId, {
    userMessage: '这一项还差几个字段没整理出来，去补齐后再发布。',
    action: 'change_input',
    details: { missingFields: [field] },
  }).error;
}

function notFoundBody(traceId: string): ErrorBody {
  return buildError(ErrorCode.NOT_FOUND, traceId, {
    userMessage: '没找到对应版本，可能已被删除。',
    action: 'change_input',
  }).error;
}

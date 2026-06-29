// STEP④ 结构化数据层（F-13）——接 40 域端点 A/B/C/E/F（结构化建版 + manifest 读写 + 单字段重生成）。
//
// 端点真源（40 §4）：
//   - A `POST /capabilities`（scope=capability.create）：从 STEP③ 选中候选建 draft 版本（软字段空、硬字段锁定）。
//     本步入口：进入 STEP④ 若无 versionId（draft 未建版）则据 selection.candidateId 建版（恰好三选一：sourceCandidateId）。
//   - B `GET /versions/{versionId}/manifest`：读 manifest（软硬分层 + structure_state 快照），续传/回看/SSE 断流兜底。
//   - C `POST /versions/{versionId}/structure`（scope=structure.start）：发起结构化 Job，SSE 走端点 D（useSSE structure 流）。
//   - E `PATCH /versions/{versionId}/manifest`（scope=manifest.patch）：改软字段（手动编辑）；硬字段键 → 后端 422 拒绝。
//   - F `POST /versions/{versionId}/manifest/fields/{field}/regenerate`（scope=manifest.regenerate_field）：单软字段重生成。
//
// SSE 字段流端点 D 不在此（同源 Cookie SSE，经 useSSE + SSE_ROUTES.structureEvents 订阅，§4.D）。
import {
  IdempotencyScope,
  type ManifestView,
  type CreateCapabilityResult,
  type StartStructureResult,
  type RegenerateFieldResult,
  type SoftFieldKey,
  type PatchManifestBody,
} from '@cb/shared';
import { apiGet, apiPost, apiPatch, type RequestOptions } from '../../../api/index.js';

/** 端点 B 路径（读 manifest）。 */
export function manifestPath(versionId: string): string {
  return `/versions/${encodeURIComponent(versionId)}/manifest`;
}

/** 端点 C 路径（发起结构化 Job）。 */
export function startStructurePath(versionId: string): string {
  return `/versions/${encodeURIComponent(versionId)}/structure`;
}

/** 端点 F 路径（单软字段重生成）。 */
export function regenerateFieldPath(versionId: string, field: SoftFieldKey): string {
  return `/versions/${encodeURIComponent(versionId)}/manifest/fields/${encodeURIComponent(field)}/regenerate`;
}

/**
 * 端点 A：建能力体 draft 版本（恰好三选一来源，40 §2.4 / §4.A）。
 * 三分支语义：
 *   ① sourceCandidateId：从 STEP③ 选中候选建首版（软字段空、硬字段锁定）——STEP④ 默认入口。
 *   ② capabilityId：published 后基于现能力体建新版本（改版重发）。
 *   ③ fromVersionId：被拒「编辑后重发」从 review_rejected 版派生新 draft（复制软字段 bump minor，原被拒版不动，P1-5 闭环）。
 * 入参【恰好三选一】（有且仅有一个 source）：本层据传入字段择一发送；多传/不传由后端 refine 拒（VALIDATION_FAILED）。
 * 写命令必带 Idempotency-Key（client 注入）+ scope=capability.create；同源重复点回放首次（不建第二条，验收 选择结构化-08）。
 */
export async function createCapability(
  body: {
    sourceCandidateId?: string;
    capabilityId?: string;
    fromVersionId?: string;
    draftId?: string;
  },
  idempotencyKey?: string,
  opts: RequestOptions = {},
): Promise<CreateCapabilityResult> {
  return apiPost<CreateCapabilityResult>(
    '/capabilities',
    {
      // 恰好三选一：只带其中一个 source（调用方择一传），其余不出现在 body（让后端 refine 校验生效）。
      ...(body.sourceCandidateId ? { sourceCandidateId: body.sourceCandidateId } : {}),
      ...(body.capabilityId ? { capabilityId: body.capabilityId } : {}),
      ...(body.fromVersionId ? { fromVersionId: body.fromVersionId } : {}),
      ...(body.draftId ? { draftId: body.draftId } : {}),
    },
    {
      ...opts,
      scope: IdempotencyScope.CAPABILITY_CREATE,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    },
  );
}

/** 端点 B：读 manifest（软硬分层 + structure_state，续传/回看真源）。 */
export async function fetchManifest(
  versionId: string,
  opts: RequestOptions = {},
): Promise<ManifestView> {
  return apiGet<ManifestView>(manifestPath(versionId), opts);
}

/**
 * 端点 C：发起结构化 Job（软字段逐字段生成、硬字段锁定）。
 * 不传 fields = 全部 7 软字段；传子集 = 仅补这些（续传只补未生成，§4.C）。
 * 写命令必带 scope=structure.start；同 version 重复发起回放同 jobId（不重复跑/字段，验收 选择结构化-26、贯穿-27）。
 */
export async function startStructure(
  versionId: string,
  fields?: SoftFieldKey[],
  idempotencyKey?: string,
  opts: RequestOptions = {},
): Promise<StartStructureResult> {
  return apiPost<StartStructureResult>(
    startStructurePath(versionId),
    fields && fields.length > 0 ? { fields } : {},
    {
      ...opts,
      scope: IdempotencyScope.STRUCTURE_START,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    },
  );
}

/**
 * 端点 E：改软字段（手动编辑）。只允许软字段键；硬字段键由后端 422 HARD_FIELD_LOCKED 拒绝（本层不传硬字段）。
 * 写命令必带 scope=manifest.patch；返回改后全量 ManifestView（含 structureState）。
 * published 后改 → 后端 409 STATE_CONFLICT（action=change_input），上层落人话错误态引导建新版本（§4.E）。
 */
export async function patchManifest(
  versionId: string,
  body: PatchManifestBody,
  idempotencyKey?: string,
  opts: RequestOptions = {},
): Promise<ManifestView> {
  return apiPatch<ManifestView>(manifestPath(versionId), body, {
    ...opts,
    scope: IdempotencyScope.MANIFEST_PATCH,
    ...(idempotencyKey ? { idempotencyKey } : {}),
  });
}

/**
 * 端点 F：单软字段重生成（只重生成卡住/指定字段，其余不动、不丢，验收 选择结构化-17/26）。
 * 写命令必带 scope=manifest.regenerate_field；返回 jobId/field/eventsUrl，SSE 仍走端点 D（按 field 过滤帧）。
 * 累计失败 2 次落字段级错误态（§3.4，转人工 escalate）。
 */
export async function regenerateField(
  versionId: string,
  field: SoftFieldKey,
  reason: 'stuck' | 'manual',
  idempotencyKey?: string,
  opts: RequestOptions = {},
): Promise<RegenerateFieldResult> {
  return apiPost<RegenerateFieldResult>(
    regenerateFieldPath(versionId, field),
    { reason },
    {
      ...opts,
      scope: IdempotencyScope.MANIFEST_REGENERATE_FIELD,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    },
  );
}

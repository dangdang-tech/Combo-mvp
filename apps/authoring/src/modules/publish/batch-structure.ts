// 50 · B-29 扩展 · 批量「全部发布」candidate 编排单元（§5.3 一次性自动整理、批量发布）。
//   candidate 起源 item 复用 structure 域的 prepareCandidateDraft：创建/复用 draft version，
//   补齐 7 个软字段，再交回 publish job 走发布门。
import type { ErrorBody, LlmGatewayPort } from '@cb/shared';
import type { Queryable } from '../../platform/jobs/types.js';
import type { Tx, TxPool } from '../../platform/events/db-tx.js';
import {
  prepareCandidateDraft,
  type CandidateDraftPreparationDeps,
  type OnVersionPreparedInTx,
} from '../structure/index.js';

/** 编排结果：candidate 整理到可发布版本（成功）或带人话错误的失败（去补齐 / 重试）。 */
export type StructureItemOutcome =
  | { kind: 'ready'; versionId: string; capabilityId: string }
  | { kind: 'failed'; error: ErrorBody; missingFields: string[] | null; versionId?: string };

export interface BatchStructureDeps extends CandidateDraftPreparationDeps {
  db: Queryable;
  txPool: TxPool;
  gateway: LlmGatewayPort;
}

/**
 * create/reuse draft version 的【同事务】受保护回填钩子。
 * 用于把 publish item.version_id 与新建/复用版本合成一个安全保存点。
 */
export type OnVersionCreatedInTx = (
  tx: Tx,
  args: { versionId: string; capabilityId?: string },
) => Promise<boolean>;

/**
 * 把一个 candidate item 编排到「可发布版本」。
 * existingVersionId 存在时续结构化；不存在时先按 source_candidate_id 复用已有 draft，
 * 再没有才新建 draft。
 */
export async function structureCandidateItem(
  deps: BatchStructureDeps,
  args: {
    candidateId: string;
    ownerUserId: string;
    jobId: string;
    fenceToken: number;
    traceId: string;
    existingVersionId?: string;
    onVersionCreatedInTx?: OnVersionCreatedInTx;
  },
): Promise<StructureItemOutcome | { kind: 'fencedOut' }> {
  const outcome = await prepareCandidateDraft(deps, {
    candidateId: args.candidateId,
    ownerUserId: args.ownerUserId,
    jobId: args.jobId,
    fenceToken: args.fenceToken,
    traceId: args.traceId,
    ...(args.existingVersionId ? { existingVersionId: args.existingVersionId } : {}),
    ...(args.onVersionCreatedInTx
      ? { onVersionPreparedInTx: args.onVersionCreatedInTx as OnVersionPreparedInTx }
      : {}),
  });

  if (outcome.kind === 'ready') {
    return {
      kind: 'ready',
      versionId: outcome.versionId,
      capabilityId: outcome.capabilityId,
    };
  }
  return outcome;
}

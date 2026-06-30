// 50 · Alpha 人工评审裁决（B-30，50-step5-publish §2.6.1 / §1.1 / §1.3）。注入 Queryable/TxPool，无真 PG，便于 mock。
//   裁决是【单 PG 事务】（withTransaction）：approve / reject 两线，任一步失败整体回滚，同事务写 outbox（硬规则③）。
//   两条状态线分明（Codex#8，§1.3）：
//     · 被拒版本线：被裁决版自身 capability_versions.status→'review_rejected' + reject_reason/rejected_at（落被拒版自身）。
//     · 当前对外版本线：publications.current_version_id（回退到上一 published 版 / 无上一版下架），上一版【绝不标脏】。
//   approve → publications.review_status='published'（清 Alpha 徽章）；current_version_id 不变；发 capability.published（reviewStatus=published）。
//   reject  → ① 标被裁决版 review_rejected（记原因/时刻）；② 按是否有上一版分流：
//             - 有上一 published 版：上一版 superseded→published 复位、current 回退指向它、review_status='published'（不标脏）、发 capability.published（isRollback=true）。
//             - 无上一版（首发被拒）：review_status='review_rejected' 下架、发 capability.unpublished。
//             两路都把被拒原因镜像到 publications.reject_reason（创作者侧可见态，§1.3），并发 notify.review_decided。
//   防重（§4）：app 层 idempotency_keys(scope=publish.review)（中间件兜）+ 本事务守门 UPDATE
//     `review_status='alpha_pending' 才裁决`（已裁决命中 0 行 → STATE_CONFLICT，绝不重复回退/上架）+ outbox ON CONFLICT (event_id)。
import {
  ErrorCode,
  type CapabilityPublishedPayload,
  type CapabilityUnpublishedPayload,
  type NotifyReviewDecidedPayload,
} from '@cb/shared';
import type { Queryable } from '../../platform/jobs/types.js';
import type { Tx, TxPool } from '../../platform/events/db-tx.js';
import { withTransaction } from '../../platform/events/db-tx.js';
import { emitInTx, eventIdFor } from '../../platform/events/outbox.js';
import { PublishError } from './repo.js';

/** 评审结果回链（→ notify.review_decided.link，把创作者带回发布页/工作台看结果，§2.6.1）。 */
export function reviewDecidedLink(capabilityId: string): string {
  return `/creator/builder?step=publish&capabilityId=${capabilityId}`;
}

// ===========================================================================
// 读 publication（评审前置闸：被裁决版 + owner + slug + manifest_hash + 上一 published 版）
// ===========================================================================

export interface ReviewPublicationRow {
  capabilityId: string;
  /** 当前对外滚动指向版（= alpha_pending 时的被裁决版，§1.3 当前对外版本线）。 */
  currentVersionId: string;
  slug: string;
  reviewStatus: string;
  ownerUserId: string;
  /** 被裁决版的 manifest_hash（发 capability.published 用，event_id 幂等键的一半）。 */
  manifestHash: string | null;
  /**
   * 上一 published 版（此前被被裁决版顶替、status='superseded' 的那版；reject 回退用，§2.6.1）。
   * 无上一版（首发被裁决）→ null，reject 走下架分流。
   */
  prevVersionId: string | null;
  /** 上一版的 manifest_hash（回退发 capability.published(isRollback) 用）。 */
  prevManifestHash: string | null;
  /**
   * 上一版【发布时冻结】的可见性（capability_versions.visibility，r3 P1）。回退时把 mutable publications.visibility
   *   还原成它（被展示版自身值），让创作者侧读模型与投影一致——不残留被拒新版的可见性。无（旧版未冻结）→ null。
   */
  prevVisibility: string | null;
}

/**
 * 读评审所需 publication 全量（JOIN capabilities 取 owner/slug + 被裁决版 hash + 上一 superseded 版）。
 *   - 同能力体的「上一 published 版」= 当前 superseded 版中最近一条（按 updated_at 倒序，本期至多一条活跃血缘）。
 *   不存在 publication → null（评审 404）。
 */
export async function readPublicationForReview(
  db: Queryable,
  capabilityId: string,
): Promise<ReviewPublicationRow | null> {
  const res = await db.query<{
    capability_id: string;
    current_version_id: string;
    slug: string;
    review_status: string;
    owner_user_id: string;
    manifest_hash: string | null;
    prev_version_id: string | null;
    prev_manifest_hash: string | null;
    prev_visibility: string | null;
  }>(
    `SELECT p.capability_id,
            p.current_version_id,
            c.slug,
            p.review_status,
            c.creator_user_id AS owner_user_id,
            cur.manifest_hash,
            prev.id            AS prev_version_id,
            prev.manifest_hash AS prev_manifest_hash,
            prev.visibility    AS prev_visibility
       FROM publications p
       JOIN capabilities c ON c.id = p.capability_id
       JOIN capability_versions cur ON cur.id = p.current_version_id
       LEFT JOIN LATERAL (
         SELECT s.id, s.manifest_hash, s.visibility
           FROM capability_versions s
          WHERE s.capability_id = p.capability_id
            AND s.status = 'superseded'
          ORDER BY s.updated_at DESC
          LIMIT 1
       ) prev ON true
      WHERE p.capability_id = $1`,
    [capabilityId],
  );
  const r = res.rows[0];
  if (!r) return null;
  return {
    capabilityId: r.capability_id,
    currentVersionId: r.current_version_id,
    slug: r.slug,
    reviewStatus: r.review_status,
    ownerUserId: r.owner_user_id,
    manifestHash: r.manifest_hash,
    prevVersionId: r.prev_version_id,
    prevManifestHash: r.prev_manifest_hash,
    prevVisibility: r.prev_visibility,
  };
}

// ===========================================================================
// 评审裁决单事务（B-30，§2.6.1）
// ===========================================================================

export type ReviewDecision = 'approve' | 'reject';

export interface ReviewDecideArgs {
  capabilityId: string;
  decision: ReviewDecision;
  /** reject 必带（人话原因，落被拒版本行 + 镜像 publications + notify，§1.3）。approve 忽略。 */
  rejectReason?: string;
  /** 评审者（→ notify recipient 是创作者；reviewer 守卫已禁自审，此处只取被通知的 owner）。 */
  reviewedVersionId: string;
  ownerUserId: string;
  slug: string;
  manifestHash: string | null;
  prevVersionId: string | null;
  prevManifestHash: string | null;
  /** 上一版发布时冻结的可见性（回退时还原 publications.visibility 与之一致，r3 P1）。无 → null（兜 public）。 */
  prevVisibility: string | null;
  traceId: string;
}

export type ReviewOutcome =
  | { decision: 'approve'; currentVersionId: string }
  | { decision: 'reject'; rejectedVersionId: string; rolledBackToVersionId: string }
  | { decision: 'reject'; rejectedVersionId: string; delisted: true };

/**
 * 评审裁决【单 PG 事务】（§2.6.1）。txPool 注入，便于 mock 真事务序。任一步失败 → 整体 ROLLBACK。
 *   守门（防重核心，§4）：所有分流首步都以
 *     `UPDATE publications … WHERE capability_id=$ AND review_status='alpha_pending'` 守门，
 *     已裁决（published/review_rejected）命中 0 行 → 抛 STATE_CONFLICT → 整事务回滚（不重复回退/上架/发事件）。
 *   两线分明（Codex#8）：reject 只把【被裁决版自身】标 review_rejected；回退后继续对外的上一版保持 published、绝不标脏。
 */
export async function reviewDecideInTx(
  txPool: TxPool,
  args: ReviewDecideArgs,
): Promise<ReviewOutcome> {
  return withTransaction(txPool, async (tx: Tx) => {
    // 统一锁序：先锁 capability 行（顶层聚合，恒存在），再锁 publication（Codex r2 防死锁）。
    //   发布门事务（publishGateInTx）也是先 capabilities FOR UPDATE → 再 publications；两事务同向取锁，
    //   杜绝「发布锁 cap 等 pub / 评审锁 pub 等 cap」交叉等待死锁（PG 否则会 abort 其一，虽不错版但不干净）。
    const capLock = await tx.query<{ id: string }>(
      `SELECT id FROM capabilities WHERE id = $1 FOR UPDATE`,
      [args.capabilityId],
    );
    if (capLock.rows.length === 0) {
      throw new PublishError(ErrorCode.NOT_FOUND, 'capability not found');
    }

    // 事务内 FOR UPDATE 重读 publication（Codex#3）：守 review_status='alpha_pending' 的同时守
    //   current_version_id=reviewedVersionId。前置闸（routes）读到 alpha_pending 后、本事务拿锁前，若并发新版发布把
    //   current_version_id 推到了新版（review_status 又回 alpha_pending），旧裁决会裁/回退【错版本】。锁后重读对齐：
    //   current_version_id 已非被裁决版 → STATE_CONFLICT 整事务回滚（该评审 no-op，不裁错版）。
    const locked = await tx.query<{ current_version_id: string; review_status: string }>(
      `SELECT current_version_id, review_status
         FROM publications
        WHERE capability_id = $1
        FOR UPDATE`,
      [args.capabilityId],
    );
    const row = locked.rows[0];
    if (!row) {
      throw new PublishError(ErrorCode.NOT_FOUND, 'publication not found');
    }
    if (
      row.review_status !== 'alpha_pending' ||
      row.current_version_id !== args.reviewedVersionId
    ) {
      // 已裁决，或并发新版发布后被裁决版已不是当前对外版 → 该评审作废（不裁错版/不重复回退）。
      throw new PublishError(
        ErrorCode.STATE_CONFLICT,
        'publication not alpha_pending on reviewed version (concurrent republish or already decided)',
      );
    }

    if (args.decision === 'approve') {
      return approveInTx(tx, args);
    }
    return rejectInTx(tx, args);
  });
}

/**
 * approve（§2.6.1）：publications.review_status='published'（清 Alpha 徽章，发布-21）；current_version_id 不变
 *   （仍指被裁决版，其 status 保持 published）。发 capability.published（reviewStatus=published，市集刷新为正式上架）
 *   + notify.review_decided(approved)。守门：仅 alpha_pending 可裁决。
 */
async function approveInTx(tx: Tx, args: ReviewDecideArgs): Promise<ReviewOutcome> {
  // 守门 UPDATE：仅 alpha_pending + current_version_id=被裁决版 → published（Codex#3）。
  //   并发新版发布把 current 推走 → 命中 0 行 → STATE_CONFLICT 回滚（不裁错版；锁后重读已先挡，这里双保险）。
  const decided = await tx.query(
    `UPDATE publications
        SET review_status = 'published', reviewed_at = now(), updated_at = now()
      WHERE capability_id = $1
        AND review_status = 'alpha_pending'
        AND current_version_id = $2`,
    [args.capabilityId, args.reviewedVersionId],
  );
  if ((decided.rowCount ?? 0) === 0) {
    throw new PublishError(
      ErrorCode.STATE_CONFLICT,
      'publication not alpha_pending (already decided)',
    );
  }

  // 同事务 outbox：lifecycle 刷新为正式上架（reviewStatus=published）。
  const publishedPayload: CapabilityPublishedPayload = {
    capabilityId: args.capabilityId,
    versionId: args.reviewedVersionId,
    slug: args.slug, // 投影 upsert 由 trg_listing_slug 焊死 capabilities.slug、不靠 payload（Codex#16）。
    manifestHash: args.manifestHash ?? '',
    reviewStatus: 'published',
    isRollback: false,
    ownerUserId: args.ownerUserId,
    traceId: args.traceId,
    occurredAt: new Date().toISOString(),
  };
  await emitInTx(tx, {
    eventId: eventIdFor.capabilityPublished(
      args.reviewedVersionId,
      `approved:${args.manifestHash ?? ''}`,
    ),
    topic: 'capability.published',
    aggregateId: args.capabilityId,
    payload: publishedPayload,
    traceId: args.traceId,
  });

  await emitReviewDecided(tx, args, 'approved');

  return { decision: 'approve', currentVersionId: args.reviewedVersionId };
}

/**
 * reject（§2.6.1）：① 标被裁决版自身 review_rejected（记 reject_reason/rejected_at，被拒版本线）；
 *   ② 按可回退性分流当前对外版本线：
 *     - 有上一 published 版：上一版 superseded→published 复位、publications.current_version_id 回退、
 *       review_status='published'（不标脏）、capabilities.current_version_id 回退、发 capability.published(isRollback=true)。
 *     - 无上一版：review_status='review_rejected' 下架（current_version_id 仍记被裁决版供追溯）、发 capability.unpublished。
 *   两路都镜像 reject_reason 到 publications（创作者可见态）+ 发 notify.review_decided(rejected, rejectReason)。
 *   守门：所有写 publications 首步都带 `review_status='alpha_pending'`（重复裁决命中 0 行 → STATE_CONFLICT）。
 */
async function rejectInTx(tx: Tx, args: ReviewDecideArgs): Promise<ReviewOutcome> {
  const rejectReason = args.rejectReason ?? '';
  const hasPrev = args.prevVersionId !== null && args.prevVersionId !== undefined;

  if (hasPrev) {
    // —— 当前对外版本线：回退到上一 published 版 + 镜像原因 + 还原可见性（r3 P1）。
    //    visibility 还原成上一版【发布时冻结】的值（被展示版自身值，兜 public）：让 mutable publications.visibility
    //    与「被展示版」一致，不残留被拒新版的可见性（投影本就读 v.visibility，这里使读模型/创作者侧也单源一致）。
    //    守门：仅 alpha_pending + current=被裁决版（Codex#3 防裁错版）。
    const reverted = await tx.query(
      `UPDATE publications
          SET current_version_id = $2,
              review_status = 'published',
              reject_reason = $3,
              visibility = $5,
              reviewed_at = now(),
              updated_at = now()
        WHERE capability_id = $1
          AND review_status = 'alpha_pending'
          AND current_version_id = $4`,
      [
        args.capabilityId,
        args.prevVersionId,
        rejectReason,
        args.reviewedVersionId,
        args.prevVisibility ?? 'public',
      ],
    );
    if ((reverted.rowCount ?? 0) === 0) {
      throw new PublishError(
        ErrorCode.STATE_CONFLICT,
        'publication not alpha_pending (already decided)',
      );
    }
  } else {
    // —— 无上一版：下架（review_status='review_rejected'）+ 镜像原因。守门：仅 alpha_pending + current=被裁决版（Codex#3）。
    const delisted = await tx.query(
      `UPDATE publications
          SET review_status = 'review_rejected',
              reject_reason = $2,
              reviewed_at = now(),
              updated_at = now()
        WHERE capability_id = $1
          AND review_status = 'alpha_pending'
          AND current_version_id = $3`,
      [args.capabilityId, rejectReason, args.reviewedVersionId],
    );
    if ((delisted.rowCount ?? 0) === 0) {
      throw new PublishError(
        ErrorCode.STATE_CONFLICT,
        'publication not alpha_pending (already decided)',
      );
    }
  }

  // —— 被拒版本线：只标【被裁决版自身】 review_rejected + 记原因/时刻（终态、不可变，§1.1）。
  //    守门 `status='published'`（被裁决版当前为 published 态；非该态命中 0 行不波及它处）。
  await tx.query(
    `UPDATE capability_versions
        SET status = 'review_rejected', reject_reason = $2, rejected_at = now(), updated_at = now()
      WHERE id = $1 AND status = 'published'`,
    [args.reviewedVersionId, rejectReason],
  );

  if (hasPrev) {
    // 上一版由 superseded 复位为 published（它不是被拒版、绝不标脏，§1.1 铁律）。
    await tx.query(
      `UPDATE capability_versions
          SET status = 'published', updated_at = now()
        WHERE id = $1 AND capability_id = $2 AND status = 'superseded'`,
      [args.prevVersionId, args.capabilityId],
    );
    // capabilities.current_version_id 同步回退（公开主页/市集滚动指回上一版）。
    await tx.query(
      `UPDATE capabilities SET current_version_id = $2, updated_at = now() WHERE id = $1`,
      [args.capabilityId, args.prevVersionId],
    );

    // 同事务 outbox：lifecycle 回退上架上一版（isRollback=true，市集回退展示、能力不消失）。
    const rollbackPayload: CapabilityPublishedPayload = {
      capabilityId: args.capabilityId,
      versionId: args.prevVersionId as string,
      slug: args.slug,
      manifestHash: args.prevManifestHash ?? '',
      reviewStatus: 'published',
      isRollback: true,
      ownerUserId: args.ownerUserId,
      traceId: args.traceId,
      occurredAt: new Date().toISOString(),
    };
    await emitInTx(tx, {
      eventId: eventIdFor.capabilityPublished(
        args.prevVersionId as string,
        `rollback:${args.reviewedVersionId}`,
      ),
      topic: 'capability.published',
      aggregateId: args.capabilityId,
      payload: rollbackPayload,
      traceId: args.traceId,
    });

    await emitReviewDecided(tx, args, 'rejected');
    return {
      decision: 'reject',
      rejectedVersionId: args.reviewedVersionId,
      rolledBackToVersionId: args.prevVersionId as string,
    };
  }

  // 无上一版：同事务 outbox 下架（capability.unpublished → 投影软删 delisted）。
  const unpublishedPayload: CapabilityUnpublishedPayload = {
    capabilityId: args.capabilityId,
    reason: 'review_rejected_no_prev',
    ownerUserId: args.ownerUserId,
    traceId: args.traceId,
    occurredAt: new Date().toISOString(),
  };
  await emitInTx(tx, {
    eventId: eventIdFor.capabilityUnpublished(args.capabilityId, args.reviewedVersionId),
    topic: 'capability.unpublished',
    aggregateId: args.capabilityId,
    payload: unpublishedPayload,
    traceId: args.traceId,
  });

  await emitReviewDecided(tx, args, 'rejected');
  return { decision: 'reject', rejectedVersionId: args.reviewedVersionId, delisted: true };
}

/**
 * 同事务发 notify.review_decided（approve/reject 均发，创作者侧三处同步：发布页/工作台/主页，发布-31）。
 *   event_id 按被裁决版幂等（每版至多一轮裁决，重投不重复通知）。reject 携被拒原因（§1.3）。
 */
async function emitReviewDecided(
  tx: Tx,
  args: ReviewDecideArgs,
  decision: 'approved' | 'rejected',
): Promise<void> {
  const payload: NotifyReviewDecidedPayload = {
    recipientId: args.ownerUserId,
    link: reviewDecidedLink(args.capabilityId),
    capabilityId: args.capabilityId,
    versionId: args.reviewedVersionId,
    decision,
    traceId: args.traceId,
    occurredAt: new Date().toISOString(),
  };
  if (decision === 'rejected' && args.rejectReason) {
    payload.rejectReason = args.rejectReason;
  }
  await emitInTx(tx, {
    eventId: eventIdFor.reviewDecided(args.capabilityId, args.reviewedVersionId),
    topic: 'notify.review_decided',
    aggregateId: args.capabilityId,
    payload,
    traceId: args.traceId,
  });
}

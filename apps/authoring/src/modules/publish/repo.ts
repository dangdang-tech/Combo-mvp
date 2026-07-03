// 50 · 发布域仓储 + 发布门事务（B-27/B-28，50-step5-publish §1.2）。注入 Queryable/TxPool，便于 mock，无真 PG。
//   发布门是【单 PG 事务】（withTransaction），任一步失败整体回滚、不留半发布态（硬规则③）。步骤序遵 §1.2：
//     ①校验(owner+status='draft'+必填) → ②冻结 manifest_hash + 本 draft→published → ③价格固化(capability_tiers)
//     → ④旧版滚动 superseded → ⑤upsert publications(capability_id UNIQ + share_token) → ⑥capabilities.current_version_id
//     → ⑦同事务 emit outbox 两条（capability.published→MarketplaceProjection / notify.publish_completed→NotifyConsumer）。
//   防重三道闸（§4）：app 层 idempotency_keys(scope=publish.version)（中间件兜）+ publications.capability_id UNIQ
//     + 本事务②的「status='draft' 才推 published」守门（重发命中 0 行 → STATE_CONFLICT，绝不产生第二条 publication）。
//   价格冻结血缘（§1.2 决策）：价格落 capability_tiers(version_id,…)、按不可变 version_id 寻址；
//     发布后改 manifest（B-26 PATCH 强制开新版）不回写已发布版的 capability_tiers 行（验收：发布后改 manifest 不变价）。
//   复合 FK（§5 / 00 §11.E）：publications.(capability_id,current_version_id) → capability_versions(capability_id,id)，
//     DB 层杜绝跨 capability 错指；旧版滚动/回退同此血缘。
import { randomUUID } from 'node:crypto';
import {
  ErrorCode,
  type Manifest,
  type CoverInput,
  type TierInput,
  type Visibility,
  type CapabilityPublishedPayload,
  type NotifyPublishCompletedPayload,
} from '@cb/shared';
import type { Queryable } from '../../platform/jobs/types.js';
import type { Tx, TxPool } from '../../platform/events/db-tx.js';
import { withTransaction } from '../../platform/events/db-tx.js';
import { emitInTx, eventIdFor } from '../../platform/events/outbox.js';
import { manifestHash } from './manifest-hash.js';

/** 业务错误（带 code，路由层据 code → HTTP + 人话信封；§2.1 错误用例）。 */
export class PublishError extends Error {
  constructor(
    public code: (typeof ErrorCode)[keyof typeof ErrorCode],
    message: string,
  ) {
    super(message);
    this.name = 'PublishError';
  }
}

// ===========================================================================
// 版本状态机（capability_versions.status，§1.1）——给批量/评审复用的纯判定
// ===========================================================================

export type VersionStatus = 'draft' | 'published' | 'superseded' | 'review_rejected';

/** 发布事务【只接受 draft】（Codex#4-r2，§1.1 铁律）。非 draft 不进发布门。 */
export function isPublishableStatus(status: string): status is 'draft' {
  return status === 'draft';
}

/**
 * 据当前 version.status 判定调发布端点应回的错误码（§2.1 错误用例）：
 *   - draft → null（可发布）。
 *   - published → ALREADY_PUBLISHED（已发布，无需重复，action none）。
 *   - superseded / review_rejected → STATE_CONFLICT（请基于被拒/旧版编辑生成新版本再发布）。
 * 复用给批量 worker 与单发布前置闸，避免状态机判定漂移。
 */
export function publishStateError(
  status: string,
): (typeof ErrorCode)[keyof typeof ErrorCode] | null {
  if (status === 'draft') return null;
  if (status === 'published') return ErrorCode.ALREADY_PUBLISHED;
  return ErrorCode.STATE_CONFLICT; // superseded / review_rejected（终态/旧版）
}

// ===========================================================================
// 读 version（发布前置闸：owner + status + manifest + slug + 创作者账号）
// ===========================================================================

export interface PublishVersionRow {
  versionId: string;
  capabilityId: string;
  slug: string;
  status: string;
  manifest: Manifest;
  creatorUserId: string;
  /** 创作者账号（→ 市集卡 byline 署名，自动取登录账号，发布-05/26）。 */
  account: string;
  /** 能力体当前对外版（旧 active 发布版；存在则发布时滚动 superseded，§1.2 步4）。 */
  currentVersionId: string | null;
}

/** 读发布所需 version 全量（JOIN capabilities + users 取 owner/account/slug/current）。不存在 → null。 */
export async function readVersionForPublish(
  db: Queryable,
  versionId: string,
): Promise<PublishVersionRow | null> {
  const res = await db.query<{
    version_id: string;
    capability_id: string;
    slug: string;
    status: string;
    manifest: Manifest;
    creator_user_id: string;
    account: string;
    current_version_id: string | null;
  }>(
    `SELECT v.id AS version_id, v.capability_id, c.slug, v.status, v.manifest,
            c.creator_user_id, u.account, c.current_version_id
       FROM capability_versions v
       JOIN capabilities c ON c.id = v.capability_id
       JOIN users u        ON u.id = c.creator_user_id
      WHERE v.id = $1`,
    [versionId],
  );
  const r = res.rows[0];
  if (!r) return null;
  return {
    versionId: r.version_id,
    capabilityId: r.capability_id,
    slug: r.slug,
    status: r.status,
    manifest: r.manifest,
    creatorUserId: r.creator_user_id,
    account: r.account,
    currentVersionId: r.current_version_id,
  };
}

// ===========================================================================
// 读已冻结价格（市集卡预览/投影 / 已发布版价格真源，按不可变 version_id 寻址）
// ===========================================================================

/** 读某 version 的冻结档位价格（按 tier_code 序）。无 → 空数组（未发布/未设价）。 */
export async function readFrozenTiers(
  db: Queryable,
  versionId: string,
): Promise<{ tierCode: string; priceMicros: number }[]> {
  const res = await db.query<{ tier_code: string; price_micros: string | number }>(
    `SELECT tier_code, price_micros
       FROM capability_tiers
      WHERE version_id = $1
      ORDER BY tier_code ASC`,
    [versionId],
  );
  return res.rows.map((t) => ({ tierCode: t.tier_code, priceMicros: Number(t.price_micros) }));
}

// ===========================================================================
// 发布门单事务（B-27，§1.2）——给单发布 API 与批量 worker 复用的 publish-one
// ===========================================================================

export interface PublishGateArgs {
  versionId: string;
  capabilityId: string;
  /** 能力体不可变 slug（前置闸已读 capabilities.slug，写进 capability.published payload，投影解析用，Codex#1）。 */
  slug: string;
  /** 冻结进 manifest_hash 的 manifest（前置闸已读，事务内据 versionId 守门写）。 */
  manifest: Manifest;
  ownerUserId: string;
  cover: CoverInput;
  tiers: TierInput[];
  visibility: Visibility;
  /**
   * 事务外读到的旧 active 发布版（仅观测用）。真正 supersede 的旧版按事务内 FOR UPDATE【锁后】重读的
   * current_version_id 决定（Codex#4，防并发双发布留多个 published）；本字段不再直接驱动 supersede。
   */
  currentVersionId: string | null;
  traceId: string;
  /** 通知回链（→ notify.publish_completed.link，把人带回完成态）。 */
  link: string;
}

export interface PublishGateResult {
  versionId: string;
  capabilityId: string;
  shareToken: string;
  reviewStatus: 'alpha_pending';
  visibility: Visibility;
  publishedVersionId: string;
  supersededVersionId?: string;
  manifestHash: string;
}

/**
 * 发布门【单 PG 事务】（§1.2）。txPool 注入，便于 mock 真事务序。任一步失败 → 整体 ROLLBACK（不留半发布态）。
 *   ② 本 draft→published 用【守门 UPDATE】`WHERE id=$ AND status='draft'`：重发/并发命中 0 行 → 抛 STATE_CONFLICT
 *      → 整事务回滚（不写 tiers/publications/outbox、绝不产生第二条 publication，防重核心闸之一）。
 *   ⑤ publications upsert `ON CONFLICT (capability_id)`：至多一条 active 发布；share_token 仅首次生成、之后稳定
 *      （COALESCE 保留既有 token，私享链接不因改版失效，§1.2 步5）。
 *   ⑦ 两条 outbox 与业务写【同事务】emitInTx（event_id 幂等：published:{versionId}:{hash} / publish_done:{versionId}）。
 */
export async function publishGateInTx(
  txPool: TxPool,
  args: PublishGateArgs,
): Promise<PublishGateResult> {
  const mh = manifestHash(args.manifest);
  const shareToken = randomUUID();

  return withTransaction(txPool, async (tx: Tx) => {
    // ① 事务内锁 capability 行（FOR UPDATE）并据【锁后】current_version_id supersede（Codex#4）。
    //    事务外读到的 args.currentVersionId 在并发双发布下会过期：两 draft 都按同一旧版 supersede、各自置 published →
    //    留下多个 published。锁后重读保证任一时刻单一对外 published 版：先发布者先拿锁、把对方先前置 published 的版滚成 superseded；
    //    后发布者拿锁时读到的 current_version_id 已是对方刚写的版，于是 supersede 的是它（而非过期旧版），不会留双 published。
    const lock = await tx.query<{ current_version_id: string | null }>(
      `SELECT current_version_id FROM capabilities WHERE id = $1 FOR UPDATE`,
      [args.capabilityId],
    );
    if (lock.rows.length === 0) {
      // 能力体不存在（理论不可达：前置闸 JOIN 已读到）→ 回滚整事务。
      throw new PublishError(ErrorCode.NOT_FOUND, 'capability not found');
    }
    const lockedCurrentVersionId = lock.rows[0]!.current_version_id;

    // ② 冻结 manifest_hash + 封面三来源 + 可见性 + 本 draft → published（守门：仅 draft 可被推 published，§1.2 步2）。
    //    封面/可见性与 manifest_hash 同写一条 UPDATE（同事务、同版本级冻结，铁律：对外卡数据版本级冻结）：
    //      · 封面三来源（glyph/image/html_snapshot，发布-11/12/13/32）落被发布版自身；投影据 versionId 读这一版的冻结封面。
    //      · 可见性落被发布版自身（非 mutable publications）：拒绝回退到上一版时，投影读上一版自己的冻结可见性，
    //        不会把上一版按被拒新版的可见性错误隐藏/曝光（Codex#r3 P1）。
    const promoted = await tx.query(
      `UPDATE capability_versions
          SET status = 'published',
              manifest_hash = $2,
              cover_source = $3,
              cover_asset_key = $4,
              cover_snapshot_ref = $5,
              visibility = $6,
              updated_at = now()
        WHERE id = $1 AND status = 'draft'`,
      [
        args.versionId,
        mh,
        args.cover.source,
        args.cover.assetKey ?? null,
        args.cover.snapshotRef ?? null,
        args.visibility,
      ],
    );
    if ((promoted.rowCount ?? 0) === 0) {
      // 已非 draft（重发/并发/被拒/旧版）→ 回滚整事务（不产生 publication/tiers/outbox）。
      throw new PublishError(
        ErrorCode.STATE_CONFLICT,
        'version no longer draft (already published / superseded / rejected)',
      );
    }

    // ③ 价格固化（capability_tiers，按 version_id 不可变寻址；发布后改 manifest 不回写，§1.2 步3）。
    for (const tier of args.tiers) {
      await tx.query(
        `INSERT INTO capability_tiers (version_id, tier_code, price_micros, quota)
         VALUES ($1, $2, $3, NULL)
         ON CONFLICT (version_id, tier_code) DO NOTHING`,
        [args.versionId, tier.tierCode, tier.priceMicros],
      );
    }

    // ④ 旧版滚动 superseded（按【锁后】current_version_id，仅当存在旧 active 发布版且 ≠ 本版，§1.2 步4 / Codex#4）。
    //    用 lockedCurrentVersionId（事务内 FOR UPDATE 重读）而非事务外 args.currentVersionId，杜绝并发双发布留多个 published。
    let supersededVersionId: string | undefined;
    if (lockedCurrentVersionId && lockedCurrentVersionId !== args.versionId) {
      const sup = await tx.query(
        `UPDATE capability_versions
            SET status = 'superseded', updated_at = now()
          WHERE id = $1 AND capability_id = $2 AND status = 'published'`,
        [lockedCurrentVersionId, args.capabilityId],
      );
      if ((sup.rowCount ?? 0) > 0) supersededVersionId = lockedCurrentVersionId;
    }

    // ⑤ upsert publications（capability_id UNIQ 至多一条；share_token 首次生成、之后稳定 COALESCE 保留）。
    await tx.query(
      `INSERT INTO publications
         (capability_id, current_version_id, share_token, visibility, review_status, reject_reason)
       VALUES ($1, $2, $3, $4, 'alpha_pending', NULL)
       ON CONFLICT (capability_id) DO UPDATE
         SET current_version_id = EXCLUDED.current_version_id,
             share_token = COALESCE(publications.share_token, EXCLUDED.share_token),
             visibility = EXCLUDED.visibility,
             review_status = 'alpha_pending',
             reject_reason = NULL,
             updated_at = now()`,
      [args.capabilityId, args.versionId, shareToken, args.visibility],
    );
    // 回读稳定 share_token（首发 = 新生成；改版 = 既有 token）。
    const pubRead = await tx.query<{ share_token: string }>(
      `SELECT share_token FROM publications WHERE capability_id = $1`,
      [args.capabilityId],
    );
    const stableShareToken = pubRead.rows[0]?.share_token ?? shareToken;

    // ⑥ capabilities.current_version_id → 本版（公开主页/市集滚动指向，§1.2 步6）。
    await tx.query(
      `UPDATE capabilities SET current_version_id = $2, updated_at = now() WHERE id = $1`,
      [args.capabilityId, args.versionId],
    );

    // ⑦ 同事务 outbox 两条（§1.2 步7 / §5.1）。lifecycle + notify 各一，event_id 幂等。
    const publishedPayload: CapabilityPublishedPayload = {
      capabilityId: args.capabilityId,
      versionId: args.versionId,
      // 真实 slug（前置闸读 capabilities.slug，Codex#1）：CapabilityPublishedPayloadSchema.slug 是非空 SlugSchema，
      //   空串会让 MarketplaceProjection 解析失败、卡住 lifecycle cursor。listing.slug 仍由 trg_listing_slug 焊死防漂移（Codex#16），
      //   但 payload 必须带真实 slug 才能通过 schema 解析进投影。
      slug: args.slug,
      manifestHash: mh,
      reviewStatus: 'alpha_pending',
      isRollback: false, // 首发/改版发布；回退场景见 §2.6.1（评审域）。
      ownerUserId: args.ownerUserId,
      traceId: args.traceId,
      occurredAt: new Date().toISOString(),
    };
    await emitInTx(tx, {
      eventId: eventIdFor.capabilityPublished(args.versionId, mh),
      topic: 'capability.published',
      aggregateId: args.capabilityId,
      payload: publishedPayload,
      traceId: args.traceId,
    });

    const notifyPayload: NotifyPublishCompletedPayload = {
      recipientId: args.ownerUserId,
      link: args.link,
      versionId: args.versionId,
      capabilityId: args.capabilityId,
      reviewStatus: 'alpha_pending',
      traceId: args.traceId,
      occurredAt: new Date().toISOString(),
    };
    await emitInTx(tx, {
      eventId: eventIdFor.publishCompleted(args.versionId),
      topic: 'notify.publish_completed',
      aggregateId: args.versionId,
      payload: notifyPayload,
      traceId: args.traceId,
    });

    const out: PublishGateResult = {
      versionId: args.versionId,
      capabilityId: args.capabilityId,
      shareToken: stableShareToken,
      reviewStatus: 'alpha_pending',
      visibility: args.visibility,
      publishedVersionId: args.versionId,
      manifestHash: mh,
    };
    if (supersededVersionId) out.supersededVersionId = supersededVersionId;
    return out;
  });
}

export { withTransaction };
export type { TxPool };

// 50 · publish-one 编排（B-27/B-28，50-step5-publish §1.2/§2.1）。单发布 API 与批量 worker（B-29）共用入口。
//   前置闸（事务外读，§2.1 错误用例）：owner（非本人 FORBIDDEN）+ status 状态机（draft 才可发；
//     published→ALREADY_PUBLISHED；superseded/review_rejected→STATE_CONFLICT，发布事务只接受 draft，Codex#4-r2）
//     + 必填软字段/封面/价格（缺 → PUBLISH_MISSING_FIELDS，details.missingFields，发布-24）。
//   闸过 → publishGateInTx（单 PG 事务：冻结/价格固化/滚动/publications/outbox 双事件，§1.2）。
//   返回 PublishResult（含即时回投市集卡，与下一步展示一致，§2.1）；市集卡 byline 取创作者账号、价格取本次冻结价。
import {
  ErrorCode,
  type PublishResult,
  type CoverInput,
  type TierInput,
  type Visibility,
} from '@cb/shared';
import type { Queryable } from '../../platform/jobs/types.js';
import type { TxPool } from '../../platform/events/db-tx.js';
import {
  PublishError,
  readVersionForPublish,
  publishGateInTx,
  publishStateError,
} from './repo.js';
import { missingPublishFields } from './manifest-hash.js';
import { buildMarketCard, primaryPriceMicros } from './market-card.js';

/** 公开市集地址（发布-15「可访问的市集地址」）。本期固定路径形态 /a/{slug}。 */
export function marketUrlFor(slug: string): string {
  return `/a/${slug}`;
}

/** 发布完成通知回链（→ notify.publish_completed.link，把人带回完成态，B-28）。 */
export function publishDoneLink(versionId: string): string {
  return `/creator/builder?step=publish&versionId=${versionId}`;
}

export interface PublishOneArgs {
  versionId: string;
  ownerUserId: string;
  cover: CoverInput;
  tiers: TierInput[];
  visibility: Visibility;
  traceId: string;
}

/**
 * 发布单个能力（§2.1）。db 读前置闸 + txPool 跑发布门事务。
 *   - version 不存在 → PublishError(NOT_FOUND)。
 *   - 非本人 → PublishError(FORBIDDEN)。
 *   - 非 draft → publishStateError 派生（ALREADY_PUBLISHED / STATE_CONFLICT）。
 *   - 缺必填 → PublishError(PUBLISH_MISSING_FIELDS)，details.missingFields。
 *   闸过 → publishGateInTx；成功回 PublishResult（含即时市集卡）。
 *   发布失败保留已编辑内容（前端态 + 草稿，发布-19）：本函数不清空任何产物，失败只抛 PublishError。
 */
export async function publishOne(
  db: Queryable,
  txPool: TxPool,
  args: PublishOneArgs,
): Promise<PublishResult> {
  const row = await readVersionForPublish(db, args.versionId);
  if (!row) {
    throw new PublishError(ErrorCode.NOT_FOUND, 'version not found');
  }
  if (row.creatorUserId !== args.ownerUserId) {
    // owner 守门（非本人不发布；不暴露存在性细节，10-auth §6.3）。
    throw new PublishError(ErrorCode.FORBIDDEN, 'not owner');
  }
  // 状态机闸（发布事务只接受 draft，Codex#4-r2）：published/superseded/review_rejected 各自人话退路。
  const stateErr = publishStateError(row.status);
  if (stateErr) {
    throw new PublishError(stateErr, `version status ${row.status} not publishable`);
  }
  // 必填校验（name/tagline 非空 + 封面来源齐 + 价格档齐，发布-24）。
  const missing = missingPublishFields(row.manifest, { cover: args.cover, tiers: args.tiers });
  if (missing.length > 0) {
    const e = new PublishError(ErrorCode.PUBLISH_MISSING_FIELDS, 'missing required publish fields');
    (e as PublishError & { missingFields: string[] }).missingFields = missing;
    throw e;
  }

  const gate = await publishGateInTx(txPool, {
    versionId: row.versionId,
    capabilityId: row.capabilityId,
    slug: row.slug,
    manifest: row.manifest,
    ownerUserId: args.ownerUserId,
    cover: args.cover,
    tiers: args.tiers,
    visibility: args.visibility,
    currentVersionId: row.currentVersionId,
    traceId: args.traceId,
    link: publishDoneLink(row.versionId),
  });

  // 即时回投市集卡（与下一步展示一致，§2.1）：byline 取账号、价格取本次冻结主档价。
  const card = buildMarketCard({
    versionId: row.versionId,
    capabilityId: row.capabilityId,
    slug: row.slug,
    manifest: row.manifest,
    account: row.account,
    cover: args.cover,
    coverUrl: null, // 封面 url 解析（glyph 生成/对象存储签发）本期前端兜底；投影/卡渲染再解析。
    priceMicros: primaryPriceMicros(args.tiers),
  });

  const result: PublishResult = {
    versionId: gate.versionId,
    capabilityId: gate.capabilityId,
    slug: row.slug,
    shareToken: gate.shareToken,
    reviewStatus: 'alpha_pending',
    visibility: gate.visibility,
    publishedVersionId: gate.publishedVersionId,
    marketUrl: marketUrlFor(row.slug),
    card,
  };
  if (gate.supersededVersionId) result.supersededVersionId = gate.supersededVersionId;
  return result;
}

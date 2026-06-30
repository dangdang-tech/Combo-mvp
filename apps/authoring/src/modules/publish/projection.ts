// B-14/B-28 · MarketplaceProjection（消费 capability.*，lifecycle，70 §1/§3；50 §5.1/§5 投影约定）。
//   - capability.published：upsert marketplace_listings（标 alpha_pending/published、刷新 card + search_tsv，
//     ON CONFLICT (capability_id) DO UPDATE，event_id 幂等）。card 是 MarketCard 投影（封面/名称/卖点/署名/
//     价格/类型，发布-03），由被发布版 manifest（软字段：name/tagline/goal/output.type 权威）+ 创作者账号（byline）
//     + 冻结档位价（capability_tiers，按 version_id 寻址）+ 被发布版【冻结封面来源/冻结可见性】（capability_versions.
//     cover_source/visibility，发布门版本级冻结，r3 P1）在 SQL 内 INSERT…SELECT 组装；search_tsv 取 name/tagline/
//     summary(goal) 全文（市集检索，§5）；slug 由 trg_listing_slug 与 capabilities.slug 焊死、不靠 payload（Codex#16）。
//     封面/可见性读【被展示版自身】冻结值（非 mutable publications）：拒绝回退到上一版时，市集卡按上一版发布时的
//     封面与可见性展示，不被被拒新版污染（铁律：对外卡数据版本级冻结、投影读冻结值）。
//   - capability.unpublished：评审拒绝且无上一版 → status→delisted 软删（保留行便于审计，50 §5.1）。
//   - lifecycle 毒丸语义在 consumer-core 处理（卡住等人工、不进死信），本处只写投影副作用。
// 副作用必须在传入的【同一事务 tx】内完成（cursor 与处理同事务，§3.3）。
import {
  CapabilityPublishedPayloadSchema,
  CapabilityUnpublishedPayloadSchema,
  type CapabilityPublishedPayload,
} from '@cb/shared';
import type { EventProcessor, FetchedEvent } from '../../platform/events/consumer-core.js';
import type { Tx } from '../../platform/events/db-tx.js';

/**
 * output.type → 类型标签人话（与 publish/market-card.ts typeLabelOf 同口径，发布-06）。
 *   投影在 SQL 内 CASE 映射（不引 app 函数，保证 listing 读模型自包含）。
 */
const TYPE_LABEL_CASE = `CASE v.manifest -> 'output' ->> 'type'
        WHEN 'text' THEN '写作'
        WHEN 'structured' THEN '结构化文档'
        WHEN 'score' THEN '评估打分'
        WHEN 'checklist' THEN '核查清单'
        ELSE '能力' END`;

/**
 * 投影写入：发布上架（幂等 upsert listing，组装 MarketCard + search_tsv）。
 *   - card：INSERT…SELECT 在 SQL 内 jsonb_build_object 组装 MarketCard 全位置（发布-03）——
 *       名称/卖点/简介=manifest 软字段、类型=output.type 映射、署名=@account、价格=冻结主档价（首档）+ 人话展示、
 *       封面=被展示版【冻结封面来源】（发布门写进 capability_versions.cover_source，三来源 glyph/image/html_snapshot，
 *         url 由前端/后续按来源解析，本期投影只落 source；旧版 cover_source NULL → COALESCE 兜 glyph）、
 *       试用 false、装机量/评分 null（占位，发布-07）。
 *   - search_tsv：to_tsvector(name||tagline||goal)（市集检索源，§5；中文分词本期用 simple 配置兜底）。
 *   - slug 列由 trg_listing_slug 在 INSERT/UPDATE OF capability_id 时强制 = capabilities.slug（payload.slug 仅占位）。
 *   - status：读【被展示版自身】的冻结可见性 v.visibility（Codex#5/r3 P1）——
 *       visibility='unlisted'（仅私享、不进公开目录，发布-27/33）→ status='unlisted'（不列入公开 listing）；
 *       否则按 payload.reviewStatus（alpha_pending → published）。读被展示版自身而非 mutable publications.visibility：
 *       拒绝回退到上一版时，按上一版【发布时】冻结的可见性展示，不会被被拒新版的可见性错误隐藏/曝光。
 *       旧版 v.visibility NULL → COALESCE 兜 public（与历史 publications 默认一致）。
 *   - 复合 FK (capability_id, version_id) → capability_versions(capability_id, id) 由 50 域焊死。
 *   - 找不到对应版本（被引用版不存在）→ INSERT…SELECT 0 行：抛错让 lifecycle 卡住等人工（不放错状态）。
 *   - 价格 LEFT JOIN capability_tiers 取 tier_code 最小档（本期单档；未冻结价 → null + display null，发布-25）。
 */
async function projectPublished(tx: Tx, p: CapabilityPublishedPayload): Promise<void> {
  const res = await tx.query(
    `INSERT INTO marketplace_listings
       (capability_id, version_id, slug, card, search_tsv, status, updated_at)
     SELECT
       v.capability_id,
       v.id,
       $3,
       jsonb_build_object(
         'versionId',    v.id,
         'capabilityId', v.capability_id,
         'slug',         c.slug,
         -- 封面：读被展示版【发布时冻结】的 cover_source（三来源，发布门写进 capability_versions，r3 P1）；
         --   旧版未冻结(NULL) → 兜 glyph。url 本期前端/后续按 source 解析（image→对象存储签发、glyph→生成）。
         'cover',        jsonb_build_object('source', COALESCE(v.cover_source, 'glyph'), 'url', NULL),
         'typeLabel',    ${TYPE_LABEL_CASE},
         'name',         COALESCE(v.manifest ->> 'name', ''),
         'tagline',      COALESCE(v.manifest ->> 'tagline', ''),
         'summary',      COALESCE(v.manifest ->> 'goal', ''),
         'byline',       '@' || u.account,
         'trustBadge',   '源自一次真实会话',
         'price',        jsonb_build_object(
                           'priceMicros', t.price_micros,
                           'display', CASE
                             WHEN t.price_micros IS NULL THEN NULL
                             WHEN t.price_micros = 0 THEN '免费'
                             ELSE '¥' || to_char(t.price_micros / 1000000.0, 'FM999999990.00')
                           END
                         ),
         'trialEnabled', false,
         'installs',     NULL,
         'rating',       NULL
       ),
       to_tsvector('simple',
         COALESCE(v.manifest ->> 'name', '') || ' ' ||
         COALESCE(v.manifest ->> 'tagline', '') || ' ' ||
         COALESCE(v.manifest ->> 'goal', '')
       ),
       -- status：读被展示版【冻结可见性】v.visibility（Codex#5/r3 P1）——unlisted（仅私享）不进公开 listing；
       --   否则按 payload.reviewStatus。旧版未冻结(NULL) → 兜 public。读被展示版自身（非 mutable publications.visibility）：
       --   回退到上一版时按上一版发布时的可见性展示，不被被拒新版可见性污染。
       CASE WHEN COALESCE(v.visibility, 'public') = 'unlisted' THEN 'unlisted' ELSE $4 END,
       now()
     FROM capability_versions v
     JOIN capabilities c ON c.id = v.capability_id
     JOIN users u        ON u.id = c.creator_user_id
     LEFT JOIN LATERAL (
       SELECT ct.price_micros
         FROM capability_tiers ct
        WHERE ct.version_id = v.id
        ORDER BY ct.tier_code ASC
        LIMIT 1
     ) t ON true
     WHERE v.capability_id = $1 AND v.id = $2
     ON CONFLICT (capability_id)
     DO UPDATE SET version_id = EXCLUDED.version_id,
                   card = EXCLUDED.card,
                   search_tsv = EXCLUDED.search_tsv,
                   status = EXCLUDED.status,
                   updated_at = now()`,
    [p.capabilityId, p.versionId, p.slug, p.reviewStatus],
  );
  if ((res.rowCount ?? 0) === 0) {
    // 被发布版不存在（理论不可达：发布事务已写版本）。lifecycle 宁卡住等人工、不放错状态。
    throw new Error('marketplace projection: published version not found');
  }
}

/** 投影写入：下架（评审拒绝且无上一版 → status→delisted 软删，保留行便于审计，50 §5.1）。 */
async function projectUnpublished(tx: Tx, capabilityId: string): Promise<void> {
  await tx.query(
    `UPDATE marketplace_listings
     SET status = 'delisted', updated_at = now()
     WHERE capability_id = $1`,
    [capabilityId],
  );
}

/** MarketplaceProjection processor（按 topic 路由 payload schema 解析后投影）。 */
export const marketplaceProjection: EventProcessor = async (
  tx: Tx,
  evt: FetchedEvent,
): Promise<void> => {
  if (evt.topic === 'capability.published') {
    const p = CapabilityPublishedPayloadSchema.parse(evt.payload);
    await projectPublished(tx, p);
    return;
  }
  if (evt.topic === 'capability.unpublished') {
    const p = CapabilityUnpublishedPayloadSchema.parse(evt.payload);
    await projectUnpublished(tx, p.capabilityId);
    return;
  }
  // 非 capability.* 不该路由到此 processor（consumer 注册按 topic 分流）；防御性忽略。
};

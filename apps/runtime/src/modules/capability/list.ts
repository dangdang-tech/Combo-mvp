// 试用市集列表：读 marketplace_listings 的已发布卡片投影，出轻量列表项。
//   只读已发布投影（status 已发布/待审，均对应 capability_versions.status='published'，契约允许加载）。
import type { Pool } from 'pg';
import { MarketCardSchema, type MarketCard, type RuntimeCapabilityListItem } from '@cb/shared';

interface MarketListingRow {
  card: unknown;
  creator_user_id: string;
  source_snapshot_id: string | null;
  source_candidate_slug: string | null;
}

function normalizeCardName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

function dedupeKey(row: MarketListingRow, card: MarketCard): string {
  if (row.source_snapshot_id && row.source_candidate_slug) {
    return ['source', row.creator_user_id, row.source_snapshot_id, row.source_candidate_slug].join(
      ':',
    );
  }
  const normalizedName = normalizeCardName(card.name);
  if (normalizedName) {
    return ['name', row.creator_user_id, normalizedName].join(':');
  }
  return ['capability', card.capabilityId].join(':');
}

export async function listPublishedCapabilities(pool: Pool): Promise<RuntimeCapabilityListItem[]> {
  const res = await pool.query<MarketListingRow>(
    `SELECT ml.card,
            c.creator_user_id::text AS creator_user_id,
            cc.snapshot_id::text AS source_snapshot_id,
            cc.slug AS source_candidate_slug
       FROM marketplace_listings ml
       JOIN capabilities c
         ON c.id = ml.capability_id
       JOIN capability_versions v
         ON v.id = ml.version_id
        AND v.capability_id = ml.capability_id
       LEFT JOIN capability_candidates cc
         ON cc.id = v.source_candidate_id
      WHERE ml.status IN ('published', 'alpha_pending')
      ORDER BY ml.updated_at DESC
      LIMIT 200`,
  );
  const items: RuntimeCapabilityListItem[] = [];
  const seen = new Set<string>();
  for (const row of res.rows) {
    const parsed = MarketCardSchema.safeParse(row.card);
    if (!parsed.success) continue; // 防御：畸形卡跳过，不整列崩
    const c = parsed.data;
    const key = dedupeKey(row, c);
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({
      capabilityId: c.capabilityId,
      slug: c.slug,
      name: c.name,
      tagline: c.tagline,
      typeLabel: c.typeLabel,
      byline: c.byline,
    });
    if (items.length >= 100) break;
  }
  return items;
}

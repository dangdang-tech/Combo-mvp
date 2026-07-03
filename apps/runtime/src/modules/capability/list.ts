// 试用市集列表：读 marketplace_listings 的已发布卡片投影，出轻量列表项。
//   只读已发布投影（status 已发布/待审，均对应 capability_versions.status='published'，契约允许加载）。
import type { Pool } from 'pg';
import { MarketCardSchema, type RuntimeCapabilityListItem } from '@cb/shared';

export async function listPublishedCapabilities(pool: Pool): Promise<RuntimeCapabilityListItem[]> {
  const res = await pool.query<{ card: unknown }>(
    `SELECT card
       FROM marketplace_listings
      WHERE status IN ('published', 'alpha_pending')
      ORDER BY updated_at DESC
      LIMIT 100`,
  );
  const items: RuntimeCapabilityListItem[] = [];
  for (const row of res.rows) {
    const parsed = MarketCardSchema.safeParse(row.card);
    if (!parsed.success) continue; // 防御：畸形卡跳过，不整列崩
    const c = parsed.data;
    items.push({
      capabilityId: c.capabilityId,
      slug: c.slug,
      name: c.name,
      tagline: c.tagline,
      typeLabel: c.typeLabel,
      byline: c.byline,
    });
  }
  return items;
}

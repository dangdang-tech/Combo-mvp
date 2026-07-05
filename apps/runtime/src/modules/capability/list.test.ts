import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import type { MarketCard } from '@cb/shared';
import { listPublishedCapabilities } from './list.js';

function card(input: {
  capabilityId: string;
  slug: string;
  name: string;
  tagline?: string;
}): MarketCard {
  return {
    versionId: `ver-${input.capabilityId}`,
    capabilityId: input.capabilityId,
    slug: input.slug,
    cover: { source: 'glyph', url: null },
    typeLabel: '核查清单',
    name: input.name,
    tagline: input.tagline ?? '把真实工作流包装成可运行能力',
    summary: '基于真实会话整理出的能力',
    byline: '@creator',
    trustBadge: '源自一次真实会话',
    price: { priceMicros: null, display: null },
    trialEnabled: false,
    installs: null,
    rating: null,
  };
}

function row(input: {
  capabilityId: string;
  slug: string;
  name: string;
  creatorUserId?: string;
  snapshotId?: string | null;
  sourceSlug?: string | null;
}) {
  return {
    card: card({
      capabilityId: input.capabilityId,
      slug: input.slug,
      name: input.name,
    }),
    creator_user_id: input.creatorUserId ?? 'user-1',
    source_snapshot_id: Object.prototype.hasOwnProperty.call(input, 'snapshotId')
      ? input.snapshotId
      : 'snapshot-1',
    source_candidate_slug: Object.prototype.hasOwnProperty.call(input, 'sourceSlug')
      ? input.sourceSlug
      : 'goal',
  };
}

function poolReturning(rows: unknown[]): Pool {
  return {
    query: async () => ({ rows }),
  } as unknown as Pool;
}

describe('listPublishedCapabilities', () => {
  it('dedupes repeated publishes from the same creator snapshot and candidate slug', async () => {
    const items = await listPublishedCapabilities(
      poolReturning([
        row({
          capabilityId: 'cap-new',
          slug: 'cap-new',
          name: '融资材料深度审查',
          sourceSlug: 'goal',
        }),
        row({
          capabilityId: 'cap-old',
          slug: 'cap-old',
          name: '融资文档深度审查',
          sourceSlug: 'goal',
        }),
        row({
          capabilityId: 'cap-md',
          slug: 'cap-md',
          name: '文档与代码一致性核查',
          sourceSlug: 'md',
        }),
      ]),
    );

    expect(items.map((item) => item.capabilityId)).toEqual(['cap-new', 'cap-md']);
  });

  it('keeps same candidate slug from different snapshots separate', async () => {
    const items = await listPublishedCapabilities(
      poolReturning([
        row({
          capabilityId: 'cap-new',
          slug: 'cap-new',
          name: '融资材料深度审查',
          snapshotId: 'snapshot-2',
          sourceSlug: 'goal',
        }),
        row({
          capabilityId: 'cap-old',
          slug: 'cap-old',
          name: '融资文档深度审查',
          snapshotId: 'snapshot-1',
          sourceSlug: 'goal',
        }),
      ]),
    );

    expect(items.map((item) => item.capabilityId)).toEqual(['cap-new', 'cap-old']);
  });

  it('falls back to creator and normalized card name when source lineage is unavailable', async () => {
    const items = await listPublishedCapabilities(
      poolReturning([
        row({
          capabilityId: 'cap-new',
          slug: 'cap-new',
          name: ' 文档与代码一致性核查 ',
          snapshotId: null,
          sourceSlug: null,
        }),
        row({
          capabilityId: 'cap-old',
          slug: 'cap-old',
          name: '文档与代码一致性核查',
          snapshotId: null,
          sourceSlug: null,
        }),
      ]),
    );

    expect(items.map((item) => item.capabilityId)).toEqual(['cap-new']);
  });
});

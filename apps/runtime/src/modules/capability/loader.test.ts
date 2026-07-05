import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import type { Manifest } from '@cb/shared';
import { getDraftCapabilityForTrial, getPublishedCapability } from './loader.js';
import { manifestHash } from './manifest-hash.js';

const MANIFEST: Manifest = {
  id: 'cap-1',
  version: '0.1.0',
  status: 'draft',
  inputs: {
    fields: [
      { key: 'topic', label: '主题', type: 'string', required: true, derivedFrom: 'instructions' },
    ],
  },
  output: { type: 'text' },
  boundaries: { riskLevel: 'low', redLines: ['no private data'] },
  name: '短视频脚本生成器',
  tagline: '按选题生成口播脚本',
  role: '内容策略助手',
  goal: '生成可直接试用的脚本草稿',
  instructions: '根据输入生成结构化脚本。',
  skill_set: ['拆解选题', '组织口播节奏'],
  starter_prompts: ['帮我写一条新品短视频脚本'],
};

function poolReturning(rows: unknown[]): Pool {
  return {
    query: async () => ({ rows }),
  } as unknown as Pool;
}

function poolCapturing(rows: unknown[], seen: { sql?: string; params?: unknown[] }): Pool {
  return {
    query: async (sql: string, params?: unknown[]) => {
      seen.sql = sql;
      seen.params = params;
      return { rows };
    },
  } as unknown as Pool;
}

describe('getPublishedCapability', () => {
  it('loads only the public view for a published capability', async () => {
    const loaded = await getPublishedCapability(
      poolReturning([
        {
          capability_id: 'cap-1',
          slug: 'short-video-script',
          version: '0.1.0',
          status: 'published',
          manifest: MANIFEST,
          manifest_hash: manifestHash(MANIFEST),
        },
      ]),
      'short-video-script',
    );

    expect(loaded?.view.instructions).toBe(MANIFEST.instructions);
    expect(loaded?.view.manifestHash).toBe(manifestHash(MANIFEST));
    expect(loaded?.publicView.slug).toBe('short-video-script');
    expect(loaded?.publicView.status).toBe('published');
    expect('instructions' in (loaded?.publicView as object)).toBe(false);
    expect('manifestHash' in (loaded?.publicView as object)).toBe(false);
    expect(loaded?.view.inputs.fields[0]?.derivedFrom).toBe('instructions');
    expect('derivedFrom' in (loaded?.publicView.inputs.fields[0] as object)).toBe(false);
  });

  it('guards direct public loads with the same source-signature dedupe policy used by market list', async () => {
    const seen: { sql?: string; params?: unknown[] } = {};
    await getPublishedCapability(poolCapturing([], seen), 'cap-old');

    expect(seen.params).toEqual(['cap-old']);
    expect(seen.sql).toContain('AND c.status =');
    expect(seen.sql).toContain('AND NOT EXISTS');
    expect(seen.sql).toContain('c2.creator_user_id = c.creator_user_id');
    expect(seen.sql).toContain('cc2.snapshot_id = cc.snapshot_id');
    expect(seen.sql).toContain('cc2.slug = cc.slug');
    expect(seen.sql).toContain(
      'COALESCE(ml2.updated_at, v2.updated_at) > COALESCE(ml.updated_at, v.updated_at)',
    );
  });
});

describe('getDraftCapabilityForTrial', () => {
  it('loads an owned complete draft version for creator trial', async () => {
    const loaded = await getDraftCapabilityForTrial(
      poolReturning([
        {
          capability_id: 'cap-1',
          slug: 'short-video-script',
          version: '0.1.0',
          status: 'draft',
          manifest: MANIFEST,
        },
      ]),
      {
        capabilityId: 'cap-1',
        versionId: 'ver-1',
        creatorUserId: 'user-1',
      },
    );

    expect(loaded?.view.status).toBe('draft');
    expect(loaded?.view.manifestHash).toBe(manifestHash(MANIFEST));
    expect(loaded?.publicView.status).toBe('draft');
    expect(loaded?.publicView.slug).toBe('short-video-script');
  });

  it('rejects incomplete draft manifests', async () => {
    const loaded = await getDraftCapabilityForTrial(
      poolReturning([
        {
          capability_id: 'cap-1',
          slug: 'short-video-script',
          version: '0.1.0',
          status: 'draft',
          manifest: { ...MANIFEST, name: '' },
        },
      ]),
      {
        capabilityId: 'cap-1',
        versionId: 'ver-1',
        creatorUserId: 'user-1',
      },
    );

    expect(loaded).toBeNull();
  });
});

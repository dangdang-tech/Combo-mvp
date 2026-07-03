import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import type { Manifest } from '@cb/shared';
import { getDraftCapabilityForTrial } from './loader.js';
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

describe('getDraftCapabilityForTrial', () => {
  it('loads an owned complete draft version for creator trial', async () => {
    const loaded = await getDraftCapabilityForTrial(poolReturning([
      {
        capability_id: 'cap-1',
        slug: 'short-video-script',
        version: '0.1.0',
        status: 'draft',
        manifest: MANIFEST,
      },
    ]), {
      capabilityId: 'cap-1',
      versionId: 'ver-1',
      creatorUserId: 'user-1',
    });

    expect(loaded?.view.status).toBe('draft');
    expect(loaded?.view.manifestHash).toBe(manifestHash(MANIFEST));
    expect(loaded?.publicView.status).toBe('draft');
    expect(loaded?.publicView.slug).toBe('short-video-script');
  });

  it('rejects incomplete draft manifests', async () => {
    const loaded = await getDraftCapabilityForTrial(poolReturning([
      {
        capability_id: 'cap-1',
        slug: 'short-video-script',
        version: '0.1.0',
        status: 'draft',
        manifest: { ...MANIFEST, name: '' },
      },
    ]), {
      capabilityId: 'cap-1',
      versionId: 'ver-1',
      creatorUserId: 'user-1',
    });

    expect(loaded).toBeNull();
  });
});

// manifest 指纹 parity 测试：把 hash 钉死在一个 fixture 上。
//   作用：runtime 的规范化算法一旦与 authoring 发布门漂移（@cb/shared canonicalManifest 被改动），
//   PINNED 立刻对不上 → 测试转红。这是「校 hash 永远等于 authoring 冻结的 hash」的守门。
import { describe, expect, it } from 'vitest';
import { canonicalManifest, type Manifest } from '@cb/shared';
import { manifestHash, verifyManifest, verifyManifestHash } from './manifest-hash.js';

const FIXTURE: Manifest = {
  id: 'cap-fixture',
  version: '1.0.0',
  status: 'draft',
  inputs: {
    fields: [
      { key: 'topic', label: '主题', type: 'string', required: true, derivedFrom: 'instructions' },
    ],
  },
  output: { type: 'text' },
  boundaries: { riskLevel: 'low', redLines: ['no'] },
  name: 'n',
  tagline: 't',
  role: 'r',
  goal: 'g',
  instructions: 'i',
  skill_set: [],
  starter_prompts: ['p'],
};

// 由 @cb/shared canonicalManifest + sha256 计算的钉死值（也即 authoring 发布门会冻结的同一 hash）。
const PINNED = 'd83f982535dba15fbb2f9e2f6028739039f329ee416d7412b55362d963cded77';

describe('manifest-hash parity', () => {
  it('pins the hash (catches drift from authoring algorithm)', () => {
    expect(manifestHash(FIXTURE)).toBe(PINNED);
  });

  it('is key-order independent (canonicalize sorts keys)', () => {
    const reordered: Manifest = {
      starter_prompts: ['p'],
      skill_set: [],
      instructions: 'i',
      goal: 'g',
      role: 'r',
      tagline: 't',
      name: 'n',
      boundaries: { redLines: ['no'], riskLevel: 'low' },
      output: { type: 'text' },
      inputs: {
        fields: [
          {
            derivedFrom: 'instructions',
            type: 'string',
            required: true,
            label: '主题',
            key: 'topic',
          },
        ],
      },
      status: 'draft',
      version: '1.0.0',
      id: 'cap-fixture',
    };
    expect(manifestHash(reordered)).toBe(PINNED);
  });

  it('verifyManifest: true for correct hash, false for tampered manifest', () => {
    expect(verifyManifest(FIXTURE, PINNED)).toBe(true);
    const tampered: Manifest = { ...FIXTURE, instructions: 'i-EVIL' };
    expect(verifyManifest(tampered, PINNED)).toBe(false);
  });

  it('verifyManifestHash: matches the VerifyManifestHash contract signature', () => {
    expect(verifyManifestHash(canonicalManifest(FIXTURE), PINNED)).toBe(true);
    expect(verifyManifestHash(canonicalManifest(FIXTURE), 'deadbeef')).toBe(false);
  });
});

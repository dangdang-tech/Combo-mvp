// B-24 建能力体 draft 版本自检（40-step3-4-structure §4.A / §2.4）：
//   三分支恰好三选一（候选新建首版 / published 后建新版本 / 被拒重发派生）；slug 服务端生成；
//   硬字段锁定填充 + 软字段空 + structure_state 软 pending/硬 locked；semver bump minor；
//   属主/状态机门禁（NOT_FOUND/FORBIDDEN/STATE_CONFLICT）；draftId 同事务回填 + 单事务原子（反向破坏 ROLLBACK）。
import { describe, it, expect } from 'vitest';
import { HARD_FIELD_KEYS, SOFT_FIELD_KEYS, type Manifest, type StructureState } from '@cb/shared';
import {
  createCapability,
  bumpMinor,
  INITIAL_VERSION,
  CreateCapabilityError,
} from '../structure/create-capability.js';
import { StructureFakeDb, StructureFakeTxPool, type VersionRowF } from './structure-fakes.js';
import { initialManifest } from '../structure/manifest.js';

function setup(): { db: StructureFakeDb; tx: StructureFakeTxPool } {
  const db = new StructureFakeDb();
  return { db, tx: new StructureFakeTxPool(db) };
}

describe('B-24 semver bump', () => {
  it('bumpMinor: 0.1.0 → 0.2.0；坏号兜底 0.1.0', () => {
    expect(bumpMinor('0.1.0')).toBe('0.2.0');
    expect(bumpMinor('1.4.7')).toBe('1.5.0');
    expect(bumpMinor('garbage')).toBe(INITIAL_VERSION);
  });
});

describe('B-24 ① 从候选新建首版（sourceCandidateId）', () => {
  it('建 capabilities + capability_versions：首版 0.1.0、硬锁软空、structure_state 软 pending/硬 locked、血缘 source_candidate_id', async () => {
    const { db, tx } = setup();
    db.candidates.set('cand1', {
      id: 'cand1',
      owner_user_id: 'u1',
      name: 'PRD 炼金师',
      slug: 'prd-alchemist',
      status: 'ready',
    });

    const res = await createCapability(db, tx, { sourceCandidateId: 'cand1' }, { userId: 'u1' });

    expect(res.version).toBe('0.1.0');
    expect(res.slug.length).toBeGreaterThan(0);
    // 落库存在。
    const cap = db.capabilities.get(res.capabilityId)!;
    expect(cap.creator_user_id).toBe('u1');
    const v = db.versions.get(res.versionId)!;
    expect(v.status).toBe('draft');
    expect(v.source_candidate_id).toBe('cand1'); // 血缘。
    // manifest：硬字段锁定填充（id=capabilityId）、软字段空。
    const mf = res.manifest;
    expect(mf.id).toBe(res.capabilityId);
    expect(mf.status).toBe('draft');
    expect(mf.name).toBe('');
    expect(mf.skill_set).toEqual([]);
    expect(mf.boundaries.riskLevel).toBe('low');
    // structure_state：软 pending、硬 locked。
    const st = res.structureState;
    for (const f of SOFT_FIELD_KEYS) {
      expect(st.fields.find((x) => x.field === f)!.status).toBe('pending');
    }
    for (const f of HARD_FIELD_KEYS) {
      expect(st.fields.find((x) => x.field === f)!.status).toBe('locked');
    }
    expect(st.doneCount).toBe(0);
    expect(st.totalCount).toBe(7);
    expect(tx.committed.length).toBe(1);
  });

  it('candidate 非属主 / 不存在 → NOT_FOUND', async () => {
    const { db, tx } = setup();
    db.candidates.set('cand1', {
      id: 'cand1',
      owner_user_id: 'someone-else',
      name: 'x',
      slug: 'x',
      status: 'ready',
    });
    await expect(
      createCapability(db, tx, { sourceCandidateId: 'cand1' }, { userId: 'u1' }),
    ).rejects.toBeInstanceOf(CreateCapabilityError);
    await expect(
      createCapability(db, tx, { sourceCandidateId: 'nope' }, { userId: 'u1' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('draftId → 同事务回填 version_id + capability_id + current_step=structure + selection（capability_id 拒绝态闭环，P1-5）', async () => {
    const { db, tx } = setup();
    db.candidates.set('cand1', {
      id: 'cand1',
      owner_user_id: 'u1',
      name: '能力',
      slug: 'cap',
      status: 'ready',
    });
    db.drafts.set('d1', {
      id: 'd1',
      owner_user_id: 'u1',
      status: 'active',
      version_id: null,
      current_step: null,
      selection: null,
    });
    const res = await createCapability(
      db,
      tx,
      { sourceCandidateId: 'cand1', draftId: 'd1' },
      { userId: 'u1' },
    );
    const d = db.drafts.get('d1')!;
    expect(d.version_id).toBe(res.versionId);
    // 真实 capabilityId 同事务回填（drafts.id ≠ capabilities.id，续传据它读 publication 拒绝态，P1-5）。
    expect(d.capability_id).toBe(res.capabilityId);
    expect(d.current_step).toBe('structure');
    expect(d.selection).toEqual({ mode: 'single', candidateId: 'cand1' });
  });

  it('draftId 属他人（owner 守卫）→ 回滚整事务、不建能力体、不覆盖他人草稿（Codex P0-2）', async () => {
    const { db, tx } = setup();
    db.candidates.set('cand1', {
      id: 'cand1',
      owner_user_id: 'u1',
      name: '能力',
      slug: 'cap',
      status: 'ready',
    });
    // 攻击者 u1 传入他人（owner=victim）的 draftId：候选属 u1，但草稿属 victim。
    db.drafts.set('victim-draft', {
      id: 'victim-draft',
      owner_user_id: 'victim',
      status: 'active',
      version_id: 'victim-existing-version',
      current_step: 'extract',
      selection: { mode: 'single', candidateId: 'victim-cand' },
    });
    await expect(
      createCapability(
        db,
        tx,
        { sourceCandidateId: 'cand1', draftId: 'victim-draft' },
        { userId: 'u1' },
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // 他人草稿一字未改（version_id/current_step/selection 全留原值，绝不被覆盖）。
    const victim = db.drafts.get('victim-draft')!;
    expect(victim.version_id).toBe('victim-existing-version');
    expect(victim.current_step).toBe('extract');
    expect(victim.selection).toEqual({ mode: 'single', candidateId: 'victim-cand' });
    // 整事务回滚：不建能力体 / 不建版本（owner 守卫 0 行 → 抛错 → ROLLBACK）。
    expect(db.capabilities.size).toBe(0);
    expect(db.versions.size).toBe(0);
    expect(tx.rolledBack.length).toBeGreaterThanOrEqual(1);
  });
});

describe('B-24 ② published 后建新版本（capabilityId，bump minor）', () => {
  it('当前生效版 published → bump minor 建新 draft（同能力体、slug 不变、软字段空）', async () => {
    const { db, tx } = setup();
    // 能力体 + 一个 published current version 0.1.0。
    db.capabilities.set('c1', {
      id: 'c1',
      creator_user_id: 'u1',
      slug: 'my-cap',
      current_version_id: 'pubv',
      status: 'active',
    });
    const pub: VersionRowF = {
      id: 'pubv',
      capability_id: 'c1',
      version: '0.1.0',
      status: 'published',
      manifest: initialManifest('c1', '0.1.0'),
      structure_state: {},
      source_candidate_id: null,
    };
    db.versions.set('pubv', pub);

    const res = await createCapability(db, tx, { capabilityId: 'c1' }, { userId: 'u1' });
    expect(res.version).toBe('0.2.0'); // bump minor。
    expect(res.capabilityId).toBe('c1'); // 同能力体。
    expect(res.slug).toBe('my-cap'); // slug 不变。
    expect(res.manifest.name).toBe(''); // 新版本软字段空（重新结构化）。
    expect(db.versions.get(res.versionId)!.status).toBe('draft');
  });

  it('当前生效版非 published（draft）→ STATE_CONFLICT', async () => {
    const { db, tx } = setup();
    db.capabilities.set('c1', {
      id: 'c1',
      creator_user_id: 'u1',
      slug: 'my-cap',
      current_version_id: 'dv',
      status: 'active',
    });
    db.versions.set('dv', {
      id: 'dv',
      capability_id: 'c1',
      version: '0.1.0',
      status: 'draft',
      manifest: initialManifest('c1', '0.1.0'),
      structure_state: {},
      source_candidate_id: null,
    });
    await expect(
      createCapability(db, tx, { capabilityId: 'c1' }, { userId: 'u1' }),
    ).rejects.toMatchObject({ code: 'STATE_CONFLICT' });
  });

  it('能力体非属主 → NOT_FOUND', async () => {
    const { db, tx } = setup();
    db.capabilities.set('c1', {
      id: 'c1',
      creator_user_id: 'other',
      slug: 'my-cap',
      current_version_id: null,
      status: 'active',
    });
    await expect(
      createCapability(db, tx, { capabilityId: 'c1' }, { userId: 'u1' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('B-24 ③ 被拒重发派生新 draft（fromVersionId）', () => {
  it('源版 review_rejected 属本人 → 同能力体复制软字段、bump minor 建新 draft（原被拒版不动）', async () => {
    const { db, tx } = setup();
    db.capabilities.set('c1', {
      id: 'c1',
      creator_user_id: 'u1',
      slug: 'my-cap',
      current_version_id: null,
      status: 'active',
    });
    const rejManifest: Manifest = {
      ...initialManifest('c1', '0.1.0'),
      name: '被拒名称',
      tagline: '被拒卖点',
      instructions: '步骤 {{topic|主题}}',
      skill_set: ['技能1', '技能2'],
      starter_prompts: ['起手1'],
    };
    db.versions.set('rejv', {
      id: 'rejv',
      capability_id: 'c1',
      version: '0.1.0',
      status: 'review_rejected',
      manifest: rejManifest,
      structure_state: {},
      source_candidate_id: 'cand1',
    });

    const res = await createCapability(db, tx, { fromVersionId: 'rejv' }, { userId: 'u1' });
    expect(res.capabilityId).toBe('c1'); // 同能力体续命脉。
    expect(res.version).toBe('0.2.0'); // bump minor。
    expect(res.slug).toBe('my-cap');
    // 复制软字段为起点。
    expect(res.manifest.name).toBe('被拒名称');
    expect(res.manifest.skill_set).toEqual(['技能1', '技能2']);
    // instructions 复制 → inputs.schema 系统重算（derivedFrom:instructions，锁定）。
    expect(res.manifest.inputs.fields[0]!.key).toBe('topic');
    // 血缘沿用源被拒版。
    expect(db.versions.get(res.versionId)!.source_candidate_id).toBe('cand1');
    // 原被拒版不动（status 仍 review_rejected）。
    expect(db.versions.get('rejv')!.status).toBe('review_rejected');
  });

  it('源版非 review_rejected → STATE_CONFLICT', async () => {
    const { db, tx } = setup();
    db.capabilities.set('c1', {
      id: 'c1',
      creator_user_id: 'u1',
      slug: 's',
      current_version_id: null,
      status: 'active',
    });
    db.versions.set('v', {
      id: 'v',
      capability_id: 'c1',
      version: '0.1.0',
      status: 'draft',
      manifest: initialManifest('c1', '0.1.0'),
      structure_state: {},
      source_candidate_id: null,
    });
    await expect(
      createCapability(db, tx, { fromVersionId: 'v' }, { userId: 'u1' }),
    ).rejects.toMatchObject({ code: 'STATE_CONFLICT' });
  });

  it('源版非属主 → FORBIDDEN', async () => {
    const { db, tx } = setup();
    db.capabilities.set('c1', {
      id: 'c1',
      creator_user_id: 'other',
      slug: 's',
      current_version_id: null,
      status: 'active',
    });
    db.versions.set('v', {
      id: 'v',
      capability_id: 'c1',
      version: '0.1.0',
      status: 'review_rejected',
      manifest: initialManifest('c1', '0.1.0'),
      structure_state: {},
      source_candidate_id: null,
    });
    await expect(
      createCapability(db, tx, { fromVersionId: 'v' }, { userId: 'u1' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('源版不存在 → NOT_FOUND', async () => {
    const { db, tx } = setup();
    await expect(
      createCapability(db, tx, { fromVersionId: 'nope' }, { userId: 'u1' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('B-24 structure_state 一致性', () => {
  it('新建 version 的 structure_state.totalCount=7（只数软字段，硬字段 locked 不计 total）', async () => {
    const { db, tx } = setup();
    db.candidates.set('cand1', {
      id: 'cand1',
      owner_user_id: 'u1',
      name: '能力',
      slug: 'cap',
      status: 'ready',
    });
    const res = await createCapability(db, tx, { sourceCandidateId: 'cand1' }, { userId: 'u1' });
    const st: StructureState = res.structureState;
    expect(st.totalCount).toBe(7);
    expect(st.fields.length).toBe(SOFT_FIELD_KEYS.length + HARD_FIELD_KEYS.length);
  });
});

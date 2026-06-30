// 50 · 发布核心 B-27 + B-28 单测（50-step5-publish §1.1/§1.2/§2.1/§2.2）。忠实 mock，无真 PG。
//   覆盖：
//     · manifest 冻结：canonical hash 键序无关、稳定。
//     · 只接受 draft：published→ALREADY_PUBLISHED、superseded/review_rejected→STATE_CONFLICT、缺字段→PUBLISH_MISSING_FIELDS。
//     · 价格冻结：发布固化 capability_tiers；发布后改 manifest 不变价（重发同版守门 0 行，价不被回写）。
//     · 防重：重试/双标签页只一条 publication（ON CONFLICT capability_id）、ON CONFLICT DO NOTHING tiers/outbox。
//     · 同事务 outbox 双事件：capability.published(lifecycle) + notify.publish_completed(notify)、event_id 幂等。
//     · 旧版滚动 superseded + 复合 FK 参数透传。
//     · 事务原子性：中途失败整体回滚（不留半发布态）。
//     · 市集卡字段来源映射 + usage 占位。
import { describe, it, expect } from 'vitest';
import type { Manifest } from '@cb/shared';
import { CapabilityPublishedPayloadSchema } from '@cb/shared';
import { asTxPool } from '../platform/events/db-tx.js';
import {
  publishGateInTx,
  readVersionForPublish,
  publishStateError,
} from '../modules/publish/repo.js';
import { publishOne } from '../modules/publish/publish-one.js';
import { PublishError } from '../modules/publish/repo.js';
import { manifestHash, canonicalManifest, missingPublishFields } from '../modules/publish/manifest-hash.js';
import {
  buildMarketCard,
  priceDisplay,
  typeLabelOf,
  bylineOf,
  USAGE_PLACEHOLDERS,
} from '../modules/publish/market-card.js';
import { PublishFakeDb, seedUser, seedCapabilityVersion, readyManifest } from './publish-fakes.js';

const TRACE = 'trace-1';
const stdCover = { source: 'glyph' as const };
const stdTiers = [{ tierCode: 'standard', priceMicros: 9_900_000 }];

function gateArgs(
  db: PublishFakeDb,
  owner: string,
  seeded: { capabilityId: string; versionId: string },
  over?: Partial<Parameters<typeof publishGateInTx>[1]>,
) {
  const v = db.versions.get(seeded.versionId)!;
  const cap = db.capabilities.get(seeded.capabilityId)!;
  return {
    versionId: seeded.versionId,
    capabilityId: seeded.capabilityId,
    slug: cap.slug,
    manifest: v.manifest,
    ownerUserId: owner,
    cover: stdCover,
    tiers: stdTiers,
    visibility: 'public' as const,
    currentVersionId: cap.current_version_id,
    traceId: TRACE,
    link: '/x',
    ...over,
  };
}

// ===========================================================================
// manifest 冻结（§1.2 步2）
// ===========================================================================
describe('manifest hash 冻结（§1.2）', () => {
  it('canonical hash 键序无关（同内容不同键序得同 hash）', () => {
    const a = { name: 'x', tagline: 'y', goal: 'g' } as unknown as Manifest;
    const b = { goal: 'g', tagline: 'y', name: 'x' } as unknown as Manifest;
    expect(canonicalManifest(a)).toBe(canonicalManifest(b));
    expect(manifestHash(a)).toBe(manifestHash(b));
  });
  it('内容变 → hash 变（不可变寻址，改版必新 hash）', () => {
    const a = readyManifest('cap-1');
    const b = { ...a, tagline: '改了卖点' };
    expect(manifestHash(a)).not.toBe(manifestHash(b));
  });
});

// ===========================================================================
// 必填校验 + 状态机判定（§1.1/§2.1）
// ===========================================================================
describe('必填校验 missingPublishFields（发布-24）', () => {
  it('齐全（name/tagline 非空 + glyph 封面 + 价格档）→ 空', () => {
    expect(missingPublishFields(readyManifest('c'), { cover: stdCover, tiers: stdTiers })).toEqual(
      [],
    );
  });
  it('name/tagline 空 → 标缺位置', () => {
    const m = { ...readyManifest('c'), name: '', tagline: '  ' };
    expect(missingPublishFields(m, { cover: stdCover, tiers: stdTiers })).toEqual([
      'name',
      'tagline',
    ]);
  });
  it('封面 image 缺 assetKey → 标 cover；html_snapshot 缺 snapshotRef → 标 cover', () => {
    const m = readyManifest('c');
    expect(missingPublishFields(m, { cover: { source: 'image' }, tiers: stdTiers })).toContain(
      'cover',
    );
    expect(
      missingPublishFields(m, { cover: { source: 'html_snapshot' }, tiers: stdTiers }),
    ).toContain('cover');
  });
});

describe('版本状态机判定 publishStateError（§1.1，发布只接受 draft）', () => {
  it('draft → null（可发布）', () => expect(publishStateError('draft')).toBeNull());
  it('published → ALREADY_PUBLISHED', () =>
    expect(publishStateError('published')).toBe('ALREADY_PUBLISHED'));
  it('superseded → STATE_CONFLICT', () =>
    expect(publishStateError('superseded')).toBe('STATE_CONFLICT'));
  it('review_rejected → STATE_CONFLICT（终态，不就地置 published）', () =>
    expect(publishStateError('review_rejected')).toBe('STATE_CONFLICT'));
});

// ===========================================================================
// 发布门单事务（§1.2）——成功路径
// ===========================================================================
describe('publishGateInTx 成功路径（§1.2 首发）', () => {
  it('draft→published + 冻结 hash + 固化 tiers + publications + 滚动 + outbox 双事件（全在一事务内 COMMIT）', async () => {
    const db = new PublishFakeDb();
    const owner = seedUser(db, 'WAYNE');
    const seeded = seedCapabilityVersion(db, owner);

    const r = await publishGateInTx(asTxPool(db), gateArgs(db, owner, seeded));

    // 版本转 published + 冻结 manifest_hash。
    const v = db.versions.get(seeded.versionId)!;
    expect(v.status).toBe('published');
    expect(v.manifest_hash).toBe(manifestHash(v.manifest));
    expect(r.reviewStatus).toBe('alpha_pending');
    // 价格固化：capability_tiers 写入冻结价。
    expect(db.tiers).toEqual([
      { version_id: seeded.versionId, tier_code: 'standard', price_micros: 9_900_000 },
    ]);
    // publications 一条（capability_id 唯一）。
    expect(db.publications.size).toBe(1);
    const pub = db.publications.get(seeded.capabilityId)!;
    expect(pub.current_version_id).toBe(seeded.versionId);
    expect(pub.review_status).toBe('alpha_pending');
    expect(r.shareToken).toBe(pub.share_token);
    // capabilities.current_version_id 滚动指向本版。
    expect(db.capabilities.get(seeded.capabilityId)!.current_version_id).toBe(seeded.versionId);
    // outbox 同事务双事件（lifecycle + notify）。
    expect(db.outbox.map((o) => o.topic).sort()).toEqual([
      'capability.published',
      'notify.publish_completed',
    ]);
    const lifecycle = db.outbox.find((o) => o.topic === 'capability.published')!;
    expect(lifecycle.aggregate_id).toBe(seeded.capabilityId);
    expect((lifecycle.payload as { reviewStatus: string }).reviewStatus).toBe('alpha_pending');
    expect((lifecycle.payload as { isRollback: boolean }).isRollback).toBe(false);
    // capability.published payload slug 必须是真实非空 slug（Codex#1）：空串会让 MarketplaceProjection
    //   按 CapabilityPublishedPayloadSchema 解析失败、卡住 lifecycle cursor。
    const lifecyclePayload = lifecycle.payload as { slug: string };
    expect(lifecyclePayload.slug).toBe(seeded.slug);
    expect(lifecyclePayload.slug).not.toBe('');
    // projection 能据该 payload 成功解析（schema 非空 SlugSchema）。
    expect(CapabilityPublishedPayloadSchema.safeParse(lifecycle.payload).success).toBe(true);
    const notify = db.outbox.find((o) => o.topic === 'notify.publish_completed')!;
    expect(notify.aggregate_id).toBe(seeded.versionId);
    expect(notify.event_id).toBe(`publish_done:${seeded.versionId}`);
    // 事务已 COMMIT（无残留快照）。
    expect(db.queries.filter((q) => q.sql === 'COMMIT')).toHaveLength(1);
    expect(db.queries.filter((q) => q.sql === 'ROLLBACK')).toHaveLength(0);
  });

  it('改版发布：旧 active 版滚动 superseded + 复合 FK 参数 (capability_id, current_version_id) 透传', async () => {
    const db = new PublishFakeDb();
    const owner = seedUser(db);
    // 已有发布版（current）。
    const old = seedCapabilityVersion(db, owner, { status: 'published', isCurrent: true });
    // 同能力体新 draft 版（共用 capabilityId/slug）。
    const newVid = 'ver-new-1';
    db.versions.set(newVid, {
      id: newVid,
      capability_id: old.capabilityId,
      version: '0.2.0',
      status: 'draft',
      manifest: readyManifest(old.capabilityId, '0.2.0'),
      manifest_hash: null,
    });
    // 先建一条既有 publication（指向旧版，模拟旧版已发布）。
    db.publications.set(old.capabilityId, {
      capability_id: old.capabilityId,
      current_version_id: old.versionId,
      share_token: 'stable-token-123',
      visibility: 'public',
      review_status: 'published',
      reject_reason: null,
    });

    const r = await publishGateInTx(
      asTxPool(db),
      gateArgs(
        db,
        owner,
        { capabilityId: old.capabilityId, versionId: newVid },
        {
          currentVersionId: old.versionId,
          manifest: db.versions.get(newVid)!.manifest,
        },
      ),
    );

    expect(db.versions.get(old.versionId)!.status).toBe('superseded');
    expect(r.supersededVersionId).toBe(old.versionId);
    expect(db.versions.get(newVid)!.status).toBe('published');
    // 复合 FK：publications.current_version_id 指新版、capability_id 不变。
    const pub = db.publications.get(old.capabilityId)!;
    expect(pub.current_version_id).toBe(newVid);
    expect(db.publications.size).toBe(1); // 仍至多一条 active 发布
    // share_token 稳定（改版不失效，COALESCE 保留既有）。
    expect(pub.share_token).toBe('stable-token-123');
    expect(r.shareToken).toBe('stable-token-123');
  });
});

// ===========================================================================
// 并发反向破坏：发布门事务内锁 + 按【锁后】current_version_id supersede（Codex#4）
//   两 draft 并发发布：各自前置闸（事务外）读到的 currentVersionId 都过期（如都读到 null/旧版）。
//   若按事务外值 supersede，会留下多个 published。事务内 FOR UPDATE 锁 capability + 锁后重读 current → 后发布者
//   据锁后真值 supersede 先发布者刚写的版，保证任一时刻单一对外 published 版。
// ===========================================================================
describe('发布门并发：锁后 current_version_id supersede，单一 published（Codex#4）', () => {
  it('两 draft 先后发布、各带过期 currentVersionId=null → 锁后重读把先发版滚 superseded，最终仅一个 published', async () => {
    const db = new PublishFakeDb();
    const owner = seedUser(db);
    // 同能力体两 draft（共用 capabilityId/slug），current 初始为 null（都未发布）。
    const a = seedCapabilityVersion(db, owner, { version: '0.1.0' });
    const bVid = 'ver-b-1';
    db.versions.set(bVid, {
      id: bVid,
      capability_id: a.capabilityId,
      version: '0.2.0',
      status: 'draft',
      manifest: readyManifest(a.capabilityId, '0.2.0'),
      manifest_hash: null,
    });

    // 先发布 A：current 为 null（首发，无 supersede）。
    await publishGateInTx(asTxPool(db), gateArgs(db, owner, a, { currentVersionId: null }));
    expect(db.versions.get(a.versionId)!.status).toBe('published');
    expect(db.capabilities.get(a.capabilityId)!.current_version_id).toBe(a.versionId);

    // 后发布 B：故意传【过期】currentVersionId=null（模拟 B 的前置闸在 A 发布前读到的旧值）。
    //   旧实现会按 null 跳过 supersede → A、B 双 published（缺陷）。
    //   修复后：事务内 FOR UPDATE 重读 current=A → supersede A，仅 B 对外 published。
    const rb = await publishGateInTx(
      asTxPool(db),
      gateArgs(
        db,
        owner,
        { capabilityId: a.capabilityId, versionId: bVid },
        { currentVersionId: null, manifest: db.versions.get(bVid)!.manifest },
      ),
    );

    // 任一时刻单一对外 published 版：A 被滚 superseded、B published。
    expect(db.versions.get(a.versionId)!.status).toBe('superseded');
    expect(rb.supersededVersionId).toBe(a.versionId);
    expect(db.versions.get(bVid)!.status).toBe('published');
    expect(db.capabilities.get(a.capabilityId)!.current_version_id).toBe(bVid);
    // 仍至多一条 publication，指向 B。
    expect(db.publications.size).toBe(1);
    expect(db.publications.get(a.capabilityId)!.current_version_id).toBe(bVid);
    // 同能力体 published 版恰好一个（不留多个 published）。
    const published = [...db.versions.values()].filter(
      (v) => v.capability_id === a.capabilityId && v.status === 'published',
    );
    expect(published).toHaveLength(1);
    expect(published[0]!.id).toBe(bVid);
  });
});

// ===========================================================================
// 防重（§1.2 步2 守门 + ON CONFLICT，§4）
// ===========================================================================
describe('防重：重试/双标签页只一条 publication（§4 / 发布-20）', () => {
  it('同 draft 二次进发布门 → 第二次 status 已 published 守门 0 行 → STATE_CONFLICT，仍一条 publication', async () => {
    const db = new PublishFakeDb();
    const owner = seedUser(db);
    const seeded = seedCapabilityVersion(db, owner);

    await publishGateInTx(asTxPool(db), gateArgs(db, owner, seeded));
    expect(db.publications.size).toBe(1);
    const tiersAfterFirst = db.tiers.map((t) => ({ ...t }));

    // 第二次（双标签页/重试，幂等中间件未拦的极端窗口）：版本已 published → 守门 0 行 → 回滚。
    await expect(publishGateInTx(asTxPool(db), gateArgs(db, owner, seeded))).rejects.toMatchObject({
      code: 'STATE_CONFLICT',
    });
    // 仍只一条 publication、无第二条 outbox、价格未被回写。
    expect(db.publications.size).toBe(1);
    expect(db.outbox.filter((o) => o.topic === 'capability.published')).toHaveLength(1);
    expect(db.tiers).toEqual(tiersAfterFirst);
    // 第二次整体回滚（ROLLBACK 调用）。
    expect(db.queries.filter((q) => q.sql === 'ROLLBACK').length).toBeGreaterThanOrEqual(1);
  });
});

// ===========================================================================
// 封面 / 可见性版本级冻结（r3 P1）：发布门把三来源封面 + 可见性同事务冻结进被发布版自身
// ===========================================================================
describe('封面/可见性版本级冻结（r3 P1）', () => {
  it('封面三来源（image/html_snapshot/glyph）随版本冻结到 capability_versions 自身（同事务 ②）', async () => {
    const db = new PublishFakeDb();
    const owner = seedUser(db);

    const img = seedCapabilityVersion(db, owner, { version: '0.1.0' });
    await publishGateInTx(
      asTxPool(db),
      gateArgs(db, owner, img, { cover: { source: 'image', assetKey: 'asset-K' } }),
    );
    const vImg = db.versions.get(img.versionId)!;
    expect(vImg.cover_source).toBe('image');
    expect(vImg.cover_asset_key).toBe('asset-K');
    expect(vImg.cover_snapshot_ref).toBeNull();

    const snap = seedCapabilityVersion(db, owner, { version: '0.1.0' });
    await publishGateInTx(
      asTxPool(db),
      gateArgs(db, owner, snap, { cover: { source: 'html_snapshot', snapshotRef: 'snap-R' } }),
    );
    const vSnap = db.versions.get(snap.versionId)!;
    expect(vSnap.cover_source).toBe('html_snapshot');
    expect(vSnap.cover_snapshot_ref).toBe('snap-R');
    expect(vSnap.cover_asset_key).toBeNull();

    const gly = seedCapabilityVersion(db, owner, { version: '0.1.0' });
    await publishGateInTx(asTxPool(db), gateArgs(db, owner, gly, { cover: { source: 'glyph' } }));
    expect(db.versions.get(gly.versionId)!.cover_source).toBe('glyph');
  });

  it('可见性随版本冻结到被发布版自身（unlisted）；冻结后改请求不影响已发布版的冻结值', async () => {
    const db = new PublishFakeDb();
    const owner = seedUser(db);
    const seeded = seedCapabilityVersion(db, owner);
    await publishGateInTx(asTxPool(db), gateArgs(db, owner, seeded, { visibility: 'unlisted' }));
    // 冻结落被发布版自身（投影/回退据此读被展示版冻结可见性，非 mutable publications）。
    expect(db.versions.get(seeded.versionId)!.visibility).toBe('unlisted');
    // mutable publications.visibility 同步当次值（首发与冻结一致）。
    expect(db.publications.get(seeded.capabilityId)!.visibility).toBe('unlisted');
  });

  it('两版各冻各自可见性：旧版 public、新版 unlisted，互不污染（版本级冻结而非能力级）', async () => {
    const db = new PublishFakeDb();
    const owner = seedUser(db);
    const a = seedCapabilityVersion(db, owner, { version: '0.1.0' });
    await publishGateInTx(asTxPool(db), gateArgs(db, owner, a, { visibility: 'public' }));

    const bVid = 'ver-vis-b';
    db.versions.set(bVid, {
      id: bVid,
      capability_id: a.capabilityId,
      version: '0.2.0',
      status: 'draft',
      manifest: readyManifest(a.capabilityId, '0.2.0'),
      manifest_hash: null,
    });
    await publishGateInTx(
      asTxPool(db),
      gateArgs(
        db,
        owner,
        { capabilityId: a.capabilityId, versionId: bVid },
        {
          currentVersionId: a.versionId,
          manifest: db.versions.get(bVid)!.manifest,
          visibility: 'unlisted',
        },
      ),
    );
    // 各版冻各自值：旧版（被滚 superseded）仍记 public，新版记 unlisted。
    expect(db.versions.get(a.versionId)!.visibility).toBe('public');
    expect(db.versions.get(bVid)!.visibility).toBe('unlisted');
  });
});

// ===========================================================================
// 价格冻结血缘（§1.2 决策）：发布后改 manifest 不影响已发布价
// ===========================================================================
describe('价格冻结：发布后改 manifest 不影响已发布版价格（发布-28）', () => {
  it('发布固化 9.9 元；之后改 manifest（库内行变）不回写 capability_tiers', async () => {
    const db = new PublishFakeDb();
    const owner = seedUser(db);
    const seeded = seedCapabilityVersion(db, owner);
    await publishGateInTx(asTxPool(db), gateArgs(db, owner, seeded));
    const frozen = db.tiers.find((t) => t.version_id === seeded.versionId)!.price_micros;
    expect(frozen).toBe(9_900_000);

    // 模拟「发布后改 manifest」（B-26 PATCH 强制开新版；这里直接改库内行验价不动）。
    db.versions.get(seeded.versionId)!.manifest = {
      ...db.versions.get(seeded.versionId)!.manifest,
      tagline: '改后的卖点',
    };
    // capability_tiers 行未被任何 manifest 编辑触碰：价仍 9.9 元（按 version_id 不可变寻址）。
    expect(db.tiers.find((t) => t.version_id === seeded.versionId)!.price_micros).toBe(9_900_000);
  });
});

// ===========================================================================
// 事务原子性（§1.2 硬规则③：任一步失败整体回滚，不留半发布态）
// ===========================================================================
describe('发布门原子性（中途失败整体回滚，§1.2）', () => {
  it('outbox 写入前注入失败 → 整事务回滚：版本仍 draft、无 publication、无 tiers、无 outbox', async () => {
    const db = new PublishFakeDb();
    const owner = seedUser(db);
    const seeded = seedCapabilityVersion(db, owner);
    // 第 5 条写后抛（②promote ③tiers ④(skip,无旧版) ⑤publications ⑥capabilities → 第5条 capabilities 写后）。
    db.throwAfterWrites = 5;

    await expect(publishGateInTx(asTxPool(db), gateArgs(db, owner, seeded))).rejects.toThrow();

    // 全部回滚：版本仍 draft、无 publication、无 tiers、无 outbox。
    expect(db.versions.get(seeded.versionId)!.status).toBe('draft');
    expect(db.versions.get(seeded.versionId)!.manifest_hash).toBeNull();
    expect(db.publications.size).toBe(0);
    expect(db.tiers).toHaveLength(0);
    expect(db.outbox).toHaveLength(0);
    expect(db.queries.filter((q) => q.sql === 'ROLLBACK')).toHaveLength(1);
  });
});

// ===========================================================================
// publishOne 编排（前置闸 → 发布门 → 结果，§2.1）
// ===========================================================================
describe('publishOne 前置闸（§2.1 错误用例）', () => {
  it('version 不存在 → NOT_FOUND', async () => {
    const db = new PublishFakeDb();
    await expect(
      publishOne(db, asTxPool(db), {
        versionId: 'nope',
        ownerUserId: 'u1',
        cover: stdCover,
        tiers: stdTiers,
        visibility: 'public',
        traceId: TRACE,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('非本人 → FORBIDDEN', async () => {
    const db = new PublishFakeDb();
    const owner = seedUser(db);
    const seeded = seedCapabilityVersion(db, owner);
    await expect(
      publishOne(db, asTxPool(db), {
        versionId: seeded.versionId,
        ownerUserId: 'someone-else',
        cover: stdCover,
        tiers: stdTiers,
        visibility: 'public',
        traceId: TRACE,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.publications.size).toBe(0); // 闸未过、未进事务
  });

  it('非 draft（review_rejected）→ STATE_CONFLICT，不进发布门（终态不就地置 published）', async () => {
    const db = new PublishFakeDb();
    const owner = seedUser(db);
    const seeded = seedCapabilityVersion(db, owner, { status: 'review_rejected' });
    await expect(
      publishOne(db, asTxPool(db), {
        versionId: seeded.versionId,
        ownerUserId: owner,
        cover: stdCover,
        tiers: stdTiers,
        visibility: 'public',
        traceId: TRACE,
      }),
    ).rejects.toMatchObject({ code: 'STATE_CONFLICT' });
    expect(db.versions.get(seeded.versionId)!.status).toBe('review_rejected'); // 不动被拒版
  });

  it('已 published → ALREADY_PUBLISHED', async () => {
    const db = new PublishFakeDb();
    const owner = seedUser(db);
    const seeded = seedCapabilityVersion(db, owner, { status: 'published' });
    await expect(
      publishOne(db, asTxPool(db), {
        versionId: seeded.versionId,
        ownerUserId: owner,
        cover: stdCover,
        tiers: stdTiers,
        visibility: 'public',
        traceId: TRACE,
      }),
    ).rejects.toMatchObject({ code: 'ALREADY_PUBLISHED' });
  });

  it('缺必填（name 空）→ PUBLISH_MISSING_FIELDS + missingFields', async () => {
    const db = new PublishFakeDb();
    const owner = seedUser(db);
    const m = { ...readyManifest('c'), name: '' };
    const seeded = seedCapabilityVersion(db, owner, { manifest: m });
    try {
      await publishOne(db, asTxPool(db), {
        versionId: seeded.versionId,
        ownerUserId: owner,
        cover: stdCover,
        tiers: stdTiers,
        visibility: 'public',
        traceId: TRACE,
      });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(PublishError);
      expect((e as PublishError).code).toBe('PUBLISH_MISSING_FIELDS');
      expect((e as PublishError & { missingFields: string[] }).missingFields).toContain('name');
    }
    expect(db.publications.size).toBe(0); // 闸未过
  });

  it('成功 → PublishResult 含即时市集卡 + marketUrl /a/{slug} + 冻结主档价', async () => {
    const db = new PublishFakeDb();
    const owner = seedUser(db, 'WAYNE');
    const seeded = seedCapabilityVersion(db, owner);
    const r = await publishOne(db, asTxPool(db), {
      versionId: seeded.versionId,
      ownerUserId: owner,
      cover: stdCover,
      tiers: stdTiers,
      visibility: 'public',
      traceId: TRACE,
    });
    expect(r.marketUrl).toBe(`/a/${seeded.slug}`);
    expect(r.reviewStatus).toBe('alpha_pending');
    expect(r.card.byline).toBe('@WAYNE');
    expect(r.card.price.priceMicros).toBe(9_900_000);
    expect(r.card.price.display).toBe('¥9.90');
    expect(r.card.installs).toBeNull();
    expect(r.card.rating).toBeNull();
    expect(r.card.trialEnabled).toBe(false);
  });
});

// ===========================================================================
// 市集卡字段来源映射 + usage 占位（§2.2 / 发布-03/06/07）
// ===========================================================================
describe('MarketCard 字段来源映射（发布-03/06）', () => {
  it('名称/卖点/简介←软字段；类型←output.type；署名←账号；试用 false；装机量/评分 null 占位', () => {
    const m = readyManifest('cap-1');
    const card = buildMarketCard({
      versionId: 'v1',
      capabilityId: 'cap-1',
      slug: 'my-cap',
      manifest: m,
      account: 'WAYNE',
      cover: { source: 'glyph' },
      coverUrl: null,
      priceMicros: 9_900_000,
    });
    expect(card.name).toBe(m.name);
    expect(card.tagline).toBe(m.tagline);
    expect(card.summary).toBe(m.goal); // 简介 ← goal 软字段
    expect(card.typeLabel).toBe(typeLabelOf(m.output.type));
    expect(card.byline).toBe(bylineOf('WAYNE'));
    expect(card.trustBadge).toBe('源自一次真实会话');
    expect(card.trialEnabled).toBe(false);
    expect(card.installs).toBeNull();
    expect(card.rating).toBeNull();
    expect(card.cover).toEqual({ source: 'glyph', url: null });
  });

  it('价格未设 → priceMicros null + display null（待填提示，发布-25）', () => {
    const card = buildMarketCard({
      versionId: 'v1',
      capabilityId: 'cap-1',
      slug: 'my-cap',
      manifest: readyManifest('cap-1'),
      account: 'WAYNE',
      priceMicros: null,
    });
    expect(card.price).toEqual({ priceMicros: null, display: null });
  });

  it('priceDisplay：0→免费、9.9 元、null→null', () => {
    expect(priceDisplay(0)).toBe('免费');
    expect(priceDisplay(9_900_000)).toBe('¥9.90');
    expect(priceDisplay(null)).toBeNull();
  });

  // 单位/币种约定锁定（micros = 微元，1 元 = 1_000_000 micros，¥=CNY；非 micro-USD/$，
  //   micro-USD 仅用于 infra/llm 成本审计，与定价域无关）。priceMicros 经 toFixed(2) 取两位小数，
  //   属正常四舍五入而非币种/换算 bug。E2E 标的 999000 = 0.999 元 → toFixed(2) 进位 ¥1.00（预期、正确）。
  it('priceDisplay 单位/币种约定锁定：micros=微元、¥=CNY、toFixed(2) 正常进位（999000→¥1.00）', () => {
    // ¥ 符号（CNY），不是 $（micro-USD 是另一个域，不混用）。
    expect(priceDisplay(1_000_000)).toBe('¥1.00'); // 1 元
    expect(priceDisplay(990_000)).toBe('¥0.99'); // 0.99 元（分级精度）
    expect(priceDisplay(99_000)).toBe('¥0.10'); // 0.099 元 → 进位 0.10
    // 关键锁定：E2E 抓到的 999000（= 0.999 元）经 toFixed(2) 正常进位为 ¥1.00（非换算/币种 bug）。
    expect(priceDisplay(999_000)).toBe('¥1.00');
    // 若把 micros 误当 micro-USD 显示 $ 或除以 1e4（误读为「分」）会立刻偏离这些断言。
    expect(priceDisplay(999_000)?.startsWith('¥')).toBe(true);
  });

  it('usage 占位文案存在（meta.placeholders，发布-07）', () => {
    expect(USAGE_PLACEHOLDERS.installs).toMatch(/上线后/);
    expect(USAGE_PLACEHOLDERS.rating).toMatch(/上线后/);
  });
});

// ===========================================================================
// readVersionForPublish（前置读形态）
// ===========================================================================
describe('readVersionForPublish', () => {
  it('读 owner/account/slug/status/current（JOIN capabilities + users）', async () => {
    const db = new PublishFakeDb();
    const owner = seedUser(db, 'WAYNE');
    const seeded = seedCapabilityVersion(db, owner, { isCurrent: true });
    const row = await readVersionForPublish(db, seeded.versionId);
    expect(row).toMatchObject({
      versionId: seeded.versionId,
      capabilityId: seeded.capabilityId,
      slug: seeded.slug,
      status: 'draft',
      creatorUserId: owner,
      account: 'WAYNE',
      currentVersionId: seeded.versionId,
    });
  });
  it('不存在 → null', async () => {
    const db = new PublishFakeDb();
    expect(await readVersionForPublish(db, 'nope')).toBeNull();
  });
});

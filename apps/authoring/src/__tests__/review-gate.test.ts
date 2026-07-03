// 50 · 评审裁决单事务自检（B-30，50-step5-publish §2.6.1 / §1.1 / §1.3）。忠实假 PG（BEGIN/COMMIT/ROLLBACK 记账）。
//   重点（契约）：
//     · approve → publications.review_status='published'（清 Alpha 徽章）；current 不变；发 capability.published(reviewStatus=published)。
//     · reject 有上一版 → 被裁决版自身 review_rejected（记原因/时刻）；上一版 superseded→published 复位（不标脏）；
//       current 回退、review_status='published'；发 capability.published(isRollback=true)。
//     · reject 无上一版 → 被裁决版 review_rejected；review_status='review_rejected' 下架；发 capability.unpublished。
//     · 两路镜像 reject_reason 到 publications（创作者可见态）+ 发 notify.review_decided（同事务）。
//     · 已裁决（非 alpha_pending）→ STATE_CONFLICT（守门 0 行回滚，不重复回退/上架/发事件）。
//     · 事务中途失败 → 整体回滚（不留半裁决态）。
import { describe, it, expect } from 'vitest';
import { ErrorCode } from '@cb/shared';
import { asTxPool } from '../platform/events/db-tx.js';
import { reviewDecideInTx, readPublicationForReview } from '../modules/publish/review-repo.js';
import { PublishError } from '../modules/publish/repo.js';
import { PublishFakeDb, seedUser, seedCapabilityVersion, type PubRow } from './publish-fakes.js';

/** 播种一条 alpha_pending 发布（当前对外版 = 被裁决版），可选一条上一 published 版（superseded）。 */
function seedPendingPublication(
  db: PublishFakeDb,
  owner: string,
  opts?: { withPrev?: boolean },
): { capabilityId: string; reviewedVersionId: string; prevVersionId?: string } {
  // 被裁决版（当前对外、published 态、review_status=alpha_pending）。
  const cur = seedCapabilityVersion(db, owner, { status: 'published', isCurrent: true });
  let prevVersionId: string | undefined;
  if (opts?.withPrev) {
    // 上一版同能力体、superseded（此前被被裁决版顶替）。
    const prevId = `ver-prev-${cur.capabilityId}`;
    db.versions.set(prevId, {
      id: prevId,
      capability_id: cur.capabilityId,
      version: '0.0.9',
      status: 'superseded',
      manifest: db.versions.get(cur.versionId)!.manifest,
      manifest_hash: 'prevhash',
      updated_at: 1,
    });
    // 被裁决版 updated_at 更晚（取最近 superseded 不会取错）。
    db.versions.get(cur.versionId)!.manifest_hash = 'curhash';
    db.versions.get(cur.versionId)!.updated_at = 2;
    prevVersionId = prevId;
  } else {
    db.versions.get(cur.versionId)!.manifest_hash = 'curhash';
  }
  const pub: PubRow = {
    capability_id: cur.capabilityId,
    current_version_id: cur.versionId,
    share_token: `tok-${cur.capabilityId}`,
    visibility: 'public',
    review_status: 'alpha_pending',
    reject_reason: null,
    published_at: '2026-06-15T00:00:00.000Z',
  };
  db.publications.set(cur.capabilityId, pub);
  return { capabilityId: cur.capabilityId, reviewedVersionId: cur.versionId, prevVersionId };
}

async function runReview(
  db: PublishFakeDb,
  capabilityId: string,
  decision: 'approve' | 'reject',
  rejectReason?: string,
) {
  const pub = await readPublicationForReview(db, capabilityId);
  if (!pub) throw new Error('no publication');
  return reviewDecideInTx(asTxPool(db), {
    capabilityId: pub.capabilityId,
    decision,
    ...(decision === 'reject' ? { rejectReason: rejectReason ?? '原因' } : {}),
    reviewedVersionId: pub.currentVersionId,
    ownerUserId: pub.ownerUserId,
    slug: pub.slug,
    manifestHash: pub.manifestHash,
    prevVersionId: pub.prevVersionId,
    prevManifestHash: pub.prevManifestHash,
    prevVisibility: pub.prevVisibility,
    traceId: 'trace-rev',
  });
}

describe('reviewDecideInTx · approve (§2.6.1)', () => {
  it('通过 → publications.review_status=published（清 Alpha 徽章）；current 不变；版本仍 published', async () => {
    const db = new PublishFakeDb();
    const owner = seedUser(db);
    const { capabilityId, reviewedVersionId } = seedPendingPublication(db, owner);
    const outcome = await runReview(db, capabilityId, 'approve');
    expect(outcome).toEqual({ decision: 'approve', currentVersionId: reviewedVersionId });
    const pub = db.publications.get(capabilityId)!;
    expect(pub.review_status).toBe('published');
    expect(pub.current_version_id).toBe(reviewedVersionId);
    expect(db.versions.get(reviewedVersionId)!.status).toBe('published'); // 被裁决版仍 published
  });

  it('通过 → 同事务发 capability.published(reviewStatus=published) + notify.review_decided(approved)', async () => {
    const db = new PublishFakeDb();
    const owner = seedUser(db);
    const { capabilityId, reviewedVersionId } = seedPendingPublication(db, owner);
    await runReview(db, capabilityId, 'approve');
    const lifecycle = db.outbox.find((o) => o.topic === 'capability.published')!;
    expect(lifecycle).toBeTruthy();
    expect((lifecycle.payload as { reviewStatus: string }).reviewStatus).toBe('published');
    expect((lifecycle.payload as { isRollback: boolean }).isRollback).toBe(false);
    expect((lifecycle.payload as { versionId: string }).versionId).toBe(reviewedVersionId);
    const notify = db.outbox.find((o) => o.topic === 'notify.review_decided')!;
    expect(notify).toBeTruthy();
    expect((notify.payload as { decision: string }).decision).toBe('approved');
    expect((notify.payload as { recipientId: string }).recipientId).toBe(owner);
  });
});

describe('reviewDecideInTx · reject 有上一版（回退，§2.6.1）', () => {
  it('被裁决版自身→review_rejected（记原因/时刻）；上一版 superseded→published 复位（不标脏）', async () => {
    const db = new PublishFakeDb();
    const owner = seedUser(db);
    const { capabilityId, reviewedVersionId, prevVersionId } = seedPendingPublication(db, owner, {
      withPrev: true,
    });
    const outcome = await runReview(db, capabilityId, 'reject', '描述与能力不符');
    expect(outcome).toEqual({
      decision: 'reject',
      rejectedVersionId: reviewedVersionId,
      rolledBackToVersionId: prevVersionId,
    });
    // 被拒版本线：只标被裁决版自身。
    const rejected = db.versions.get(reviewedVersionId)!;
    expect(rejected.status).toBe('review_rejected');
    expect(rejected.reject_reason).toBe('描述与能力不符');
    expect(rejected.rejected_at).toBeTruthy();
    // 上一版复位 published（绝不标脏，§1.1 铁律）。
    expect(db.versions.get(prevVersionId!)!.status).toBe('published');
    expect(db.versions.get(prevVersionId!)!.reject_reason ?? null).toBeNull();
  });

  it('当前对外版本线：current 回退指上一版 + review_status=published + reject_reason 镜像', async () => {
    const db = new PublishFakeDb();
    const owner = seedUser(db);
    const { capabilityId, prevVersionId } = seedPendingPublication(db, owner, { withPrev: true });
    await runReview(db, capabilityId, 'reject', '描述与能力不符');
    const pub = db.publications.get(capabilityId)!;
    expect(pub.current_version_id).toBe(prevVersionId);
    expect(pub.review_status).toBe('published'); // 对外是正常上架的旧版，不标脏
    expect(pub.reject_reason).toBe('描述与能力不符'); // 创作者侧可见镜像
    expect(db.capabilities.get(capabilityId)!.current_version_id).toBe(prevVersionId); // 主页/市集回退
  });

  it('回退还原 publications.visibility 为上一版【发布时冻结】值（被展示版自身值，r3 P1）', async () => {
    // 上一版发布时冻结 unlisted；被拒新版当前是 public（mutable publications）。回退后 publications.visibility
    //   还原成上一版冻结的 unlisted——与「被展示版」一致，不残留被拒新版的可见性（投影本就读 v.visibility）。
    const db = new PublishFakeDb();
    const owner = seedUser(db);
    const { capabilityId, prevVersionId } = seedPendingPublication(db, owner, { withPrev: true });
    db.versions.get(prevVersionId!)!.visibility = 'unlisted'; // 上一版发布时冻结 unlisted
    db.publications.get(capabilityId)!.visibility = 'public'; // 被拒新版当前 public
    await runReview(db, capabilityId, 'reject', '描述与能力不符');
    const pub = db.publications.get(capabilityId)!;
    expect(pub.current_version_id).toBe(prevVersionId);
    expect(pub.visibility).toBe('unlisted'); // 还原成被展示（上一）版冻结值，不残留被拒新版的 public
  });

  it('上一版无冻结可见性（旧版 NULL）→ 回退兜底 public（与历史默认一致）', async () => {
    const db = new PublishFakeDb();
    const owner = seedUser(db);
    const { capabilityId, prevVersionId } = seedPendingPublication(db, owner, { withPrev: true });
    // 上一版未冻结 visibility（旧版，迁移前发布）；被拒新版当前 unlisted。
    db.versions.get(prevVersionId!)!.visibility = null;
    db.publications.get(capabilityId)!.visibility = 'unlisted';
    await runReview(db, capabilityId, 'reject', 'x');
    expect(db.publications.get(capabilityId)!.visibility).toBe('public'); // 兜 public
  });

  it('同事务发 capability.published(isRollback=true) 指回退版 + notify.review_decided(rejected,原因)', async () => {
    const db = new PublishFakeDb();
    const owner = seedUser(db);
    const { capabilityId, prevVersionId } = seedPendingPublication(db, owner, { withPrev: true });
    await runReview(db, capabilityId, 'reject', '描述与能力不符');
    const lifecycle = db.outbox.find((o) => o.topic === 'capability.published')!;
    expect((lifecycle.payload as { isRollback: boolean }).isRollback).toBe(true);
    expect((lifecycle.payload as { versionId: string }).versionId).toBe(prevVersionId);
    expect((lifecycle.payload as { reviewStatus: string }).reviewStatus).toBe('published');
    const notify = db.outbox.find((o) => o.topic === 'notify.review_decided')!;
    expect((notify.payload as { decision: string }).decision).toBe('rejected');
    expect((notify.payload as { rejectReason: string }).rejectReason).toBe('描述与能力不符');
    // 不下架（有上一版）：无 capability.unpublished。
    expect(db.outbox.find((o) => o.topic === 'capability.unpublished')).toBeUndefined();
  });
});

describe('reviewDecideInTx · reject 无上一版（首发被拒下架，§2.6.1）', () => {
  it('被裁决版→review_rejected；review_status=review_rejected 下架；发 capability.unpublished', async () => {
    const db = new PublishFakeDb();
    const owner = seedUser(db);
    const { capabilityId, reviewedVersionId } = seedPendingPublication(db, owner);
    const outcome = await runReview(db, capabilityId, 'reject', '首发不达标');
    expect(outcome).toEqual({
      decision: 'reject',
      rejectedVersionId: reviewedVersionId,
      delisted: true,
    });
    expect(db.versions.get(reviewedVersionId)!.status).toBe('review_rejected');
    const pub = db.publications.get(capabilityId)!;
    expect(pub.review_status).toBe('review_rejected');
    expect(pub.reject_reason).toBe('首发不达标'); // 镜像
    // current_version_id 仍记被裁决版供创作者侧追溯。
    expect(pub.current_version_id).toBe(reviewedVersionId);
    const unpub = db.outbox.find((o) => o.topic === 'capability.unpublished')!;
    expect(unpub).toBeTruthy();
    expect((unpub.payload as { reason: string }).reason).toBe('review_rejected_no_prev');
    // 无回退上架：无 capability.published。
    expect(db.outbox.find((o) => o.topic === 'capability.published')).toBeUndefined();
    // notify 仍发。
    expect(db.outbox.find((o) => o.topic === 'notify.review_decided')).toBeTruthy();
  });
});

describe('reviewDecideInTx · 防重 / 不可变 / 回滚', () => {
  it('已裁决（review_status≠alpha_pending）→ STATE_CONFLICT，整事务回滚（无新事件）', async () => {
    const db = new PublishFakeDb();
    const owner = seedUser(db);
    const { capabilityId } = seedPendingPublication(db, owner);
    // 先通过一次。
    await runReview(db, capabilityId, 'approve');
    const outboxAfterFirst = db.outbox.length;
    // 第二次裁决（已 published）→ 守门 0 行 → STATE_CONFLICT。
    await expect(runReview(db, capabilityId, 'reject', 'x')).rejects.toMatchObject({
      code: ErrorCode.STATE_CONFLICT,
    });
    // 回滚：不新增 outbox（不重复回退/上架/发事件）。
    expect(db.outbox.length).toBe(outboxAfterFirst);
  });

  it('被拒版是终态（不可被再次拒绝/通过）：以被拒版当前态裁决守门 0 行 → STATE_CONFLICT', async () => {
    const db = new PublishFakeDb();
    const owner = seedUser(db);
    const { capabilityId, reviewedVersionId } = seedPendingPublication(db, owner);
    await runReview(db, capabilityId, 'reject', '首发不达标');
    expect(db.versions.get(reviewedVersionId)!.status).toBe('review_rejected'); // 终态
    // publications 已是 review_rejected（非 alpha_pending）→ 再裁决守门 0 行。
    await expect(runReview(db, capabilityId, 'approve')).rejects.toBeInstanceOf(PublishError);
    expect(db.versions.get(reviewedVersionId)!.status).toBe('review_rejected'); // 仍终态、不变
  });

  it('裁决事务中途失败 → 整体回滚（被裁决版/publications/outbox 全还原，不留半裁决态）', async () => {
    const db = new PublishFakeDb();
    const owner = seedUser(db);
    const { capabilityId, reviewedVersionId, prevVersionId } = seedPendingPublication(db, owner, {
      withPrev: true,
    });
    // reject 有上一版路径：publications 回退是第 1 条写；令第 2 条写后抛错（被拒版标记 / 复位前后）。
    db.throwAfterWrites = 2;
    await expect(runReview(db, capabilityId, 'reject', '描述与能力不符')).rejects.toThrow();
    // 回滚：publications 还原 alpha_pending、current 不变、版本未标脏、无 outbox。
    const pub = db.publications.get(capabilityId)!;
    expect(pub.review_status).toBe('alpha_pending');
    expect(pub.current_version_id).toBe(reviewedVersionId);
    expect(db.versions.get(reviewedVersionId)!.status).toBe('published');
    expect(db.versions.get(prevVersionId!)!.status).toBe('superseded');
    expect(db.outbox.length).toBe(0);
  });
});

// ===========================================================================
// 并发反向破坏：评审事务守 current_version_id（Codex#3）
//   前置闸读到 alpha_pending 后、裁决事务拿锁前，并发新版发布把 current_version_id 推到新版（review_status 又回
//   alpha_pending）。旧裁决用前置闸读到的【旧被裁决版】调事务 → 事务内 FOR UPDATE 重读发现 current 已变 →
//   STATE_CONFLICT 整事务回滚（不裁/不回退【错版本】）。
// ===========================================================================
describe('reviewDecideInTx · 守 current_version_id（并发新版发布，Codex#3）', () => {
  /** 显式以指定 reviewedVersionId 调裁决（模拟前置闸读到的是【旧】被裁决版，与事务内 current 不一致）。 */
  async function decideWithReviewedVersion(
    db: PublishFakeDb,
    capabilityId: string,
    reviewedVersionId: string,
    decision: 'approve' | 'reject',
  ) {
    const pub = await readPublicationForReview(db, capabilityId);
    if (!pub) throw new Error('no publication');
    return reviewDecideInTx(asTxPool(db), {
      capabilityId,
      decision,
      ...(decision === 'reject' ? { rejectReason: '旧裁决' } : {}),
      reviewedVersionId, // 故意传旧版（前置闸读到的版），事务内 current 已是新版
      ownerUserId: pub.ownerUserId,
      slug: pub.slug,
      manifestHash: pub.manifestHash,
      prevVersionId: pub.prevVersionId,
      prevManifestHash: pub.prevManifestHash,
      prevVisibility: pub.prevVisibility,
      traceId: 'trace-rev',
    });
  }

  it('approve 旧被裁决版（并发已把 current 推到新版）→ STATE_CONFLICT，整事务回滚（不误清新版徽章）', async () => {
    const db = new PublishFakeDb();
    const owner = seedUser(db);
    const { capabilityId, reviewedVersionId: oldVersionId } = seedPendingPublication(db, owner);

    // 并发新版发布：current_version_id 推到 newVersionId，review_status 仍 alpha_pending（新版待审）。
    const newVersionId = `ver-new-${capabilityId}`;
    db.versions.set(newVersionId, {
      id: newVersionId,
      capability_id: capabilityId,
      version: '0.2.0',
      status: 'published',
      manifest: db.versions.get(oldVersionId)!.manifest,
      manifest_hash: 'newhash',
      updated_at: 3,
    });
    const pub = db.publications.get(capabilityId)!;
    pub.current_version_id = newVersionId; // 已被新版顶替
    pub.review_status = 'alpha_pending'; // 新版又是待审态（旧裁决误以为还能裁旧版）

    // 旧裁决以旧版调事务：事务内 FOR UPDATE 重读 current=newVersionId ≠ oldVersionId → STATE_CONFLICT。
    await expect(
      decideWithReviewedVersion(db, capabilityId, oldVersionId, 'approve'),
    ).rejects.toMatchObject({ code: ErrorCode.STATE_CONFLICT });
    // 不裁错版：新版仍 alpha_pending（未被旧裁决误清成 published）、current 不变、无新事件。
    expect(db.publications.get(capabilityId)!.review_status).toBe('alpha_pending');
    expect(db.publications.get(capabilityId)!.current_version_id).toBe(newVersionId);
    expect(db.outbox.length).toBe(0);
  });

  it('reject 旧被裁决版（并发已把 current 推到新版）→ STATE_CONFLICT，整事务回滚（不回退错版本）', async () => {
    const db = new PublishFakeDb();
    const owner = seedUser(db);
    const {
      capabilityId,
      reviewedVersionId: oldVersionId,
      prevVersionId,
    } = seedPendingPublication(db, owner, { withPrev: true });

    const newVersionId = `ver-new-${capabilityId}`;
    db.versions.set(newVersionId, {
      id: newVersionId,
      capability_id: capabilityId,
      version: '0.3.0',
      status: 'published',
      manifest: db.versions.get(oldVersionId)!.manifest,
      manifest_hash: 'newhash',
      updated_at: 4,
    });
    const pub = db.publications.get(capabilityId)!;
    pub.current_version_id = newVersionId;
    pub.review_status = 'alpha_pending';

    await expect(
      decideWithReviewedVersion(db, capabilityId, oldVersionId, 'reject'),
    ).rejects.toMatchObject({ code: ErrorCode.STATE_CONFLICT });
    // 不回退错版本：current 仍指新版、新版未被标脏、上一版未被误复位、无事件。
    expect(db.publications.get(capabilityId)!.current_version_id).toBe(newVersionId);
    expect(db.versions.get(newVersionId)!.status).toBe('published');
    expect(db.versions.get(prevVersionId!)!.status).toBe('superseded'); // 未被误复位
    expect(db.outbox.length).toBe(0);
  });
});

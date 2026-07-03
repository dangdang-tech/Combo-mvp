// 50 · 评审域 API handler 自检（B-30）。50-step5-publish §2.6.1 / §2.6.2。
//   重点（契约）：
//     · 评审 approve → 200 Envelope<PublicationView>(reviewStatus=published)；reject 有上一版→回退（published）、无上一版→下架（review_rejected）。
//     · reject 缺原因 → 400 change_input；已裁决 → 409 none；不存在 → 404；对外信封绝不含 code（D1）。
//     · 创作者侧 GET → reviewStatus/rejectReason/rejectedVersionId（发布页拒绝提示 + 重试/编辑入口，发布-31）；owner 守门(404/403/401)。
//     · 三处单一真源：裁决后 GET 读到的 review_status/reject_reason 与裁决落库一致（发布页/工作台/主页同源）。
import { describe, it, expect } from 'vitest';
import type { RouteHandlerMethod } from 'fastify';
import {
  reviewDecisionHandler,
  getPublicationHandler,
} from '../modules/publish/review-handlers.js';
import { PublishFakeDb, seedUser, seedCapabilityVersion, type PubRow } from './publish-fakes.js';

interface Sent {
  code: number;
  body: unknown;
}
function makeReqReply(opts: {
  userId?: string;
  params?: Record<string, string>;
  body?: unknown;
  db: PublishFakeDb;
}) {
  const sent: Sent = { code: 0, body: undefined };
  const reply = {
    code(c: number) {
      sent.code = c;
      return this;
    },
    send(b: unknown) {
      sent.body = b;
      return this;
    },
    header() {
      return this;
    },
  };
  const req = {
    id: 'trace-1',
    auth: opts.userId ? { userId: opts.userId } : undefined,
    params: opts.params ?? {},
    body: opts.body,
    headers: {},
    server: { infra: { db: opts.db } },
  };
  return { req, reply, sent };
}
async function call(h: RouteHandlerMethod, ctx: ReturnType<typeof makeReqReply>): Promise<void> {
  await (h as (req: unknown, reply: unknown) => Promise<unknown>).call(
    undefined,
    ctx.req,
    ctx.reply,
  );
}
function assertNoCode(body: unknown): void {
  expect(JSON.stringify(body)).not.toMatch(/"code"/);
}
function dataOf<T>(body: unknown): T {
  return (body as { data: T }).data;
}
function errOf(body: unknown): { action: string; userMessage: string; traceId: string } {
  return (body as { error: { action: string; userMessage: string; traceId: string } }).error;
}

/** 播种 alpha_pending 发布（可选上一版）。返回 ids。 */
function seedPending(
  db: PublishFakeDb,
  owner: string,
  withPrev = false,
): { capabilityId: string; reviewedVersionId: string; prevVersionId?: string } {
  const cur = seedCapabilityVersion(db, owner, { status: 'published', isCurrent: true });
  db.versions.get(cur.versionId)!.manifest_hash = 'curhash';
  db.versions.get(cur.versionId)!.updated_at = 2;
  let prevVersionId: string | undefined;
  if (withPrev) {
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
    prevVersionId = prevId;
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

// ===========================================================================
// §2.6.1 · 评审裁决
// ===========================================================================
describe('reviewDecisionHandler (§2.6.1)', () => {
  it('approve → 200 PublicationView(reviewStatus=published)，无 code', async () => {
    const db = new PublishFakeDb();
    const reviewer = seedUser(db, 'REV');
    const owner = seedUser(db, 'WAYNE');
    const { capabilityId } = seedPending(db, owner);
    const ctx = makeReqReply({
      userId: reviewer,
      params: { capabilityId },
      body: { decision: 'approve' },
      db,
    });
    await call(reviewDecisionHandler(), ctx);
    expect(ctx.sent.code).toBe(200);
    const v = dataOf<{ reviewStatus: string; rejectReason?: string }>(ctx.sent.body);
    expect(v.reviewStatus).toBe('published');
    expect(v.rejectReason).toBeUndefined();
    assertNoCode(ctx.sent.body);
  });

  it('reject 有上一版 → 200 回退（reviewStatus=published）+ rejectReason 镜像 + rejectedVersionId，无 code', async () => {
    const db = new PublishFakeDb();
    const reviewer = seedUser(db, 'REV');
    const owner = seedUser(db, 'WAYNE');
    const { capabilityId, reviewedVersionId, prevVersionId } = seedPending(db, owner, true);
    const ctx = makeReqReply({
      userId: reviewer,
      params: { capabilityId },
      body: { decision: 'reject', rejectReason: '描述与能力不符' },
      db,
    });
    await call(reviewDecisionHandler(), ctx);
    expect(ctx.sent.code).toBe(200);
    const v = dataOf<{
      reviewStatus: string;
      currentVersionId: string;
      rejectReason: string;
      rejectedVersionId: string;
    }>(ctx.sent.body);
    expect(v.reviewStatus).toBe('published'); // 对外回退到上一版（不标脏）
    expect(v.currentVersionId).toBe(prevVersionId);
    expect(v.rejectReason).toBe('描述与能力不符'); // 创作者侧可见镜像
    expect(v.rejectedVersionId).toBe(reviewedVersionId); // 被拒版定位（编辑重发用）
    assertNoCode(ctx.sent.body);
  });

  it('reject 无上一版 → 200 下架（reviewStatus=review_rejected）+ rejectReason + rejectedVersionId', async () => {
    const db = new PublishFakeDb();
    const reviewer = seedUser(db, 'REV');
    const owner = seedUser(db, 'WAYNE');
    const { capabilityId, reviewedVersionId } = seedPending(db, owner);
    const ctx = makeReqReply({
      userId: reviewer,
      params: { capabilityId },
      body: { decision: 'reject', rejectReason: '首发不达标' },
      db,
    });
    await call(reviewDecisionHandler(), ctx);
    expect(ctx.sent.code).toBe(200);
    const v = dataOf<{ reviewStatus: string; rejectReason: string; rejectedVersionId: string }>(
      ctx.sent.body,
    );
    expect(v.reviewStatus).toBe('review_rejected');
    expect(v.rejectReason).toBe('首发不达标');
    expect(v.rejectedVersionId).toBe(reviewedVersionId);
  });

  it('reject 缺 rejectReason → 400 change_input（拒绝需填原因），无 code，未改态', async () => {
    const db = new PublishFakeDb();
    const reviewer = seedUser(db, 'REV');
    const owner = seedUser(db, 'WAYNE');
    const { capabilityId } = seedPending(db, owner);
    const ctx = makeReqReply({
      userId: reviewer,
      params: { capabilityId },
      body: { decision: 'reject' },
      db,
    });
    await call(reviewDecisionHandler(), ctx);
    expect(ctx.sent.code).toBe(400);
    expect(errOf(ctx.sent.body).action).toBe('change_input');
    assertNoCode(ctx.sent.body);
    expect(db.publications.get(capabilityId)!.review_status).toBe('alpha_pending'); // 未改态
  });

  it('已裁决 → 409 none（这条已评审过了），无 code', async () => {
    const db = new PublishFakeDb();
    const reviewer = seedUser(db, 'REV');
    const owner = seedUser(db, 'WAYNE');
    const { capabilityId } = seedPending(db, owner);
    db.publications.get(capabilityId)!.review_status = 'published'; // 已裁决
    const ctx = makeReqReply({
      userId: reviewer,
      params: { capabilityId },
      body: { decision: 'approve' },
      db,
    });
    await call(reviewDecisionHandler(), ctx);
    expect(ctx.sent.code).toBe(409);
    expect(errOf(ctx.sent.body).action).toBe('none');
    expect(errOf(ctx.sent.body).userMessage).toMatch(/已评审/);
    assertNoCode(ctx.sent.body);
  });

  it('publication 不存在 → 404，无 code', async () => {
    const db = new PublishFakeDb();
    const reviewer = seedUser(db, 'REV');
    const ctx = makeReqReply({
      userId: reviewer,
      params: { capabilityId: 'nope' },
      body: { decision: 'approve' },
      db,
    });
    await call(reviewDecisionHandler(), ctx);
    expect(ctx.sent.code).toBe(404);
    assertNoCode(ctx.sent.body);
  });

  it('未登录 → 401，无 code', async () => {
    const db = new PublishFakeDb();
    const ctx = makeReqReply({ params: { capabilityId: 'c' }, body: { decision: 'approve' }, db });
    await call(reviewDecisionHandler(), ctx);
    expect(ctx.sent.code).toBe(401);
    assertNoCode(ctx.sent.body);
  });
});

// ===========================================================================
// §2.6.2 · 创作者只读发布态 + 三处单一真源
// ===========================================================================
describe('getPublicationHandler (§2.6.2)', () => {
  it('owner 读 alpha_pending → 200 PublicationView(reviewStatus=alpha_pending)，无 code', async () => {
    const db = new PublishFakeDb();
    const owner = seedUser(db, 'WAYNE');
    const { capabilityId } = seedPending(db, owner);
    const ctx = makeReqReply({ userId: owner, params: { capabilityId }, db });
    await call(getPublicationHandler(), ctx);
    expect(ctx.sent.code).toBe(200);
    const v = dataOf<{ reviewStatus: string; ownerUserId?: string }>(ctx.sent.body);
    expect(v.reviewStatus).toBe('alpha_pending');
    expect(v.ownerUserId).toBeUndefined(); // 内部字段不外泄
    assertNoCode(ctx.sent.body);
  });

  it('非本人 → 403 escalate；不存在 → 404；未登录 → 401（均无 code）', async () => {
    const db = new PublishFakeDb();
    const owner = seedUser(db, 'WAYNE');
    const { capabilityId } = seedPending(db, owner);
    const c1 = makeReqReply({ userId: 'intruder', params: { capabilityId }, db });
    await call(getPublicationHandler(), c1);
    expect(c1.sent.code).toBe(403);
    expect(errOf(c1.sent.body).action).toBe('escalate');
    assertNoCode(c1.sent.body);
    const c2 = makeReqReply({ userId: owner, params: { capabilityId: 'nope' }, db });
    await call(getPublicationHandler(), c2);
    expect(c2.sent.code).toBe(404);
    const c3 = makeReqReply({ params: { capabilityId }, db });
    await call(getPublicationHandler(), c3);
    expect(c3.sent.code).toBe(401);
  });

  it('三处单一真源：reject 裁决后 owner GET 读到的 reviewStatus/rejectReason/rejectedVersionId 与落库一致', async () => {
    const db = new PublishFakeDb();
    const reviewer = seedUser(db, 'REV');
    const owner = seedUser(db, 'WAYNE');
    const { capabilityId, reviewedVersionId } = seedPending(db, owner);
    // 裁决拒绝（无上一版→下架）。
    const rev = makeReqReply({
      userId: reviewer,
      params: { capabilityId },
      body: { decision: 'reject', rejectReason: '描述与能力不符' },
      db,
    });
    await call(reviewDecisionHandler(), rev);
    expect(rev.sent.code).toBe(200);
    // 创作者侧 GET（发布页/工作台/主页同一真源 publications.review_status/reject_reason）。
    const get = makeReqReply({ userId: owner, params: { capabilityId }, db });
    await call(getPublicationHandler(), get);
    const v = dataOf<{ reviewStatus: string; rejectReason: string; rejectedVersionId: string }>(
      get.sent.body,
    );
    expect(v.reviewStatus).toBe('review_rejected');
    expect(v.rejectReason).toBe('描述与能力不符');
    expect(v.rejectedVersionId).toBe(reviewedVersionId); // 编辑重发入口定位
  });
});

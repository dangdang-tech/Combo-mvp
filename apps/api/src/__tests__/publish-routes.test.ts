// 50 · 发布域 API handler 自检（B-27 发布门 + B-28 市集卡预览）。50-step5-publish §2.1/§2.2。
//   重点（契约）：
//     · 发布：200 Envelope<PublishResult>（含即时市集卡 + meta.placeholders）；非 draft→409、缺必填→422+missingFields、
//       非本人→403、不存在→404；对外信封绝不含 code（D1）；同步事务（不建 job/不裸转圈）。
//     · 市集卡预览：200 Envelope<MarketCard>（不写库）；软字段未完→409；owner 守门(404/403)；未登录 401。
import { describe, it, expect } from 'vitest';
import type { RouteHandlerMethod } from 'fastify';
import { publishVersionHandler, marketCardPreviewHandler } from '../routes/publish-handlers.js';
import { PublishFakeDb, seedUser, seedCapabilityVersion, readyManifest } from './publish-fakes.js';

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
function metaOf(body: unknown): { placeholders?: Record<string, string>; traceId?: string } {
  return (body as { meta: { placeholders?: Record<string, string>; traceId?: string } }).meta;
}
function errOf(body: unknown): {
  action: string;
  userMessage: string;
  traceId: string;
  details?: Record<string, unknown>;
} {
  return (
    body as {
      error: {
        action: string;
        userMessage: string;
        traceId: string;
        details?: Record<string, unknown>;
      };
    }
  ).error;
}

const stdBody = {
  cover: { source: 'glyph' },
  tiers: [{ tierCode: 'standard', priceMicros: 9_900_000 }],
  visibility: 'public',
};

// ===========================================================================
// §2.1 · 发布
// ===========================================================================
describe('publishVersionHandler (§2.1)', () => {
  it('成功 → 200 Envelope<PublishResult>（即时市集卡 + meta.placeholders）；无 code', async () => {
    const db = new PublishFakeDb();
    const owner = seedUser(db, 'WAYNE');
    const seeded = seedCapabilityVersion(db, owner);
    const ctx = makeReqReply({
      userId: owner,
      params: { versionId: seeded.versionId },
      body: stdBody,
      db,
    });
    await call(publishVersionHandler(), ctx);
    expect(ctx.sent.code).toBe(200);
    assertNoCode(ctx.sent.body);
    const r = dataOf<{ reviewStatus: string; marketUrl: string; card: { byline: string } }>(
      ctx.sent.body,
    );
    expect(r.reviewStatus).toBe('alpha_pending');
    expect(r.marketUrl).toBe(`/a/${seeded.slug}`);
    expect(r.card.byline).toBe('@WAYNE');
    expect(metaOf(ctx.sent.body).placeholders?.installs).toMatch(/上线后/);
    // 同步：未建 job（发布门是事务、非长任务）。
    expect(db.publications.size).toBe(1);
  });

  it('非本人 → 403 escalate，无 code，未写库', async () => {
    const db = new PublishFakeDb();
    const owner = seedUser(db);
    const seeded = seedCapabilityVersion(db, owner);
    const ctx = makeReqReply({
      userId: 'intruder',
      params: { versionId: seeded.versionId },
      body: stdBody,
      db,
    });
    await call(publishVersionHandler(), ctx);
    expect(ctx.sent.code).toBe(403);
    expect(errOf(ctx.sent.body).action).toBe('escalate');
    assertNoCode(ctx.sent.body);
    expect(db.publications.size).toBe(0);
  });

  it('已 published → 409 ALREADY_PUBLISHED（action none），无 code', async () => {
    const db = new PublishFakeDb();
    const owner = seedUser(db);
    const seeded = seedCapabilityVersion(db, owner, { status: 'published' });
    const ctx = makeReqReply({
      userId: owner,
      params: { versionId: seeded.versionId },
      body: stdBody,
      db,
    });
    await call(publishVersionHandler(), ctx);
    expect(ctx.sent.code).toBe(409);
    expect(errOf(ctx.sent.body).action).toBe('none');
    expect(errOf(ctx.sent.body).userMessage).toMatch(/已发布/);
    assertNoCode(ctx.sent.body);
  });

  it('被拒版 → 409 STATE_CONFLICT（change_input，引导基于新版本），无 code', async () => {
    const db = new PublishFakeDb();
    const owner = seedUser(db);
    const seeded = seedCapabilityVersion(db, owner, { status: 'review_rejected' });
    const ctx = makeReqReply({
      userId: owner,
      params: { versionId: seeded.versionId },
      body: stdBody,
      db,
    });
    await call(publishVersionHandler(), ctx);
    expect(ctx.sent.code).toBe(409);
    expect(errOf(ctx.sent.body).action).toBe('change_input');
    assertNoCode(ctx.sent.body);
  });

  it('缺必填（name 空）→ 422 PUBLISH_MISSING_FIELDS + details.missingFields，无 code', async () => {
    const db = new PublishFakeDb();
    const owner = seedUser(db);
    const seeded = seedCapabilityVersion(db, owner, {
      manifest: { ...readyManifest('c'), name: '' },
    });
    const ctx = makeReqReply({
      userId: owner,
      params: { versionId: seeded.versionId },
      body: stdBody,
      db,
    });
    await call(publishVersionHandler(), ctx);
    expect(ctx.sent.code).toBe(422);
    expect(errOf(ctx.sent.body).action).toBe('change_input');
    expect((errOf(ctx.sent.body).details?.missingFields as string[]) ?? []).toContain('name');
    assertNoCode(ctx.sent.body);
  });

  it('版本不存在 → 404，无 code', async () => {
    const db = new PublishFakeDb();
    const owner = seedUser(db);
    const ctx = makeReqReply({
      userId: owner,
      params: { versionId: 'nope' },
      body: stdBody,
      db,
    });
    await call(publishVersionHandler(), ctx);
    expect(ctx.sent.code).toBe(404);
    assertNoCode(ctx.sent.body);
  });

  it('body 格式错（缺 cover/tiers/visibility）→ 422 change_input（去补齐），无 code', async () => {
    const db = new PublishFakeDb();
    const owner = seedUser(db);
    const seeded = seedCapabilityVersion(db, owner);
    const ctx = makeReqReply({
      userId: owner,
      params: { versionId: seeded.versionId },
      body: {},
      db,
    });
    await call(publishVersionHandler(), ctx);
    expect(ctx.sent.code).toBe(422);
    expect(errOf(ctx.sent.body).action).toBe('change_input');
    assertNoCode(ctx.sent.body);
  });

  it('未登录 → 401，无 code', async () => {
    const db = new PublishFakeDb();
    const ctx = makeReqReply({ params: { versionId: 'v' }, body: stdBody, db });
    await call(publishVersionHandler(), ctx);
    expect(ctx.sent.code).toBe(401);
    assertNoCode(ctx.sent.body);
  });
});

// ===========================================================================
// §2.2 · 市集卡预览
// ===========================================================================
describe('marketCardPreviewHandler (§2.2)', () => {
  it('成功 → 200 Envelope<MarketCard>（不写库）+ meta.placeholders；价格按预览入参', async () => {
    const db = new PublishFakeDb();
    const owner = seedUser(db, 'WAYNE');
    const seeded = seedCapabilityVersion(db, owner);
    const ctx = makeReqReply({
      userId: owner,
      params: { versionId: seeded.versionId },
      body: { tiers: [{ tierCode: 'standard', priceMicros: 5_000_000 }] },
      db,
    });
    await call(marketCardPreviewHandler(), ctx);
    expect(ctx.sent.code).toBe(200);
    const card = dataOf<{
      byline: string;
      price: { priceMicros: number; display: string };
      installs: null;
    }>(ctx.sent.body);
    expect(card.byline).toBe('@WAYNE');
    expect(card.price.priceMicros).toBe(5_000_000);
    expect(card.price.display).toBe('¥5.00');
    expect(card.installs).toBeNull();
    expect(metaOf(ctx.sent.body).placeholders?.rating).toMatch(/上线后/);
    assertNoCode(ctx.sent.body);
    // 不写库（预览无副作用）：无 publications。
    expect(db.publications.size).toBe(0);
  });

  it('未设价 → priceMicros null + display null（待填）', async () => {
    const db = new PublishFakeDb();
    const owner = seedUser(db);
    const seeded = seedCapabilityVersion(db, owner);
    const ctx = makeReqReply({
      userId: owner,
      params: { versionId: seeded.versionId },
      body: {},
      db,
    });
    await call(marketCardPreviewHandler(), ctx);
    expect(ctx.sent.code).toBe(200);
    const card = dataOf<{ price: { priceMicros: number | null; display: string | null } }>(
      ctx.sent.body,
    );
    expect(card.price).toEqual({ priceMicros: null, display: null });
  });

  it('软字段未完（name 空）→ 409 STATE_CONFLICT（回上一步补全），无 code', async () => {
    const db = new PublishFakeDb();
    const owner = seedUser(db);
    const seeded = seedCapabilityVersion(db, owner, {
      manifest: { ...readyManifest('c'), name: '' },
    });
    const ctx = makeReqReply({
      userId: owner,
      params: { versionId: seeded.versionId },
      body: {},
      db,
    });
    await call(marketCardPreviewHandler(), ctx);
    expect(ctx.sent.code).toBe(409);
    expect(errOf(ctx.sent.body).action).toBe('change_input');
    assertNoCode(ctx.sent.body);
  });

  it('非本人 → 403；不存在 → 404；未登录 → 401（均无 code）', async () => {
    const db = new PublishFakeDb();
    const owner = seedUser(db);
    const seeded = seedCapabilityVersion(db, owner);
    const c1 = makeReqReply({ userId: 'x', params: { versionId: seeded.versionId }, body: {}, db });
    await call(marketCardPreviewHandler(), c1);
    expect(c1.sent.code).toBe(403);
    assertNoCode(c1.sent.body);
    const c2 = makeReqReply({ userId: owner, params: { versionId: 'nope' }, body: {}, db });
    await call(marketCardPreviewHandler(), c2);
    expect(c2.sent.code).toBe(404);
    assertNoCode(c2.sent.body);
    const c3 = makeReqReply({ params: { versionId: seeded.versionId }, body: {}, db });
    await call(marketCardPreviewHandler(), c3);
    expect(c3.sent.code).toBe(401);
    assertNoCode(c3.sent.body);
  });
});

// 60 个人主页 API handler 自检（B-33，60-dashboard-profile §2，主页-13/16/17）。忠实假 PG，无真 PG。
//   重点：轻包络 {data,meta}；usage 占位 meta.placeholders；404 不存在；500 聚合/分区失败带退路；
//        访客同视图（optionalAuth）；对外信封绝不含 code（D1）；只读不下钻（无经营维度泄漏）。
import { describe, it, expect } from 'vitest';
import type { RouteHandlerMethod } from 'fastify';
import {
  getCreatorProfileHandler,
  getDensityHandler,
  getHeatmapHandler,
  getNetworkHandler,
  getWorksHandler,
} from '../modules/profile/handlers.js';
import {
  ProfileFakeDb,
  seedProfile,
  seedPublishedCapability,
  seedRejectedCapability,
  seedSupport,
} from './profile-fakes.js';

interface Sent {
  code: number;
  body: unknown;
}
function makeReqReply(opts: {
  userId?: string;
  account?: string;
  params?: Record<string, string>;
  query?: Record<string, string>;
  db: ProfileFakeDb;
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
    auth: opts.userId ? { userId: opts.userId, account: opts.account ?? '测试账号' } : undefined,
    params: opts.params ?? {},
    query: opts.query ?? {},
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
/** 对外信封绝不含 code（D1）。 */
function assertNoCode(body: unknown): void {
  expect(JSON.stringify(body)).not.toMatch(/"code"/);
}

const TODAY_SEED = '2026-06-01T00:00:00.000Z';

describe('GET /creators/:id/profile（主聚合）', () => {
  it('200 轻包络 {data,meta} + usage 占位 placeholders（脊柱 §2.2）', async () => {
    const db = new ProfileFakeDb();
    const creatorId = seedProfile(db);
    seedPublishedCapability(db, creatorId, { name: '需求炼金师', createdAt: TODAY_SEED });
    const ctx = makeReqReply({ params: { creatorId }, db });
    await call(getCreatorProfileHandler(), ctx);
    expect(ctx.sent.code).toBe(200);
    const body = ctx.sent.body as { data: unknown; meta: { placeholders: Record<string, string> } };
    expect(body.data).toBeTruthy();
    // usage 占位文案：暂无数据 / 上线后填充。
    expect(body.meta.placeholders['totalInvocations']).toBe('暂无数据 / 上线后填充');
    expect(body.meta.placeholders['hottestTopic.heatValue']).toBe('暂无数据 / 上线后填充');
    assertNoCode(body);
  });

  it('访客（无 auth）同视图：viewerIsFollowing=null', async () => {
    const db = new ProfileFakeDb();
    const creatorId = seedProfile(db);
    const ctx = makeReqReply({ params: { creatorId }, db });
    await call(getCreatorProfileHandler(), ctx);
    const body = ctx.sent.body as {
      data: { hero: { social: { viewerIsFollowing: boolean | null } } };
    };
    expect(body.data.hero.social.viewerIsFollowing).toBeNull();
  });

  it('登录访客 viewerIsFollowing 反映关注态（仅切文案，不下钻）', async () => {
    const db = new ProfileFakeDb();
    const creatorId = seedProfile(db);
    db.follows.push({ follower_id: 'v1', followee_id: creatorId });
    const ctx = makeReqReply({ params: { creatorId }, userId: 'v1', db });
    await call(getCreatorProfileHandler(), ctx);
    const body = ctx.sent.body as {
      data: { hero: { social: { viewerIsFollowing: boolean | null } } };
    };
    expect(body.data.hero.social.viewerIsFollowing).toBe(true);
  });

  it('404 creatorId 不存在（不下钻不暴露存在性，§2.7）—— 信封无 code', async () => {
    const db = new ProfileFakeDb();
    const ctx = makeReqReply({ params: { creatorId: 'nope' }, db });
    await call(getCreatorProfileHandler(), ctx);
    expect(ctx.sent.code).toBe(404);
    const body = ctx.sent.body as { error: { userMessage: string; action: string } };
    expect(body.error.action).toBe('change_input');
    expect(body.error.userMessage).toContain('没找到');
    assertNoCode(body);
  });

  it('500 聚合失败带退路（主页-16，retriable+retry）—— 基行失败整页 500，不裸露 code/堆栈', async () => {
    const db = new ProfileFakeDb();
    const creatorId = seedProfile(db);
    db.throwNext = true; // 注入基行读（首查）异常 → 整页 500（基行是身份门）
    const ctx = makeReqReply({ params: { creatorId }, db });
    await call(getCreatorProfileHandler(), ctx);
    expect(ctx.sent.code).toBe(500);
    const body = ctx.sent.body as {
      error: { retriable: boolean; action: string; userMessage: string };
    };
    expect(body.error.retriable).toBe(true);
    expect(body.error.action).toBe('retry');
    assertNoCode(body);
    // 人话，不含 SQL/堆栈。
    expect(body.error.userMessage).not.toMatch(/SELECT|Error|at /);
  });

  it('creatorId 非法 UUID 文本（PG 22P02）→ 404 链接失效（change_input），不落 500 重试态（BUG-011）', async () => {
    // 真实 PG 把非 UUID 文本绑定 uuid 列会抛 22P02；非法链接不是可重试服务故障，应 404 而非 500。
    const db = new ProfileFakeDb();
    db.throwCodeNext = '22P02';
    const ctx = makeReqReply({ params: { creatorId: 'not-a-uuid' }, db });
    await call(getCreatorProfileHandler(), ctx);
    expect(ctx.sent.code).toBe(404);
    const body = ctx.sent.body as { error: { action: string; userMessage: string } };
    expect(body.error.action).toBe('change_input');
    expect(body.error.userMessage).toContain('没找到');
    assertNoCode(body);
  });

  // —— 分区局部失败不连坐（§2.7，主页-17，Codex#r3 P1）：次要分区失败仍 200，失败分区有标记 ——
  it('次要分区（热力图/网络）失败 → 整页仍 200，失败分区 null + sectionErrors；核心分区在', async () => {
    const db = new ProfileFakeDb();
    const creatorId = seedProfile(db);
    seedPublishedCapability(db, creatorId, { name: '需求炼金师' });
    db.throwOnSources.add('heatmap');
    db.throwOnSources.add('hits');
    const ctx = makeReqReply({ params: { creatorId }, db });
    await call(getCreatorProfileHandler(), ctx);
    // 不连坐：整页仍 200（非 500），核心分区照常返回。
    expect(ctx.sent.code).toBe(200);
    const body = ctx.sent.body as {
      data: {
        hero: unknown;
        metrics: unknown;
        works: unknown;
        heatmap: unknown;
        network: unknown;
        sectionErrors: Array<{ section: string; retriable: boolean }>;
      };
    };
    expect(body.data.hero).toBeTruthy();
    expect(body.data.metrics).toBeTruthy(); // 核心分区不连坐
    expect(body.data.works).toBeTruthy();
    expect(body.data.heatmap).toBeNull(); // 失败分区
    expect(body.data.network).toBeNull();
    expect(body.data.sectionErrors.map((e) => e.section).sort()).toEqual(['heatmap', 'network']);
    assertNoCode(body);
  });
});

// —— self 别名 'me'（§2.0 / Codex r1#1 P0）：/creators/me/* 解析为当前登录用户 creatorId ——
describe('self 别名 me（鉴权态自身主页）', () => {
  it('登录态 GET /creators/me/profile → 解析为本人 creatorId，200 返回本人名片', async () => {
    const db = new ProfileFakeDb();
    const creatorId = seedProfile(db, { display_name: '本人韦恩' });
    seedPublishedCapability(db, creatorId, { name: '需求炼金师' });
    // auth.userId = 本人，path 用别名 me。
    const ctx = makeReqReply({ params: { creatorId: 'me' }, userId: creatorId, db });
    await call(getCreatorProfileHandler(), ctx);
    expect(ctx.sent.code).toBe(200);
    const body = ctx.sent.body as { data: { creatorId: string; hero: { displayName: string } } };
    expect(body.data.creatorId).toBe(creatorId);
    expect(body.data.hero.displayName).toBe('本人韦恩');
  });

  // —— BUG-014：登录用户访问自己主页但无 creator_profiles 行 → 不该 404「没找到创作者」，Hero 恒在 ——
  it('me 别名无 profile 数据 → 200 最小 Hero（账号名 displayName），非 404（BUG-014）', async () => {
    const db = new ProfileFakeDb(); // 不 seed profile：自己还没建名片。
    const ctx = makeReqReply({
      params: { creatorId: 'me' },
      userId: 'self-no-profile',
      account: '新创作者A',
      db,
    });
    await call(getCreatorProfileHandler(), ctx);
    expect(ctx.sent.code).toBe(200); // 不是 404
    const body = ctx.sent.body as {
      data: {
        creatorId: string;
        hero: { displayName: string; social: { viewerIsFollowing: boolean | null } };
        metrics: { capabilityCount: number } | null;
        density: { rows: unknown[] } | null;
        works: { cards: unknown[] } | null;
        network: { thumbnailOnly: boolean } | null;
        heatmap: unknown;
        heatmapEnabled: boolean;
        sectionErrors: unknown[];
      };
      meta: { placeholders: Record<string, string> };
    };
    // Hero 恒在：用登录账号身份兜底（displayName=account）。
    expect(body.data.creatorId).toBe('self-no-profile');
    expect(body.data.hero.displayName).toBe('新创作者A');
    expect(body.data.hero.social.viewerIsFollowing).toBeNull(); // 自己看自己无关注语义
    // 空分区（非失败）：有结构、零内容，无 sectionErrors（前端各分区出空态，不出局部错误条）。
    expect(body.data.metrics?.capabilityCount).toBe(0);
    expect(body.data.density?.rows).toEqual([]);
    expect(body.data.works?.cards).toEqual([]);
    expect(body.data.network?.thumbnailOnly).toBe(true);
    expect(body.data.heatmap).toBeNull();
    expect(body.data.heatmapEnabled).toBe(false);
    expect(body.data.sectionErrors).toEqual([]);
    // usage 占位键照常（与有数据时一致，前端单键读不漂移）。
    expect(body.meta.placeholders['totalInvocations']).toBe('暂无数据 / 上线后填充');
    assertNoCode(body);
  });

  it('登录用户用自己真实 id（非 me 别名）访问无 profile 的自己 → 同样 200 最小 Hero（BUG-014）', async () => {
    const db = new ProfileFakeDb(); // 无 profile 行。
    const myId = 'real-self-id';
    const ctx = makeReqReply({
      params: { creatorId: myId }, // 真实 id（不是 'me' 别名），但 == viewerId。
      userId: myId,
      account: '本人',
      db,
    });
    await call(getCreatorProfileHandler(), ctx);
    expect(ctx.sent.code).toBe(200);
    const body = ctx.sent.body as { data: { hero: { displayName: string } } };
    expect(body.data.hero.displayName).toBe('本人');
    assertNoCode(body);
  });

  it('他人主页无 profile 数据仍 404（不下钻、不暴露存在性，§2.7；self 兜底不外溢）', async () => {
    const db = new ProfileFakeDb(); // 无 profile 行。
    // 登录用户 viewer1 访问别人的 id（!= 自己）→ 仍 404，不构造他人最小名片。
    const ctx = makeReqReply({
      params: { creatorId: 'someone-else' },
      userId: 'viewer1',
      account: 'viewer1账号',
      db,
    });
    await call(getCreatorProfileHandler(), ctx);
    expect(ctx.sent.code).toBe(404);
    const body = ctx.sent.body as { error: { action: string; userMessage: string } };
    expect(body.error.action).toBe('change_input');
    expect(body.error.userMessage).toContain('没找到');
    assertNoCode(body);
  });

  it('未登录 GET /creators/me/profile → 401 escalate（self 需鉴权，不下钻不当 404）', async () => {
    const db = new ProfileFakeDb();
    const ctx = makeReqReply({ params: { creatorId: 'me' }, db }); // 无 userId
    await call(getCreatorProfileHandler(), ctx);
    expect(ctx.sent.code).toBe(401);
    const body = ctx.sent.body as { error: { action: string; userMessage: string } };
    expect(body.error.action).toBe('escalate');
    expect(body.error.userMessage).toContain('登录');
    assertNoCode(body);
  });

  it('me 别名同样覆盖子端点（works）：登录态解析本人、未登录 401', async () => {
    const db = new ProfileFakeDb();
    const creatorId = seedProfile(db);
    seedPublishedCapability(db, creatorId, { name: '上架能力' });
    // 登录态：解析本人，200。
    const okCtx = makeReqReply({ params: { creatorId: 'me' }, userId: creatorId, db });
    await call(getWorksHandler(), okCtx);
    expect(okCtx.sent.code).toBe(200);
    // 未登录：401。
    const noAuthCtx = makeReqReply({ params: { creatorId: 'me' }, db });
    await call(getWorksHandler(), noAuthCtx);
    expect(noAuthCtx.sent.code).toBe(401);
    assertNoCode(noAuthCtx.sent.body);
  });

  it('他人主页（非 me）匿名仍 200（公开只读不受 self 鉴权影响）', async () => {
    const db = new ProfileFakeDb();
    const creatorId = seedProfile(db);
    const ctx = makeReqReply({ params: { creatorId }, db }); // 真实 id、无 auth
    await call(getCreatorProfileHandler(), ctx);
    expect(ctx.sent.code).toBe(200);
  });
});

describe('分区子端点 handler', () => {
  it('密度榜：Paginated 形态 + readonly 行（主页-08）', async () => {
    const db = new ProfileFakeDb();
    const creatorId = seedProfile(db);
    const a = seedPublishedCapability(db, creatorId, { name: 'A', slug: 'da' });
    seedSupport(db, creatorId, a.slug, ['2026-05-01T00:00:00.000Z']);
    const ctx = makeReqReply({ params: { creatorId }, query: { byDensity: 'true' }, db });
    await call(getDensityHandler(), ctx);
    expect(ctx.sent.code).toBe(200);
    const body = ctx.sent.body as {
      data: { readonly: boolean }[];
      meta: { page: { hasMore: boolean } };
    };
    expect(body.data[0]!.readonly).toBe(true);
    expect(body.meta.page).toBeTruthy();
  });

  it('密度榜 limit 非法 → 400 翻页参数失效', async () => {
    const db = new ProfileFakeDb();
    const creatorId = seedProfile(db);
    const ctx = makeReqReply({ params: { creatorId }, query: { limit: '999' }, db });
    await call(getDensityHandler(), ctx);
    expect(ctx.sent.code).toBe(400);
    assertNoCode(ctx.sent.body);
  });

  it('密度榜 cursor 失效/畸形 → 400 VALIDATION_FAILED（change_input，非静默首页/非 500，Codex r1#2）', async () => {
    const db = new ProfileFakeDb();
    const creatorId = seedProfile(db);
    seedPublishedCapability(db, creatorId, { name: 'x' });
    const ctx = makeReqReply({
      params: { creatorId },
      query: { cursor: 'garbage-cursor', limit: '3' },
      db,
    });
    await call(getDensityHandler(), ctx);
    expect(ctx.sent.code).toBe(400);
    expect((ctx.sent.body as { error: { action: string } }).error.action).toBe('change_input');
    assertNoCode(ctx.sent.body);
  });

  it('作品墙 cursor 失效/畸形 → 400 VALIDATION_FAILED（非静默首页/非 500）', async () => {
    const db = new ProfileFakeDb();
    const creatorId = seedProfile(db);
    seedPublishedCapability(db, creatorId, { name: 'x' });
    const ctx = makeReqReply({
      params: { creatorId },
      query: { cursor: 'garbage-cursor', limit: '24' },
      db,
    });
    await call(getWorksHandler(), ctx);
    expect(ctx.sent.code).toBe(400);
    expect((ctx.sent.body as { error: { action: string } }).error.action).toBe('change_input');
    assertNoCode(ctx.sent.body);
  });

  it('热力图：Envelope 形态，只数量不露原文', async () => {
    const db = new ProfileFakeDb();
    const creatorId = seedProfile(db);
    const a = seedPublishedCapability(db, creatorId, { name: 'x' });
    seedSupport(db, creatorId, a.slug, ['2026-06-15T00:00:00.000Z']);
    const ctx = makeReqReply({ params: { creatorId }, db });
    await call(getHeatmapHandler(), ctx);
    expect(ctx.sent.code).toBe(200);
    const body = ctx.sent.body as { data: { cells: Record<string, unknown>[] } };
    if (body.data.cells.length > 0) {
      expect(Object.keys(body.data.cells[0]!).sort()).toEqual(['count', 'date', 'level']);
    }
  });

  it('网络：thumbnailOnly + 无展开入口字段（主页-10）', async () => {
    const db = new ProfileFakeDb();
    const creatorId = seedProfile(db);
    const ctx = makeReqReply({ params: { creatorId }, db });
    await call(getNetworkHandler(), ctx);
    expect(ctx.sent.code).toBe(200);
    const body = ctx.sent.body as { data: Record<string, unknown> };
    expect(body.data['thumbnailOnly']).toBe(true);
    expect(Object.keys(body.data).sort()).toEqual(['edges', 'nodes', 'thumbnailOnly']);
  });

  it('作品墙：被拒下架不上墙（主页-23）+ invocations 占位 + placeholders', async () => {
    const db = new ProfileFakeDb();
    const creatorId = seedProfile(db);
    seedPublishedCapability(db, creatorId, { name: '上架能力' });
    seedRejectedCapability(db, creatorId, { name: '被拒能力' });
    const ctx = makeReqReply({ params: { creatorId }, db });
    await call(getWorksHandler(), ctx);
    expect(ctx.sent.code).toBe(200);
    const body = ctx.sent.body as {
      data: { name: string; invocations: number | null }[];
      meta: { placeholders: Record<string, string> };
    };
    expect(body.data.map((c) => c.name)).toEqual(['上架能力']);
    expect(body.data[0]!.invocations).toBeNull();
    // 占位键与主聚合一致（works.invocations），前端单键读不漂移（Codex r1#3）。
    expect(body.meta.placeholders['works.invocations']).toBe('暂无数据 / 上线后填充');
  });

  it('分区失败 → 500 PROFILE_SECTION_FAILED 局部退路（主页-17）', async () => {
    const db = new ProfileFakeDb();
    const creatorId = seedProfile(db);
    // readDensityPage 先读 base 成功，再读 caps 抛错 → 第二次 query 抛。
    // 用 throwNext 在 base 读后置位：先调一次让 base 读掉，再注入。
    // 简化：直接让首个 query 抛（base 读失败也走 section 500，整页不崩）。
    db.throwNext = true;
    const ctx = makeReqReply({ params: { creatorId }, db });
    await call(getDensityHandler(), ctx);
    expect(ctx.sent.code).toBe(500);
    const body = ctx.sent.body as { error: { retriable: boolean; userMessage: string } };
    expect(body.error.retriable).toBe(true);
    expect(body.error.userMessage).toContain('分区');
    assertNoCode(body);
  });

  it('子端点 404 creatorId 不存在', async () => {
    const db = new ProfileFakeDb();
    const ctx = makeReqReply({ params: { creatorId: 'nope' }, db });
    await call(getWorksHandler(), ctx);
    expect(ctx.sent.code).toBe(404);
  });

  it('子端点 creatorId 非法 UUID（22P02）→ 404 链接失效（非 500 分区重试，BUG-011）', async () => {
    const db = new ProfileFakeDb();
    db.throwCodeNext = '22P02';
    const ctx = makeReqReply({ params: { creatorId: 'not-a-uuid' }, db });
    await call(getWorksHandler(), ctx);
    expect(ctx.sent.code).toBe(404);
    expect((ctx.sent.body as { error: { action: string } }).error.action).toBe('change_input');
    assertNoCode(ctx.sent.body);
  });
});

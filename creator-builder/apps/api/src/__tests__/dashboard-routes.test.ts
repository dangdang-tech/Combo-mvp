// 60 工作台聚合 API 自检（B-32，60-dashboard-profile §1）。忠实假 PG，无真 PG。
//   重点（契约 + 合规清单）：
//     · 已发布数【真实】（count），与摘要句/metrics published 卡一致；usage 维度统一 null + meta.placeholders（非裸 0）。
//     · 能力表状态列【单一真源派生】（derivePublicationDisplayState + 工作台 draft/unpublished 派生态），不自行拼装。
//     · 草稿条只返 active、携落点 + stepProgress（续传），多条独立；空态 data:[] + hasMore:false。
//     · 时间范围三档解析/回显（range 回响应；published 卡环比按 range 取上一区间基期，all → 环比 null）。
//     · 鉴权 owner：handler 取 req.auth.userId 作 owner，全部本人聚合（无登录 → 401；不下钻他人）。
//     · 对外信封绝不含 code（D1）；聚合失败 → 500 人话可重试；range/cursor 非法 → 400。
//   反向破坏：注入 db 抛错 → 500；喂不同 review_status 组合断言派生唯一；非本人 owner 取空。
import { describe, it, expect } from 'vitest';
import type { RouteHandlerMethod } from 'fastify';
import {
  dashboardSummaryHandler,
  dashboardMetricsHandler,
  dashboardTokenTrendHandler,
  dashboardCapabilitiesHandler,
  dashboardDraftsHandler,
} from '../routes/dashboard-handlers.js';
import {
  DashboardSummarySchema,
  DashboardMetricsSchema,
  TokenTrendSchema,
  DashboardCapabilityRowSchema,
  DraftViewSchema,
  ErrorEnvelopeSchema,
  encodeIdCursor,
} from '@cb/shared';
import { USAGE_PLACEHOLDER_TEXT } from '../dashboard/usage-placeholders.js';
import { DashboardFakeDb, seedCapability, seedDraft } from './dashboard-fakes.js';

interface Sent {
  code: number;
  body: unknown;
}
function makeReqReply(opts: {
  userId?: string;
  query?: Record<string, string>;
  db: DashboardFakeDb;
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
    id: 'trace-dash-1',
    auth: opts.userId ? { userId: opts.userId } : undefined,
    query: opts.query ?? {},
    params: {},
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
type EnvBody = { data: unknown; meta?: { placeholders?: Record<string, string>; page?: unknown } };

// ===========================================================================
// §1.1 摘要：已发布数真实 + usage 占位
// ===========================================================================
describe('GET /dashboard/summary（页头摘要，§1.1）', () => {
  it('publishedCount 真实（本人 published 计数）；monthlyInvocations null + placeholder（非裸 0）', async () => {
    const db = new DashboardFakeDb();
    const me = 'user-me';
    seedCapability(db, me, { reviewStatus: 'published' });
    seedCapability(db, me, { reviewStatus: 'published' });
    seedCapability(db, me, { reviewStatus: 'alpha_pending' }); // 不计入 published
    seedCapability(db, me, { reviewStatus: null }); // 草稿不计入
    seedCapability(db, 'other-user', { reviewStatus: 'published' }); // 他人不计入（owner）

    const ctx = makeReqReply({ userId: me, db });
    await call(dashboardSummaryHandler(), ctx);

    expect(ctx.sent.code).toBe(200);
    const body = ctx.sent.body as EnvBody;
    expect(DashboardSummarySchema.safeParse(body.data).success).toBe(true);
    const data = body.data as {
      publishedCount: number;
      monthlyInvocations: number | null;
      title: string;
    };
    expect(data.publishedCount).toBe(2); // 真实，仅本人 published
    expect(data.title).toBe('创作者中心');
    expect(data.monthlyInvocations).toBeNull(); // usage 占位（非 0）
    expect(body.meta?.placeholders?.monthlyInvocations).toBe(USAGE_PLACEHOLDER_TEXT);
    assertNoCode(body);
  });

  it('无登录 → 401（escalate）；信封无 code', async () => {
    const db = new DashboardFakeDb();
    const ctx = makeReqReply({ db }); // 无 userId
    await call(dashboardSummaryHandler(), ctx);
    expect(ctx.sent.code).toBe(401);
    expect(ErrorEnvelopeSchema.safeParse(ctx.sent.body).success).toBe(true);
    expect((ctx.sent.body as { error: { action: string } }).error.action).toBe('escalate');
    assertNoCode(ctx.sent.body);
  });

  it('聚合查询失败 → 500 DASHBOARD_AGGREGATE_FAILED（人话可重试，无 code）', async () => {
    const db = new DashboardFakeDb();
    db.throwOnNext = true;
    const ctx = makeReqReply({ userId: 'user-me', db });
    await call(dashboardSummaryHandler(), ctx);
    expect(ctx.sent.code).toBe(500);
    const env = ctx.sent.body as {
      error: { action: string; retriable: boolean; userMessage: string };
    };
    expect(env.error.action).toBe('retry');
    expect(env.error.retriable).toBe(true);
    expect(env.error.userMessage).toContain('请重试');
    assertNoCode(ctx.sent.body);
  });
});

// ===========================================================================
// §1.2 四卡 + 环比：published 真实 + usage 三卡占位
// ===========================================================================
describe('GET /dashboard/metrics（四卡 + 环比，§1.2）', () => {
  it('恒四卡顺序固定；published 卡真实值；usage 三卡 value/delta 全 null + placeholders', async () => {
    const db = new DashboardFakeDb();
    const me = 'user-me';
    seedCapability(db, me, { reviewStatus: 'published' });

    const ctx = makeReqReply({ userId: me, query: { range: '30d' }, db });
    await call(dashboardMetricsHandler(), ctx);

    expect(ctx.sent.code).toBe(200);
    const body = ctx.sent.body as EnvBody;
    expect(DashboardMetricsSchema.safeParse(body.data).success).toBe(true);
    const data = body.data as {
      range: string;
      cards: Array<{
        key: string;
        value: number | null;
        deltaPercent: number | null;
        deltaDirection: string | null;
      }>;
    };
    expect(data.range).toBe('30d'); // range 回显
    expect(data.cards.map((c) => c.key)).toEqual([
      'published',
      'invocationsTotal',
      'spendThisMonth',
      'activeConsumers',
    ]);
    // published 卡真实
    expect(data.cards[0]!.value).toBe(1);
    // usage 三卡全 null
    for (const c of data.cards.slice(1)) {
      expect(c.value).toBeNull();
      expect(c.deltaPercent).toBeNull();
      expect(c.deltaDirection).toBeNull();
    }
    expect(body.meta?.placeholders?.invocationsTotal).toBe(USAGE_PLACEHOLDER_TEXT);
    expect(body.meta?.placeholders?.spendThisMonth).toBe(USAGE_PLACEHOLDER_TEXT);
    expect(body.meta?.placeholders?.activeConsumers).toBe(USAGE_PLACEHOLDER_TEXT);
    assertNoCode(body);
  });

  it('range=all → published 卡环比 null（无上一区间基期，不裸造）', async () => {
    const db = new DashboardFakeDb();
    const me = 'user-me';
    seedCapability(db, me, { reviewStatus: 'published' });
    const ctx = makeReqReply({ userId: me, query: { range: 'all' }, db });
    await call(dashboardMetricsHandler(), ctx);
    const data = ctx.sent.body as {
      data: {
        range: string;
        cards: Array<{ deltaPercent: number | null; deltaDirection: string | null }>;
      };
    };
    expect(data.data.range).toBe('all');
    expect(data.data.cards[0]!.deltaPercent).toBeNull();
    expect(data.data.cards[0]!.deltaDirection).toBeNull();
  });

  it('range=7d → published 卡真实环比（当前窗新增 1、上一窗 0 → direction=up，percent null）', async () => {
    const db = new DashboardFakeDb();
    const me = 'user-me';
    // 当前 7 天窗内【新增】1（published_at 1 天前，明确在 [now-7d, now) 内、不卡 now 边界）；
    //   上一窗（[now-14d, now-7d)）无 → prev=0：当前新增 1 > 上一窗新增 0 → up；percent null（除 0 无意义）。
    seedCapability(db, me, {
      reviewStatus: 'published',
      publishedAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    });
    const ctx = makeReqReply({ userId: me, query: { range: '7d' }, db });
    await call(dashboardMetricsHandler(), ctx);
    const data = ctx.sent.body as {
      data: {
        cards: Array<{
          value: number | null;
          deltaDirection: string | null;
          deltaPercent: number | null;
        }>;
      };
    };
    expect(data.data.cards[0]!.value).toBe(1);
    expect(data.data.cards[0]!.deltaDirection).toBe('up');
    expect(data.data.cards[0]!.deltaPercent).toBeNull(); // prev=0 → percent 无意义
  });

  it('range 非法值 → 400 VALIDATION_FAILED（change_input，无 code）', async () => {
    const db = new DashboardFakeDb();
    const ctx = makeReqReply({ userId: 'user-me', query: { range: 'forever' }, db });
    await call(dashboardMetricsHandler(), ctx);
    expect(ctx.sent.code).toBe(400);
    expect((ctx.sent.body as { error: { action: string } }).error.action).toBe('change_input');
    assertNoCode(ctx.sent.body);
  });

  // —— 环比口径修正（Codex#r3 P1）：value=总数；delta 用两窗【新增】同口径，方向不误报 ——
  //   反向破坏：旧口径用「总数(current) vs 上一窗新增(previous)」会把这个场景误报 up（总数恒 >= 上一窗新增）。
  it('旧能力很多、当前窗口新增 0、上一窗口新增>0 → value=总数 + direction=down（不误报 up）', async () => {
    const db = new DashboardFakeDb();
    const me = 'user-me';
    const dayMs = 24 * 60 * 60 * 1000;
    const now = Date.now();
    // 一堆旧能力（早于上一窗，published_at 很久以前）：计入总数，但不计入任一窗口新增。
    for (let i = 0; i < 5; i += 1) {
      seedCapability(db, me, {
        reviewStatus: 'published',
        name: `old-${i}`,
        publishedAt: new Date(now - 100 * dayMs).toISOString(),
      });
    }
    // 上一 7 天窗 [now-14d, now-7d) 内新增 2 个；当前 7 天窗内新增 0。
    seedCapability(db, me, {
      reviewStatus: 'published',
      name: 'prev-1',
      publishedAt: new Date(now - 10 * dayMs).toISOString(),
    });
    seedCapability(db, me, {
      reviewStatus: 'published',
      name: 'prev-2',
      publishedAt: new Date(now - 9 * dayMs).toISOString(),
    });
    const ctx = makeReqReply({ userId: me, query: { range: '7d' }, db });
    await call(dashboardMetricsHandler(), ctx);
    const card = (
      ctx.sent.body as {
        data: { cards: Array<{ value: number | null; deltaDirection: string | null }> };
      }
    ).data.cards[0]!;
    expect(card.value).toBe(7); // value=总已发布数（5 旧 + 2 上一窗）
    expect(card.deltaDirection).toBe('down'); // 当前窗新增 0 < 上一窗新增 2 → down，绝不误报 up
  });

  it('当前窗新增 = 上一窗新增（都>0）→ direction=flat（同口径，不被总数干扰）', async () => {
    const db = new DashboardFakeDb();
    const me = 'user-me';
    const dayMs = 24 * 60 * 60 * 1000;
    const now = Date.now();
    // 当前 7 天窗内 1 个、上一 7 天窗内 1 个，外加旧能力若干。
    seedCapability(db, me, {
      reviewStatus: 'published',
      name: 'cur',
      publishedAt: new Date(now - 2 * dayMs).toISOString(),
    });
    seedCapability(db, me, {
      reviewStatus: 'published',
      name: 'prev',
      publishedAt: new Date(now - 9 * dayMs).toISOString(),
    });
    seedCapability(db, me, {
      reviewStatus: 'published',
      name: 'old',
      publishedAt: new Date(now - 100 * dayMs).toISOString(),
    });
    const ctx = makeReqReply({ userId: me, query: { range: '7d' }, db });
    await call(dashboardMetricsHandler(), ctx);
    const card = (
      ctx.sent.body as {
        data: { cards: Array<{ value: number | null; deltaDirection: string | null }> };
      }
    ).data.cards[0]!;
    expect(card.value).toBe(3);
    expect(card.deltaDirection).toBe('flat'); // 1 == 1 同口径 → flat
  });
});

// ===========================================================================
// §1.3 token 趋势：整图占位
// ===========================================================================
describe('GET /dashboard/token-trend（趋势双口径，§1.3）', () => {
  it('本期整图占位：points:[]、peak:null、empty:true + placeholders["points"]', async () => {
    const db = new DashboardFakeDb();
    const ctx = makeReqReply({ userId: 'user-me', query: { range: '30d', metric: 'tokens' }, db });
    await call(dashboardTokenTrendHandler(), ctx);
    expect(ctx.sent.code).toBe(200);
    const body = ctx.sent.body as EnvBody;
    expect(TokenTrendSchema.safeParse(body.data).success).toBe(true);
    const data = body.data as { points: unknown[]; peak: unknown; empty: boolean; metric: string };
    expect(data.points).toEqual([]);
    expect(data.peak).toBeNull();
    expect(data.empty).toBe(true);
    expect(body.meta?.placeholders?.points).toBe(USAGE_PLACEHOLDER_TEXT);
    assertNoCode(body);
  });

  it('切 metric=invocations 照常返回（不报错）；metric 回显', async () => {
    const db = new DashboardFakeDb();
    const ctx = makeReqReply({ userId: 'user-me', query: { metric: 'invocations' }, db });
    await call(dashboardTokenTrendHandler(), ctx);
    expect(ctx.sent.code).toBe(200);
    expect((ctx.sent.body as { data: { metric: string } }).data.metric).toBe('invocations');
  });
});

// ===========================================================================
// §1.4 能力表：状态单源 + usage 列占位 + 试用 + 拒绝态
// ===========================================================================
describe('GET /dashboard/capabilities（能力表，§1.4）', () => {
  it('状态列单源派生：alpha_pending/published/draft/review_rejected(回退)/unpublished(下架) 全覆盖 + statusLabel', async () => {
    const db = new DashboardFakeDb();
    const me = 'user-me';
    seedCapability(db, me, { reviewStatus: 'alpha_pending', name: 'A' });
    seedCapability(db, me, { reviewStatus: 'published', name: 'B' });
    seedCapability(db, me, { reviewStatus: null, name: 'C' }); // 无 publication → draft
    // 被拒回退：published + reject_reason 镜像 + 有上一 published 版（has_published_version=true）→ review_rejected 可见态
    seedCapability(db, me, {
      reviewStatus: 'published',
      reject_reason: undefined,
      rejectReason: '描述与能力不符',
      name: 'D',
      addRejectedVersion: true,
      addPublishedVersion: true,
    } as never);
    // 被拒下架：review_rejected + 无上一 published 版 → unpublished
    seedCapability(db, me, {
      reviewStatus: 'review_rejected',
      rejectReason: '内容不合规',
      name: 'E',
      addRejectedVersion: true,
    });

    const ctx = makeReqReply({ userId: me, db });
    await call(dashboardCapabilitiesHandler(), ctx);
    expect(ctx.sent.code).toBe(200);
    const body = ctx.sent.body as {
      data: Array<Record<string, unknown>>;
      meta: { page: { hasMore: boolean } };
    };
    for (const row of body.data) {
      expect(DashboardCapabilityRowSchema.safeParse(row).success).toBe(true);
    }
    const byName = (n: string) => body.data.find((r) => r.name === n)!;
    expect(byName('A').reviewStatus).toBe('alpha_pending');
    expect(byName('A').statusLabel).toBe('Alpha·审核中');
    expect(byName('B').reviewStatus).toBe('published');
    expect(byName('B').statusLabel).toBe('已上架');
    expect(byName('C').reviewStatus).toBe('draft');
    expect(byName('C').statusLabel).toBe('草稿');
    expect(byName('D').reviewStatus).toBe('review_rejected'); // 回退可见态
    expect(byName('D').statusLabel).toBe('已退回');
    expect(byName('D').rejectReason).toBe('描述与能力不符');
    expect(byName('D').retryEditable).toBe(true); // 有被拒版定位
    expect(byName('E').reviewStatus).toBe('unpublished'); // 被拒下架
    expect(byName('E').statusLabel).toBe('已下架');
  });

  it('usage 列（本月调用/消耗迷你图/收益）null + meta.placeholders 逐键标注；名称/简介真实', async () => {
    const db = new DashboardFakeDb();
    const me = 'user-me';
    seedCapability(db, me, {
      reviewStatus: 'published',
      name: '需求炼金师',
      tagline: '把对话炼成能力',
    });
    const ctx = makeReqReply({ userId: me, db });
    await call(dashboardCapabilitiesHandler(), ctx);
    const body = ctx.sent.body as EnvBody & { data: Array<Record<string, unknown>> };
    const row = body.data[0]!;
    expect(row.name).toBe('需求炼金师'); // 真实
    expect(row.tagline).toBe('把对话炼成能力'); // 真实
    expect(row.monthlyInvocations).toBeNull();
    expect(row.spendSparkline).toBeNull();
    expect(row.revenueMicros).toBeNull();
    expect(body.meta?.placeholders?.monthlyInvocations).toBe(USAGE_PLACEHOLDER_TEXT);
    expect(body.meta?.placeholders?.spendSparkline).toBe(USAGE_PLACEHOLDER_TEXT);
    expect(body.meta?.placeholders?.revenueMicros).toBe(USAGE_PLACEHOLDER_TEXT);
  });

  it('试用按钮在但本期未开放（actions.trial.enabled=false, hint）；edit/more 可达', async () => {
    const db = new DashboardFakeDb();
    const me = 'user-me';
    seedCapability(db, me, { reviewStatus: 'published' });
    const ctx = makeReqReply({ userId: me, db });
    await call(dashboardCapabilitiesHandler(), ctx);
    const row = (
      ctx.sent.body as {
        data: Array<{
          actions: { trial: { enabled: boolean; hint: string }; edit: boolean; more: boolean };
        }>;
      }
    ).data[0]!;
    expect(row.actions.trial.enabled).toBe(false);
    expect(row.actions.trial.hint).toBe('本期未开放');
    expect(row.actions.edit).toBe(true);
    expect(row.actions.more).toBe(true);
  });

  it('status=draft 过滤只回无 publication 行的能力', async () => {
    const db = new DashboardFakeDb();
    const me = 'user-me';
    seedCapability(db, me, { reviewStatus: 'published', name: 'pub' });
    seedCapability(db, me, { reviewStatus: null, name: 'draft1' });
    seedCapability(db, me, { reviewStatus: null, name: 'draft2' });
    const ctx = makeReqReply({ userId: me, query: { status: 'draft' }, db });
    await call(dashboardCapabilitiesHandler(), ctx);
    const names = (
      ctx.sent.body as { data: Array<{ name: string; reviewStatus: string }> }
    ).data.map((r) => r.name);
    expect(names.sort()).toEqual(['draft1', 'draft2']);
  });

  // —— status 过滤【镜像单源派生态】（Codex#r3 P1）：回退拒绝态（published + reject_reason）按 ——
  //   status=review_rejected 命中、按 status=published 排除。反向破坏：若过滤按 review_status 原始值，
  //   这两个断言都会红（原始值 review_status='published' → published 过滤反查到它、review_rejected 查不到）。
  it('status=review_rejected 过滤命中回退拒绝态（published + reject_reason，与展示层 review_rejected 一致）', async () => {
    const db = new DashboardFakeDb();
    const me = 'user-me';
    // 真退回（review_rejected）。
    seedCapability(db, me, {
      reviewStatus: 'review_rejected',
      rejectReason: '不合规',
      name: 'hard',
    });
    // 回退拒绝态：review_status='published' 但带 reject_reason 镜像（展示层归 review_rejected）。
    seedCapability(db, me, {
      reviewStatus: 'published',
      rejectReason: '描述与能力不符',
      name: 'fallback',
    });
    // 纯已发布（无 reject_reason）：不应命中 review_rejected 过滤。
    seedCapability(db, me, { reviewStatus: 'published', name: 'clean' });
    const ctx = makeReqReply({ userId: me, query: { status: 'review_rejected' }, db });
    await call(dashboardCapabilitiesHandler(), ctx);
    const names = (ctx.sent.body as { data: Array<{ name: string }> }).data.map((r) => r.name);
    expect(names.sort()).toEqual(['fallback', 'hard']); // 回退拒绝态命中、纯发布排除
  });

  it('status=published 过滤排除回退拒绝态（published + reject_reason 不算已发布，与展示层一致）', async () => {
    const db = new DashboardFakeDb();
    const me = 'user-me';
    seedCapability(db, me, { reviewStatus: 'published', name: 'clean' }); // 纯已发布 → 命中
    seedCapability(db, me, {
      reviewStatus: 'published',
      rejectReason: '描述与能力不符', // 回退拒绝态 → 排除
      name: 'fallback',
    });
    seedCapability(db, me, { reviewStatus: 'review_rejected', rejectReason: 'x', name: 'hard' });
    const ctx = makeReqReply({ userId: me, query: { status: 'published' }, db });
    await call(dashboardCapabilitiesHandler(), ctx);
    const names = (ctx.sent.body as { data: Array<{ name: string }> }).data.map((r) => r.name);
    expect(names).toEqual(['clean']); // 仅纯已发布；回退拒绝态被排除
  });

  it('status=alpha_pending 过滤只回审核中（与派生 pending_review 同口径）', async () => {
    const db = new DashboardFakeDb();
    const me = 'user-me';
    seedCapability(db, me, { reviewStatus: 'alpha_pending', name: 'pending' });
    seedCapability(db, me, { reviewStatus: 'published', name: 'pub' });
    const ctx = makeReqReply({ userId: me, query: { status: 'alpha_pending' }, db });
    await call(dashboardCapabilitiesHandler(), ctx);
    const names = (ctx.sent.body as { data: Array<{ name: string }> }).data.map((r) => r.name);
    expect(names).toEqual(['pending']);
  });

  it('cursor 锚为回退拒绝态、status=review_rejected → 锚仍在集合内（200 翻页，非 400 误判失效）', async () => {
    const db = new DashboardFakeDb();
    const me = 'user-me';
    // 锚 = 回退拒绝态（published + reject_reason）。它在 review_rejected 派生集合内，
    //   故按它翻页应 200（锚有效）；若锚点校验按 review_status 原始值，会误判它不在 review_rejected 集合 → 400。
    const anchor = seedCapability(db, me, {
      reviewStatus: 'published',
      rejectReason: '描述与能力不符',
      name: 'fallback',
    });
    seedCapability(db, me, { reviewStatus: 'review_rejected', rejectReason: 'y', name: 'hard' });
    const ctx = makeReqReply({
      userId: me,
      query: {
        status: 'review_rejected',
        order: 'asc',
        cursor: encodeIdCursor(anchor.capabilityId),
      },
      db,
    });
    await call(dashboardCapabilitiesHandler(), ctx);
    expect(ctx.sent.code).toBe(200); // 锚在派生集合内 → 翻页有效，非 400
  });

  it('cursor 分页：limit=1 → hasMore + nextCursor；翻第二页拿到剩余', async () => {
    const db = new DashboardFakeDb();
    const me = 'user-me';
    seedCapability(db, me, { reviewStatus: 'published', name: 'one' });
    seedCapability(db, me, { reviewStatus: 'published', name: 'two' });
    const p1 = makeReqReply({ userId: me, query: { limit: '1', order: 'asc' }, db });
    await call(dashboardCapabilitiesHandler(), p1);
    const b1 = p1.sent.body as {
      data: Array<{ capabilityId: string }>;
      meta: { page: { hasMore: boolean; nextCursor: string | null } };
    };
    expect(b1.data.length).toBe(1);
    expect(b1.meta.page.hasMore).toBe(true);
    expect(b1.meta.page.nextCursor).not.toBeNull();
    const p2 = makeReqReply({
      userId: me,
      query: { limit: '1', order: 'asc', cursor: b1.meta.page.nextCursor! },
      db,
    });
    await call(dashboardCapabilitiesHandler(), p2);
    const b2 = p2.sent.body as { data: Array<unknown>; meta: { page: { hasMore: boolean } } };
    expect(b2.data.length).toBe(1);
    expect(b2.meta.page.hasMore).toBe(false);
  });

  it('非本人能力不出现（owner 守门）：只回本人行', async () => {
    const db = new DashboardFakeDb();
    seedCapability(db, 'user-me', { reviewStatus: 'published', name: 'mine' });
    seedCapability(db, 'other', { reviewStatus: 'published', name: 'theirs' });
    const ctx = makeReqReply({ userId: 'user-me', db });
    await call(dashboardCapabilitiesHandler(), ctx);
    const names = (ctx.sent.body as { data: Array<{ name: string }> }).data.map((r) => r.name);
    expect(names).toEqual(['mine']);
  });

  it('cursor 畸形（非不透明编码）→ 400 VALIDATION_FAILED（非静默错页/非 500，Codex r1#2）', async () => {
    const db = new DashboardFakeDb();
    seedCapability(db, 'user-me', { reviewStatus: 'published', name: 'mine' });
    const ctx = makeReqReply({ userId: 'user-me', query: { cursor: 'raw-id-not-encoded' }, db });
    await call(dashboardCapabilitiesHandler(), ctx);
    expect(ctx.sent.code).toBe(400);
    expect((ctx.sent.body as { error: { action: string } }).error.action).toBe('change_input');
    assertNoCode(ctx.sent.body);
  });

  // —— 锚点归属校验（合法编码但锚不属当前 owner+status 集合 → 400，Codex r2 P1）——
  //   反向破坏：若只校验编码格式不校验锚点归属 → 这些用例会静默错页/空页 200（测应红）。
  it('cursor 合法编码但锚 id 不存在 → 400 VALIDATION_FAILED（失效锚，非静默错页/空页）', async () => {
    const db = new DashboardFakeDb();
    seedCapability(db, 'user-me', { reviewStatus: 'published', name: 'mine' });
    const ctx = makeReqReply({
      userId: 'user-me',
      query: { cursor: encodeIdCursor('cap-does-not-exist') },
      db,
    });
    await call(dashboardCapabilitiesHandler(), ctx);
    expect(ctx.sent.code).toBe(400);
    expect((ctx.sent.body as { error: { action: string } }).error.action).toBe('change_input');
    assertNoCode(ctx.sent.body);
  });

  it('cursor 锚 id 属他人 owner → 400（不静默翻他人翻页 / 不空页）', async () => {
    const db = new DashboardFakeDb();
    seedCapability(db, 'user-me', { reviewStatus: 'published', name: 'mine' });
    const theirs = seedCapability(db, 'other', { reviewStatus: 'published', name: 'theirs' });
    const ctx = makeReqReply({
      userId: 'user-me',
      query: { cursor: encodeIdCursor(theirs.capabilityId) },
      db,
    });
    await call(dashboardCapabilitiesHandler(), ctx);
    expect(ctx.sent.code).toBe(400);
    expect((ctx.sent.body as { error: { action: string } }).error.action).toBe('change_input');
  });

  it('cursor 锚 id 被当前 status 筛掉（本人但状态不匹配）→ 400（失效锚，非空页 200）', async () => {
    const db = new DashboardFakeDb();
    const me = 'user-me';
    const drafted = seedCapability(db, me, { reviewStatus: null, name: 'draft-cap' }); // draft 态
    seedCapability(db, me, { reviewStatus: 'published', name: 'pub-cap' });
    // 用 status=published 过滤，但锚指向 draft 能力（在 published 集合外）→ 失效锚。
    const ctx = makeReqReply({
      userId: me,
      query: { status: 'published', cursor: encodeIdCursor(drafted.capabilityId) },
      db,
    });
    await call(dashboardCapabilitiesHandler(), ctx);
    expect(ctx.sent.code).toBe(400);
    expect((ctx.sent.body as { error: { action: string } }).error.action).toBe('change_input');
  });

  it('正常空尾页 vs 无效锚：有效 cursor 翻到真实最后一页空尾 → 200（不误判 400）', async () => {
    const db = new DashboardFakeDb();
    const me = 'user-me';
    // 仅 1 条；用它做锚翻页 → 锚有效且在集合内，比较后无更多行 → 200 空页（非 400）。
    const only = seedCapability(db, me, { reviewStatus: 'published', name: 'only' });
    const ctx = makeReqReply({
      userId: me,
      query: { order: 'asc', cursor: encodeIdCursor(only.capabilityId) },
      db,
    });
    await call(dashboardCapabilitiesHandler(), ctx);
    expect(ctx.sent.code).toBe(200); // 有效锚的正常空尾页，不误判 400
    const body = ctx.sent.body as { data: unknown[]; meta: { page: { hasMore: boolean } } };
    expect(body.data).toEqual([]);
    expect(body.meta.page.hasMore).toBe(false);
  });
});

// ===========================================================================
// §1.5 草稿条：只 active + 落点 + 空态
// ===========================================================================
describe('GET /dashboard/drafts（草稿条，§1.5）', () => {
  it('只返 active 草稿（completed/abandoned 不上条）；携 currentStep + stepProgress + 落点', async () => {
    const db = new DashboardFakeDb();
    const me = 'user-me';
    seedDraft(db, me, {
      status: 'active',
      currentStep: 'structure',
      percent: 60,
      phrase: '结构化中 60%',
      title: '炼金',
      snapshotId: 'snap-1',
    });
    seedDraft(db, me, { status: 'completed' });
    seedDraft(db, me, { status: 'abandoned' });
    const ctx = makeReqReply({ userId: me, db });
    await call(dashboardDraftsHandler(), ctx);
    expect(ctx.sent.code).toBe(200);
    const body = ctx.sent.body as { data: Array<Record<string, unknown>> };
    expect(body.data.length).toBe(1);
    const d = body.data[0]!;
    expect(DraftViewSchema.safeParse(d).success).toBe(true);
    expect(d.status).toBe('active');
    expect(d.currentStep).toBe('structure');
    expect((d.stepProgress as { percent: number; phrase: string }).percent).toBe(60);
    expect((d.stepProgress as { phrase: string }).phrase).toBe('结构化中 60%');
    expect(d.snapshotId).toBe('snap-1');
    expect(d.title).toBe('炼金');
  });

  it('多条逐条独立不串台（各自 id/落点）', async () => {
    const db = new DashboardFakeDb();
    const me = 'user-me';
    const a = seedDraft(db, me, { title: 'A', currentStep: 'extract', snapshotId: 'snap-A' });
    const b = seedDraft(db, me, { title: 'B', currentStep: 'publish', snapshotId: 'snap-B' });
    const ctx = makeReqReply({ userId: me, query: { order: 'asc' }, db });
    await call(dashboardDraftsHandler(), ctx);
    const data = (
      ctx.sent.body as { data: Array<{ id: string; title: string; snapshotId: string }> }
    ).data;
    const byId = (id: string) => data.find((d) => d.id === id)!;
    expect(byId(a).title).toBe('A');
    expect(byId(a).snapshotId).toBe('snap-A');
    expect(byId(b).title).toBe('B');
    expect(byId(b).snapshotId).toBe('snap-B');
  });

  it('空态（无 active 草稿）→ data:[] + hasMore:false（不出空白胶囊）', async () => {
    const db = new DashboardFakeDb();
    const ctx = makeReqReply({ userId: 'user-me', db });
    await call(dashboardDraftsHandler(), ctx);
    expect(ctx.sent.code).toBe(200);
    const body = ctx.sent.body as { data: unknown[]; meta: { page: { hasMore: boolean } } };
    expect(body.data).toEqual([]);
    expect(body.meta.page.hasMore).toBe(false);
  });

  it('非本人草稿不出现（owner 守门）', async () => {
    const db = new DashboardFakeDb();
    seedDraft(db, 'user-me', { title: 'mine' });
    seedDraft(db, 'other', { title: 'theirs' });
    const ctx = makeReqReply({ userId: 'user-me', db });
    await call(dashboardDraftsHandler(), ctx);
    const titles = (ctx.sent.body as { data: Array<{ title: string }> }).data.map((d) => d.title);
    expect(titles).toEqual(['mine']);
  });

  it('cursor 畸形 → 400 VALIDATION_FAILED（非静默错页/非 500，Codex r1#2）', async () => {
    const db = new DashboardFakeDb();
    seedDraft(db, 'user-me', { title: 'mine' });
    const ctx = makeReqReply({ userId: 'user-me', query: { cursor: 'raw-id-not-encoded' }, db });
    await call(dashboardDraftsHandler(), ctx);
    expect(ctx.sent.code).toBe(400);
    expect((ctx.sent.body as { error: { action: string } }).error.action).toBe('change_input');
    assertNoCode(ctx.sent.body);
  });

  // —— 锚点归属校验（合法编码但锚不属当前 owner + active 集合 → 400，Codex r2 P1）——
  it('cursor 合法编码但锚 id 不存在 → 400（失效锚，非静默错页/空页）', async () => {
    const db = new DashboardFakeDb();
    seedDraft(db, 'user-me', { title: 'mine' });
    const ctx = makeReqReply({
      userId: 'user-me',
      query: { cursor: encodeIdCursor('draft-does-not-exist') },
      db,
    });
    await call(dashboardDraftsHandler(), ctx);
    expect(ctx.sent.code).toBe(400);
    expect((ctx.sent.body as { error: { action: string } }).error.action).toBe('change_input');
    assertNoCode(ctx.sent.body);
  });

  it('cursor 锚 id 属他人 owner → 400（不静默翻他人翻页 / 不空页）', async () => {
    const db = new DashboardFakeDb();
    seedDraft(db, 'user-me', { title: 'mine' });
    const theirs = seedDraft(db, 'other', { title: 'theirs' });
    const ctx = makeReqReply({
      userId: 'user-me',
      query: { cursor: encodeIdCursor(theirs) },
      db,
    });
    await call(dashboardDraftsHandler(), ctx);
    expect(ctx.sent.code).toBe(400);
    expect((ctx.sent.body as { error: { action: string } }).error.action).toBe('change_input');
  });

  it('cursor 锚 id 被 status 筛掉（completed/abandoned，非 active 集合）→ 400（失效锚，非空页 200）', async () => {
    const db = new DashboardFakeDb();
    const me = 'user-me';
    seedDraft(db, me, { status: 'active', title: 'live' });
    const done = seedDraft(db, me, { status: 'completed', title: 'done' }); // 不在 active 集合
    const ctx = makeReqReply({ userId: me, query: { cursor: encodeIdCursor(done) }, db });
    await call(dashboardDraftsHandler(), ctx);
    expect(ctx.sent.code).toBe(400);
    expect((ctx.sent.body as { error: { action: string } }).error.action).toBe('change_input');
  });

  it('正常空尾页 vs 无效锚：有效 cursor 翻到真实最后一页空尾 → 200（不误判 400）', async () => {
    const db = new DashboardFakeDb();
    const me = 'user-me';
    const only = seedDraft(db, me, { status: 'active', title: 'only' });
    const ctx = makeReqReply({
      userId: me,
      query: { order: 'asc', cursor: encodeIdCursor(only) },
      db,
    });
    await call(dashboardDraftsHandler(), ctx);
    expect(ctx.sent.code).toBe(200); // 有效锚的正常空尾页，不误判 400
    const body = ctx.sent.body as { data: unknown[]; meta: { page: { hasMore: boolean } } };
    expect(body.data).toEqual([]);
    expect(body.meta.page.hasMore).toBe(false);
  });
});

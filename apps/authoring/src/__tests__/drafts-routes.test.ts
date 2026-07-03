// 00 · 草稿生命周期 API 自检（脊柱 §8，开工总纲 §5.0；Codex phase4c P0-2）。忠实假 PG，无真 PG。
//   重点（契约 + 铁律）：
//     · POST /drafts → 201 Envelope<DraftView>（含 draftId，active/import，前端贯穿基线）。
//     · GET /drafts/:draftId → 200 完整 DraftView（owner 守卫：非本人/不存在 → 404，不暴露存在性）。
//     · 未登录 → 401；title 非法 → 422；DB 抛错 → 500 人话可重试。对外信封绝不含 code（D1）。
import { describe, it, expect } from 'vitest';
import type { RouteHandlerMethod } from 'fastify';
import { DraftViewSchema, ErrorEnvelopeSchema } from '@cb/shared';
import { createDraftHandler, getDraftHandler } from '../modules/drafts/handlers.js';
import { createDraft } from '../modules/drafts/repo.js';

interface DraftRowF {
  id: string;
  owner_user_id: string;
  status: string;
  current_step: string;
  step_progress: unknown;
  title: string | null;
  snapshot_id: string | null;
  extract_job_id: string | null;
  selection: unknown;
  version_id: string | null;
  capability_id: string | null;
  batch_id: string | null;
  created_at: string;
  updated_at: string;
}

let seq = 0;

class DraftsFakeDb {
  rows = new Map<string, DraftRowF>();
  throwOnNext = false;

  async query<R = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<{ rows: R[]; rowCount: number | null }> {
    if (this.throwOnNext) {
      this.throwOnNext = false;
      throw new Error('injected db failure');
    }
    if (sql.includes('INSERT INTO drafts') && sql.includes('RETURNING')) {
      seq += 1;
      const id = `draft-${seq}`;
      const now = new Date(1781600000000 + seq * 1000).toISOString();
      const row: DraftRowF = {
        id,
        owner_user_id: params[0] as string,
        status: 'active',
        current_step: 'import',
        step_progress: {},
        title: (params[1] as string | null) ?? null,
        snapshot_id: null,
        extract_job_id: null,
        selection: null,
        version_id: null,
        capability_id: null,
        batch_id: null,
        created_at: now,
        updated_at: now,
      };
      this.rows.set(id, row);
      return { rows: [row as unknown as R], rowCount: 1 };
    }
    if (sql.includes('FROM drafts') && sql.trimStart().startsWith('SELECT')) {
      const r = this.rows.get(params[0] as string);
      if (!r || r.owner_user_id !== params[1] || r.status !== 'active') {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [r as unknown as R], rowCount: 1 };
    }
    throw new Error(`DraftsFakeDb: unhandled SQL: ${sql.slice(0, 80)}`);
  }
}

interface Sent {
  code: number;
  body: unknown;
}
function makeCtx(opts: {
  userId?: string;
  body?: unknown;
  params?: Record<string, string>;
  db: DraftsFakeDb;
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
    id: 'trace-draft-1',
    auth: opts.userId ? { userId: opts.userId } : undefined,
    body: opts.body,
    params: opts.params ?? {},
    headers: {},
    log: { error() {}, warn() {} },
    server: { infra: { db: opts.db } },
  };
  return { req, reply, sent };
}
async function call(h: RouteHandlerMethod, ctx: ReturnType<typeof makeCtx>): Promise<void> {
  await (h as (req: unknown, reply: unknown) => Promise<unknown>).call(
    undefined,
    ctx.req,
    ctx.reply,
  );
}
function assertNoCode(body: unknown): void {
  expect(JSON.stringify(body)).not.toMatch(/"code"/);
}

const OWNER = 'user-me';
const OTHER = 'user-other';

describe('POST /drafts（草稿 bootstrap，§8）', () => {
  it('201 Envelope<DraftView>（含 draftId，active/import）', async () => {
    const db = new DraftsFakeDb();
    const ctx = makeCtx({ userId: OWNER, body: { title: '我的能力' }, db });
    await call(createDraftHandler(), ctx);
    expect(ctx.sent.code).toBe(201);
    const body = ctx.sent.body as { data: unknown };
    const view = DraftViewSchema.parse(body.data); // 契约形态校验。
    expect(view.id).toBeTruthy();
    expect(view.status).toBe('active');
    expect(view.currentStep).toBe('import');
    expect(view.title).toBe('我的能力');
  });

  it('空 body（无 title）→ 201（title 可选）', async () => {
    const db = new DraftsFakeDb();
    const ctx = makeCtx({ userId: OWNER, body: {}, db });
    await call(createDraftHandler(), ctx);
    expect(ctx.sent.code).toBe(201);
  });

  it('未登录 → 401（不裸 code）', async () => {
    const db = new DraftsFakeDb();
    const ctx = makeCtx({ db, body: {} });
    await call(createDraftHandler(), ctx);
    expect(ctx.sent.code).toBe(401);
    assertNoCode(ctx.sent.body);
  });

  it('title 非法（空串）→ 422 人话（change_input，不裸 code）', async () => {
    const db = new DraftsFakeDb();
    const ctx = makeCtx({ userId: OWNER, body: { title: '' }, db });
    await call(createDraftHandler(), ctx);
    expect(ctx.sent.code).toBe(422);
    const env = ErrorEnvelopeSchema.parse(ctx.sent.body);
    expect(env.error.action).toBe('change_input');
    assertNoCode(ctx.sent.body);
  });

  it('DB 抛错 → 500 人话可重试（不裸 code/堆栈）', async () => {
    const db = new DraftsFakeDb();
    db.throwOnNext = true;
    const ctx = makeCtx({ userId: OWNER, body: {}, db });
    await call(createDraftHandler(), ctx);
    expect(ctx.sent.code).toBe(500);
    const env = ErrorEnvelopeSchema.parse(ctx.sent.body);
    expect(env.error.action).toBe('retry');
    assertNoCode(ctx.sent.body);
  });
});

describe('GET /drafts/:draftId（读完整 DraftView，续传 hydrate，§8.4）', () => {
  it('200 完整 DraftView（本人）', async () => {
    const db = new DraftsFakeDb();
    const created = await createDraft(db, { ownerUserId: OWNER, title: 'X' });
    const ctx = makeCtx({ userId: OWNER, params: { draftId: created.id }, db });
    await call(getDraftHandler(), ctx);
    expect(ctx.sent.code).toBe(200);
    const body = ctx.sent.body as { data: unknown };
    const view = DraftViewSchema.parse(body.data);
    expect(view.id).toBe(created.id);
    expect(view.currentStep).toBe('import');
  });

  it('owner 守卫：非本人读 → 404（不暴露存在性，不裸 code）', async () => {
    const db = new DraftsFakeDb();
    const created = await createDraft(db, { ownerUserId: OWNER });
    const ctx = makeCtx({ userId: OTHER, params: { draftId: created.id }, db });
    await call(getDraftHandler(), ctx);
    expect(ctx.sent.code).toBe(404);
    assertNoCode(ctx.sent.body);
  });

  it('不存在草稿 → 404', async () => {
    const db = new DraftsFakeDb();
    const ctx = makeCtx({ userId: OWNER, params: { draftId: 'nope' }, db });
    await call(getDraftHandler(), ctx);
    expect(ctx.sent.code).toBe(404);
  });

  it('未登录 → 401', async () => {
    const db = new DraftsFakeDb();
    const ctx = makeCtx({ params: { draftId: 'x' }, db });
    await call(getDraftHandler(), ctx);
    expect(ctx.sent.code).toBe(401);
  });
});

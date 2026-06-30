// 40 结构化 API handler 自检（B-24 建体三选一 + B-25 起结构化 + B-26 改/重生成软字段 + STEP③ 存草稿）。
//   重点（40 §4 契约）：
//     · 建体三选一：sourceCandidate 建首版 / capabilityId published 后建新版本(bump minor) / fromVersionId 被拒重发派生；
//       恰好三选一（零个/多个 → 422）；非本人 404、被拒版非本人 403、状态不符 409。
//     · 读 manifest：软硬分层 ManifestView(locked + structureState)；owner 守门(404/403)。
//     · 起结构化：202 + jobId/eventsUrl/structureState；建 jobs(type=structure, mode=full)；非 draft 409；同 version 回放。
//     · 改软字段：仅软字段；硬字段键 → 422 HARD_FIELD_LOCKED；published → 409；改 instructions 派生 inputs.schema。
//     · 单字段重生成：仅该字段 generating（其余不丢）；硬字段 path → 422；建 mode=single-field job；published → 409。
//     · STEP③ 存草稿：持久化 selection + current_step='select'；owner 守门(404/403)；不建任何 job/能力体。
//     · 鉴权：未登录 401；对外信封绝不含 code（D1）。
import { describe, it, expect } from 'vitest';
import type { RouteHandlerMethod } from 'fastify';
import type { StructureState } from '@cb/shared';
import {
  patchSelectionHandler,
  createCapabilityHandler,
  getManifestHandler,
  startStructureHandler,
  patchManifestHandler,
  regenerateFieldHandler,
} from '../modules/structure/handlers.js';
import {
  StructureRoutesFakeDb,
  FakeQueue,
  seedCandidate,
  seedCapabilityWithVersion,
  seedDraft,
} from './structure-routes-fakes.js';
import { initialManifest, applySoftFields, setFieldState } from '../modules/structure/manifest.js';

interface Sent {
  code: number;
  body: unknown;
}
function makeReqReply(opts: {
  userId?: string;
  params?: Record<string, string>;
  body?: unknown;
  db: StructureRoutesFakeDb;
  queue?: FakeQueue;
  /** 请求头（If-Match 乐观锁等）。 */
  headers?: Record<string, string>;
}) {
  const sent: Sent = { code: 0, body: undefined };
  // 响应头捕获（ETag 等，§4.E）。
  const headers: Record<string, string> = {};
  const reply = {
    code(c: number) {
      sent.code = c;
      return this;
    },
    send(b: unknown) {
      sent.body = b;
      return this;
    },
    header(k: string, v: string) {
      headers[k] = v;
      return this;
    },
  };
  const req = {
    id: 'trace-1',
    auth: opts.userId ? { userId: opts.userId } : undefined,
    params: opts.params ?? {},
    body: opts.body,
    headers: opts.headers ?? {},
    server: { infra: { db: opts.db, queue: opts.queue ?? new FakeQueue() } },
  };
  return { req, reply, sent, headers };
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

// ===========================================================================
// A · POST /capabilities — 建能力体 draft 版本（三选一，§4.A）
// ===========================================================================
describe('createCapabilityHandler (§4.A)', () => {
  it('① sourceCandidateId → 201 建首版(0.1.0) + 硬字段锁定 + 软字段空 + structure_state 软 pending/硬 locked', async () => {
    const db = new StructureRoutesFakeDb();
    const candidateId = seedCandidate(db, 'u1', { name: '需求炼金师' });
    const ctx = makeReqReply({ userId: 'u1', body: { sourceCandidateId: candidateId }, db });
    await call(createCapabilityHandler(), ctx);
    expect(ctx.sent.code).toBe(201);
    const r = dataOf<{
      capabilityId: string;
      versionId: string;
      slug: string;
      version: string;
      manifest: { status: string; name: string; id: string };
      structureState: { fields: Array<{ field: string; status: string }>; totalCount: number };
    }>(ctx.sent.body);
    expect(r.version).toBe('0.1.0');
    expect(r.manifest.status).toBe('draft');
    expect(r.manifest.name).toBe(''); // 软字段空待结构化
    expect(r.manifest.id).toBe(r.capabilityId); // 硬字段 id = capabilityId
    // structure_state：软字段全 pending、硬字段 locked、totalCount=7（只数软字段）。
    expect(r.structureState.totalCount).toBe(7);
    const name = r.structureState.fields.find((f) => f.field === 'name')!;
    expect(name.status).toBe('pending');
    const idF = r.structureState.fields.find((f) => f.field === 'id')!;
    expect(idF.status).toBe('locked');
    // 建了 capabilities + capability_versions（血缘 source_candidate_id）。
    expect(db.capabilities.size).toBe(1);
    expect(db.versions.size).toBe(1);
    const ver = [...db.versions.values()][0]!;
    expect(ver.source_candidate_id).toBe(candidateId);
    assertNoCode(ctx.sent.body);
  });

  it('① 带 draftId → 同事务回填 draft.version_id + current_step=structure + selection(single)', async () => {
    const db = new StructureRoutesFakeDb();
    const candidateId = seedCandidate(db, 'u1');
    const draftId = seedDraft(db, 'u1');
    const ctx = makeReqReply({
      userId: 'u1',
      body: { sourceCandidateId: candidateId, draftId },
      db,
    });
    await call(createCapabilityHandler(), ctx);
    expect(ctx.sent.code).toBe(201);
    const d = db.drafts.get(draftId)!;
    expect(d.current_step).toBe('structure');
    expect(d.version_id).toBe(dataOf<{ versionId: string }>(ctx.sent.body).versionId);
    expect(d.selection).toEqual({ mode: 'single', candidateId });
  });

  it('① 候选非本人 → 404（不暴露存在性，无 code，绝不建能力体）', async () => {
    const db = new StructureRoutesFakeDb();
    const candidateId = seedCandidate(db, 'owner');
    const ctx = makeReqReply({ userId: 'attacker', body: { sourceCandidateId: candidateId }, db });
    await call(createCapabilityHandler(), ctx);
    expect(ctx.sent.code).toBe(404);
    expect(db.capabilities.size).toBe(0);
    assertNoCode(ctx.sent.body);
  });

  it('① 两个 CJK 名候选 → 各建独立能力体（slug 经 candidateId 种子 hash 后缀区分，唯一）', async () => {
    // slugify 对纯 CJK 名退回「cap-<hash(candidateId)>」，故同名不同候选 slug 不同（不撞重）。
    const db = new StructureRoutesFakeDb();
    const c1 = seedCandidate(db, 'u1', { name: '炼金师' });
    const c2 = seedCandidate(db, 'u1', { name: '炼金师' });
    const a = makeReqReply({ userId: 'u1', body: { sourceCandidateId: c1 }, db });
    await call(createCapabilityHandler(), a);
    const b = makeReqReply({ userId: 'u1', body: { sourceCandidateId: c2 }, db });
    await call(createCapabilityHandler(), b);
    expect(a.sent.code).toBe(201);
    expect(b.sent.code).toBe(201);
    expect(db.capabilities.size).toBe(2);
    const slugs = new Set([...db.capabilities.values()].map((c) => c.slug));
    expect(slugs.size).toBe(2); // slug 唯一
  });

  it('① 同候选重复 POST（CJK 名 slug 撞 uq_capabilities_slug）→ 409 STATE_CONFLICT 干净信封（非 503、不可重试、无 code，BUG-2）', async () => {
    // BUG-2：CJK 候选名 slugify 回退成 cap-{hash(candidateId)}，同候选两次产同 slug → 第二次撞唯一约束。
    //   修前：原始 PG 23505 落 handler catch-all → 503 DEPENDENCY_UNAVAILABLE「系统正在恢复」（retriable 但重试永不成功）。
    //   修后：映射成 409 STATE_CONFLICT「这个能力已经创建过了」（action=none、retriable=false）。
    const db = new StructureRoutesFakeDb();
    const candidateId = seedCandidate(db, 'u1', { name: '需求炼金师' }); // 纯 CJK 名 → slug 走 hash 后缀
    const first = makeReqReply({ userId: 'u1', body: { sourceCandidateId: candidateId }, db });
    await call(createCapabilityHandler(), first);
    expect(first.sent.code).toBe(201); // 首次建体成功
    expect(db.capabilities.size).toBe(1);

    const second = makeReqReply({ userId: 'u1', body: { sourceCandidateId: candidateId }, db });
    await call(createCapabilityHandler(), second);
    // 干净 409 冲突（不是 503）：同候选重复创建。
    expect(second.sent.code).toBe(409);
    const err = (second.sent.body as { error: { retriable: boolean; action: string } }).error;
    expect(err.retriable).toBe(false); // 冲突不可重试（修前 503 是 retriable=true 永远失败）
    expect(err.action).toBe('none');
    expect(errOf(second.sent.body).userMessage).toContain('已经创建过');
    assertNoCode(second.sent.body); // 对外无 code（D1）
    // 第二次未新建第二个能力体（事务回滚 / 冲突）。
    expect(db.capabilities.size).toBe(1);
  });

  it('① 注入 23505 + constraint=uq_capabilities_slug → 409 STATE_CONFLICT 干净信封（正例保留：精确约束名命中）', async () => {
    // Codex 收紧后正例：精确约束名命中仍判 slug 冲突 → 409（非 503、不可重试、无 code）。
    const db = new StructureRoutesFakeDb();
    const candidateId = seedCandidate(db, 'u1', { name: '需求炼金师' });
    const e = new Error(
      'duplicate key value violates unique constraint "uq_capabilities_slug"',
    ) as Error & { code: string; constraint: string };
    e.code = '23505';
    e.constraint = 'uq_capabilities_slug';
    db.nextInsertCapabilityError = e;
    const ctx = makeReqReply({ userId: 'u1', body: { sourceCandidateId: candidateId }, db });
    await call(createCapabilityHandler(), ctx);
    expect(ctx.sent.code).toBe(409);
    const err = (ctx.sent.body as { error: { retriable: boolean; action: string } }).error;
    expect(err.retriable).toBe(false);
    expect(err.action).toBe('none');
    expect(errOf(ctx.sent.body).userMessage).toContain('已经创建过');
    assertNoCode(ctx.sent.body);
  });

  it('① 负例：23505 + constraint=uq_capability_version（非 slug 唯一约束）→ 不变 409，走原 DB 异常路径 503（可重试）', async () => {
    // Codex 收紧：同事务其它唯一约束（如 uq_capability_version）的 23505 绝不能被误判成 slug 冲突 409。
    //   应继续落 handler catch-all → 503 DEPENDENCY_UNAVAILABLE（retriable=true），而非干净 409。
    const db = new StructureRoutesFakeDb();
    const candidateId = seedCandidate(db, 'u1', { name: '需求炼金师' });
    const e = new Error(
      'duplicate key value violates unique constraint "uq_capability_version"',
    ) as Error & { code: string; constraint: string };
    e.code = '23505';
    e.constraint = 'uq_capability_version';
    db.nextInsertCapabilityError = e;
    const ctx = makeReqReply({ userId: 'u1', body: { sourceCandidateId: candidateId }, db });
    await call(createCapabilityHandler(), ctx);
    expect(ctx.sent.code).not.toBe(409); // 不能被误判成 slug 冲突
    expect(ctx.sent.code).toBe(503); // 走原 DB 异常路径
    const err = (ctx.sent.body as { error: { retriable: boolean } }).error;
    expect(err.retriable).toBe(true); // DB 异常可重试（slug 冲突则不可重试）
    assertNoCode(ctx.sent.body);
  });

  it('① 负例：23505 空 constraint/message（无约束名兜底已删）→ 不变 409，走原 DB 异常路径 503（可重试）', async () => {
    // Codex 收紧：删掉「空 constraint/message 也归 slug 冲突」的兜底；裸 23505 应继续走原 DB 异常路径（503），不变 409。
    const db = new StructureRoutesFakeDb();
    const candidateId = seedCandidate(db, 'u1', { name: '需求炼金师' });
    const e = { code: '23505' }; // 无 constraint、无 message
    db.nextInsertCapabilityError = e;
    const ctx = makeReqReply({ userId: 'u1', body: { sourceCandidateId: candidateId }, db });
    await call(createCapabilityHandler(), ctx);
    expect(ctx.sent.code).not.toBe(409); // 不能被误判成 slug 冲突
    expect(ctx.sent.code).toBe(503); // 走原 DB 异常路径
    const err = (ctx.sent.body as { error: { retriable: boolean } }).error;
    expect(err.retriable).toBe(true);
    assertNoCode(ctx.sent.body);
  });

  it('② capabilityId 当前版已 published → 201 建新 draft 版本 bump minor(0.2.0)', async () => {
    const db = new StructureRoutesFakeDb();
    const seeded = seedCapabilityWithVersion(db, 'u1', {
      versionStatus: 'published',
      version: '0.1.0',
      isCurrent: true,
    });
    const ctx = makeReqReply({ userId: 'u1', body: { capabilityId: seeded.capabilityId }, db });
    await call(createCapabilityHandler(), ctx);
    expect(ctx.sent.code).toBe(201);
    const r = dataOf<{ version: string; slug: string; capabilityId: string }>(ctx.sent.body);
    expect(r.version).toBe('0.2.0');
    expect(r.slug).toBe(seeded.slug); // slug 不变（沿用能力体）
    expect(r.capabilityId).toBe(seeded.capabilityId);
    expect(db.versions.size).toBe(2); // 原 published + 新 draft
  });

  it('② capabilityId 当前版仍 draft（未发布）→ 409 STATE_CONFLICT（需已发布版本）', async () => {
    const db = new StructureRoutesFakeDb();
    const seeded = seedCapabilityWithVersion(db, 'u1', {
      versionStatus: 'draft',
      isCurrent: true,
    });
    const ctx = makeReqReply({ userId: 'u1', body: { capabilityId: seeded.capabilityId }, db });
    await call(createCapabilityHandler(), ctx);
    expect(ctx.sent.code).toBe(409);
    assertNoCode(ctx.sent.body);
  });

  it('③ fromVersionId 源版 review_rejected 属本人 → 201 派生新 draft + 复制软字段 + bump minor', async () => {
    const db = new StructureRoutesFakeDb();
    const rejManifest = applySoftFields(initialManifest('cap-x', '0.3.0'), {
      name: '被拒能力',
      instructions: '第一步：{{topic|主题}}。',
    });
    const seeded = seedCapabilityWithVersion(db, 'u1', {
      versionStatus: 'review_rejected',
      version: '0.3.0',
      manifest: rejManifest,
    });
    const ctx = makeReqReply({ userId: 'u1', body: { fromVersionId: seeded.versionId }, db });
    await call(createCapabilityHandler(), ctx);
    expect(ctx.sent.code).toBe(201);
    const r = dataOf<{
      version: string;
      capabilityId: string;
      manifest: { name: string; inputs: { fields: Array<{ key: string }> } };
    }>(ctx.sent.body);
    expect(r.version).toBe('0.4.0'); // bump minor
    expect(r.capabilityId).toBe(seeded.capabilityId); // 同能力体续命脉
    expect(r.manifest.name).toBe('被拒能力'); // 复制软字段
    expect(r.manifest.inputs.fields.some((f) => f.key === 'topic')).toBe(true); // 派生 inputs.schema
    // 原被拒版不动（终态不可变）。
    expect(db.versions.get(seeded.versionId)!.status).toBe('review_rejected');
  });

  it('③ fromVersionId 源版属他人 → 403 FORBIDDEN', async () => {
    const db = new StructureRoutesFakeDb();
    const seeded = seedCapabilityWithVersion(db, 'owner', { versionStatus: 'review_rejected' });
    const ctx = makeReqReply({ userId: 'attacker', body: { fromVersionId: seeded.versionId }, db });
    await call(createCapabilityHandler(), ctx);
    expect(ctx.sent.code).toBe(403);
    assertNoCode(ctx.sent.body);
  });

  it('③ fromVersionId 源版非 review_rejected（draft）→ 409 STATE_CONFLICT', async () => {
    const db = new StructureRoutesFakeDb();
    const seeded = seedCapabilityWithVersion(db, 'u1', { versionStatus: 'draft' });
    const ctx = makeReqReply({ userId: 'u1', body: { fromVersionId: seeded.versionId }, db });
    await call(createCapabilityHandler(), ctx);
    expect(ctx.sent.code).toBe(409);
  });

  it('恰好三选一：零个 source → 422 VALIDATION_FAILED（change_input）', async () => {
    const db = new StructureRoutesFakeDb();
    const ctx = makeReqReply({ userId: 'u1', body: {}, db });
    await call(createCapabilityHandler(), ctx);
    expect(ctx.sent.code).toBe(400); // VALIDATION_FAILED http=400
    expect(errOf(ctx.sent.body).action).toBe('change_input');
    assertNoCode(ctx.sent.body);
  });

  it('恰好三选一：两个 source 并存 → 422 拒（不建任何产物）', async () => {
    const db = new StructureRoutesFakeDb();
    const candidateId = seedCandidate(db, 'u1');
    const seeded = seedCapabilityWithVersion(db, 'u1', {
      versionStatus: 'published',
      isCurrent: true,
    });
    const ctx = makeReqReply({
      userId: 'u1',
      body: { sourceCandidateId: candidateId, capabilityId: seeded.capabilityId },
      db,
    });
    await call(createCapabilityHandler(), ctx);
    expect(ctx.sent.code).toBe(400);
    expect(db.versions.size).toBe(1); // 仅 seed 的那条，未新建
  });

  it('未登录 → 401', async () => {
    const db = new StructureRoutesFakeDb();
    const ctx = makeReqReply({ body: {}, db });
    await call(createCapabilityHandler(), ctx);
    expect(ctx.sent.code).toBe(401);
  });
});

// ===========================================================================
// B · GET /versions/:versionId/manifest — 读 manifest（§4.B）
// ===========================================================================
describe('getManifestHandler (§4.B)', () => {
  it('200 ManifestView（locked=硬字段全集 + structureState + manifest 软硬分层）', async () => {
    const db = new StructureRoutesFakeDb();
    const seeded = seedCapabilityWithVersion(db, 'u1');
    const ctx = makeReqReply({ userId: 'u1', params: { versionId: seeded.versionId }, db });
    await call(getManifestHandler(), ctx);
    expect(ctx.sent.code).toBe(200);
    const view = dataOf<{
      versionId: string;
      capabilityId: string;
      slug: string;
      locked: string[];
      structureState: { totalCount: number };
      manifest: { status: string };
    }>(ctx.sent.body);
    expect(view.versionId).toBe(seeded.versionId);
    expect(view.locked).toEqual(['id', 'version', 'status', 'inputs', 'output', 'boundaries']);
    expect(view.structureState.totalCount).toBe(7);
    expect(view.manifest.status).toBe('draft');
  });

  it('版本不存在 → 404（无 code）', async () => {
    const db = new StructureRoutesFakeDb();
    const ctx = makeReqReply({ userId: 'u1', params: { versionId: 'nope' }, db });
    await call(getManifestHandler(), ctx);
    expect(ctx.sent.code).toBe(404);
    assertNoCode(ctx.sent.body);
  });

  it('非本人 → 403', async () => {
    const db = new StructureRoutesFakeDb();
    const seeded = seedCapabilityWithVersion(db, 'owner');
    const ctx = makeReqReply({ userId: 'attacker', params: { versionId: seeded.versionId }, db });
    await call(getManifestHandler(), ctx);
    expect(ctx.sent.code).toBe(403);
  });
});

// ===========================================================================
// C · POST /versions/:versionId/structure — 发起结构化 Job（§4.C）
// ===========================================================================
describe('startStructureHandler (§4.C)', () => {
  it('draft 版本 → 202 + jobId/eventsUrl/structureState + 建 jobs(type=structure, mode=full) + 入队', async () => {
    const db = new StructureRoutesFakeDb();
    const queue = new FakeQueue();
    const seeded = seedCapabilityWithVersion(db, 'u1');
    const ctx = makeReqReply({ userId: 'u1', params: { versionId: seeded.versionId }, db, queue });
    await call(startStructureHandler(), ctx);
    expect(ctx.sent.code).toBe(202);
    const r = dataOf<{
      jobId: string;
      versionId: string;
      eventsUrl: string;
      structureState: unknown;
    }>(ctx.sent.body);
    expect(r.versionId).toBe(seeded.versionId);
    expect(r.eventsUrl).toBe(`/api/v1/versions/${seeded.versionId}/structure/events`);
    expect(r.structureState).toBeTruthy();
    const job = [...db.jobs.values()][0]!;
    expect(job.type).toBe('structure');
    expect(job.subject_ref.mode).toBe('full');
    expect(job.subject_ref.versionId).toBe(seeded.versionId);
    expect(queue.enqueued).toHaveLength(1);
    expect(queue.enqueued[0]!.type).toBe('structure');
  });

  it('fields 子集 → subject_ref.fields 携带（续传只补未生成）', async () => {
    const db = new StructureRoutesFakeDb();
    const seeded = seedCapabilityWithVersion(db, 'u1');
    const ctx = makeReqReply({
      userId: 'u1',
      params: { versionId: seeded.versionId },
      body: { fields: ['instructions', 'skill_set'] },
      db,
    });
    await call(startStructureHandler(), ctx);
    expect(ctx.sent.code).toBe(202);
    const job = [...db.jobs.values()][0]!;
    expect(job.subject_ref.fields).toEqual(['instructions', 'skill_set']);
  });

  it('同 version 已有未终态 job → 回放运行中 jobId（不重复跑、不重复入队）', async () => {
    const db = new StructureRoutesFakeDb();
    const queue = new FakeQueue();
    const seeded = seedCapabilityWithVersion(db, 'u1');
    const first = makeReqReply({
      userId: 'u1',
      params: { versionId: seeded.versionId },
      db,
      queue,
    });
    await call(startStructureHandler(), first);
    const firstJobId = dataOf<{ jobId: string }>(first.sent.body).jobId;
    const second = makeReqReply({
      userId: 'u1',
      params: { versionId: seeded.versionId },
      db,
      queue,
    });
    await call(startStructureHandler(), second);
    expect(dataOf<{ jobId: string }>(second.sent.body).jobId).toBe(firstJobId); // 回放同一 jobId
    expect(db.jobs.size).toBe(1); // 不重复建
    expect(queue.enqueued).toHaveLength(1); // 不重复入队
  });

  it('published 版本 → 409 STATE_CONFLICT（需建新版本，不建 job）', async () => {
    const db = new StructureRoutesFakeDb();
    const seeded = seedCapabilityWithVersion(db, 'u1', { versionStatus: 'published' });
    const ctx = makeReqReply({ userId: 'u1', params: { versionId: seeded.versionId }, db });
    await call(startStructureHandler(), ctx);
    expect(ctx.sent.code).toBe(409);
    expect(db.jobs.size).toBe(0);
    assertNoCode(ctx.sent.body);
  });

  it('非本人 → 403（不建 job）', async () => {
    const db = new StructureRoutesFakeDb();
    const seeded = seedCapabilityWithVersion(db, 'owner');
    const ctx = makeReqReply({ userId: 'attacker', params: { versionId: seeded.versionId }, db });
    await call(startStructureHandler(), ctx);
    expect(ctx.sent.code).toBe(403);
    expect(db.jobs.size).toBe(0);
  });

  it('入队失败 → 仍 202 留 queued（不裸转圈，交 sweeper 补投）', async () => {
    const db = new StructureRoutesFakeDb();
    const queue = new FakeQueue();
    queue.fail = true;
    const seeded = seedCapabilityWithVersion(db, 'u1');
    const ctx = makeReqReply({ userId: 'u1', params: { versionId: seeded.versionId }, db, queue });
    await call(startStructureHandler(), ctx);
    expect(ctx.sent.code).toBe(202);
    expect(db.jobs.size).toBe(1); // job 已建成 queued
  });
});

// ===========================================================================
// E · PATCH /versions/:versionId/manifest — 改软字段（§4.E）
// ===========================================================================
describe('patchManifestHandler (§4.E)', () => {
  it('改软字段 → 200 ManifestView（manifest 更新 + 该字段 structure_state=done）', async () => {
    const db = new StructureRoutesFakeDb();
    const seeded = seedCapabilityWithVersion(db, 'u1');
    const ctx = makeReqReply({
      userId: 'u1',
      params: { versionId: seeded.versionId },
      body: { name: '需求炼金师', tagline: '把杂乱想法炼成 PRD' },
      db,
    });
    await call(patchManifestHandler(), ctx);
    expect(ctx.sent.code).toBe(200);
    const view = dataOf<{
      manifest: { name: string; tagline: string };
      structureState: { fields: Array<{ field: string; status: string; value?: unknown }> };
    }>(ctx.sent.body);
    expect(view.manifest.name).toBe('需求炼金师');
    const name = view.structureState.fields.find((f) => f.field === 'name')!;
    expect(name.status).toBe('done');
    expect(name.value).toBe('需求炼金师');
    // 落库生效。
    expect((db.versions.get(seeded.versionId)!.manifest as { name: string }).name).toBe(
      '需求炼金师',
    );
  });

  it('改 instructions → 系统重算 inputs.schema（硬字段仍锁定、derivedFrom:instructions）', async () => {
    const db = new StructureRoutesFakeDb();
    const seeded = seedCapabilityWithVersion(db, 'u1');
    const ctx = makeReqReply({
      userId: 'u1',
      params: { versionId: seeded.versionId },
      body: { instructions: '请围绕 {{product_idea|你的产品一句话}} 给出 PRD。' },
      db,
    });
    await call(patchManifestHandler(), ctx);
    expect(ctx.sent.code).toBe(200);
    const view = dataOf<{
      manifest: { inputs: { fields: Array<{ key: string; derivedFrom: string }> } };
    }>(ctx.sent.body);
    const field = view.manifest.inputs.fields.find((f) => f.key === 'product_idea')!;
    expect(field).toBeTruthy();
    expect(field.derivedFrom).toBe('instructions');
  });

  it('不连坐（§3.4）：PATCH 字段 A 不清掉字段 B 的 failed + 累计 attempts（即使 B 有旧 manifest 值）', async () => {
    const db = new StructureRoutesFakeDb();
    // B=name 曾 done（有旧值）后 regen 失败：status=failed + attempts=1（manifest 仍留旧值）。
    const manifest = applySoftFields(initialManifest('cap-p', '0.1.0'), {
      name: '旧名',
      role: '旧角色',
    });
    const seeded = seedCapabilityWithVersion(db, 'u1', { manifest });
    const v = db.versions.get(seeded.versionId)!;
    const ss = v.structure_state as {
      fields: Array<{ field: string; status: string; attempts?: number }>;
    };
    ss.fields = ss.fields.map((f) =>
      f.field === 'name' ? { ...f, status: 'failed', attempts: 1 } : f,
    );
    // PATCH 另一个字段 A=tagline（与 name 无关）。
    const ctx = makeReqReply({
      userId: 'u1',
      params: { versionId: seeded.versionId },
      body: { tagline: '新卖点' },
      db,
    });
    await call(patchManifestHandler(), ctx);
    expect(ctx.sent.code).toBe(200);
    const after = db.versions.get(seeded.versionId)!.structure_state as {
      fields: Array<{ field: string; status: string; attempts?: number }>;
    };
    // name 仍 failed + attempts=1（B 的累计不被 A 的 PATCH 清零，否则 §3.4 永不落错误态）。
    const nameSt = after.fields.find((f) => f.field === 'name')!;
    expect(nameSt.status).toBe('failed');
    expect(nameSt.attempts).toBe(1);
    // tagline（A）正常置 done。
    expect(after.fields.find((f) => f.field === 'tagline')!.status).toBe('done');
  });

  it('不丢运行中 partial（Codex r5 P1）：字段 A(skill_set) generating 有 partial 时 PATCH 字段 B → A 的 partial 不丢', async () => {
    const db = new StructureRoutesFakeDb();
    // skill_set 正 generating 且已落 2 个 partial item（active structure job 边生成边逐项落 structure_state、
    //   不落 manifest）；manifest.skill_set 仍空数组。PATCH 另一软字段（tagline）不得把 skill_set partial 擦成空。
    const seeded = seedCapabilityWithVersion(db, 'u1');
    const v = db.versions.get(seeded.versionId)!;
    v.structure_state = setFieldState(v.structure_state as StructureState, 'skill_set', {
      status: 'generating',
      value: ['技能A', '技能B'],
    });
    // PATCH 字段 B=tagline（与 skill_set 无关）。
    const ctx = makeReqReply({
      userId: 'u1',
      params: { versionId: seeded.versionId },
      body: { tagline: '运行中改的卖点' },
      db,
    });
    await call(patchManifestHandler(), ctx);
    expect(ctx.sent.code).toBe(200);
    const after = db.versions.get(seeded.versionId)!.structure_state as {
      fields: Array<{ field: string; status: string; value?: unknown }>;
    };
    // skill_set 仍 generating + partial 2 项不丢（未被 manifest 空数组投影擦掉，已生成不丢硬规则③）。
    const skillSt = after.fields.find((f) => f.field === 'skill_set')!;
    expect(skillSt.status).toBe('generating');
    expect(skillSt.value as string[]).toEqual(['技能A', '技能B']);
    // tagline（B）正常置 done。
    expect(after.fields.find((f) => f.field === 'tagline')!.status).toBe('done');
  });

  it('请求含硬字段键（status/inputs）→ 422 HARD_FIELD_LOCKED（人话，不改库）', async () => {
    const db = new StructureRoutesFakeDb();
    const seeded = seedCapabilityWithVersion(db, 'u1');
    const before = JSON.stringify(db.versions.get(seeded.versionId)!.manifest);
    const ctx = makeReqReply({
      userId: 'u1',
      params: { versionId: seeded.versionId },
      body: { name: 'x', status: 'published' },
      db,
    });
    await call(patchManifestHandler(), ctx);
    expect(ctx.sent.code).toBe(422);
    expect(errOf(ctx.sent.body).action).toBe('change_input');
    assertNoCode(ctx.sent.body);
    expect(JSON.stringify(db.versions.get(seeded.versionId)!.manifest)).toBe(before); // 不改库
  });

  it('空改动 → 400 VALIDATION_FAILED', async () => {
    const db = new StructureRoutesFakeDb();
    const seeded = seedCapabilityWithVersion(db, 'u1');
    const ctx = makeReqReply({
      userId: 'u1',
      params: { versionId: seeded.versionId },
      body: {},
      db,
    });
    await call(patchManifestHandler(), ctx);
    expect(ctx.sent.code).toBe(400);
  });

  it('published 版本改 → 409 STATE_CONFLICT（基于新版本编辑）', async () => {
    const db = new StructureRoutesFakeDb();
    const seeded = seedCapabilityWithVersion(db, 'u1', { versionStatus: 'published' });
    const ctx = makeReqReply({
      userId: 'u1',
      params: { versionId: seeded.versionId },
      body: { name: 'x' },
      db,
    });
    await call(patchManifestHandler(), ctx);
    expect(ctx.sent.code).toBe(409);
    assertNoCode(ctx.sent.body);
  });

  it('If-Match 乐观锁（Codex P1-5）：GET 拿 ETag → PATCH 带对的 If-Match → 200 + 新 ETag（且每次写后 ETag 变）', async () => {
    const db = new StructureRoutesFakeDb();
    const seeded = seedCapabilityWithVersion(db, 'u1');
    // GET manifest 拿当前 ETag。
    const get = makeReqReply({ userId: 'u1', params: { versionId: seeded.versionId }, db });
    await call(getManifestHandler(), get);
    const etag = get.headers['ETag'] as string;
    expect(etag).toBeTruthy();
    // PATCH 带对的 If-Match → 200。
    const patch = makeReqReply({
      userId: 'u1',
      params: { versionId: seeded.versionId },
      headers: { 'if-match': etag },
      body: { name: '需求炼金师' },
      db,
    });
    await call(patchManifestHandler(), patch);
    expect(patch.sent.code).toBe(200);
    const newEtag = patch.headers['ETag'] as string;
    expect(newEtag).toBeTruthy();
    expect(newEtag).not.toBe(etag); // 写后 ETag 推进（下次乐观锁据新值）。
  });

  it('If-Match 冲突（Codex P1-5）：带过期 ETag（内容已被并发改过）→ 412 PRECONDITION_FAILED（retry，无 code，不改库）', async () => {
    const db = new StructureRoutesFakeDb();
    const seeded = seedCapabilityWithVersion(db, 'u1');
    const get = makeReqReply({ userId: 'u1', params: { versionId: seeded.versionId }, db });
    await call(getManifestHandler(), get);
    const staleEtag = get.headers['ETag'] as string;
    // 模拟「另一并发 PATCH 先改过」：直接成功 PATCH 一次，推进 ETag。
    const concurrent = makeReqReply({
      userId: 'u1',
      params: { versionId: seeded.versionId },
      headers: { 'if-match': staleEtag },
      body: { tagline: '别人先改的' },
      db,
    });
    await call(patchManifestHandler(), concurrent);
    expect(concurrent.sent.code).toBe(200);
    const beforeManifest = JSON.stringify(db.versions.get(seeded.versionId)!.manifest);
    // 我方仍拿旧 staleEtag PATCH → 412（内容刚被改过）。
    const mine = makeReqReply({
      userId: 'u1',
      params: { versionId: seeded.versionId },
      headers: { 'if-match': staleEtag },
      body: { name: '我的改动' },
      db,
    });
    await call(patchManifestHandler(), mine);
    expect(mine.sent.code).toBe(412);
    expect(errOf(mine.sent.body).action).toBe('retry');
    assertNoCode(mine.sent.body);
    // 冲突未改库（name 未变）。
    expect(JSON.stringify(db.versions.get(seeded.versionId)!.manifest)).toBe(beforeManifest);
  });

  it('不丢字段（Codex P1-5）：锁内读最新 manifest 再 patch，只动被 patch 软字段，其余字段从锁内带走', async () => {
    const db = new StructureRoutesFakeDb();
    // 预置 name/role 已有值。
    const manifest = applySoftFields(initialManifest('cap-im', '0.1.0'), {
      name: '原名',
      role: '原角色',
    });
    const seeded = seedCapabilityWithVersion(db, 'u1', { manifest });
    // 只 PATCH tagline（不带 If-Match）→ name/role 不被丢（锁内最新 manifest 带走）。
    const ctx = makeReqReply({
      userId: 'u1',
      params: { versionId: seeded.versionId },
      body: { tagline: '新卖点' },
      db,
    });
    await call(patchManifestHandler(), ctx);
    expect(ctx.sent.code).toBe(200);
    const after = db.versions.get(seeded.versionId)!.manifest as {
      name: string;
      role: string;
      tagline: string;
    };
    expect(after.tagline).toBe('新卖点');
    expect(after.name).toBe('原名'); // 不丢。
    expect(after.role).toBe('原角色'); // 不丢。
  });

  it('非本人 → 403', async () => {
    const db = new StructureRoutesFakeDb();
    const seeded = seedCapabilityWithVersion(db, 'owner');
    const ctx = makeReqReply({
      userId: 'attacker',
      params: { versionId: seeded.versionId },
      body: { name: 'x' },
      db,
    });
    await call(patchManifestHandler(), ctx);
    expect(ctx.sent.code).toBe(403);
  });
});

// ===========================================================================
// F · POST /versions/:versionId/manifest/fields/:field/regenerate — 单软字段重生成（§4.F）
// ===========================================================================
describe('regenerateFieldHandler (§4.F)', () => {
  it('重生成单软字段 → 202 + jobId/field/eventsUrl + 仅该字段 generating（其余不丢）+ 建 mode=single-field job', async () => {
    const db = new StructureRoutesFakeDb();
    const queue = new FakeQueue();
    // 预置：name 已生成、role 已生成。
    const manifest = applySoftFields(initialManifest('cap-y', '0.1.0'), {
      name: '炼金师',
      role: '资深 PM',
    });
    const seeded = seedCapabilityWithVersion(db, 'u1', { manifest });
    const ctx = makeReqReply({
      userId: 'u1',
      params: { versionId: seeded.versionId, field: 'name' },
      db,
      queue,
    });
    await call(regenerateFieldHandler(), ctx);
    expect(ctx.sent.code).toBe(202);
    const r = dataOf<{ jobId: string; field: string; eventsUrl: string }>(ctx.sent.body);
    expect(r.field).toBe('name');
    expect(r.eventsUrl).toBe(`/api/v1/versions/${seeded.versionId}/structure/events`);
    // structure_state：name → generating；role 仍 done（其余不丢，验收-26）。
    const state = db.versions.get(seeded.versionId)!.structure_state as {
      fields: Array<{ field: string; status: string }>;
    };
    expect(state.fields.find((f) => f.field === 'name')!.status).toBe('generating');
    expect(state.fields.find((f) => f.field === 'role')!.status).toBe('done');
    // 建 single-field job。
    const job = [...db.jobs.values()][0]!;
    expect(job.subject_ref.mode).toBe('single-field');
    expect(job.subject_ref.field).toBe('name');
  });

  it('跨调用累计（§3.4）：读该字段持久化 attempts 作 attemptsBefore 透传给 regen job（其余不丢）', async () => {
    const db = new StructureRoutesFakeDb();
    const queue = new FakeQueue();
    const manifest = applySoftFields(initialManifest('cap-z', '0.1.0'), { role: '资深 PM' });
    const seeded = seedCapabilityWithVersion(db, 'u1', { manifest });
    // 模拟上轮端点 F 一次失败的残留态：name=failed + 累计 attempts=1（其余 role 仍 done）。
    const v = db.versions.get(seeded.versionId)!;
    const ss = v.structure_state as {
      fields: Array<{ field: string; status: string; attempts?: number }>;
    };
    ss.fields = ss.fields.map((f) =>
      f.field === 'name' ? { ...f, status: 'failed', attempts: 1 } : f,
    );
    const ctx = makeReqReply({
      userId: 'u1',
      params: { versionId: seeded.versionId, field: 'name' },
      db,
      queue,
    });
    await call(regenerateFieldHandler(), ctx);
    expect(ctx.sent.code).toBe(202);
    // 关键：建的 regen job 携 attemptsBefore=1（路由读出持久化 attempts 后透传），让 worker 本轮预算 = 2-1 = 1。
    const job = [...db.jobs.values()][0]!;
    expect(job.subject_ref.mode).toBe('single-field');
    expect(job.subject_ref.field).toBe('name');
    expect(job.subject_ref.attemptsBefore).toBe(1);
    // 受理把 name 置 generating（attempts 不清零，跨调用累计基线保留）；role 仍 done（不丢）。
    const after = db.versions.get(seeded.versionId)!.structure_state as {
      fields: Array<{ field: string; status: string; attempts?: number }>;
    };
    expect(after.fields.find((f) => f.field === 'name')!.status).toBe('generating');
    expect(after.fields.find((f) => f.field === 'name')!.attempts).toBe(1);
    expect(after.fields.find((f) => f.field === 'role')!.status).toBe('done');
    assertNoCode(ctx.sent.body);
  });

  it('首次重生成（无历史失败）：attempts 缺省 → attemptsBefore 不透传/为 0（全新预算，正常）', async () => {
    const db = new StructureRoutesFakeDb();
    const queue = new FakeQueue();
    const seeded = seedCapabilityWithVersion(db, 'u1');
    const ctx = makeReqReply({
      userId: 'u1',
      params: { versionId: seeded.versionId, field: 'name' },
      db,
      queue,
    });
    await call(regenerateFieldHandler(), ctx);
    expect(ctx.sent.code).toBe(202);
    const job = [...db.jobs.values()][0]!;
    // 无历史失败 → attemptsBefore 省略或 0（createRegenerateFieldJob 仅当 >0 才写入 subject_ref）。
    expect(job.subject_ref.attemptsBefore ?? 0).toBe(0);
  });

  it('硬字段 path（inputs）→ 422 HARD_FIELD_LOCKED（不建 job、不改库）', async () => {
    const db = new StructureRoutesFakeDb();
    const seeded = seedCapabilityWithVersion(db, 'u1');
    const ctx = makeReqReply({
      userId: 'u1',
      params: { versionId: seeded.versionId, field: 'inputs' },
      db,
    });
    await call(regenerateFieldHandler(), ctx);
    expect(ctx.sent.code).toBe(422);
    expect(db.jobs.size).toBe(0);
    assertNoCode(ctx.sent.body);
  });

  it('published 版本重生成 → 409 STATE_CONFLICT（不建 job）', async () => {
    const db = new StructureRoutesFakeDb();
    const seeded = seedCapabilityWithVersion(db, 'u1', { versionStatus: 'published' });
    const ctx = makeReqReply({
      userId: 'u1',
      params: { versionId: seeded.versionId, field: 'name' },
      db,
    });
    await call(regenerateFieldHandler(), ctx);
    expect(ctx.sent.code).toBe(409);
    expect(db.jobs.size).toBe(0);
  });

  it('字段级硬锁（Codex P1-4）：该字段已 generating → 423 RESOURCE_LOCKED（wait，不重复受理、不建 job）', async () => {
    const db = new StructureRoutesFakeDb();
    const seeded = seedCapabilityWithVersion(db, 'u1');
    // 把 name 预置 generating（模拟正在生成）。
    const v = db.versions.get(seeded.versionId)!;
    const ss = v.structure_state as { fields: Array<{ field: string; status: string }> };
    ss.fields = ss.fields.map((f) => (f.field === 'name' ? { ...f, status: 'generating' } : f));
    const ctx = makeReqReply({
      userId: 'u1',
      params: { versionId: seeded.versionId, field: 'name' },
      db,
    });
    await call(regenerateFieldHandler(), ctx);
    expect(ctx.sent.code).toBe(423);
    expect(errOf(ctx.sent.body).action).toBe('wait');
    expect(db.jobs.size).toBe(0); // 不建 job。
    assertNoCode(ctx.sent.body);
  });

  it('version 级硬锁（Codex P1-4 / r2 P1）：同 version 已有未终态 structure job → regen 返回 423（不双跑覆盖）+ structure_state 完全不变（锁获取与置 generating 同事务原子）', async () => {
    const db = new StructureRoutesFakeDb();
    const queue = new FakeQueue();
    const seeded = seedCapabilityWithVersion(db, 'u1');
    // 先发起 full 结构化（建一个 queued structure job，占 version 级锁）。
    const start = makeReqReply({
      userId: 'u1',
      params: { versionId: seeded.versionId },
      db,
      queue,
    });
    await call(startStructureHandler(), start);
    expect(db.jobs.size).toBe(1);
    // 受理前快照 structure_state（用于反向破坏对照：423 后必须逐字段完全相等）。
    const before = JSON.stringify(db.versions.get(seeded.versionId)!.structure_state);
    // 再对另一字段 regen：取 version 锁（建 job）冲突 → 整事务回滚 → 423，字段【未被置 generating】。
    const regen = makeReqReply({
      userId: 'u1',
      params: { versionId: seeded.versionId, field: 'role' },
      db,
      queue,
    });
    await call(regenerateFieldHandler(), regen);
    expect(regen.sent.code).toBe(423);
    expect(errOf(regen.sent.body).action).toBe('wait');
    expect(db.jobs.size).toBe(1); // 没新建第二个 job（不双跑）。
    // Codex r2 P1 核心断言：423 后 structure_state 完全不变（role 未被置 generating、attempts 未动）。
    const after = JSON.stringify(db.versions.get(seeded.versionId)!.structure_state);
    expect(after).toBe(before);
    const roleState = db.versions.get(seeded.versionId)!.structure_state as {
      fields: Array<{ field: string; status: string }>;
    };
    expect(roleState.fields.find((f) => f.field === 'role')!.status).not.toBe('generating');
    assertNoCode(regen.sent.body);
  });

  it('字段级硬锁（Codex r2 P1）：该字段已 generating → 423 后 structure_state 完全不变（不重复置 generating、attempts 未动、不建 job）', async () => {
    const db = new StructureRoutesFakeDb();
    const seeded = seedCapabilityWithVersion(db, 'u1');
    // 预置 name=generating + attempts=1（模拟正在生成且有累计失败历史）。
    const v = db.versions.get(seeded.versionId)!;
    const ss = v.structure_state as {
      fields: Array<{ field: string; status: string; attempts?: number }>;
    };
    ss.fields = ss.fields.map((f) =>
      f.field === 'name' ? { ...f, status: 'generating', attempts: 1 } : f,
    );
    const before = JSON.stringify(db.versions.get(seeded.versionId)!.structure_state);
    const ctx = makeReqReply({
      userId: 'u1',
      params: { versionId: seeded.versionId, field: 'name' },
      db,
    });
    await call(regenerateFieldHandler(), ctx);
    expect(ctx.sent.code).toBe(423);
    expect(errOf(ctx.sent.body).action).toBe('wait');
    expect(db.jobs.size).toBe(0); // 不建 job。
    // 423 后 state 完全不变（attempts=1 保留、status 仍 generating、未被本次受理动过）。
    const after = JSON.stringify(db.versions.get(seeded.versionId)!.structure_state);
    expect(after).toBe(before);
    assertNoCode(ctx.sent.body);
  });

  it('版本不存在 → 404', async () => {
    const db = new StructureRoutesFakeDb();
    const ctx = makeReqReply({ userId: 'u1', params: { versionId: 'nope', field: 'name' }, db });
    await call(regenerateFieldHandler(), ctx);
    expect(ctx.sent.code).toBe(404);
  });

  it('非本人 → 403（不建 job）', async () => {
    const db = new StructureRoutesFakeDb();
    const seeded = seedCapabilityWithVersion(db, 'owner');
    const ctx = makeReqReply({
      userId: 'attacker',
      params: { versionId: seeded.versionId, field: 'name' },
      db,
    });
    await call(regenerateFieldHandler(), ctx);
    expect(ctx.sent.code).toBe(403);
    expect(db.jobs.size).toBe(0);
  });
});

// ===========================================================================
// G · PATCH /drafts/:draftId/selection — STEP③ 存草稿（§4.G）
// ===========================================================================
describe('patchSelectionHandler (§4.G)', () => {
  it('single 选择 → 200 DraftView（selection 持久化 + current_step=select）+ 不建任何 job/能力体', async () => {
    const db = new StructureRoutesFakeDb();
    const draftId = seedDraft(db, 'u1', { snapshotId: 'snap-1' });
    const candidateId = seedCandidate(db, 'u1', { snapshotId: 'snap-1' });
    const ctx = makeReqReply({
      userId: 'u1',
      params: { draftId },
      body: { selection: { mode: 'single', candidateId } },
      db,
    });
    await call(patchSelectionHandler(), ctx);
    expect(ctx.sent.code).toBe(200);
    const view = dataOf<{ currentStep: string; selection: unknown }>(ctx.sent.body);
    expect(view.currentStep).toBe('select');
    expect(view.selection).toEqual({ mode: 'single', candidateId });
    // 不建 job/能力体（端点 G 只存草稿，§4.G）。
    expect(db.jobs.size).toBe(0);
    expect(db.capabilities.size).toBe(0);
    assertNoCode(ctx.sent.body);
  });

  it('subset 选 N==total（全部发布特例）→ 200 持久化 candidateIds', async () => {
    const db = new StructureRoutesFakeDb();
    const draftId = seedDraft(db, 'u1', { snapshotId: 'snap-1' });
    const c1 = seedCandidate(db, 'u1', { snapshotId: 'snap-1' });
    const c2 = seedCandidate(db, 'u1', { snapshotId: 'snap-1' });
    const ctx = makeReqReply({
      userId: 'u1',
      params: { draftId },
      body: { selection: { mode: 'subset', candidateIds: [c1, c2] } },
      db,
    });
    await call(patchSelectionHandler(), ctx);
    expect(ctx.sent.code).toBe(200);
    expect(db.drafts.get(draftId)!.selection).toEqual({ mode: 'subset', candidateIds: [c1, c2] });
  });

  it('subset 选 N<total（批量勾选 N 项，§5.2）→ 200 持久化（不再要求 == 全 ready，子集化 P0-1 / Codex r6 P1）', async () => {
    const db = new StructureRoutesFakeDb();
    const draftId = seedDraft(db, 'u1', { snapshotId: 'snap-1' });
    const c1 = seedCandidate(db, 'u1', { snapshotId: 'snap-1' });
    seedCandidate(db, 'u1', { snapshotId: 'snap-1' }); // c2 存在但【不选】→ 子集 N(1)<total(2)，旧实现会 400 卡死。
    const c3 = seedCandidate(db, 'u1', { snapshotId: 'snap-1' }); // c3 选中。
    const ctx = makeReqReply({
      userId: 'u1',
      params: { draftId },
      body: { selection: { mode: 'subset', candidateIds: [c1, c3] } }, // 选 2 / 共 3 = 真子集。
      db,
    });
    await call(patchSelectionHandler(), ctx);
    expect(ctx.sent.code).toBe(200); // 放开后子集通过（旧 ==全ready 校验会 400）。
    expect(db.drafts.get(draftId)!.selection).toEqual({ mode: 'subset', candidateIds: [c1, c3] });
    assertNoCode(ctx.sent.body);
  });

  it('兼容别名 all（旧草稿/未迁移前端）→ 200 持久化（= subset 语义，⊆ ready 即可，不强制全选）', async () => {
    const db = new StructureRoutesFakeDb();
    const draftId = seedDraft(db, 'u1', { snapshotId: 'snap-1' });
    const c1 = seedCandidate(db, 'u1', { snapshotId: 'snap-1' });
    seedCandidate(db, 'u1', { snapshotId: 'snap-1' }); // c2 未选 → N<total，别名 all 也按子集放开。
    const ctx = makeReqReply({
      userId: 'u1',
      params: { draftId },
      body: { selection: { mode: 'all', candidateIds: [c1] } },
      db,
    });
    await call(patchSelectionHandler(), ctx);
    expect(ctx.sent.code).toBe(200);
    expect(db.drafts.get(draftId)!.selection).toEqual({ mode: 'all', candidateIds: [c1] });
  });

  it('幂等：同 draft 重复保存覆盖（最后写赢）', async () => {
    const db = new StructureRoutesFakeDb();
    const draftId = seedDraft(db, 'u1', { snapshotId: 'snap-1' });
    const c1 = seedCandidate(db, 'u1', { snapshotId: 'snap-1' });
    const c2 = seedCandidate(db, 'u1', { snapshotId: 'snap-1' });
    const first = makeReqReply({
      userId: 'u1',
      params: { draftId },
      body: { selection: { mode: 'single', candidateId: c1 } },
      db,
    });
    await call(patchSelectionHandler(), first);
    const second = makeReqReply({
      userId: 'u1',
      params: { draftId },
      body: { selection: { mode: 'single', candidateId: c2 } },
      db,
    });
    await call(patchSelectionHandler(), second);
    expect(db.drafts.get(draftId)!.selection).toEqual({ mode: 'single', candidateId: c2 }); // 覆盖
  });

  it('草稿不存在 → 404', async () => {
    const db = new StructureRoutesFakeDb();
    const candidateId = seedCandidate(db, 'u1', { snapshotId: 'snap-1' });
    const ctx = makeReqReply({
      userId: 'u1',
      params: { draftId: 'nope' },
      body: { selection: { mode: 'single', candidateId } },
      db,
    });
    await call(patchSelectionHandler(), ctx);
    expect(ctx.sent.code).toBe(404);
    assertNoCode(ctx.sent.body);
  });

  it('草稿非本人 → 403（不改库）', async () => {
    const db = new StructureRoutesFakeDb();
    const draftId = seedDraft(db, 'owner', { snapshotId: 'snap-1' });
    const candidateId = seedCandidate(db, 'attacker', { snapshotId: 'snap-1' });
    const ctx = makeReqReply({
      userId: 'attacker',
      params: { draftId },
      body: { selection: { mode: 'single', candidateId } },
      db,
    });
    await call(patchSelectionHandler(), ctx);
    expect(ctx.sent.code).toBe(403);
    expect(db.drafts.get(draftId)!.selection).toBeNull(); // 未改
  });

  it('候选属他人（Codex P1-3）→ 400 VALIDATION_FAILED（不存伪选择，无 code）', async () => {
    const db = new StructureRoutesFakeDb();
    const draftId = seedDraft(db, 'u1', { snapshotId: 'snap-1' });
    // 候选属他人（victim）：u1 不能把它选进自己的草稿。
    const victimCand = seedCandidate(db, 'victim', { snapshotId: 'snap-1' });
    const ctx = makeReqReply({
      userId: 'u1',
      params: { draftId },
      body: { selection: { mode: 'single', candidateId: victimCand } },
      db,
    });
    await call(patchSelectionHandler(), ctx);
    expect(ctx.sent.code).toBe(400);
    expect(errOf(ctx.sent.body).action).toBe('change_input');
    assertNoCode(ctx.sent.body);
    expect(db.drafts.get(draftId)!.selection).toBeNull(); // 未存
  });

  it('候选跨来源 snapshot（Codex P1-3）→ 400（不同 snapshot 的候选不可混选）', async () => {
    const db = new StructureRoutesFakeDb();
    const draftId = seedDraft(db, 'u1', { snapshotId: 'snap-1' });
    const otherSnapCand = seedCandidate(db, 'u1', { snapshotId: 'snap-OTHER' });
    const ctx = makeReqReply({
      userId: 'u1',
      params: { draftId },
      body: { selection: { mode: 'single', candidateId: otherSnapCand } },
      db,
    });
    await call(patchSelectionHandler(), ctx);
    expect(ctx.sent.code).toBe(400);
    expect(db.drafts.get(draftId)!.selection).toBeNull();
  });

  it('候选非 ready（Codex P1-3）→ 400（还没识别好不可选）', async () => {
    const db = new StructureRoutesFakeDb();
    const draftId = seedDraft(db, 'u1', { snapshotId: 'snap-1' });
    const generatingCand = seedCandidate(db, 'u1', {
      snapshotId: 'snap-1',
      status: 'generating',
    });
    const ctx = makeReqReply({
      userId: 'u1',
      params: { draftId },
      body: { selection: { mode: 'single', candidateId: generatingCand } },
      db,
    });
    await call(patchSelectionHandler(), ctx);
    expect(ctx.sent.code).toBe(400);
  });

  it('subset 含他人候选 → 400（子集闸：每个 id 须 ⊆ 本人 ready，含他人即拒，不存伪选择）', async () => {
    const db = new StructureRoutesFakeDb();
    const draftId = seedDraft(db, 'u1', { snapshotId: 'snap-1' });
    const mine = seedCandidate(db, 'u1', { snapshotId: 'snap-1' });
    const victimCand = seedCandidate(db, 'victim', { snapshotId: 'snap-1' }); // 他人候选混进子集。
    const ctx = makeReqReply({
      userId: 'u1',
      params: { draftId },
      body: { selection: { mode: 'subset', candidateIds: [mine, victimCand] } },
      db,
    });
    await call(patchSelectionHandler(), ctx);
    expect(ctx.sent.code).toBe(400);
    assertNoCode(ctx.sent.body);
    expect(db.drafts.get(draftId)!.selection).toBeNull();
  });

  it('subset 含非 ready 候选 → 400（还没识别好不可选）', async () => {
    const db = new StructureRoutesFakeDb();
    const draftId = seedDraft(db, 'u1', { snapshotId: 'snap-1' });
    const ready = seedCandidate(db, 'u1', { snapshotId: 'snap-1' });
    const generating = seedCandidate(db, 'u1', { snapshotId: 'snap-1', status: 'generating' });
    const ctx = makeReqReply({
      userId: 'u1',
      params: { draftId },
      body: { selection: { mode: 'subset', candidateIds: [ready, generating] } },
      db,
    });
    await call(patchSelectionHandler(), ctx);
    expect(ctx.sent.code).toBe(400);
    expect(db.drafts.get(draftId)!.selection).toBeNull();
  });

  it('subset 跨来源 snapshot → 400（不同 snapshot 候选不可混选）', async () => {
    const db = new StructureRoutesFakeDb();
    const draftId = seedDraft(db, 'u1', { snapshotId: 'snap-1' });
    const sameSnap = seedCandidate(db, 'u1', { snapshotId: 'snap-1' });
    const otherSnap = seedCandidate(db, 'u1', { snapshotId: 'snap-OTHER' });
    const ctx = makeReqReply({
      userId: 'u1',
      params: { draftId },
      body: { selection: { mode: 'subset', candidateIds: [sameSnap, otherSnap] } },
      db,
    });
    await call(patchSelectionHandler(), ctx);
    expect(ctx.sent.code).toBe(400);
    expect(db.drafts.get(draftId)!.selection).toBeNull();
  });

  it('subset 含重复 id → 400（子集去重防御）', async () => {
    const db = new StructureRoutesFakeDb();
    const draftId = seedDraft(db, 'u1', { snapshotId: 'snap-1' });
    const c1 = seedCandidate(db, 'u1', { snapshotId: 'snap-1' });
    const ctx = makeReqReply({
      userId: 'u1',
      params: { draftId },
      body: { selection: { mode: 'subset', candidateIds: [c1, c1] } },
      db,
    });
    await call(patchSelectionHandler(), ctx);
    expect(ctx.sent.code).toBe(400);
    expect(db.drafts.get(draftId)!.selection).toBeNull();
  });

  it('subset 空数组 → 400（schema .min(1)，空选非合法子集，Codex P1-3）', async () => {
    const db = new StructureRoutesFakeDb();
    const draftId = seedDraft(db, 'u1', { snapshotId: 'snap-1' });
    seedCandidate(db, 'u1', { snapshotId: 'snap-1' });
    const ctx = makeReqReply({
      userId: 'u1',
      params: { draftId },
      body: { selection: { mode: 'subset', candidateIds: [] } },
      db,
    });
    await call(patchSelectionHandler(), ctx);
    expect(ctx.sent.code).toBe(400);
    expect(errOf(ctx.sent.body).action).toBe('change_input');
    expect(db.drafts.get(draftId)!.selection).toBeNull();
  });

  // 反向破坏（证明「放开 ==全ready 校验」正确）：若后端仍把 subset 当 all==全ready 校验，
  //   则下例 N(2)<total(3) 必被 400 拒。当前实现【不再做数量相等校验】→ 该子集 200 通过。
  //   这条用例锁死：旧「==全ready」校验【绝不能】回归，否则它会变红（N<total 被错拒 = 卡死回归）。
  it('反向破坏：subset N<total 必须 200（若回归到 all==全ready 校验则此条变红，证明放开正确）', async () => {
    const db = new StructureRoutesFakeDb();
    const draftId = seedDraft(db, 'u1', { snapshotId: 'snap-1' });
    const a = seedCandidate(db, 'u1', { snapshotId: 'snap-1' });
    const b = seedCandidate(db, 'u1', { snapshotId: 'snap-1' });
    seedCandidate(db, 'u1', { snapshotId: 'snap-1' }); // 第三个 ready 存在但不选 → total=3, 选 2。
    const ctx = makeReqReply({
      userId: 'u1',
      params: { draftId },
      body: { selection: { mode: 'subset', candidateIds: [a, b] } },
      db,
    });
    await call(patchSelectionHandler(), ctx);
    expect(ctx.sent.code).toBe(200);
    expect(db.drafts.get(draftId)!.selection).toEqual({ mode: 'subset', candidateIds: [a, b] });
  });

  it('selection 格式不对 → 400 VALIDATION_FAILED（change_input）', async () => {
    const db = new StructureRoutesFakeDb();
    const draftId = seedDraft(db, 'u1');
    const ctx = makeReqReply({
      userId: 'u1',
      params: { draftId },
      body: { selection: { mode: 'bogus' } },
      db,
    });
    await call(patchSelectionHandler(), ctx);
    expect(ctx.sent.code).toBe(400);
    expect(errOf(ctx.sent.body).action).toBe('change_input');
  });

  it('未登录 → 401', async () => {
    const db = new StructureRoutesFakeDb();
    const ctx = makeReqReply({ params: { draftId: 'd1' }, body: {}, db });
    await call(patchSelectionHandler(), ctx);
    expect(ctx.sent.code).toBe(401);
  });
});

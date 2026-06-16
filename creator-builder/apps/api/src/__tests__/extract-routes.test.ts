// B-22/B-23 提取接入 API handler 自检：触发萃取/列候选/详情/证据/单候选重试。
//   重点（B-23 契约）：
//     · 触发萃取 202 + eventsUrl + 建 job 入队；快照非本人 404、未就绪 409；入队失败仍 202 留 queued（不裸转圈）。
//     · 列候选 cursor 分页（asc）+ status 过滤 + meta.confidenceSummary（仅 ready）；job 非本人/非 extract → 404。
//     · 候选详情 / 证据下钻 owner 守门；证据 quote = 去敏正文（不裸隐私）。
//     · 单候选重试 → **新建 retry job + 新 eventsUrl（≠ 原 extractJobId 流）**（Codex#4）；候选 failed→generating + retry_cnt+1；
//       已 ready → 409；不存在/非本人 → 404；达上限 → subject_ref.escalate=true（handler 再失败升 escalate）。
//     · 对外信封绝不含 code（D1）；错误归一人话 userMessage+action。
//     · 反向破坏：建 job/重试均「单条 CTE 守门」不两步查写（属主/就绪/状态闸内联）。
import { describe, it, expect } from 'vitest';
import type { RouteHandlerMethod } from 'fastify';
import {
  triggerExtractHandler,
  listCandidatesHandler,
  getCandidateHandler,
  listEvidenceHandler,
  retryCandidateHandler,
} from '../routes/extract-handlers.js';
import {
  ExtractRoutesFakeDb,
  FakeQueue,
  seedSnapshot,
  seedExtractJob,
  seedCandidate,
  seedEvidence,
} from './extract-routes-fakes.js';

interface Sent {
  code: number;
  body: unknown;
}
function makeReqReply(opts: {
  userId?: string;
  params?: Record<string, string>;
  query?: Record<string, string>;
  infra: Record<string, unknown>;
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
    query: opts.query ?? {},
    headers: {},
    server: { infra: opts.infra },
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

// ===========================================================================
// B-23 触发萃取（POST /snapshots/{snapshotId}/extract）
// ===========================================================================
describe('triggerExtractHandler (B-23 §2.1)', () => {
  it('就绪快照 → 202 + ExtractJobAccepted(jobId/status=queued/eventsUrl) + 建 extract job + 入队', async () => {
    const db = new ExtractRoutesFakeDb();
    const queue = new FakeQueue();
    const snapshotId = seedSnapshot(db, 'u1', 8);
    const ctx = makeReqReply({ userId: 'u1', params: { snapshotId }, infra: { db, queue } });
    await call(triggerExtractHandler(), ctx);
    expect(ctx.sent.code).toBe(202);
    const data = (
      ctx.sent.body as {
        data: { jobId: string; snapshotId: string; status: string; eventsUrl: string };
      }
    ).data;
    expect(data.status).toBe('queued');
    expect(data.snapshotId).toBe(snapshotId);
    expect(data.eventsUrl).toBe(`/api/v1/jobs/${data.jobId}/events`); // 立连 SSE，不裸转圈
    // 建了一条 extract job + subject_ref.mode='extract'（B-22 对接）。
    expect(db.jobs.size).toBe(1);
    const job = [...db.jobs.values()][0]!;
    expect(job.type).toBe('extract');
    expect((job.subject_ref as { mode: string; snapshotId: string }).mode).toBe('extract');
    expect((job.subject_ref as { snapshotId: string }).snapshotId).toBe(snapshotId);
    expect(queue.enqueued).toHaveLength(1);
    expect(queue.enqueued[0]!.type).toBe('extract');
  });

  it('快照不存在/非本人 → 404 NOT_FOUND（不暴露存在性，无 code）', async () => {
    const db = new ExtractRoutesFakeDb();
    const queue = new FakeQueue();
    const snapshotId = seedSnapshot(db, 'owner', 5);
    const attacker = makeReqReply({
      userId: 'someone-else',
      params: { snapshotId },
      infra: { db, queue },
    });
    await call(triggerExtractHandler(), attacker);
    expect(attacker.sent.code).toBe(404);
    const err = (attacker.sent.body as { error: { action: string } }).error;
    expect(err.action).toBe('change_input');
    expect(db.jobs.size).toBe(0); // 越权绝不建 job
    assertNoCode(attacker.sent.body);
  });

  it('快照未就绪（segment_count=0，无段可萃取）→ 409 EXTRACT_SNAPSHOT_NOT_READY（无 code，绝不建 job）', async () => {
    const db = new ExtractRoutesFakeDb();
    const queue = new FakeQueue();
    const snapshotId = seedSnapshot(db, 'u1', 0); // 未就绪
    const ctx = makeReqReply({ userId: 'u1', params: { snapshotId }, infra: { db, queue } });
    await call(triggerExtractHandler(), ctx);
    expect(ctx.sent.code).toBe(409);
    const err = (ctx.sent.body as { error: { action: string } }).error;
    expect(err.action).toBe('change_input');
    expect(db.jobs.size).toBe(0);
    assertNoCode(ctx.sent.body);
  });

  it('入队失败 → 仍 202（job 留 queued 交 sweeper 补投，不裸转圈、不删 job）', async () => {
    const db = new ExtractRoutesFakeDb();
    const queue = new FakeQueue();
    queue.fail = true;
    const snapshotId = seedSnapshot(db, 'u1', 5);
    const ctx = makeReqReply({ userId: 'u1', params: { snapshotId }, infra: { db, queue } });
    await call(triggerExtractHandler(), ctx);
    expect(ctx.sent.code).toBe(202); // 非 503、非删 job
    const data = (ctx.sent.body as { data: { status: string } }).data;
    expect(data.status).toBe('queued');
    expect(db.jobs.size).toBe(1); // job 留 queued
    expect([...db.jobs.values()][0]!.status).toBe('queued');
  });

  it('未登录 → 401', async () => {
    const db = new ExtractRoutesFakeDb();
    const ctx = makeReqReply({
      params: { snapshotId: 's' },
      infra: { db, queue: new FakeQueue() },
    });
    await call(triggerExtractHandler(), ctx);
    expect(ctx.sent.code).toBe(401);
  });

  it('DB 异常 → 503 DEPENDENCY_UNAVAILABLE（人话，无裸报错）', async () => {
    const db = new ExtractRoutesFakeDb();
    db.failOn = 'INSERT INTO jobs';
    const queue = new FakeQueue();
    const snapshotId = seedSnapshot(db, 'u1', 5);
    const ctx = makeReqReply({ userId: 'u1', params: { snapshotId }, infra: { db, queue } });
    await call(triggerExtractHandler(), ctx);
    expect(ctx.sent.code).toBe(503);
    assertNoCode(ctx.sent.body);
  });
});

// ===========================================================================
// B-22 列候选（GET /extract-jobs/{jobId}/candidates）
// ===========================================================================
describe('listCandidatesHandler (B-22 §2.2)', () => {
  function seedJobWithCands(db: ExtractRoutesFakeDb, owner: string) {
    const snapshotId = seedSnapshot(db, owner, 5);
    const jobId = seedExtractJob(db, owner);
    // 4 ready (high/high/med/low) + 1 failed → confidenceSummary 仅统计 ready。
    seedCandidate(db, {
      extractJobId: jobId,
      snapshotId,
      owner,
      status: 'ready',
      confidence: 'high',
    });
    seedCandidate(db, {
      extractJobId: jobId,
      snapshotId,
      owner,
      status: 'ready',
      confidence: 'high',
    });
    seedCandidate(db, {
      extractJobId: jobId,
      snapshotId,
      owner,
      status: 'ready',
      confidence: 'med',
    });
    seedCandidate(db, {
      extractJobId: jobId,
      snapshotId,
      owner,
      status: 'ready',
      confidence: 'low',
    });
    seedCandidate(db, {
      extractJobId: jobId,
      snapshotId,
      owner,
      status: 'failed',
      confidence: null,
      error: {
        userMessage: '这一项没能识别出来，可点重试。',
        action: 'retry',
        retriable: true,
        traceId: 't',
      },
    });
    return { jobId, snapshotId };
  }

  it('属主 200 + 全部状态（含 failed 行）+ meta.confidenceSummary 仅 ready + order=asc', async () => {
    const db = new ExtractRoutesFakeDb();
    const { jobId } = seedJobWithCands(db, 'u1');
    const ctx = makeReqReply({
      userId: 'u1',
      params: { jobId },
      infra: { db, queue: new FakeQueue() },
    });
    await call(listCandidatesHandler(), ctx);
    expect(ctx.sent.code).toBe(200);
    const body = ctx.sent.body as {
      data: Array<{ id: string; status: string }>;
      meta: {
        page: { order: string; hasMore: boolean };
        confidenceSummary: { high: number; med: number; low: number };
      };
    };
    expect(body.data).toHaveLength(5); // 含 failed 行（提取-17）
    expect(body.data.some((c) => c.status === 'failed')).toBe(true);
    expect(body.meta.page.order).toBe('asc'); // 追加流默认 asc（提取-30）
    // confidenceSummary 三数 = ready 候选数（high2/med1/low1 = 4），failed 不计入（提取-12）。
    expect(body.meta.confidenceSummary).toEqual({ high: 2, med: 1, low: 1 });
    // 升序：id 字典序递增。
    const ids = body.data.map((c) => c.id);
    expect([...ids].sort()).toEqual(ids);
  });

  it('?status=failed 过滤 → 仅失败行；error 是人话 ErrorBody（无 code）', async () => {
    const db = new ExtractRoutesFakeDb();
    const { jobId } = seedJobWithCands(db, 'u1');
    const ctx = makeReqReply({
      userId: 'u1',
      params: { jobId },
      query: { status: 'failed' },
      infra: { db, queue: new FakeQueue() },
    });
    await call(listCandidatesHandler(), ctx);
    expect(ctx.sent.code).toBe(200);
    const body = ctx.sent.body as { data: Array<{ status: string; error: unknown }> };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.status).toBe('failed');
    expect(body.data[0]!.error).toBeTruthy();
    assertNoCode(ctx.sent.body); // 候选 error 也无 code（脊柱 §11.B）
  });

  it('cursor 分页（limit=2）→ 第二页续传、nextCursor 推进、内容不跳变', async () => {
    const db = new ExtractRoutesFakeDb();
    const { jobId } = seedJobWithCands(db, 'u1');
    const p1 = makeReqReply({
      userId: 'u1',
      params: { jobId },
      query: { limit: '2' },
      infra: { db, queue: new FakeQueue() },
    });
    await call(listCandidatesHandler(), p1);
    const b1 = p1.sent.body as {
      data: Array<{ id: string }>;
      meta: { page: { nextCursor: string | null; hasMore: boolean } };
    };
    expect(b1.data).toHaveLength(2);
    expect(b1.meta.page.hasMore).toBe(true);
    const cursor = b1.meta.page.nextCursor!;
    const p2 = makeReqReply({
      userId: 'u1',
      params: { jobId },
      query: { limit: '2', cursor },
      infra: { db, queue: new FakeQueue() },
    });
    await call(listCandidatesHandler(), p2);
    const b2 = p2.sent.body as { data: Array<{ id: string }> };
    // 第二页与第一页无重叠（asc 续传不跳变）。
    const set1 = new Set(b1.data.map((c) => c.id));
    expect(b2.data.every((c) => !set1.has(c.id))).toBe(true);
  });

  it('job 非本人 / 非 extract 类型 → 404（不暴露存在性）', async () => {
    const db = new ExtractRoutesFakeDb();
    const { jobId } = seedJobWithCands(db, 'owner');
    const attacker = makeReqReply({
      userId: 'x',
      params: { jobId },
      infra: { db, queue: new FakeQueue() },
    });
    await call(listCandidatesHandler(), attacker);
    expect(attacker.sent.code).toBe(404);
    assertNoCode(attacker.sent.body);
  });

  it('limit 非法 → 400', async () => {
    const db = new ExtractRoutesFakeDb();
    const { jobId } = seedJobWithCands(db, 'u1');
    const ctx = makeReqReply({
      userId: 'u1',
      params: { jobId },
      query: { limit: '999' },
      infra: { db, queue: new FakeQueue() },
    });
    await call(listCandidatesHandler(), ctx);
    expect(ctx.sent.code).toBe(400);
  });

  it('未登录 → 401', async () => {
    const db = new ExtractRoutesFakeDb();
    const ctx = makeReqReply({ params: { jobId: 'j' }, infra: { db, queue: new FakeQueue() } });
    await call(listCandidatesHandler(), ctx);
    expect(ctx.sent.code).toBe(401);
  });
});

// ===========================================================================
// B-22 候选详情 / 证据下钻
// ===========================================================================
describe('getCandidateHandler + listEvidenceHandler (B-22 §2.4)', () => {
  it('候选详情：属主 200 全量；非属主 404', async () => {
    const db = new ExtractRoutesFakeDb();
    const snapshotId = seedSnapshot(db, 'u1', 5);
    const jobId = seedExtractJob(db, 'u1');
    const candId = seedCandidate(db, { extractJobId: jobId, snapshotId, owner: 'u1' });
    const mine = makeReqReply({
      userId: 'u1',
      params: { candidateId: candId },
      infra: { db, queue: new FakeQueue() },
    });
    await call(getCandidateHandler(), mine);
    expect(mine.sent.code).toBe(200);
    const view = (mine.sent.body as { data: { id: string; status: string; extractJobId: string } })
      .data;
    expect(view.id).toBe(candId);
    expect(view.extractJobId).toBe(jobId);

    const attacker = makeReqReply({
      userId: 'x',
      params: { candidateId: candId },
      infra: { db, queue: new FakeQueue() },
    });
    await call(getCandidateHandler(), attacker);
    expect(attacker.sent.code).toBe(404);
  });

  it('证据下钻：属主 200 + quote=去敏正文 + 条数=segment_count；非属主 404', async () => {
    const db = new ExtractRoutesFakeDb();
    const snapshotId = seedSnapshot(db, 'u1', 5);
    const jobId = seedExtractJob(db, 'u1');
    const candId = seedCandidate(db, { extractJobId: jobId, snapshotId, owner: 'u1' });
    seedEvidence(db, {
      candidateId: candId,
      snapshotId,
      content: '去敏后的代表性片段（手机号已抹）',
    });
    seedEvidence(db, { candidateId: candId, snapshotId, content: '另一段去敏证据' });
    const ctx = makeReqReply({
      userId: 'u1',
      params: { candidateId: candId },
      infra: { db, queue: new FakeQueue() },
    });
    await call(listEvidenceHandler(), ctx);
    expect(ctx.sent.code).toBe(200);
    const body = ctx.sent.body as {
      data: Array<{ quote: string; candidateId: string; segmentId: string; snapshotId: string }>;
      meta: { page: { order: string } };
    };
    expect(body.data).toHaveLength(2);
    expect(body.meta.page.order).toBe('asc');
    expect(body.data[0]!.quote).toContain('去敏');
    expect(body.data[0]!.candidateId).toBe(candId);
    expect(body.data[0]!.snapshotId).toBe(snapshotId); // 血缘回溯具体快照（提取-33）

    const attacker = makeReqReply({
      userId: 'x',
      params: { candidateId: candId },
      infra: { db, queue: new FakeQueue() },
    });
    await call(listEvidenceHandler(), attacker);
    expect(attacker.sent.code).toBe(404);
  });
});

// ===========================================================================
// B-23 单候选重试（POST /candidates/{candidateId}/retry）— 新 retry job + 新流（Codex#4）
// ===========================================================================
describe('retryCandidateHandler (B-23 §2.3, Codex#4)', () => {
  function seedFailed(db: ExtractRoutesFakeDb, owner: string, retryCnt = 0) {
    const snapshotId = seedSnapshot(db, owner, 5);
    const extractJobId = seedExtractJob(db, owner);
    const candId = seedCandidate(db, {
      extractJobId,
      snapshotId,
      owner,
      status: 'failed',
      confidence: null,
      retryCnt,
      error: {
        userMessage: '这一项没能识别出来，可点重试。',
        action: 'retry',
        retriable: true,
        traceId: 't',
      },
    });
    return { candId, extractJobId, snapshotId };
  }

  it('failed 候选重试 → 202 + 新 retryJobId（≠原 extractJobId）+ 新 eventsUrl 指向 retry job 流 + 候选 failed→generating + retry_cnt+1', async () => {
    const db = new ExtractRoutesFakeDb();
    const queue = new FakeQueue();
    const { candId, extractJobId } = seedFailed(db, 'u1', 0);
    const ctx = makeReqReply({
      userId: 'u1',
      params: { candidateId: candId },
      infra: { db, queue },
    });
    await call(retryCandidateHandler(), ctx);
    expect(ctx.sent.code).toBe(202);
    const data = (
      ctx.sent.body as {
        data: {
          candidateId: string;
          extractJobId: string;
          retryJobId: string;
          status: string;
          retryCount: number;
          eventsUrl: string;
        };
      }
    ).data;
    expect(data.candidateId).toBe(candId);
    expect(data.status).toBe('generating');
    expect(data.retryCount).toBe(1); // retry_cnt 0→1
    // Codex#4：retryJobId 是【新建】job，≠ 原萃取 job；eventsUrl 指向新 retry job 流（非原 job 流）。
    expect(data.extractJobId).toBe(extractJobId); // 只读引用
    expect(data.retryJobId).not.toBe(extractJobId); // 全新 retry job
    expect(data.eventsUrl).toBe(`/api/v1/jobs/${data.retryJobId}/events`);
    expect(data.eventsUrl).not.toContain(extractJobId); // 绝不在原 job 流追加
    // 候选行：failed→generating + retry_cnt+1（行内进入「重试中」态，提取-19）。
    const c = db.candidates.get(candId)!;
    expect(c.status).toBe('generating');
    expect(c.retry_cnt).toBe(1);
    // 新建了 retry job（type=extract, mode='single-candidate', candidateId 携带，B-22 单候选对接）。
    const retryJob = db.jobs.get(data.retryJobId)!;
    expect(retryJob.type).toBe('extract');
    const sr = retryJob.subject_ref as { mode: string; candidateId: string; escalate: boolean };
    expect(sr.mode).toBe('single-candidate');
    expect(sr.candidateId).toBe(candId);
    expect(sr.escalate).toBe(false); // 未达上限
    // 入队到 extract 队列。
    expect(queue.enqueued).toHaveLength(1);
    expect(queue.enqueued[0]!.type).toBe('extract');
    assertNoCode(ctx.sent.body);
  });

  it('受理重试 → 新 retry job 初始 progress.items 含该候选 generating 态（新流首帧 state_snapshot 不裸转圈，Codex r2#4）', async () => {
    const db = new ExtractRoutesFakeDb();
    const queue = new FakeQueue();
    const { candId } = seedFailed(db, 'u1', 0);
    const candName = db.candidates.get(candId)!.name; // 失败候选已带已知名（来自聚类草稿）
    const ctx = makeReqReply({
      userId: 'u1',
      params: { candidateId: candId },
      infra: { db, queue },
    });
    await call(retryCandidateHandler(), ctx);
    expect(ctx.sent.code).toBe(202);
    const data = (ctx.sent.body as { data: { retryJobId: string } }).data;
    // retry job 初始 progress.items 注入该候选 { id, status:'generating', isNew:false, name }，
    //   使前端连新流即收到含 generating 态的 state_snapshot（永不裸转圈，契约 §2.3）。
    const retryProgress = db.jobs.get(data.retryJobId)!.progress as {
      items?: Array<{ id: string; status: string; isNew: boolean; name: string | null }>;
    };
    expect(retryProgress.items).toHaveLength(1);
    const item = retryProgress.items![0]!;
    expect(item.id).toBe(candId);
    expect(item.status).toBe('generating');
    expect(item.isNew).toBe(false);
    expect(item.name).toBe(candName);
  });

  it('达上限重试（retry_cnt 已 1，本次→2）→ subject_ref.escalate=true（handler 再失败升 escalate，§2.3）', async () => {
    const db = new ExtractRoutesFakeDb();
    const queue = new FakeQueue();
    const { candId } = seedFailed(db, 'u1', 1); // 已重试 1 次
    const ctx = makeReqReply({
      userId: 'u1',
      params: { candidateId: candId },
      infra: { db, queue },
    });
    await call(retryCandidateHandler(), ctx);
    expect(ctx.sent.code).toBe(202);
    const data = (ctx.sent.body as { data: { retryJobId: string; retryCount: number } }).data;
    expect(data.retryCount).toBe(2); // 达上限
    const sr = db.jobs.get(data.retryJobId)!.subject_ref as { escalate: boolean };
    expect(sr.escalate).toBe(true); // 升级 escalate
  });

  it('候选已 ready（无需重试）→ 409 CANDIDATE_ALREADY_READY（无 code，不建 retry job、不动候选）', async () => {
    const db = new ExtractRoutesFakeDb();
    const queue = new FakeQueue();
    const snapshotId = seedSnapshot(db, 'u1', 5);
    const extractJobId = seedExtractJob(db, 'u1');
    const candId = seedCandidate(db, { extractJobId, snapshotId, owner: 'u1', status: 'ready' });
    const ctx = makeReqReply({
      userId: 'u1',
      params: { candidateId: candId },
      infra: { db, queue },
    });
    await call(retryCandidateHandler(), ctx);
    expect(ctx.sent.code).toBe(409);
    const err = (ctx.sent.body as { error: { action: string } }).error;
    expect(err.action).toBe('none');
    // 不建 retry job、候选仍 ready（无连坐、不动该行）。
    expect(
      [...db.jobs.values()].filter(
        (j) => (j.subject_ref as { mode?: string }).mode === 'single-candidate',
      ),
    ).toHaveLength(0);
    expect(db.candidates.get(candId)!.status).toBe('ready');
    expect(queue.enqueued).toHaveLength(0);
    assertNoCode(ctx.sent.body);
  });

  it('候选已 generating（重试/首轮萃取在途）+ 不同 Idempotency-Key → 423 RESOURCE_LOCKED + action:wait（无 code，不建 retry job，Codex r2#3）', async () => {
    const db = new ExtractRoutesFakeDb();
    const queue = new FakeQueue();
    const snapshotId = seedSnapshot(db, 'u1', 5);
    const extractJobId = seedExtractJob(db, 'u1');
    // 候选已在途（generating）：同 key 由幂等层 423 拦；这里模拟用【不同 key】撞上在途态走到本端点。
    const candId = seedCandidate(db, {
      extractJobId,
      snapshotId,
      owner: 'u1',
      status: 'generating',
      confidence: null,
    });
    const ctx = makeReqReply({
      userId: 'u1',
      params: { candidateId: candId },
      infra: { db, queue },
    });
    await call(retryCandidateHandler(), ctx);
    expect(ctx.sent.code).toBe(423);
    const err = (ctx.sent.body as { error: { action: string; userMessage: string } }).error;
    expect(err.action).toBe('wait');
    expect(err.userMessage).toContain('稍候');
    // 在途 → 绝不重复建 retry job、不动候选、不入队。
    expect(
      [...db.jobs.values()].filter(
        (j) => (j.subject_ref as { mode?: string }).mode === 'single-candidate',
      ),
    ).toHaveLength(0);
    expect(db.candidates.get(candId)!.status).toBe('generating');
    expect(queue.enqueued).toHaveLength(0);
    assertNoCode(ctx.sent.body);
  });

  it('候选不存在/非本人 → 404（不暴露存在性，不建 retry job）', async () => {
    const db = new ExtractRoutesFakeDb();
    const queue = new FakeQueue();
    const { candId } = seedFailed(db, 'owner', 0);
    const attacker = makeReqReply({
      userId: 'x',
      params: { candidateId: candId },
      infra: { db, queue },
    });
    await call(retryCandidateHandler(), attacker);
    expect(attacker.sent.code).toBe(404);
    const err = (attacker.sent.body as { error: { action: string } }).error;
    expect(err.action).toBe('change_input');
    // 越权绝不建 retry job、不动候选（无连坐）。
    expect(queue.enqueued).toHaveLength(0);
    expect(db.candidates.get(candId)!.status).toBe('failed');
    assertNoCode(attacker.sent.body);
  });

  it('无连坐：重试一个候选不影响其它候选与其它候选的重试次数', async () => {
    const db = new ExtractRoutesFakeDb();
    const queue = new FakeQueue();
    const snapshotId = seedSnapshot(db, 'u1', 5);
    const extractJobId = seedExtractJob(db, 'u1');
    const failedId = seedCandidate(db, {
      extractJobId,
      snapshotId,
      owner: 'u1',
      status: 'failed',
      confidence: null,
      error: { userMessage: 'x', action: 'retry', retriable: true, traceId: 't' },
    });
    const readyId = seedCandidate(db, {
      extractJobId,
      snapshotId,
      owner: 'u1',
      status: 'ready',
      confidence: 'high',
    });
    const ctx = makeReqReply({
      userId: 'u1',
      params: { candidateId: failedId },
      infra: { db, queue },
    });
    await call(retryCandidateHandler(), ctx);
    expect(ctx.sent.code).toBe(202);
    // 只动 failedId；readyId 原样保留（提取-29 失败不阻塞其余）。
    expect(db.candidates.get(failedId)!.status).toBe('generating');
    expect(db.candidates.get(readyId)!.status).toBe('ready');
    expect(db.candidates.get(readyId)!.retry_cnt).toBe(0);
  });

  it('未登录 → 401', async () => {
    const db = new ExtractRoutesFakeDb();
    const ctx = makeReqReply({
      params: { candidateId: 'c' },
      infra: { db, queue: new FakeQueue() },
    });
    await call(retryCandidateHandler(), ctx);
    expect(ctx.sent.code).toBe(401);
  });

  it('DB 异常 → 503（人话，无裸报错）', async () => {
    const db = new ExtractRoutesFakeDb();
    db.failOn = 'WITH target AS';
    const queue = new FakeQueue();
    const { candId } = seedFailed(db, 'u1', 0);
    const ctx = makeReqReply({
      userId: 'u1',
      params: { candidateId: candId },
      infra: { db, queue },
    });
    await call(retryCandidateHandler(), ctx);
    expect(ctx.sent.code).toBe(503);
    assertNoCode(ctx.sent.body);
  });
});

// ===========================================================================
// 反向破坏验证：建 job / 重试用单条 CTE 守门（属主/就绪/状态闸内联，不两步「查后写」）
// ===========================================================================
describe('reverse-breakage: single-CTE gated writes (no two-step query-then-write)', () => {
  it('触发萃取：建 job 的属主+就绪闸在【同一条 INSERT...SELECT FROM raw_snapshots】内联（非先 SELECT 校验再 INSERT）', async () => {
    const db = new ExtractRoutesFakeDb();
    const queue = new FakeQueue();
    const snapshotId = seedSnapshot(db, 'u1', 5);
    const ctx = makeReqReply({ userId: 'u1', params: { snapshotId }, infra: { db, queue } });
    await call(triggerExtractHandler(), ctx);
    // 成功路径只有【一条】写库 INSERT（其属主+就绪闸内联进 SELECT 数据源），没有独立的「先 SELECT owner 再 INSERT」两步。
    const insertJobs = db.queries.filter((q) => q.sql.includes('INSERT INTO jobs'));
    expect(insertJobs).toHaveLength(1);
    expect(insertJobs[0]!.sql).toContain('FROM raw_snapshots');
    expect(insertJobs[0]!.sql).toContain('segment_count > 0'); // 就绪闸内联进数据源
    expect(insertJobs[0]!.sql).toContain('owner_user_id'); // 属主闸内联进数据源
    // 成功路径无 0 行后的轻查分类（仅失败路径才走 AS ready 轻查）。
    expect(db.queries.some((q) => q.sql.includes('AS ready'))).toBe(false);
  });

  it('单候选重试：建 retry job + 候选状态翻转在【同一条 CTE】（target FOR UPDATE → INSERT → flipped UPDATE，候选行只改一次）', async () => {
    const db = new ExtractRoutesFakeDb();
    const queue = new FakeQueue();
    const snapshotId = seedSnapshot(db, 'u1', 5);
    const extractJobId = seedExtractJob(db, 'u1');
    const candId = seedCandidate(db, {
      extractJobId,
      snapshotId,
      owner: 'u1',
      status: 'failed',
      confidence: null,
      error: { userMessage: 'x', action: 'retry', retriable: true, traceId: 't' },
    });
    const ctx = makeReqReply({
      userId: 'u1',
      params: { candidateId: candId },
      infra: { db, queue },
    });
    await call(retryCandidateHandler(), ctx);
    // 成功路径：只有【一条】CTE 同时建 retry job + 翻转候选（target 守门 + 单次 flipped UPDATE）。
    const cte = db.queries.filter(
      (q) => q.sql.includes('WITH target AS') && q.sql.includes('INSERT INTO jobs'),
    );
    expect(cte).toHaveLength(1);
    expect(cte[0]!.sql).toContain('FOR UPDATE'); // 守门 + 行锁
    expect(cte[0]!.sql).toContain("status = 'failed'"); // 状态闸内联（只 failed 可重试）
    // 没有独立的「先 UPDATE generating 再单独 INSERT job」两步——候选翻转与建 job 在同一语句。
    const standaloneFlip = db.queries.filter(
      (q) => q.sql.includes('UPDATE capability_candidates') && !q.sql.includes('WITH target AS'),
    );
    expect(standaloneFlip).toHaveLength(0);
  });
});

// B-22 ⇄ B-23 跨模块接缝回归（集成自检补防）：
//   单候选重试的 subject_ref.mode【生产者真源】(create-extract-job.ts 的 createRetryJob 实际写库值)
//   必须与【消费者真源】(extract handler 据 subject.mode 分流到单候选重试分支) 一致。
//
//   背景：两侧各自单测都用本模块自带夹具，从不跨缝。曾出现生产者写 'retry_candidate'、handler 只认
//   'single-candidate'，结果重试 job 会被 handler 当成「全量重萃取」整张快照——两侧测试全绿却线上错。
//   本测试把生产者实际产出喂给 handler 的分流逻辑，钉死接缝：mode 漂移即红。
import { describe, it, expect } from 'vitest';
import { createRetryJob } from '../extract/create-extract-job.js';
import { createExtractHandler } from '../jobs/handlers/extract.js';
import type { JobContext, LeasedJob } from '../jobs/types.js';
import {
  ExtractRoutesFakeDb,
  FakeQueue,
  seedSnapshot,
  seedExtractJob,
  seedCandidate,
} from './extract-routes-fakes.js';
import {
  ExtractFakeDb,
  ExtractFakeTxPool,
  FakeLlmGateway,
  type JobRowF,
  type SegmentRowF,
} from './extract-fakes.js';

/** 建一个 failed 候选（可重试），返回 candidateId。 */
function seedFailedCandidate(db: ExtractRoutesFakeDb, owner: string): string {
  const snapshotId = seedSnapshot(db, owner, 5);
  const extractJobId = seedExtractJob(db, owner);
  return seedCandidate(db, {
    extractJobId,
    snapshotId,
    owner,
    status: 'failed',
    error: { userMessage: '没能识别', action: 'retry', retriable: true },
  });
}

describe('B-22⇄B-23 接缝：单候选重试 subject_ref.mode 生产者/消费者一致', () => {
  it('生产者 createRetryJob 写入的 mode 正是 handler 单候选分支的分流值', async () => {
    const db = new ExtractRoutesFakeDb();
    const queue = new FakeQueue();
    const candId = seedFailedCandidate(db, 'u1');

    const out = await createRetryJob(db, queue, candId, 'u1');
    expect(out.kind).toBe('created');
    if (out.kind !== 'created') return;

    // 生产者真实写库的 subject_ref（不是注释、不是文档——读 job 行）。
    const retryJob = db.jobs.get(out.job.retryJobId)!;
    const producedMode = (retryJob.subject_ref as { mode?: string }).mode;

    // —— 消费者真源：handler 的分流逻辑。把生产者产出原样喂进去，断言它走「重试分支」而非「全量重萃取」——
    //   判别法（最稳）：retry 分支 run() 第一条 DB 读是 readCandidateForOwner（capability_candidates）；
    //   full-extract 分支第一条读是 readSnapshotSegments（session_segments），且从不先读 candidates。
    //   （retry 之后也会读 segments 重新聚类，故只看「第一条读访问的是哪张表」。）
    const reads: string[] = [];
    const probeDb = {
      async query(sql: string, _params?: unknown[]) {
        if (sql.includes('FROM capability_candidates')) {
          reads.push('candidates');
          const c = db.candidates.get(candId)!;
          return {
            rows: [
              {
                id: c.id,
                snapshot_id: c.snapshot_id,
                status: c.status,
                slug: c.slug,
                name: c.name,
                retry_cnt: c.retry_cnt,
              },
            ],
            rowCount: 1,
          };
        }
        if (sql.includes('FROM session_segments')) {
          reads.push('segments');
          return { rows: [], rowCount: 0 };
        }
        return { rows: [], rowCount: 0 };
      },
    };
    const handler = createExtractHandler({
      db: probeDb as never,
      txPool: {
        connect: async () => ({ query: async () => ({ rows: [], rowCount: 0 }) }),
      } as never,
      gateway: { complete: async () => ({ text: '{}', degraded: true }) } as never,
    });

    const probeJob: LeasedJob = {
      id: out.job.retryJobId,
      type: 'extract',
      fenceToken: retryJob.fence_token,
      ownerUserId: 'u1',
      subjectRef: retryJob.subject_ref,
    } as unknown as LeasedJob;
    const ctx = makeNoopCtx();
    try {
      await handler.run(probeJob, ctx);
    } catch {
      // 探针 DB 不完整，retry 分支后续步骤可能抛错——无妨，分流读取序已采集。
    }

    // 接缝钉死：① handler 第一条 DB 读是候选行 → 走了单候选重试分支（没有把整张快照当全量重萃取）。
    expect(reads[0]).toBe('candidates');
    // ② 生产者写的 mode 与 handler 实际分流到 retry 的值一致（漂移即红，直接点名 mode 值）。
    expect(producedMode).toBe('single-candidate');
  });
});

function makeNoopCtx(): JobContext {
  const noopAsync = async () => {};
  return {
    reportSubtask: noopAsync,
    reportProgress: noopAsync,
    appendItem: noopAsync,
    isCancelled: () => false,
    emitSlowHint: noopAsync,
    traceId: 'seam-trace',
  } as unknown as JobContext;
}

// ===========================================================================
// Codex#3 整链：POST retry（受理 CTE +1）→ 跑 worker（runRetry，收尾不再 +1）→ retryCount 只 +1
//   反向破坏：若 worker 收尾再 +1，单次重试后 retry_cnt 会变 2（escalate/上限漂移）→ 本测红。
// ===========================================================================
describe('B-23 retry 整链：受理 + worker 收尾 → retryCount 只 +1（Codex#3 双重加一守门）', () => {
  it('failed(retry_cnt=0) → POST retry 受理(→generating, retry_cnt=1) → worker 成功收尾 → retry_cnt 仍 1（非 2）', async () => {
    // —— 阶段① 受理：createRetryJob（acceptance CTE）做 failed→generating + retry_cnt+1（权威计数点）——
    const acceptDb = new ExtractRoutesFakeDb();
    const queue = new FakeQueue();
    const snapshotId = seedSnapshot(acceptDb, 'u1', 5);
    const extractJobId = seedExtractJob(acceptDb, 'u1');
    const candId = seedCandidate(acceptDb, {
      extractJobId,
      snapshotId,
      owner: 'u1',
      status: 'failed',
      confidence: null,
      retryCnt: 0,
      error: { userMessage: '没能识别', action: 'retry', retriable: true, traceId: 't' },
    });
    const accepted = await createRetryJob(acceptDb, queue, candId, 'u1');
    expect(accepted.kind).toBe('created');
    if (accepted.kind !== 'created') return;
    // 受理后：候选 failed→generating，retry_cnt 0→1（受理 CTE 的唯一一次 +1）。
    expect(acceptDb.candidates.get(candId)!.status).toBe('generating');
    expect(acceptDb.candidates.get(candId)!.retry_cnt).toBe(1);
    expect(accepted.job.retryCount).toBe(1); // 对外回放本次受理后的累计次数

    // —— 阶段② worker：把受理后的候选迁到 worker 夹具（ExtractFakeDb），跑 handler 的 runRetry 收尾 ——
    //   worker 收尾用 applyRetrySuccessInTx，已移除「再次 +1」（Codex#3），只翻状态/重写证据，retry_cnt 不动。
    const workerDb = new ExtractFakeDb();
    // 段集（重识别需读 snapshot 段集重聚类）。
    for (let i = 0; i < 5; i++) {
      const s: SegmentRowF = {
        id: `seg-${i}`,
        snapshot_id: snapshotId,
        title: '重构模块',
        source: 'claude',
        project: 'alpha',
        happened_at: null,
        content: 'refactor module dependency 重构 依赖 分析',
        message_count: 4,
      };
      workerDb.segments.set(s.id, s);
    }
    // 迁入受理后的候选行（generating, retry_cnt=1），保留同 id/snapshot/slug（worker runRetry 按 id 读、按 slug 定位簇）。
    const acc = acceptDb.candidates.get(candId)!;
    workerDb.candidates.set(candId, {
      id: candId,
      extract_job_id: extractJobId,
      snapshot_id: snapshotId,
      owner_user_id: 'u1',
      status: acc.status, // 'generating'
      error: acc.error,
      retry_cnt: acc.retry_cnt, // 1（受理 CTE 已 +1）
      slug: acc.slug,
      name: acc.name,
      intent: acc.intent,
      type: acc.type,
      confidence: acc.confidence,
      segment_count: acc.segment_count,
      frequency_ratio: acc.frequency_ratio,
      reusability: acc.reusability,
      scope_coherence: acc.scope_coherence,
      split_suggested: acc.split_suggested ?? false,
      scope: acc.scope,
      reusability_breakdown: acc.reusability_breakdown,
      created_at: acc.created_at,
    });
    // 新建的 retry job 行（worker 受保护写入据此 fence 守门）。
    const retryJobRow: JobRowF = {
      id: accepted.job.retryJobId,
      type: 'extract',
      status: 'running',
      owner_user_id: 'u1',
      subject_ref: acceptDb.jobs.get(accepted.job.retryJobId)!.subject_ref,
      progress: {},
      fence_token: 11,
    };
    workerDb.jobs.set(retryJobRow.id, retryJobRow);

    const tx = new ExtractFakeTxPool(workerDb);
    const gw = new FakeLlmGateway();
    gw.default = { text: '{"name":"重试后能力","intent":"重试后用途"}', degraded: false };
    const handler = createExtractHandler({ db: workerDb, txPool: tx, gateway: gw });
    const workerJob: LeasedJob = {
      id: retryJobRow.id,
      type: 'extract',
      ownerUserId: 'u1',
      subjectRef: retryJobRow.subject_ref as LeasedJob['subjectRef'],
      attemptNo: 1,
      fenceToken: 11,
      progress: { percent: 0, phrase: '', subtasks: [] },
    };
    const res = await handler.run(workerJob, makeNoopCtx());

    // worker 成功收尾：候选回 ready、证据重写。
    const done = workerDb.candidates.get(candId)!;
    expect(done.status).toBe('ready');
    expect((res.result as { status: string }).status).toBe('ready');
    // 关键守门：整链一次重试后 retry_cnt 恰为 1（受理 +1、worker 不再 +1）。若 worker 仍 +1 → 这里会是 2 → 红。
    expect(done.retry_cnt).toBe(1);
  });
});

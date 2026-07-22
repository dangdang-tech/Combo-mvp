// B-22/B-23 提取 Job handler 自检：五项子任务依次点亮 + 逐个浮现（item-appended）+ 计数量化、
//   置信分布摘要（高X中Y低Z）、单候选失败不阻塞其余、血缘复合 FK 同快照、取消保留已浮现、fence 收尾、
//   同事务 outbox（extract 完成→通知）、单候选重试（成功回填 ready / 再失败 failed / fence-out 干净退出）。
import { describe, it, expect } from 'vitest';
import type { SubtaskStatus, CandidateItem, ProgressView } from '@cb/shared';
import {
  createExtractHandler,
  EXTRACT_SUBTASK_KEYS,
  type ExtractHandlerDeps,
} from '../modules/extract/job.js';
import type { JobContext, LeasedJob } from '../platform/jobs/types.js';
import {
  ExtractFakeDb,
  ExtractFakeTxPool,
  FakeLlmGateway,
  type JobRowF,
  type SegmentRowF,
} from './extract-fakes.js';

// —— fixtures ——
function seg(over: Partial<SegmentRowF> & { id: string; snapshot_id: string }): SegmentRowF {
  return {
    title: '工作流',
    source: 'claude',
    project: null,
    happened_at: '2026-06-10T10:00:00.000Z',
    content: '内容',
    message_count: 4,
    ...over,
  };
}

interface CapturedCtx {
  ctx: JobContext;
  subtasks: Array<{ key: string; status: SubtaskStatus }>;
  progress: Array<{
    percent: number;
    phrase: string;
    done?: number;
    total?: number;
    metrics?: ProgressView['metrics'];
  }>;
  items: CandidateItem[];
  setCancelled: (v: boolean) => void;
}

function makeCtx(job: LeasedJob): CapturedCtx {
  const subtasks: Array<{ key: string; status: SubtaskStatus }> = [];
  const progress: CapturedCtx['progress'] = [];
  const items: CandidateItem[] = [];
  let cancelled = false;
  const ctx: JobContext = {
    jobId: job.id,
    traceId: 'trace-extract',
    fenceToken: job.fenceToken,
    attemptNo: job.attemptNo,
    signal: new AbortController().signal,
    isCancelled: () => cancelled,
    async reportProgress(u) {
      progress.push({
        percent: u.percent,
        phrase: u.phrase,
        done: u.done,
        total: u.total,
        metrics: u.metrics,
      });
    },
    async reportSubtask(key, status) {
      subtasks.push({ key, status });
    },
    async appendItem(item) {
      items.push(item as CandidateItem);
    },
    async emitField() {},
    async emitSlowHint() {},
  };
  return { ctx, subtasks, progress, items, setCancelled: (v) => (cancelled = v) };
}

function runningJob(db: ExtractFakeDb, over: Partial<LeasedJob> = {}): LeasedJob {
  const job: LeasedJob = {
    id: 'ejob-1',
    type: 'extract',
    ownerUserId: 'u1',
    subjectRef: { mode: 'extract', snapshotId: 'snap-1' },
    attemptNo: 1,
    fenceToken: 7,
    progress: { percent: 0, phrase: '', subtasks: [] },
    ...over,
  };
  const row: JobRowF = {
    id: job.id,
    type: 'extract',
    status: 'running',
    owner_user_id: job.ownerUserId,
    subject_ref: job.subjectRef,
    progress: {},
    fence_token: job.fenceToken,
  };
  db.jobs.set(job.id, row);
  return job;
}

/** 种入一个 snapshot 的段集（默认 8 段；真实全量提取应聚成 2 个工作流簇）。 */
function seedSegments(db: ExtractFakeDb, snapshotId: string): void {
  // 簇 A：proj-alpha，6 段（高频）。
  for (let i = 0; i < 6; i++) {
    const s = seg({
      id: `seg-a-${i}`,
      snapshot_id: snapshotId,
      project: 'alpha',
      title: '代码依赖审查',
      content: '代码 依赖 重构 审查 分析 修复 交付 回归',
    });
    db.segments.set(s.id, s);
  }
  // 簇 B：proj-beta，2 段（偶发）。
  for (let i = 0; i < 2; i++) {
    const s = seg({
      id: `seg-b-${i}`,
      snapshot_id: snapshotId,
      project: 'beta',
      title: '测试覆盖评审',
      content: '代码 单元 测试 覆盖 评审 验证 交付',
    });
    db.segments.set(s.id, s);
  }
}

function setup(): {
  db: ExtractFakeDb;
  tx: ExtractFakeTxPool;
  gw: FakeLlmGateway;
  handler: ReturnType<typeof createExtractHandler>;
} {
  const db = new ExtractFakeDb();
  const tx = new ExtractFakeTxPool(db);
  const gw = new FakeLlmGateway();
  const prepareCandidateDraft: NonNullable<ExtractHandlerDeps['prepareCandidateDraft']> = async (
    _deps,
    args,
  ) => ({
    kind: 'ready',
    capabilityId: `cap-${args.candidateId}`,
    versionId: `ver-${args.candidateId}`,
    slug: `trial-${args.candidateId}`,
  });
  const handler = createExtractHandler({
    db,
    txPool: tx,
    gateway: gw,
    prepareCandidateDraft,
    prepareConcurrency: 1,
  });
  return { db, tx, gw, handler };
}

describe('extract handler — 正常链路（B-22）', () => {
  it('五项子任务依次点亮 done + 逐个浮现候选（item-appended，刚浮现 isNew）+ 计数量化', async () => {
    const { db, handler } = setup();
    seedSegments(db, 'snap-1');
    const job = runningJob(db);
    const cap = makeCtx(job);
    const res = await handler.run(job, cap.ctx);

    // 五项子任务都点到 done（永不裸转圈，提取-03）。
    const doneKeys = cap.subtasks.filter((s) => s.status === 'done').map((s) => s.key);
    expect(doneKeys).toEqual(expect.arrayContaining(EXTRACT_SUBTASK_KEYS as unknown as string[]));
    // 子任务顺序：analyze 在 rank 前点亮（标准序）。
    const firstRunning = cap.subtasks.filter((s) => s.status === 'running').map((s) => s.key);
    expect(firstRunning[0]).toBe('analyze');
    expect(firstRunning[firstRunning.length - 1]).toBe('rank');

    // 逐个浮现：真实聚类后，alpha/beta 两个工作流簇各生成一个候选。
    expect(cap.items).toHaveLength(2);
    expect(cap.items.every((it) => it.isNew === true)).toBe(true);
    expect(cap.items.every((it) => it.status === 'ready')).toBe(true);

    // 候选 + 证据落库：每个候选挂载其簇内全部 session evidence。
    expect(db.candidates.size).toBe(cap.items.length);
    expect(db.evidence.size).toBe(8);
    expect([...db.candidates.values()].map((c) => c.segment_count).sort()).toEqual([2, 6]);

    // 计数：done/total 量化（提取-07/08），完成时 done==total。
    const last = cap.progress[cap.progress.length - 1]!;
    expect(last.percent).toBe(100);
    const counted = cap.progress.filter((p) => p.phrase.includes('已浮现'));
    expect(counted.length).toBeGreaterThan(0);
    expect(
      cap.progress.some(
        (p) => p.metrics?.analyzedSegments === 8 && p.metrics?.discoveredCandidates === 0,
      ),
    ).toBe(true);
    expect(last.metrics).toEqual({ analyzedSegments: 8, discoveredCandidates: cap.items.length });

    // done.result 摘要。
    const result = res.result as {
      candidateCount: number;
      readyCount: number;
      analyzedSegments: number;
    };
    expect(result.candidateCount).toBe(cap.items.length);
    expect(result.readyCount).toBe(cap.items.length);
    expect(result.analyzedSegments).toBe(8);
    expect(res.finalized).toBe(true);
  });

  it('血缘复合 FK：证据 segment_count = 证据行数 = 下钻条数（提取-34），且证据 snapshot 与候选同源', async () => {
    const { db, handler } = setup();
    seedSegments(db, 'snap-1');
    const job = runningJob(db);
    await handler.run(job, makeCtx(job).ctx);

    for (const c of db.candidates.values()) {
      const evRows = [...db.evidence.values()].filter((e) => e.candidate_id === c.id);
      // 频次条段数（segment_count 回填）== 证据行数（下钻条数）。
      expect(c.segment_count).toBe(evRows.length);
      // 证据 snapshot 与候选 snapshot 同源（复合 FK §11.E）。
      expect(evRows.every((e) => e.snapshot_id === c.snapshot_id)).toBe(true);
    }
  });

  it('发布准备前筛掉单段泛任务：大量一次性 session 不应拖慢 trial capability 预准备', async () => {
    const { db, handler } = setup();
    seedSegments(db, 'snap-1');
    for (let i = 0; i < 20; i++) {
      const s = seg({
        id: `one-off-${i}`,
        snapshot_id: 'snap-1',
        project: `one-off-project-${i}`,
        title: `aa${i} bb${i}`,
        content: `aa${i} bb${i} cc${i} dd${i}`,
        message_count: 20,
      });
      db.segments.set(s.id, s);
    }

    const job = runningJob(db);
    const cap = makeCtx(job);
    const res = await handler.run(job, cap.ctx);

    expect(cap.items).toHaveLength(2);
    expect(db.candidates.size).toBe(2);
    expect([...db.candidates.values()].map((c) => c.segment_count).sort()).toEqual([2, 6]);
    expect(
      cap.progress.some((p) => p.phrase.includes('已筛选出 2 / 22 个可发布候选')),
    ).toBe(true);
    expect((res.result as { candidateCount: number }).candidateCount).toBe(2);
  });

  it('置信分布摘要可派生（高X中Y低Z，提取-12）：ready 候选 confidence 三档之和 = ready 数', async () => {
    const { db, handler } = setup();
    seedSegments(db, 'snap-1');
    const job = runningJob(db);
    await handler.run(job, makeCtx(job).ctx);

    const ready = [...db.candidates.values()].filter((c) => c.status === 'ready');
    const high = ready.filter((c) => c.confidence === 'high').length;
    const med = ready.filter((c) => c.confidence === 'med').length;
    const low = ready.filter((c) => c.confidence === 'low').length;
    expect(high + med + low).toBe(ready.length);
    // 真实聚类默认候选应至少有一个 med/high，不出现全 low。
    expect(high + med).toBeGreaterThanOrEqual(1);
  });

  it('LLM 降级（无 key/不稳）→ 用确定性兜底名命名、不裸 502、整体仍完成（§10 degraded 不阻塞）', async () => {
    const { db, gw, handler } = setup();
    seedSegments(db, 'snap-1');
    gw.default = { degraded: true }; // 所有命名降级
    const job = runningJob(db);
    const res = await handler.run(job, makeCtx(job).ctx);
    // 仍完成、候选仍落库（名用聚类兜底）。
    expect((res.result as { candidateCount: number }).candidateCount).toBe(2);
    expect([...db.candidates.values()].every((c) => c.status === 'ready')).toBe(true);
    expect([...db.candidates.values()].every((c) => (c.name ?? '').length > 0)).toBe(true);
    expect([...db.candidates.values()].map((c) => c.name).sort()).toEqual([
      '代码依赖审查',
      '测试覆盖评审',
    ]);
    // done.result.degraded 诚实标 true（LLM 降级地完成，§10），但不算失败、不裸码。
    expect((res.result as { degraded: boolean }).degraded).toBe(true);
  });

  it('混合真实段与 Codex 平台噪声段：脏标题不生成候选，degraded 也不拿噪声当能力名', async () => {
    const { db, gw, handler } = setup();
    gw.default = { degraded: true };
    const noiseSegments = [
      seg({
        id: 'noise-env',
        snapshot_id: 'snap-1',
        source: 'codex',
        title: '<environment_context>',
        content: 'user: <environment_context>\n  <cwd>/x</cwd>\n</environment_context>',
      }),
      seg({
        id: 'noise-agents',
        snapshot_id: 'snap-1',
        source: 'codex',
        title: '# AGENTS.md instructions for /x',
        content: 'user: # AGENTS.md instructions for /x\n\n<INSTRUCTIONS>...</INSTRUCTIONS>',
      }),
    ];
    for (const s of noiseSegments) db.segments.set(s.id, s);
    for (let i = 0; i < 3; i++) {
      const s = seg({
        id: `real-prod-${i}`,
        snapshot_id: 'snap-1',
        source: 'codex',
        project: null,
        title: '生产链路排障',
        content: '定位 worker 日志 生产链路 上传 萃取 候选 质量',
      });
      db.segments.set(s.id, s);
    }

    const job = runningJob(db);
    const res = await handler.run(job, makeCtx(job).ctx);

    const names = [...db.candidates.values()].map((c) => c.name ?? '');
    expect((res.result as { candidateCount: number }).candidateCount).toBe(1);
    expect(names).toEqual(['生产链路排障']);
    expect(names.join('\n')).not.toContain('environment_context');
    expect(names.join('\n')).not.toContain('AGENTS.md');
    expect((res.result as { degraded: boolean }).degraded).toBe(true);
  });

  it('同事务落 completed + 发 extract 完成通知（Codex P0-3：业务状态+job结果+outbox 同一 PG 事务）', async () => {
    const { db, tx, handler } = setup();
    seedSegments(db, 'snap-1');
    const job = runningJob(db);
    const res = await handler.run(job, makeCtx(job).ctx);
    expect(tx.outbox).toHaveLength(1);
    expect(tx.outbox[0]!.topic).toBe('notify.extract_completed');
    expect(tx.outbox[0]!.eventId).toBe(`extract_done:${job.id}:${job.attemptNo}`);
    const payload = tx.outbox[0]!.payload as { recipientId: string; candidateCount: number };
    expect(payload.recipientId).toBe('u1');
    expect(payload.candidateCount).toBe((res.result as { candidateCount: number }).candidateCount);
    expect(db.jobs.get(job.id)!.status).toBe('completed');
    // 收尾（complete job + outbox）同事务提交成功，全程无回滚（Codex#4 后单候选各自事务 + 收尾事务都 COMMIT）。
    expect(tx.committed.length).toBeGreaterThanOrEqual(1);
    expect(tx.rolledBack).toHaveLength(0);
    expect(res.finalized).toBe(true);
  });

  it('全量提取完成会原子回写匹配草稿，工作台无需用户再次保存即可看到 Agent 已准备好', async () => {
    const { db, handler } = setup();
    seedSegments(db, 'snap-1');
    const job = runningJob(db);
    db.drafts.set('draft-1', {
      id: 'draft-1',
      owner_user_id: 'u1',
      status: 'active',
      current_step: 'extract',
      extract_job_id: job.id,
      step_progress: { percent: 42, phrase: '正在识别 Agent' },
    });
    db.drafts.set('draft-2', {
      id: 'draft-2',
      owner_user_id: 'u1',
      status: 'active',
      current_step: 'select',
      extract_job_id: job.id,
      step_progress: { percent: 88, phrase: '旧的完成文案' },
    });
    db.drafts.set('draft-archived', {
      id: 'draft-archived',
      owner_user_id: 'u1',
      status: 'archived',
      current_step: 'extract',
      extract_job_id: job.id,
      step_progress: { percent: 10, phrase: '归档状态不应变化' },
    });

    await handler.run(job, makeCtx(job).ctx);

    const draft = db.drafts.get('draft-1')!;
    expect(draft.step_progress).toEqual({ percent: 100, phrase: '已准备好 2 个 Agent' });
    expect(draft.current_step).toBe('extract'); // 完成回写只更新进度，不擅自推进步骤。
    expect(db.drafts.get('draft-2')).toMatchObject({
      current_step: 'select',
      step_progress: { percent: 88, phrase: '旧的完成文案' },
    });
    expect(db.drafts.get('draft-archived')!.step_progress).toEqual({
      percent: 10,
      phrase: '归档状态不应变化',
    });
  });

  it('同事务 outbox 失败 → 收尾回滚：job 不落 completed、不吞失败（已浮现候选保留）', async () => {
    const { db, tx, handler } = setup();
    seedSegments(db, 'snap-1');
    tx.throwOnOutbox = true;
    const job = runningJob(db);
    db.drafts.set('draft-rollback', {
      id: 'draft-rollback',
      owner_user_id: 'u1',
      status: 'active',
      current_step: 'extract',
      extract_job_id: job.id,
      step_progress: { percent: 75, phrase: '正在准备 Agent' },
    });
    await expect(handler.run(job, makeCtx(job).ctx)).rejects.toBeTruthy();
    // 候选已落（各自单候选事务已 COMMIT，已浮现不丢），但收尾事务（complete job + outbox）抛错 ROLLBACK：
    //   job 未落 completed、outbox 无行、发生过回滚（绝不吞失败、不另起事务，Codex P0-3）。
    expect(db.candidates.size).toBe(2);
    expect(db.jobs.get(job.id)!.status).toBe('running');
    expect(tx.outbox).toHaveLength(0);
    expect(tx.rolledBack.length).toBeGreaterThanOrEqual(1);
    expect(db.drafts.get('draft-rollback')!.step_progress).toEqual({
      percent: 75,
      phrase: '正在准备 Agent',
    });
  });

  it('空态：snapshot 无段 → 候选 0、completed、candidateCount=0（提取-26，非错误、非裸转圈）', async () => {
    const { db, tx, handler } = setup();
    // 不种段。
    const job = runningJob(db);
    db.drafts.set('draft-empty', {
      id: 'draft-empty',
      owner_user_id: 'u1',
      status: 'active',
      current_step: 'extract',
      extract_job_id: job.id,
      step_progress: { percent: 25, phrase: '正在识别 Agent' },
    });
    const cap = makeCtx(job);
    const res = await handler.run(job, cap.ctx);
    expect((res.result as { candidateCount: number }).candidateCount).toBe(0);
    expect(res.finalized).toBe(true);
    expect(db.jobs.get(job.id)!.status).toBe('completed');
    expect(tx.outbox).toHaveLength(1); // 仍发完成通知（带 candidateCount=0）
    expect(db.drafts.get('draft-empty')).toMatchObject({
      current_step: 'extract',
      step_progress: { percent: 100, phrase: '没有识别到可复用的 Agent' },
    });
    // 五项子任务仍全部点亮（永不裸转圈）。
    expect(cap.subtasks.filter((s) => s.status === 'done').length).toBeGreaterThanOrEqual(5);
  });
});

describe('extract handler — 单候选原子落库（Codex#4：证据/回填失败 → 不出 ready，血缘不半残）', () => {
  it('证据 INSERT 抛错 → 整单事务 ROLLBACK：候选不落 ready（改 failed item），绝不留「ready 但无 evidence」', async () => {
    const { db, tx, handler } = setup();
    seedSegments(db, 'snap-1');
    tx.throwOnEvidence = true; // 单候选事务里证据 INSERT 抛错 → 候选 INSERT 一并回滚（原子）。
    const job = runningJob(db);
    const cap = makeCtx(job);
    const res = await handler.run(job, cap.ctx);

    // 反向破坏守门：绝不存在「ready 候选但 evidence 缺失」的半残血缘。
    const ready = [...db.candidates.values()].filter((c) => c.status === 'ready');
    expect(ready).toHaveLength(0); // 证据失败 → 候选整单 ROLLBACK，不留 ready
    expect(db.evidence.size).toBe(0); // 证据一条都没落（事务回滚）
    // 任何 ready 候选都必须有匹配的证据行（血缘一致；这里 ready 数为 0，空集天然满足，但显式断言不出半残）。
    for (const c of ready) {
      const ev = [...db.evidence.values()].filter((e) => e.candidate_id === c.id);
      expect(ev.length).toBe(c.segment_count);
      expect(ev.length).toBeGreaterThan(0);
    }
    // 落库失败的候选改走 failed item（人话 error），不是裸 ready、不是裸错误码（提取-17）。
    const failedItems = cap.items.filter((it) => it.status === 'failed');
    expect(failedItems.length).toBeGreaterThanOrEqual(1);
    expect(cap.items.every((it) => it.status !== 'ready')).toBe(true);
    expect(failedItems[0]!.error?.userMessage).toContain('没能识别');
    // job 整体仍 completed（单候选落库失败 ≠ job 失败，无连坐）。
    expect(res.finalized).toBe(true);
    expect((res.result as { readyCount: number; failedCount: number }).readyCount).toBe(0);
    expect((res.result as { failedCount: number }).failedCount).toBeGreaterThanOrEqual(1);
  });

  it('证据/count 回填 0 行（fence out）→ 整单事务 ROLLBACK：无半 ready、无证据残留（Codex r2#1）', async () => {
    const { db, tx, handler } = setup();
    seedSegments(db, 'snap-1');
    tx.zeroRowSegmentCount = true; // 候选+证据写入后，segment_count 回填受保护写返回 0 行（模拟该步 fence out）。
    const job = runningJob(db);
    const cap = makeCtx(job);
    const res = await handler.run(job, cap.ctx);

    // 反向破坏守门：segment_count 回填 0 行 → 抛哨兵 → 候选/证据整单 ROLLBACK（绝不留「ready 但 count 半残/证据缺失」）。
    expect([...db.candidates.values()].filter((c) => c.status === 'ready')).toHaveLength(0);
    expect(db.evidence.size).toBe(0); // 证据随事务一并回滚，零残留
    expect(tx.rolledBack.length).toBeGreaterThanOrEqual(1); // 确有回滚发生
    // fence out（哨兵）≠ 「这一项识别失败」→ 不落 failed item（已浮现保留语义，停在安全点）。
    expect(cap.items.filter((it) => it.status === 'failed')).toHaveLength(0);
    // 收尾本身仍 fence 匹配（job 未换 fence）→ job 落 completed，但因每个候选都 fence-out 跳过，readyCount=0。
    expect((res.result as { readyCount: number }).readyCount).toBe(0);
  });

  it('正常路径：每个 ready 候选的 segment_count == 其证据行数（同事务原子回填，提取-34）', async () => {
    const { db, handler } = setup();
    seedSegments(db, 'snap-1');
    const job = runningJob(db);
    await handler.run(job, makeCtx(job).ctx);
    const ready = [...db.candidates.values()].filter((c) => c.status === 'ready');
    expect(ready).toHaveLength(2);
    for (const c of ready) {
      const ev = [...db.evidence.values()].filter((e) => e.candidate_id === c.id);
      expect(c.segment_count).toBe(ev.length); // 频次条段数 == 下钻条数，绝不漂
    }
  });
});

describe('extract handler — LLM 单候选失败不阻塞', () => {
  it('某次命名 LLM 抛错 → 该簇落 failed，其余簇继续 ready，整体 completed', async () => {
    const { db, gw, handler } = setup();
    seedSegments(db, 'snap-1');
    // 第一次 complete 抛错（第一个簇命名失败），其余正常。
    gw.responses = [{ throwIt: true }];
    const job = runningJob(db);
    const cap = makeCtx(job);
    const res = await handler.run(job, cap.ctx);

    const failed = [...db.candidates.values()].filter((c) => c.status === 'failed');
    const ready = [...db.candidates.values()].filter((c) => c.status === 'ready');
    expect(failed).toHaveLength(1);
    expect(ready).toHaveLength(1);
    expect(failed[0]!.error).toBeTruthy();
    // job 整体仍 completed（单候选失败不影响 job 状态，提取边界）。
    expect(db.jobs.get(job.id)!.status).toBe('completed');
    const r = res.result as { failedCount: number; readyCount: number; degraded: boolean };
    expect(r.failedCount).toBe(1);
    expect(r.readyCount).toBe(ready.length);
    expect(r.degraded).toBe(false);
    expect(cap.items).toHaveLength(2);
    expect(cap.items.some((it) => it.status === 'failed')).toBe(true);
    expect(cap.items.some((it) => it.status === 'ready')).toBe(true);
  });
});

describe('extract handler — 取消保留已浮现（硬规则③）', () => {
  it('浮现一个候选后取消（换 fence）→ 停在安全点，已浮现候选保留、不发 completed', async () => {
    const { db, tx, handler } = setup();
    seedSegments(db, 'snap-1');
    const job = runningJob(db);
    const cap = makeCtx(job);
    // 第一个候选 appendItem 后换 fence（模拟取消）+ 标 cancelled。
    let appended = 0;
    const realAppend = cap.ctx.appendItem.bind(cap.ctx);
    (cap.ctx as { appendItem: JobContext['appendItem'] }).appendItem = async (item: unknown) => {
      await realAppend(item);
      appended++;
      if (appended === 1) {
        db.jobs.get(job.id)!.fence_token = 999;
        cap.setCancelled(true);
      }
    };
    const res = await handler.run(job, cap.ctx);
    // 已浮现第一个候选保留（已生成不丢）。
    expect(db.candidates.size).toBeGreaterThanOrEqual(1);
    // 收尾 completeJobInTx fence out → 不发通知、job 未落 completed。
    expect(res.finalized).not.toBe(true);
    expect(tx.outbox).toHaveLength(0);
    expect(db.jobs.get(job.id)!.status).toBe('running');
  });
});

describe('extract handler — sweeper 接管重跑收尾合并不丢候选（Codex r3 P1，已生成不丢）', () => {
  it('attempt1 落候选 → sweeper 重入队 attempt2（去重跳过旧候选）→ 终态 finalProgress.items/result/outbox 含全部旧候选（合并重建）', async () => {
    const { db, tx, handler } = setup();
    seedSegments(db, 'snap-1');

    // —— attempt1（fence=7）：正常跑完，落候选（含 ready）+ 发一条 notify.extract_completed ——
    const job1 = runningJob(db, { attemptNo: 1, fenceToken: 7 });
    const cap1 = makeCtx(job1);
    const res1 = await handler.run(job1, cap1.ctx);
    const attempt1Count = (res1.result as { candidateCount: number }).candidateCount;
    expect(attempt1Count).toBe(2);
    const candIdsAfter1 = new Set([...db.candidates.keys()]);
    expect(candIdsAfter1.size).toBe(attempt1Count);
    const outboxAfter1 = tx.outbox.length;
    expect(outboxAfter1).toBe(1);

    // —— sweeper 接管：同一 extract job（同 id）重入队 attempt2，换 fence=8、status 回 running ——
    //   runningJob 用同 id 覆盖 DB job 行回 running + fence=8（忠实模拟 sweeper 重入队换 fence）。
    const job2 = runningJob(db, { attemptNo: 2, fenceToken: 8 });
    const cap2 = makeCtx(job2);
    const res2 = await handler.run(job2, cap2.ctx);

    // attempt2 重聚类同段集 → 同 slug → (extract_job_id, slug) 去重命中 → 本 attempt 内存累加器无新 append。
    expect(cap2.items.length).toBe(0); // 本轮没有「刚浮现」的新候选
    // 但 DB 候选数不变（旧候选保留，未新增、未丢）。
    expect(db.candidates.size).toBe(attempt1Count);
    expect(new Set([...db.candidates.keys()])).toEqual(candIdsAfter1);

    // —— 终态从 DB 全量候选合并重建：含全部旧候选，不丢（硬规则③）——
    const r2 = res2.result as { candidateCount: number; readyCount: number; failedCount: number };
    expect(r2.candidateCount).toBe(attempt1Count); // = DB 实际候选数
    expect(r2.readyCount + r2.failedCount).toBe(attempt1Count);
    expect(res2.finalized).toBe(true);

    // finalProgress.items 含全部已生成候选（≥2），与 DB 候选 id 一一对应。
    const finalItems = res2.finalProgress!.items ?? [];
    expect(finalItems.length).toBe(attempt1Count);
    expect(new Set(finalItems.map((it) => it.id))).toEqual(candIdsAfter1);
    // 收尾合并的旧候选不是「刚浮现」→ isNew=false（本 attempt 无新 append，全部为合并旧项）。
    expect(finalItems.every((it) => it.isNew === false)).toBe(true);

    // outbox candidateCount = DB 实际候选数（与终态一致，不丢）。
    const retryOutbox = tx.outbox.slice(outboxAfter1);
    expect(retryOutbox).toHaveLength(1);
    expect((retryOutbox[0]!.payload as { candidateCount: number }).candidateCount).toBe(
      attempt1Count,
    );

    // 置信分布摘要正确：finalProgress.items 的 ready confidence 三档之和 = DB ready 数。
    const dbReady = [...db.candidates.values()].filter((c) => c.status === 'ready');
    const itemReady = finalItems.filter((it) => it.status === 'ready');
    const high = itemReady.filter((it) => it.confidence === 'high').length;
    const med = itemReady.filter((it) => it.confidence === 'med').length;
    const low = itemReady.filter((it) => it.confidence === 'low').length;
    expect(high + med + low).toBe(dbReady.length);
    expect(itemReady.length).toBe(dbReady.length);

    // job 落 completed，finalProgress.done==total（量化不撕裂）。
    expect(db.jobs.get('ejob-1')!.status).toBe('completed');
    expect(res2.finalProgress!.done).toBe(res2.finalProgress!.total);
    expect(res2.finalProgress!.total).toBe(attempt1Count);
  });

  it('反向破坏可被守门：只统计本 attempt（不从 DB 合并）→ 终态丢旧候选（候选数/计数掉到 0，断言失败）', async () => {
    // 这是「反向破坏」语义的显式锚点：buildFinalFromDb 从 DB 真源重建是本修复的核心。
    //   若把收尾改回「只用本 attempt 内存累加器 items/readyCount/failedCount」，则 attempt2 收尾会得到 0 候选 ——
    //   下方对「合并重建 = DB 真源」的断言会红（候选丢失）。此处正向验证合并值 != 本 attempt 局部值（0）。
    const { db, tx, handler } = setup();
    seedSegments(db, 'snap-1');
    const job1 = runningJob(db, { attemptNo: 1, fenceToken: 7 });
    const cap1 = makeCtx(job1);
    await handler.run(job1, cap1.ctx);
    const dbCount = db.candidates.size;

    const job2 = runningJob(db, { attemptNo: 2, fenceToken: 8 }); // sweeper 重入队同 id job，换 fence=8 回 running
    const cap2 = makeCtx(job2);
    const res2 = await handler.run(job2, cap2.ctx);

    // 本 attempt 局部累加器为 0（去重全跳过）——若收尾用它就会丢候选。
    const attemptLocalCount = cap2.items.length;
    expect(attemptLocalCount).toBe(0);
    // 合并重建后的终态计数严格大于本 attempt 局部计数（= DB 真源，已生成不丢）。
    const merged = (res2.result as { candidateCount: number }).candidateCount;
    expect(merged).toBe(dbCount);
    expect(merged).toBeGreaterThan(attemptLocalCount); // 守门：合并值 > 局部值，否则即「只统计本 attempt」回归
    expect((tx.outbox.at(-1)!.payload as { candidateCount: number }).candidateCount).toBe(dbCount);
  });
});

describe('extract handler — 单候选重试（B-23，新 retry job + 新流）', () => {
  /** 先跑一次萃取产出候选，再人为把一个候选标 failed，模拟 retry job 接力。 */
  async function seedFailedCandidate(): Promise<{
    db: ExtractFakeDb;
    tx: ExtractFakeTxPool;
    gw: FakeLlmGateway;
    handler: ReturnType<typeof createExtractHandler>;
    candidateId: string;
  }> {
    const { db, tx, gw, handler } = setup();
    seedSegments(db, 'snap-1');
    const job = runningJob(db);
    await handler.run(job, makeCtx(job).ctx);
    // 取一个候选标 failed（模拟首轮失败）。
    const c = [...db.candidates.values()][0]!;
    c.status = 'failed';
    c.error = {
      userMessage: '这一项没能识别出来，可点重试。',
      action: 'retry',
      retriable: true,
      traceId: 't',
    };
    // 删它的证据，模拟失败候选无证据。
    for (const [k, e] of db.evidence) if (e.candidate_id === c.id) db.evidence.delete(k);
    return { db, tx, gw, handler, candidateId: c.id };
  }

  it('重试成功 → 候选回填 ready + 重写证据 + segment_count 一致 + item-appended（同 id，status=ready）', async () => {
    const { db, tx, gw, handler, candidateId } = await seedFailedCandidate();
    const outboxBefore = tx.outbox.length; // 首轮全量萃取已发过一条 notify.extract_completed
    // 新 retry job（mode='single-candidate'）。
    const retryJob = runningJob(db, {
      id: 'retry-1',
      fenceToken: 11,
      subjectRef: {
        mode: 'single-candidate',
        snapshotId: 'snap-1',
        candidateId,
        extractJobId: 'ejob-1',
      },
    });
    db.drafts.set('draft-retry', {
      id: 'draft-retry',
      owner_user_id: 'u1',
      status: 'active',
      current_step: 'select',
      extract_job_id: retryJob.id,
      step_progress: { percent: 64, phrase: '保留项目级进度' },
    });
    gw.default = { text: '{"name":"重试后能力","intent":"重试后用途"}', degraded: false };
    const cap = makeCtx(retryJob);
    const res = await handler.run(retryJob, cap.ctx);

    const c = db.candidates.get(candidateId)!;
    expect(c.status).toBe('ready');
    expect(c.error).toBeNull();
    expect(c.name).toBe('重试后能力');
    // 证据重写 + segment_count == 证据行数（提取-34 不漂）。
    const evRows = [...db.evidence.values()].filter((e) => e.candidate_id === candidateId);
    expect(evRows.length).toBeGreaterThan(0);
    expect(c.segment_count).toBe(evRows.length);
    expect(evRows.every((e) => e.snapshot_id === c.snapshot_id)).toBe(true);
    // worker（runRetry）收尾不再 +1（Codex#3 双重加一）：retry_cnt 的 +1 由受理 CTE（createRetryJob）承载。
    //   本测从 retry_cnt=0 的失败候选直接跑 worker（不经受理）→ 维持 0。整链「受理+worker = 只 +1」见 retry-chain 集成测。
    expect(c.retry_cnt).toBe(0);
    // 回填帧：同 candidateId、status=ready、isNew=false（前端原地替换失败行，提取-19）。
    const readyItems = cap.items.filter((it) => it.status === 'ready');
    expect(readyItems.at(-1)!.id).toBe(candidateId);
    expect(readyItems.at(-1)!.isNew).toBe(false);
    expect((res.result as { status: string }).status).toBe('ready');
    // Codex#5：retry job 也走 handler 内同事务收尾 → retry job 落 completed + 发 notify.extract_completed（口径同全量）。
    expect(res.finalized).toBe(true);
    expect(db.jobs.get('retry-1')!.status).toBe('completed');
    const retryOutbox = tx.outbox.slice(outboxBefore);
    expect(retryOutbox).toHaveLength(1);
    expect(retryOutbox[0]!.topic).toBe('notify.extract_completed');
    // event_id = extract_done:{retryJobId}:{attemptNo}（retry job 自己的 id/attempt，与原萃取 job 不撞）。
    expect(retryOutbox[0]!.eventId).toBe(`extract_done:retry-1:${retryJob.attemptNo}`);
    expect((retryOutbox[0]!.payload as { candidateCount: number }).candidateCount).toBe(1);
    expect(db.drafts.get('draft-retry')!.step_progress).toEqual({
      percent: 64,
      phrase: '保留项目级进度',
    });
  });

  it('重试再失败（命名 LLM 抛错）→ 候选回 failed + 人话 error，无连坐（其余候选不动）', async () => {
    const { db, gw, handler, candidateId } = await seedFailedCandidate();
    const others = [...db.candidates.values()]
      .filter((c) => c.id !== candidateId)
      .map((c) => ({ id: c.id, status: c.status }));
    const retryJob = runningJob(db, {
      id: 'retry-2',
      fenceToken: 12,
      subjectRef: {
        mode: 'single-candidate',
        snapshotId: 'snap-1',
        candidateId,
        extractJobId: 'ejob-1',
      },
    });
    gw.responses = [{ throwIt: true }]; // 重命名抛错 → 再失败
    const cap = makeCtx(retryJob);
    const res = await handler.run(retryJob, cap.ctx);

    const c = db.candidates.get(candidateId)!;
    expect(c.status).toBe('failed');
    const err = c.error as { userMessage: string; action: string };
    expect(err.userMessage).toContain('没能识别');
    expect(err.action).toBe('retry');
    expect((res.result as { status: string }).status).toBe('failed');
    // 无连坐：其余候选状态原样。
    for (const o of others) expect(db.candidates.get(o.id)!.status).toBe(o.status);
    // 失败回填帧（同 id、status=failed）。
    expect(cap.items.at(-1)!.id).toBe(candidateId);
    expect(cap.items.at(-1)!.status).toBe('failed');
  });

  it('再失败的 failed 回写 0 行（retry job 被换 fence）→ 不 append failed、不 finalize completed，返回 fenced_out（Codex r2#2）', async () => {
    const { db, tx, gw, handler, candidateId } = await seedFailedCandidate();
    const outboxBefore = tx.outbox.length;
    const beforeStatus = db.candidates.get(candidateId)!.status; // 'failed'（首轮失败态）
    // leased retry job fence=21；但 DB 里 retry job 行 fence 被换成 99（模拟受理后被接管换 fence）。
    const retryJob = runningJob(db, {
      id: 'retry-zero',
      fenceToken: 21,
      subjectRef: {
        mode: 'single-candidate',
        snapshotId: 'snap-1',
        candidateId,
        extractJobId: 'ejob-1',
      },
    });
    db.jobs.get('retry-zero')!.fence_token = 99; // 换 fence → applyRetryFailureProtected guard 0 行
    gw.responses = [{ throwIt: true }]; // 命名抛错 → 走 reportRetryFailed（再失败回写）
    const cap = makeCtx(retryJob);
    const res = await handler.run(retryJob, cap.ctx);

    // failed 回写 0 行（fence out）→ 不吞、不假装成功：
    //   ① 不 appendItem(failed)（避免「DB 仍 generating / 流显示 failed」状态撕裂）。
    expect(cap.items.filter((it) => it.status === 'failed')).toHaveLength(0);
    //   ② 不 finalize completed（retry job 未落 completed、无 extract_completed outbox）。
    expect(db.jobs.get('retry-zero')!.status).toBe('running');
    expect(tx.outbox.slice(outboxBefore)).toHaveLength(0);
    //   ③ 返回 fenced_out（交还 runner 兜，不发 done completed）。
    expect((res.result as { status: string }).status).toBe('fenced_out');
    expect(res.finalized).not.toBe(true);
    //   ④ 候选行未被改（fence out 写 0 行，DB 维持原状，绝不半残）。
    expect(db.candidates.get(candidateId)!.status).toBe(beforeStatus);
  });

  it('重试达上限 escalate：subject_ref.escalate → 再失败时 action=escalate（提取-20/§2.3）', async () => {
    const { db, gw, handler, candidateId } = await seedFailedCandidate();
    const retryJob = runningJob(db, {
      id: 'retry-3',
      fenceToken: 13,
      subjectRef: {
        mode: 'single-candidate',
        snapshotId: 'snap-1',
        candidateId,
        extractJobId: 'ejob-1',
        escalate: true,
      },
    });
    gw.responses = [{ throwIt: true }];
    await handler.run(retryJob, makeCtx(retryJob).ctx);
    const err = db.candidates.get(candidateId)!.error as { action: string; userMessage: string };
    expect(err.action).toBe('escalate');
    expect(err.userMessage).toContain('反馈');
  });

  it('重试时 retry job 被 fence out（换 fence）→ 干净退出：候选不被改、证据不动（无连坐、不污染）', async () => {
    const { db, gw, handler, candidateId } = await seedFailedCandidate();
    const before = { ...db.candidates.get(candidateId)! };
    const retryJob = runningJob(db, {
      id: 'retry-4',
      fenceToken: 14,
      subjectRef: {
        mode: 'single-candidate',
        snapshotId: 'snap-1',
        candidateId,
        extractJobId: 'ejob-1',
      },
    });
    gw.default = { text: '{"name":"x","intent":"y"}', degraded: false };
    const cap = makeCtx(retryJob);
    // 命名后、写库前换 fence（模拟接管/取消）。
    let named = false;
    const realSubtask = cap.ctx.reportSubtask.bind(cap.ctx);
    (cap.ctx as { reportSubtask: JobContext['reportSubtask'] }).reportSubtask = async (k, s, l) => {
      await realSubtask(k, s, l);
      if (k === 'rank' && s === 'running' && !named) {
        named = true;
        db.jobs.get(retryJob.id)!.fence_token = 999; // fence out 前置：applyRetrySuccessInTx 第一步 guard 0 行
        cap.setCancelled(true);
      }
    };
    const res = await handler.run(retryJob, cap.ctx);
    // 候选未被改（仍 failed），不发 ready 回填。
    expect(db.candidates.get(candidateId)!.status).toBe('failed');
    expect(db.candidates.get(candidateId)!.name).toBe(before.name);
    expect((res.result as { status: string }).status).toBe('fenced_out');
  });
});

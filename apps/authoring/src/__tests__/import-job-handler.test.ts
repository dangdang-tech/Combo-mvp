// B-19 导入 Job handler 自检：子任务进度流、解析+去敏落库、快照内去重、重导新快照、去敏报告落库、
//   空结果 IMPORT_NO_CONTENT、S3 失败归一、取消保留已生成段、同事务发 import 完成通知。
import { gzipSync } from 'node:zlib';
import { describe, it, expect } from 'vitest';
import type { SubtaskStatus } from '@cb/shared';
import { createImportHandler } from '../modules/import/job.js';
import { BUNDLE_SENTINEL, computeContentHash } from '../modules/import/session-parse.js';
import type { JobContext, LeasedJob } from '../platform/jobs/types.js';
import { ImportFakeDb, FakeObjectStore, FakeTxPool, type JobRowF } from './import-fakes.js';

// —— 真实格式 fixture（对齐 B-18 解析口径）——
function claudeSession(
  lines: Array<{ role: string; text: string; ts?: string; cwd?: string }>,
): string {
  return lines
    .map((l) =>
      JSON.stringify({
        type: 'message',
        message: { role: l.role, content: l.text },
        timestamp: l.ts ?? '2026-03-20T10:00:00.000Z',
        cwd: l.cwd ?? '/home/u/proj-alpha',
      }),
    )
    .join('\n');
}

/** Codex 会话 fixture（对齐 B-18：{type, payload, timestamp}，顶层 payload 而非 message）。 */
function codexSession(
  userText: string,
  assistantText: string,
  ts = '2026-06-01T12:00:00.000Z',
): string {
  return [
    { type: 'session_meta', timestamp: ts, payload: { cwd: '/Users/dev/repos/codex-proj' } },
    { type: 'event_msg', timestamp: ts, payload: { type: 'user_message', message: userText } },
    {
      type: 'event_msg',
      timestamp: ts,
      payload: { type: 'agent_message', message: assistantText },
    },
  ]
    .map((o) => JSON.stringify(o))
    .join('\n');
}

interface CapturedCtx {
  ctx: JobContext;
  subtasks: Array<{ key: string; status: SubtaskStatus }>;
  progress: Array<{ percent: number; phrase: string }>;
  items: unknown[];
  setCancelled: (v: boolean) => void;
}

function makeCtx(job: LeasedJob, db: ImportFakeDb): CapturedCtx {
  const subtasks: Array<{ key: string; status: SubtaskStatus }> = [];
  const progress: Array<{ percent: number; phrase: string }> = [];
  const items: unknown[] = [];
  let cancelled = false;
  const ctx: JobContext = {
    jobId: job.id,
    traceId: 'trace-import',
    fenceToken: job.fenceToken,
    attemptNo: job.attemptNo,
    signal: new AbortController().signal,
    isCancelled: () => cancelled,
    async reportProgress(u) {
      progress.push({ percent: u.percent, phrase: u.phrase });
    },
    async reportSubtask(key, status) {
      subtasks.push({ key, status });
    },
    async appendItem(item) {
      items.push(item);
    },
    async emitField() {
      /* noop */
    },
    async emitSlowHint() {
      /* noop */
    },
  };
  void db;
  return { ctx, subtasks, progress, items, setCancelled: (v) => (cancelled = v) };
}

function leased(db: ImportFakeDb, over: Partial<LeasedJob> = {}): LeasedJob {
  const job: LeasedJob = {
    id: 'job-1',
    type: 'import',
    ownerUserId: 'u1',
    subjectRef: { uploadId: 'up1', source: 'claude', rawS3Keys: ['raw/claude/f1.jsonl'] },
    attemptNo: 1,
    fenceToken: 7,
    progress: { percent: 0, phrase: '', subtasks: [] },
    ...over,
  };
  // 注入对应 running job 行（受保护写入需 jobs 行存在 + fence + running）。
  const row: JobRowF = {
    id: job.id,
    type: 'import',
    status: 'running',
    owner_user_id: job.ownerUserId,
    subject_ref: job.subjectRef,
    progress: {},
    fence_token: job.fenceToken,
  };
  db.jobs.set(job.id, row);
  return job;
}

function setup(objects: Record<string, string>) {
  const db = new ImportFakeDb();
  const store = new FakeObjectStore(new Map(Object.entries(objects)));
  // 同事务 supersede + completeJobInTx 落血缘/completed 到 db（Codex P0-3/P1-r3：血缘+业务状态+outbox 同一事务）。
  const txPool = new FakeTxPool(db.jobs, db.snapshots);
  const handler = createImportHandler({ db, txPool, objectStore: store });
  return { db, store, txPool, handler };
}

describe('import handler — 正常链路', () => {
  it('五项子任务依次点亮 done + 边写段边 item-appended + 建快照', async () => {
    const raw = claudeSession([
      { role: 'user', text: '帮我重构这个模块' },
      { role: 'assistant', text: '好的，先看依赖' },
    ]);
    const { db, handler } = setup({ 'raw/claude/f1.jsonl': raw });
    const job = leased(db);
    const cap = makeCtx(job, db);
    const res = await handler.run(job, cap.ctx);

    // 五项子任务都点到 done（永不裸转圈，导入-08）。
    const doneKeys = cap.subtasks.filter((s) => s.status === 'done').map((s) => s.key);
    expect(doneKeys).toEqual(
      expect.arrayContaining(['credential', 'fetch_index', 'redact', 'segment', 'snapshot']),
    );
    // 建了快照 + 写了段 + item-appended（边生成边显示，导入-09）。
    expect(db.snapshots.size).toBe(1);
    expect(db.segments.size).toBe(1);
    expect(cap.items).toHaveLength(1);
    expect((res.result as { snapshotId: string }).snapshotId).toBe([...db.snapshots.keys()][0]);
    // 进度收尾 100%。
    expect(cap.progress[cap.progress.length - 1]!.percent).toBe(100);
  });

  it('去敏真生效：含手机号原文 → 段正文不含明文、快照去敏报告计数 ≥1（导入-30/§5.4）', async () => {
    const raw = claudeSession([{ role: 'user', text: '我的手机号是 13812345678 帮我记一下' }]);
    const { db, handler } = setup({ 'raw/claude/f1.jsonl': raw });
    const job = leased(db);
    const cap = makeCtx(job, db);
    await handler.run(job, cap.ctx);
    const seg = [...db.segments.values()][0]!;
    expect(seg.content).not.toContain('13812345678'); // 明文已抹
    const snap = [...db.snapshots.values()][0]!;
    const report = snap.redaction_report as { totalRedactions: number; rulesetVersion: string };
    expect(report.totalRedactions).toBeGreaterThanOrEqual(1);
    expect(report.rulesetVersion).toBe('redaction-v1');
    expect(snap.redaction_ruleset_ver).toBe('redaction-v1');
  });

  it('JSON 转义 NUL：raw 层无真实 0x00，JSON.parse 后字段级清洗再落库（PG text 22021 回归）', async () => {
    const raw = claudeSession([{ role: 'user', text: `前缀${'\u0000'}后缀` }]);
    expect(raw).toContain('\\u0000');
    expect(raw).not.toContain('\u0000');
    const { db, handler } = setup({ 'raw/claude/f1.jsonl': raw });
    const job = leased(db);
    const cap = makeCtx(job, db);
    await handler.run(job, cap.ctx);
    const seg = [...db.segments.values()][0]!;
    expect(seg.content).not.toContain('\u0000');
    expect(seg.title).not.toContain('\u0000');
    expect(seg.content).toContain('前缀后缀');
    expect(seg.content_hash).toBe(computeContentHash(seg.content));
  });

  it('快照内去重：两个完全相同会话 → 只写一段（导入-22）', async () => {
    const one = claudeSession([{ role: 'user', text: '同一段内容' }]);
    const { db, handler } = setup({
      'raw/claude/a.jsonl': one,
      'raw/claude/b.jsonl': one,
    });
    const job = leased(db, {
      subjectRef: {
        uploadId: 'up1',
        source: 'claude',
        rawS3Keys: ['raw/claude/a.jsonl', 'raw/claude/b.jsonl'],
      },
    });
    const cap = makeCtx(job, db);
    await handler.run(job, cap.ctx);
    expect(db.segments.size).toBe(1); // 去重后一段
    const snap = [...db.snapshots.values()][0]!;
    expect(snap.segment_count).toBe(1); // 统计不算重
  });

  it('打包分片（bundle=gzip）：一个 gzip 分片含多个整文件 → 解压拆回逐个解析（命令行助手路径）', async () => {
    // 模拟脚本端：把 2 个会话（claude + codex）按 sentinel 拼成一个分片，gzip 压缩落桶。
    const fileA = claudeSession([{ role: 'user', text: '打包会话 A 内容' }]);
    const fileB = codexSession('打包会话 B 提问', '打包会话 B 回复');
    const bundleText = `${BUNDLE_SENTINEL}\n${fileA}\n${BUNDLE_SENTINEL}\n${fileB}\n`;
    const db = new ImportFakeDb();
    const store = new FakeObjectStore(new Map());
    store.rawBytes.set('raw/u1/pair1/part-0', gzipSync(Buffer.from(bundleText, 'utf-8')));
    const txPool = new FakeTxPool(db.jobs, db.snapshots);
    const handler = createImportHandler({ db, txPool, objectStore: store });
    const job = leased(db, {
      subjectRef: {
        uploadId: 'pair1',
        source: 'mixed',
        rawS3Keys: ['raw/u1/pair1/part-0'],
        bundle: 'gzip',
      },
    });
    const cap = makeCtx(job, db);
    await handler.run(job, cap.ctx);
    // 一个分片拆出 2 个文件 → 2 段；来源按内容嗅探得 claude + codex。
    expect(db.segments.size).toBe(2);
    const snap = [...db.snapshots.values()][0]!;
    expect(snap.segment_count).toBe(2);
    const sources = [...db.segments.values()].map((s) => s.source).sort();
    expect(sources).toEqual(['claude', 'codex']);
  });

  it('同事务落 completed + 发 import 完成通知（Codex P0-3：业务状态+job结果+outbox 同一 PG 事务）', async () => {
    const raw = claudeSession([{ role: 'user', text: '内容' }]);
    const { db, handler, txPool } = setup({ 'raw/claude/f1.jsonl': raw });
    const job = leased(db);
    const cap = makeCtx(job, db);
    const res = await handler.run(job, cap.ctx);
    // outbox 在同事务内写（COMMIT 前），且只一行。
    expect(txPool.outbox).toHaveLength(1);
    expect(txPool.outbox[0]!.topic).toBe('notify.import_completed');
    expect(txPool.outbox[0]!.eventId).toBe(`import_done:${job.id}:${job.attemptNo}`);
    const payload = txPool.outbox[0]!.payload as { recipientId: string; segmentCount: number };
    expect(payload.recipientId).toBe('u1');
    expect(payload.segmentCount).toBe(1);
    // 同事务把 job 落 completed（不再交给 runner 二次落终态）。
    expect(db.jobs.get(job.id)!.status).toBe('completed');
    expect(txPool.committed.length).toBe(1);
    // handler 回 finalized:true（runner 据此只发 done、不再 completeJob）。
    expect(res.finalized).toBe(true);
    expect((res.result as { snapshotId: string }).snapshotId).toBeTruthy();
  });

  it('同事务 outbox 失败 → 整体回滚：job 不落 completed、不吞失败（Codex P0-3）', async () => {
    const raw = claudeSession([{ role: 'user', text: '内容' }]);
    const db = new ImportFakeDb();
    const store = new FakeObjectStore(new Map([['raw/claude/f1.jsonl', raw]]));
    const txPool = new FakeTxPool(db.jobs, db.snapshots);
    txPool.throwOnOutbox = true; // emitInTx 抛错 → withTransaction ROLLBACK。
    const handler = createImportHandler({ db, txPool, objectStore: store });
    const job = leased(db);
    const cap = makeCtx(job, db);
    // 整事务失败必须上抛（runner 走 failed/重试），绝不静默吞。
    await expect(handler.run(job, cap.ctx)).rejects.toBeTruthy();
    // 段已落（真源保留），但 job 未落 completed（同事务回滚），outbox 无行。
    expect(db.segments.size).toBe(1);
    expect(db.jobs.get(job.id)!.status).toBe('running'); // 未落 completed
    expect(txPool.outbox).toHaveLength(0);
    expect(txPool.committed.length).toBe(0);
  });

  it('收尾时 fence 已被换（接管/取消）→ completeJobInTx 0 行 → 不发通知、不落 completed（已生成段保留）', async () => {
    const raw = claudeSession([{ role: 'user', text: '内容' }]);
    const { db, handler, txPool } = setup({ 'raw/claude/f1.jsonl': raw });
    const job = leased(db);
    const cap = makeCtx(job, db);
    // 段写完后、收尾前把 fence 换掉（模拟取消/接管）：通过 reportProgress 最后一次拦截换 fence。
    const realProgress = cap.ctx.reportProgress.bind(cap.ctx);
    (cap.ctx as { reportProgress: JobContext['reportProgress'] }).reportProgress = async (u) => {
      await realProgress(u);
      // 写段循环结束后、收尾 completeJobInTx 之前换 fence（段写入 percent 到 95 后那次之后）。
      if (u.percent >= 95) db.jobs.get(job.id)!.fence_token = 999;
    };
    const res = await handler.run(job, cap.ctx);
    // completeJobInTx fence out（0 行）→ finalized 非 true、不发通知、job 未落 completed。
    expect(res.finalized).not.toBe(true);
    expect(txPool.outbox).toHaveLength(0);
    expect(db.jobs.get(job.id)!.status).toBe('running');
    // 已写段保留（硬规则③）。
    expect(db.segments.size).toBe(1);
  });

  it('收尾时 fence-out → 同事务 supersede 也回滚：旧快照 superseded_by 不变（取消不污染血缘，Codex P1-r3）', async () => {
    const raw = claudeSession([{ role: 'user', text: '第二次导入内容' }]);
    const { db, handler, txPool } = setup({ 'raw/claude/f1.jsonl': raw });
    // 先种一个该 owner 已有的 latest 旧快照（前一次成功导入的产物，superseded_by=null）。
    const prevSnap = 'snap-prev';
    db.snapshots.set(prevSnap, {
      id: prevSnap,
      owner_user_id: 'u1',
      import_job_id: 'prev-job',
      source: 'claude',
      sources: ['claude'],
      raw_s3_key: null,
      raw_purged_at: null,
      segment_count: 1,
      message_count: 1,
      project_count: 0,
      time_span_from: null,
      time_span_to: null,
      redaction_report: {},
      redaction_ruleset_ver: 'redaction-v1',
      superseded_by: null,
      created_at: new Date(db.now).toISOString(),
    });
    expect(db.snapshots.get(prevSnap)!.superseded_by).toBeNull();

    const job = leased(db); // id='job-1', owner='u1', fence=7
    const cap = makeCtx(job, db);
    // 段写完后、收尾 supersede/completeJob 之前换 fence（fence-out）：整收尾事务（含 supersede）应回滚。
    const realProgress = cap.ctx.reportProgress.bind(cap.ctx);
    (cap.ctx as { reportProgress: JobContext['reportProgress'] }).reportProgress = async (u) => {
      await realProgress(u);
      if (u.percent >= 95) db.jobs.get(job.id)!.fence_token = 999;
    };
    const res = await handler.run(job, cap.ctx);

    // fence-out：未 finalized、不发通知（completeJobInTx 0 行 → fn 返回 false，事务空提交、无 outbox）。
    expect(res.finalized).not.toBe(true);
    expect(txPool.outbox).toHaveLength(0);
    expect(db.jobs.get(job.id)!.status).toBe('running'); // 未落 completed
    // 关键：取消/接管路径绝不更新血缘——旧快照 superseded_by 仍为 null（不被未完成的新快照接替）。
    expect(db.snapshots.get(prevSnap)!.superseded_by).toBeNull();
    // 新快照已建（已生成不丢），但它没接替旧快照（血缘未被污染）。
    const newSnap = [...db.snapshots.values()].find((s) => s.id !== prevSnap);
    expect(newSnap).toBeTruthy();
    expect(newSnap!.superseded_by).toBeNull();
  });

  it('【交错回归 Codex P1-r4】supersede 后、complete 前 fence 失效 → 整事务回滚（哨兵）：旧快照 superseded_by 不变、不发通知、job 仍 running', async () => {
    const raw = claudeSession([{ role: 'user', text: '交错场景内容' }]);
    const { db, handler, txPool } = setup({ 'raw/claude/f1.jsonl': raw });
    // 该 owner 已有 latest 旧快照（superseded_by=null）。
    const prevSnap = 'snap-prev-r4';
    db.snapshots.set(prevSnap, {
      id: prevSnap,
      owner_user_id: 'u1',
      import_job_id: 'prev-job',
      source: 'claude',
      sources: ['claude'],
      raw_s3_key: null,
      raw_purged_at: null,
      segment_count: 1,
      message_count: 1,
      project_count: 0,
      time_span_from: null,
      time_span_to: null,
      redaction_report: {},
      redaction_ruleset_ver: 'redaction-v1',
      superseded_by: null,
      created_at: new Date(db.now).toISOString(),
    });

    const job = leased(db); // id='job-1', owner='u1', fence=7
    // 关键交错（Codex P1-r4）：收尾事务里 supersede 已写（缓冲）、complete 之前换 fence → complete guard 0 行 → 抛哨兵 → 回滚。
    //   注意：tx 开头先 FOR UPDATE 锁 job 行（此刻 fence 仍 7、running → 锁到）；supersede 也命中（仍 7、running）→ 缓冲；
    //   afterSupersede 把 fence 换 999 → complete guard 失配 0 行 → FinalizeFencedOut → ROLLBACK → 缓冲的 supersede 丢弃。
    txPool.afterSupersede = () => {
      db.jobs.get(job.id)!.fence_token = 999;
    };
    const cap = makeCtx(job, db);
    const res = await handler.run(job, cap.ctx);

    // fence-out（哨兵回滚）：未 finalized、不发通知、job 未落 completed（仍 running，fence 已被换走）。
    expect(res.finalized).not.toBe(true);
    expect(txPool.outbox).toHaveLength(0);
    expect(txPool.committed).toHaveLength(0); // 整事务未提交
    expect(txPool.rolledBack.length).toBeGreaterThanOrEqual(1); // 走了 ROLLBACK
    // 关键：旧快照 superseded_by 保持不变（supersede 与 complete 同事务，complete 失败连 supersede 一起回滚，血缘不污染）。
    expect(db.snapshots.get(prevSnap)!.superseded_by).toBeNull();
    // 新快照已建（已生成不丢），但未接替旧快照。
    const newSnap = [...db.snapshots.values()].find((s) => s.id !== prevSnap);
    expect(newSnap).toBeTruthy();
    expect(newSnap!.superseded_by).toBeNull();
  });

  it('【交错回归 Codex P1-r4·赢家】正常赢家 fence：FOR UPDATE 锁到 → supersede + complete + outbox 同时提交（旧快照被接替）', async () => {
    const raw = claudeSession([{ role: 'user', text: '赢家收尾内容' }]);
    const { db, handler, txPool } = setup({ 'raw/claude/f1.jsonl': raw });
    const prevSnap = 'snap-prev-winner';
    db.snapshots.set(prevSnap, {
      id: prevSnap,
      owner_user_id: 'u1',
      import_job_id: 'prev-job',
      source: 'claude',
      sources: ['claude'],
      raw_s3_key: null,
      raw_purged_at: null,
      segment_count: 1,
      message_count: 1,
      project_count: 0,
      time_span_from: null,
      time_span_to: null,
      redaction_report: {},
      redaction_ruleset_ver: 'redaction-v1',
      superseded_by: null,
      created_at: new Date(db.now).toISOString(),
    });
    const job = leased(db);
    const cap = makeCtx(job, db);
    const res = await handler.run(job, cap.ctx);

    // 赢家：FOR UPDATE 锁到本 fence running 行 → supersede + complete + outbox 同事务一起 COMMIT。
    expect(res.finalized).toBe(true);
    expect(txPool.committed).toHaveLength(1);
    expect(txPool.rolledBack).toHaveLength(0);
    expect(txPool.outbox).toHaveLength(1);
    expect(db.jobs.get(job.id)!.status).toBe('completed');
    // 血缘归并提交：旧快照被新快照接替。
    const newSnap = [...db.snapshots.values()].find((s) => s.id !== prevSnap)!;
    expect(db.snapshots.get(prevSnap)!.superseded_by).toBe(newSnap.id);
    expect(newSnap.superseded_by).toBeNull();
  });
});

describe('import handler — 来源按内容识别（回归：Codex 子目录 / 助手路径 key 不含来源标记）', () => {
  it('选 .codex/sessions/2026/06/01 子目录导入：S3 key 丢了 .codex 前缀 + source=mixed → 仍解析出 Codex 段（绝不 IMPORT_NO_CONTENT）', async () => {
    // 复现用户场景：浏览器选 `.codex/sessions/2026/06/01` 子目录时，webkitRelativePath 根是 `01/`，
    //   clientPartId/S3 key 丢掉了 `.codex` 前缀 → key 既无 codex 也无 claude 标记；前端 source 恒为 'mixed'。
    //   旧实现 sourceFromKey 在此回退默认 'claude' → Codex 原文（顶层 payload）被 parseClaudeLines（认 message）
    //   全部跳过 → 零段 → IMPORT_NO_CONTENT「没读到可用内容」。修复后按内容嗅探为 codex，正常解析。
    const key = 'raw/u1/up1/0-01/rollout-2026-06-01T12-00-00.jsonl#0';
    const { db, handler } = setup({ [key]: codexSession('修一下这个 bug', '我来定位根因') });
    const job = leased(db, {
      subjectRef: { uploadId: 'up1', source: 'mixed', rawS3Keys: [key] },
    });
    const cap = makeCtx(job, db);
    const res = await handler.run(job, cap.ctx);

    expect(db.segments.size).toBe(1); // 解析出 Codex 段（修复前为 0 → 抛 IMPORT_NO_CONTENT）
    const snap = [...db.snapshots.values()][0]!;
    expect(snap.source).toBe('codex'); // 段级来源按内容定为 codex
    expect(snap.sources).toContain('codex');
    expect((res.result as { snapshotId: string }).snapshotId).toBeTruthy();
  });

  it('助手路径 key（raw/{owner}/{pairId}/part-N，无来源标记）+ source=mixed 的 Codex 原文 → 正常解析', async () => {
    // 助手路径（curl 一键导入）落桶 key 形如 raw/{owner}/{pairId}/part-0，同样不含来源标记 → 同根因。
    const key = 'raw/u1/pair-xyz/part-0';
    const { db, handler } = setup({ [key]: codexSession('帮我跑测试', '在跑了') });
    const job = leased(db, { subjectRef: { uploadId: 'up1', source: 'mixed', rawS3Keys: [key] } });
    const cap = makeCtx(job, db);
    await handler.run(job, cap.ctx);
    expect(db.segments.size).toBe(1);
    expect([...db.snapshots.values()][0]!.source).toBe('codex');
  });

  it('Claude + Codex 同批（混合，两路径 key 均无标记）→ 各自按内容识别、两段两来源', async () => {
    const ck = 'raw/u1/up1/0-01/a.jsonl#0'; // 中性文件名：key 无来源标记，全靠内容嗅探
    const xk = 'raw/u1/up1/1-01/b.jsonl#0';
    const { db, handler } = setup({
      [ck]: claudeSession([{ role: 'user', text: 'Claude 这边的问题' }]),
      [xk]: codexSession('Codex 这边的问题', '收到'),
    });
    const job = leased(db, {
      subjectRef: { uploadId: 'up1', source: 'mixed', rawS3Keys: [ck, xk] },
    });
    const cap = makeCtx(job, db);
    await handler.run(job, cap.ctx);
    expect(db.segments.size).toBe(2);
    const snap = [...db.snapshots.values()][0]!;
    expect(snap.source).toBe('mixed'); // 命中两来源 → 快照级 mixed
    expect([...snap.sources].sort()).toEqual(['claude', 'codex']);
  });
});

describe('import handler — 重导新快照旧保留（导入-21/贯穿-21）', () => {
  it('同 owner 二次导入 → 新快照、旧快照 superseded_by 指向新（不删、不串）', async () => {
    const raw = claudeSession([{ role: 'user', text: '第一次' }]);
    const { db, handler } = setup({ 'raw/claude/f1.jsonl': raw });
    const job1 = leased(db, { id: 'job-1' });
    await handler.run(job1, makeCtx(job1, db).ctx);
    const oldSnap = [...db.snapshots.keys()][0]!;

    // 第二次导入（新 job、新原文）。
    const raw2 = claudeSession([{ role: 'user', text: '第二次不同内容' }]);
    const store2 = new FakeObjectStore(new Map([['raw/claude/f2.jsonl', raw2]]));
    const handler2 = createImportHandler({
      db,
      txPool: new FakeTxPool(db.jobs, db.snapshots),
      objectStore: store2,
    });
    const job2 = leased(db, {
      id: 'job-2',
      subjectRef: { uploadId: 'up2', source: 'claude', rawS3Keys: ['raw/claude/f2.jsonl'] },
    });
    await handler2.run(job2, makeCtx(job2, db).ctx);

    expect(db.snapshots.size).toBe(2); // 旧保留 + 新建
    const freshSnap = [...db.snapshots.values()].find((s) => s.id !== oldSnap)!;
    expect(db.snapshots.get(oldSnap)!.superseded_by).toBe(freshSnap.id);
    expect(freshSnap.superseded_by).toBeNull();
  });
});

describe('import handler — 错误/边界归一', () => {
  it('空结果（解析零段）→ 抛 IMPORT_NO_CONTENT，不建空完成态（导入-20）', async () => {
    // 全是坏行 → 解析零段。
    const { db, handler } = setup({ 'raw/claude/f1.jsonl': '{bad json\n{also bad' });
    const job = leased(db);
    const cap = makeCtx(job, db);
    await expect(handler.run(job, cap.ctx)).rejects.toMatchObject({ code: 'IMPORT_NO_CONTENT' });
    expect(db.snapshots.size).toBe(0); // 不建空快照
    expect(cap.subtasks.some((s) => s.key === 'segment' && s.status === 'failed')).toBe(true);
  });

  it('subject_ref 无原文引用 → IMPORT_NO_CONTENT（上传未落地）', async () => {
    const { db, handler } = setup({});
    const job = leased(db, { subjectRef: { uploadId: 'x', source: 'claude', rawS3Keys: [] } });
    await expect(handler.run(job, makeCtx(job, db).ctx)).rejects.toMatchObject({
      code: 'IMPORT_NO_CONTENT',
    });
  });

  it('S3 拉取失败 → DEPENDENCY_UNAVAILABLE（人话归一，绝不裸 ECONNRESET）', async () => {
    const { db, store, handler } = setup({ 'raw/claude/f1.jsonl': 'x' });
    store.failKeys.add('raw/claude/f1.jsonl');
    const job = leased(db);
    const cap = makeCtx(job, db);
    await expect(handler.run(job, cap.ctx)).rejects.toMatchObject({
      code: 'DEPENDENCY_UNAVAILABLE',
    });
    expect(cap.subtasks.some((s) => s.key === 'fetch_index' && s.status === 'failed')).toBe(true);
  });
});

describe('import handler — 取消保留已生成（导入-35，硬规则③）', () => {
  it('写段途中 fence 被换（取消/接管）→ 停在安全点，已写段保留', async () => {
    // 三段，写第一段后模拟取消（换 fence），后续段写 0 行（fenced_out）→ break。
    const raw = (t: string): string => claudeSession([{ role: 'user', text: t }]);
    const { db, handler } = setup({
      'raw/claude/a.jsonl': raw('alpha'),
      'raw/claude/b.jsonl': raw('beta'),
      'raw/claude/c.jsonl': raw('gamma'),
    });
    const job = leased(db, {
      subjectRef: {
        uploadId: 'up1',
        source: 'claude',
        rawS3Keys: ['raw/claude/a.jsonl', 'raw/claude/b.jsonl', 'raw/claude/c.jsonl'],
      },
    });
    const cap = makeCtx(job, db);

    // appendItem 第一次后把 jobs.fence_token 换掉（模拟取消换 fence）。
    let appended = 0;
    const realAppend = cap.ctx.appendItem.bind(cap.ctx);
    (cap.ctx as { appendItem: JobContext['appendItem'] }).appendItem = async (item: unknown) => {
      await realAppend(item);
      appended += 1;
      if (appended === 1) {
        db.jobs.get(job.id)!.fence_token = 999; // 换 fence → 后续段写 fenced_out
      }
    };

    const res = await handler.run(job, cap.ctx);
    // 已写第一段保留（硬规则③），后续段被 fence out 停下。
    expect(db.segments.size).toBe(1);
    // 不抛错（fence-out 是正常控制流），返回 result（runner 会据 fence 兜终态）。
    expect(res).toBeDefined();
  });

  it('isCancelled 在写段前为 true → 不再写新段（已写保留）', async () => {
    const raw = (t: string): string => claudeSession([{ role: 'user', text: t }]);
    const { db, handler } = setup({
      'raw/claude/a.jsonl': raw('alpha'),
      'raw/claude/b.jsonl': raw('beta'),
    });
    const job = leased(db, {
      subjectRef: {
        uploadId: 'up1',
        source: 'claude',
        rawS3Keys: ['raw/claude/a.jsonl', 'raw/claude/b.jsonl'],
      },
    });
    const cap = makeCtx(job, db);
    let appended = 0;
    const realAppend = cap.ctx.appendItem.bind(cap.ctx);
    (cap.ctx as { appendItem: JobContext['appendItem'] }).appendItem = async (item: unknown) => {
      await realAppend(item);
      appended += 1;
      if (appended === 1) cap.setCancelled(true); // 第一段后取消
    };
    await handler.run(job, cap.ctx);
    expect(db.segments.size).toBe(1); // 仅第一段写入，取消后停
  });
});

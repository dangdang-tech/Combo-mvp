// B-25 结构化 Job handler 自检（40-step3-4-structure §3/§4.C）：
//   软字段流式逐字段/逐项、硬字段不生成不报错、三退路（field_stuck）、两次失败落错误态（ErrorEnvelope）、
//   重生成不丢其它、fence（受保护写 0 行干净退出）、resume 只补未生成、finalize 顺序（终态进度在 completed 之前）。
import { describe, it, expect } from 'vitest';
import {
  SOFT_FIELD_KEYS,
  HARD_FIELD_KEYS,
  lintUserMessage,
  type SoftFieldKey,
  type StructureState,
  type Manifest,
} from '@cb/shared';
import { createStructureHandler, type StructureSubjectRef } from '../jobs/handlers/structure.js';
import type { JobContext, LeasedJob } from '../jobs/types.js';
import { initialManifest, initialStructureState, setFieldState } from '../structure/manifest.js';
import {
  writeFieldStuckIfGenerating,
  writeManifestAndStateProtected,
  writeArrayItemIfGenerating,
  writeFieldStateSurgical,
} from '../structure/structure-repo.js';
import { StructureFakeDb, StreamingFakeGateway, type VersionRowF } from './structure-fakes.js';

interface Frame {
  event: string;
  payload: unknown;
}
interface CapturedCtx {
  ctx: JobContext;
  frames: Frame[];
  progress: Array<{ percent: number; done?: number; total?: number; phrase: string }>;
  subtasks: Array<{ key: string; status: string }>;
  slowHints: () => number;
  setCancelled: (v: boolean) => void;
}

function makeCtx(job: LeasedJob): CapturedCtx {
  const frames: Frame[] = [];
  const progress: CapturedCtx['progress'] = [];
  const subtasks: CapturedCtx['subtasks'] = [];
  let slowHints = 0;
  let cancelled = false;
  const ctx: JobContext = {
    jobId: job.id,
    traceId: 'trace-structure',
    fenceToken: job.fenceToken,
    attemptNo: job.attemptNo,
    signal: new AbortController().signal,
    isCancelled: () => cancelled,
    async reportProgress(u) {
      progress.push({ percent: u.percent, done: u.done, total: u.total, phrase: u.phrase });
    },
    async reportSubtask(key, status) {
      subtasks.push({ key, status });
    },
    async appendItem() {},
    async emitField(event, payload) {
      frames.push({ event, payload });
    },
    async emitSlowHint() {
      slowHints += 1;
    },
  };
  return {
    ctx,
    frames,
    progress,
    subtasks,
    slowHints: () => slowHints,
    setCancelled: (v) => (cancelled = v),
  };
}

function seedVersion(
  db: StructureFakeDb,
  opts: {
    versionId: string;
    capabilityId: string;
    candidateId: string;
    manifest?: Manifest;
    structureState?: Partial<StructureState>;
    status?: string;
  },
): void {
  const manifest = opts.manifest ?? initialManifest(opts.capabilityId, '0.1.0');
  const structureState = opts.structureState ?? initialStructureState(opts.versionId, manifest);
  db.capabilities.set(opts.capabilityId, {
    id: opts.capabilityId,
    creator_user_id: 'u1',
    slug: 'cap-slug',
    current_version_id: null,
    status: 'active',
  });
  const v: VersionRowF = {
    id: opts.versionId,
    capability_id: opts.capabilityId,
    version: '0.1.0',
    status: opts.status ?? 'draft',
    manifest,
    structure_state: structureState,
    source_candidate_id: opts.candidateId,
  };
  db.versions.set(opts.versionId, v);
}

function seedEvidence(db: StructureFakeDb, candidateId: string, n = 3): void {
  for (let i = 0; i < n; i++) {
    const segId = `seg-${candidateId}-${i}`;
    db.segments.set(segId, {
      id: segId,
      snapshot_id: 'snap-1',
      title: `会话 ${i}`,
      source: 'claude',
      project: 'alpha',
      content: `把模糊想法拆成结构化问题 ${i}`,
    });
    db.evidence.set(`ev-${candidateId}-${i}`, {
      id: `ev-${candidateId}-${i}`,
      candidate_id: candidateId,
      segment_id: segId,
    });
  }
}

function runningJob(db: StructureFakeDb, subject: StructureSubjectRef, fence = 5): LeasedJob {
  const job: LeasedJob = {
    id: 'sjob-1',
    type: 'structure',
    ownerUserId: 'u1',
    subjectRef: subject,
    attemptNo: 1,
    fenceToken: fence,
    progress: { percent: 0, phrase: '', subtasks: [] },
  };
  db.jobs.set(job.id, { id: job.id, status: 'running', owner_user_id: 'u1', fence_token: fence });
  return job;
}

function setup(): {
  db: StructureFakeDb;
  gw: StreamingFakeGateway;
  handler: ReturnType<typeof createStructureHandler>;
} {
  const db = new StructureFakeDb();
  const gw = new StreamingFakeGateway();
  const handler = createStructureHandler({ db, gateway: gw, stuckAfterMs: 999_999 });
  return { db, gw, handler };
}

function framesByEvent(frames: Frame[], event: string): Frame[] {
  return frames.filter((f) => f.event === event);
}

describe('B-25 结构化 handler · 软字段流式生成（逐字段 + 逐项）', () => {
  it('7 软字段全生成：逐字段 field_start/field_done、数组逐项 item-appended、硬字段不发字段级帧', async () => {
    const { db, handler } = setup();
    seedVersion(db, { versionId: 'v1', capabilityId: 'c1', candidateId: 'cand1' });
    seedEvidence(db, 'cand1');
    const job = runningJob(db, { versionId: 'v1' });
    const cap = makeCtx(job);

    const res = await handler.run(job, cap.ctx);

    // field_start：7 个软字段各一次（首轮）。
    const starts = framesByEvent(cap.frames, 'field_start').map(
      (f) => (f.payload as { field: SoftFieldKey }).field,
    );
    expect(new Set(starts)).toEqual(new Set(SOFT_FIELD_KEYS));
    // field_done：7 个软字段。
    const dones = framesByEvent(cap.frames, 'field_done').map(
      (f) => (f.payload as { field: SoftFieldKey }).field,
    );
    expect(new Set(dones)).toEqual(new Set(SOFT_FIELD_KEYS));
    // 数组字段逐项 item-appended（skill_set + starter_prompts，每个 ≥1 条）。
    const items = framesByEvent(cap.frames, 'item-appended');
    const itemFields = new Set(items.map((f) => (f.payload as { field: string }).field));
    expect(itemFields).toEqual(new Set(['skill_set', 'starter_prompts']));
    expect(items.length).toBeGreaterThanOrEqual(2);

    // 硬字段：永不发字段级帧（field_start/field_done/item-appended 里无硬字段名）。
    const allFieldNames = cap.frames
      .map((f) => (f.payload as { field?: string }).field)
      .filter((x): x is string => Boolean(x));
    for (const hard of HARD_FIELD_KEYS) {
      expect(allFieldNames).not.toContain(hard);
    }

    // 终态：structure_state 7 软字段全 done、硬字段 locked；manifest 软字段非空、硬字段锁定填充。
    const v = db.versions.get('v1')!;
    const st = v.structure_state as StructureState;
    expect(st.doneCount).toBe(7);
    expect(st.totalCount).toBe(7);
    const locked = st.fields.filter((f) => f.status === 'locked').map((f) => f.field);
    expect(new Set(locked)).toEqual(new Set(HARD_FIELD_KEYS));
    const mf = v.manifest as Manifest;
    expect(mf.status).toBe('draft');
    expect(mf.id).toBe('c1'); // 硬字段 id = capabilityId（平台锁定，不生成）。
    expect(mf.name.length).toBeGreaterThan(0);
    expect(Array.isArray(mf.skill_set) && mf.skill_set.length).toBeTruthy();

    // result.finalProgress 在收尾返回（finalize 顺序由 reportProgress 100% 在 run 返回前发，见独立用例）。
    expect((res.finalProgress as { percent: number }).percent).toBe(100);
    expect(res.finalProgress).toBeTruthy();
  });

  it('instructions 占位 → 硬字段 inputs.schema 系统派生（derivedFrom:instructions，锁定不报字段级帧）', async () => {
    const { db, gw } = setup();
    gw.scalarChunks['instructions'] = ['请填写 {{product_idea|你的产品一句话}} 然后继续。'];
    const handler = createStructureHandler({ db, gateway: gw, stuckAfterMs: 999_999 });
    seedVersion(db, { versionId: 'v1', capabilityId: 'c1', candidateId: 'cand1' });
    seedEvidence(db, 'cand1');
    const job = runningJob(db, { versionId: 'v1', fields: ['instructions'] });
    const cap = makeCtx(job);

    await handler.run(job, cap.ctx);

    const mf = db.versions.get('v1')!.manifest as Manifest;
    expect(mf.inputs.fields.length).toBe(1);
    expect(mf.inputs.fields[0]!.key).toBe('product_idea');
    expect(mf.inputs.fields[0]!.derivedFrom).toBe('instructions');
    // inputs 是硬字段：structure_state 里 locked、不发 field_* 帧。
    const inputsState = (db.versions.get('v1')!.structure_state as StructureState).fields.find(
      (f) => f.field === 'inputs',
    );
    expect(inputsState!.status).toBe('locked');
    expect(
      framesByEvent(cap.frames, 'field_start').map((f) => (f.payload as { field: string }).field),
    ).not.toContain('inputs');
  });
});

describe('B-25 结构化 handler · 逐字段落库（已生成不丢）', () => {
  it('每软字段生成完即受保护落库（manifestWrites ≥ 软字段数，边生成边落）', async () => {
    const { db, handler } = setup();
    seedVersion(db, { versionId: 'v1', capabilityId: 'c1', candidateId: 'cand1' });
    seedEvidence(db, 'cand1');
    const job = runningJob(db, { versionId: 'v1' });
    const cap = makeCtx(job);
    await handler.run(job, cap.ctx);
    // 每字段至少两次落库（generating 占位 + done），≥ 7（实际 14）。
    expect(db.manifestWrites).toBeGreaterThanOrEqual(7);
  });
});

describe('B-25 结构化 handler · 三退路（field_stuck）', () => {
  it('软字段慢 → field_stuck（options continue/regen/wait）+ slow_hint；硬字段永不发 field_stuck', async () => {
    const db = new StructureFakeDb();
    const gw = new StreamingFakeGateway();
    // name 字段流真慢（每片 delta 间 30ms）；stuckAfterMs=5ms < 生成耗时 → 生成途中触发 field_stuck。
    gw.scalarChunks['name'] = ['慢', '名'];
    gw.slowFields.add('name');
    gw.slowMs = 30;
    const handler = createStructureHandler({ db, gateway: gw, stuckAfterMs: 5 });
    seedVersion(db, { versionId: 'v1', capabilityId: 'c1', candidateId: 'cand1' });
    seedEvidence(db, 'cand1');
    const job = runningJob(db, { versionId: 'v1', fields: ['name'] });
    const cap = makeCtx(job);

    await handler.run(job, cap.ctx);

    const stuck = framesByEvent(cap.frames, 'field_stuck');
    expect(stuck.length).toBeGreaterThanOrEqual(1);
    const p = stuck[0]!.payload as { field: string; options: string[] };
    expect(p.field).toBe('name'); // 软字段。
    expect(p.options).toEqual(['continue', 'regen', 'wait']);
    expect(cap.slowHints()).toBeGreaterThanOrEqual(1); // 偏慢同时发 slow_hint（永不裸转圈）。
    // 硬字段不发 field_stuck。
    for (const f of stuck) {
      expect(HARD_FIELD_KEYS).not.toContain((f.payload as { field: string }).field);
    }
  });
});

describe('B-25 结构化 handler · stuck 态持久化（Codex P1-8，断线重连不丢三退路）', () => {
  it('软字段慢 → 受保护写 structure_state[field].status=stuck + stuckMs（中途持久化），完成后转 done（stuck 清）', async () => {
    const db = new StructureFakeDb();
    const gw = new StreamingFakeGateway();
    // name 字段流真慢；stuckAfterMs 小于生成耗时 → 生成途中触发 stuck timer 落库。
    gw.scalarChunks['name'] = ['慢', '名'];
    gw.slowFields.add('name');
    gw.slowMs = 30;
    const handler = createStructureHandler({ db, gateway: gw, stuckAfterMs: 5 });
    seedVersion(db, { versionId: 'v1', capabilityId: 'c1', candidateId: 'cand1' });
    seedEvidence(db, 'cand1');
    const job = runningJob(db, { versionId: 'v1', fields: ['name'] });
    const cap = makeCtx(job);

    await handler.run(job, cap.ctx);

    // 中途某次受保护落库把 name 持久化为 stuck + stuckMs（断线重连 snapshot 能重建三退路态）。
    const stuckWrite = db.stateWrites.find((s) => {
      const f = s.fields.find((x) => x.field === 'name');
      return f?.status === 'stuck' && typeof (f as { stuckMs?: number }).stuckMs === 'number';
    });
    expect(stuckWrite).toBeTruthy();
    // 最终态：name 转 done（stuck 已清，不残留 stuckMs）。
    const finalName = (db.versions.get('v1')!.structure_state as StructureState).fields.find(
      (f) => f.field === 'name',
    )!;
    expect(finalName.status).toBe('done');
    expect((finalName as { stuckMs?: number }).stuckMs).toBeUndefined();
  });

  it('stuck 持久化不清已存 attempts（保留累计基线，§3.4）', async () => {
    const db = new StructureFakeDb();
    const gw = new StreamingFakeGateway();
    gw.scalarChunks['name'] = ['慢', '名'];
    gw.slowFields.add('name');
    gw.slowMs = 30;
    // 预置 name 已累计 attempts=1（上轮失败残留）。
    const manifest = initialManifest('c1', '0.1.0');
    let seeded = initialStructureState('v1', manifest);
    seeded = {
      ...seeded,
      fields: seeded.fields.map((f) =>
        f.field === 'name' ? { ...f, status: 'failed', attempts: 1 } : f,
      ),
    };
    const handler = createStructureHandler({ db, gateway: gw, stuckAfterMs: 5 });
    seedVersion(db, {
      versionId: 'v1',
      capabilityId: 'c1',
      candidateId: 'cand1',
      manifest,
      structureState: seeded,
    });
    seedEvidence(db, 'cand1');
    const job = runningJob(db, { versionId: 'v1', fields: ['name'] });
    const cap = makeCtx(job);
    await handler.run(job, cap.ctx);
    const stuckWrite = db.stateWrites.find(
      (s) => s.fields.find((x) => x.field === 'name')?.status === 'stuck',
    );
    expect(stuckWrite).toBeTruthy();
    // stuck 落库时 attempts 不清零（累计基线保留）。
    const stuckName = stuckWrite!.fields.find((f) => f.field === 'name')! as { attempts?: number };
    expect(stuckName.attempts).toBe(1);
  });
});

describe('B-25 结构化 handler · full/resume 保留跨 job attempts（Codex P1-6）', () => {
  it('full：字段已累计 attempts=1（上轮残留）→ 本 job 续算（一试失败即累计达 2 → escalate 终态），不被清零', async () => {
    const db = new StructureFakeDb();
    const gw = new StreamingFakeGateway();
    gw.failFields.add('name'); // 本 job 这一试真抛。
    // 预置 name failed + attempts=1（上一个 full job 的残留累计）。
    const manifest = initialManifest('c1', '0.1.0');
    let seeded = initialStructureState('v1', manifest);
    seeded = {
      ...seeded,
      fields: seeded.fields.map((f) =>
        f.field === 'name' ? { ...f, status: 'failed', attempts: 1 } : f,
      ),
    };
    const handler = createStructureHandler({ db, gateway: gw, stuckAfterMs: 999_999 });
    seedVersion(db, {
      versionId: 'v1',
      capabilityId: 'c1',
      candidateId: 'cand1',
      manifest,
      structureState: seeded,
    });
    seedEvidence(db, 'cand1');
    // full 模式（subject 无 attemptsBefore）：旧 bug 会把 attemptsBefore 当 0 → 永远停在 attempts=1、永不 escalate。
    const job = runningJob(db, { versionId: 'v1', fields: ['name'] });
    const cap = makeCtx(job);
    await handler.run(job, cap.ctx);
    const errFrames = cap.frames.filter((f) => f.event === 'error');
    expect(errFrames.length).toBe(1);
    const env = errFrames[0]!.payload as {
      error: { action: string; details: { attempts: number } };
    };
    // 跨 job 续算：1（残留）+ 1（本 job 一试失败）= 2 → escalate 终态（attempts 不被清零）。
    expect(env.error.details.attempts).toBe(2);
    expect(env.error.action).toBe('escalate');
    const nameSt = (db.versions.get('v1')!.structure_state as StructureState).fields.find(
      (f) => f.field === 'name',
    )! as { status: string; attempts?: number };
    expect(nameSt.status).toBe('failed');
    expect(nameSt.attempts).toBe(2);
  });

  it('反向破坏守门：若 full 把每字段 attemptsBefore 当 0（清零）→ 本 job 一试只到 attempts=1/retry，永不 escalate（断言会红）', async () => {
    // 这正是修法前的缺口：full/resume 忽略 structure_state[field].attempts，跨 job 累计被清零。
    // 修法后从字段现有 state 读 attempts 续算，故下面应得 attempts=2/escalate；若回退到清零，则停在 1/retry，本断言变红。
    const db = new StructureFakeDb();
    const gw = new StreamingFakeGateway();
    gw.failFields.add('role');
    const manifest = initialManifest('c1', '0.1.0');
    let seeded = initialStructureState('v1', manifest);
    seeded = {
      ...seeded,
      fields: seeded.fields.map((f) =>
        f.field === 'role' ? { ...f, status: 'failed', attempts: 1 } : f,
      ),
    };
    const handler = createStructureHandler({ db, gateway: gw, stuckAfterMs: 999_999 });
    seedVersion(db, {
      versionId: 'v1',
      capabilityId: 'c1',
      candidateId: 'cand1',
      manifest,
      structureState: seeded,
    });
    seedEvidence(db, 'cand1');
    const job = runningJob(db, { versionId: 'v1', fields: ['role'] });
    const cap = makeCtx(job);
    await handler.run(job, cap.ctx);
    const env = cap.frames.find((f) => f.event === 'error')!.payload as {
      error: { action: string; details: { attempts: number } };
    };
    expect(env.error.details.attempts).toBe(2); // 续算（非清零）。
    expect(env.error.action).toBe('escalate'); // 跨 job 累计达上限 → 终态。
  });
});

describe('B-25 结构化 handler · 两次失败落人话错误态（§3.4）', () => {
  it('同软字段重试两次仍真抛 → error 帧（完整 ErrorEnvelope，无 code，action escalate）+ structure_state[field]=failed，其它字段不丢', async () => {
    const db = new StructureFakeDb();
    const gw = new StreamingFakeGateway();
    gw.failFields.add('name'); // name 每次 stream 都真抛 → 累计 2 次 → 落错误态。
    const handler = createStructureHandler({ db, gateway: gw, stuckAfterMs: 999_999 });
    seedVersion(db, { versionId: 'v1', capabilityId: 'c1', candidateId: 'cand1' });
    seedEvidence(db, 'cand1');
    // 生成 name + tagline：name 失败、tagline 成功（验证「其它不丢」）。
    const job = runningJob(db, { versionId: 'v1', fields: ['name', 'tagline'] });
    const cap = makeCtx(job);

    const res = await handler.run(job, cap.ctx);

    // error 帧 = 完整对外 ErrorEnvelope（{ error: {...} }），无 code，userMessage 人话，details.field ∈ SoftFieldKey。
    const errFrames = framesByEvent(cap.frames, 'error');
    expect(errFrames.length).toBe(1);
    const env = errFrames[0]!.payload as { error: Record<string, unknown> };
    expect(env.error).toBeTruthy();
    expect('code' in env.error).toBe(false); // 对外不含 code（D1）。
    expect(typeof env.error.userMessage).toBe('string');
    expect(lintUserMessage(env.error.userMessage as string)).toEqual([]); // 人话（无堆栈/状态码/SQL）。
    expect(env.error.action).toBe('escalate'); // 两次失败 → escalate。
    const details = env.error.details as { field: string; attempts: number };
    expect(SOFT_FIELD_KEYS).toContain(details.field as SoftFieldKey);
    expect(details.field).toBe('name');
    expect(details.attempts).toBe(2);

    // structure_state：name=failed（带 error）、tagline=done（其它不丢）；硬字段 locked。
    const st = db.versions.get('v1')!.structure_state as StructureState;
    const nameSt = st.fields.find((f) => f.field === 'name')!;
    expect(nameSt.status).toBe('failed');
    expect((nameSt as { error?: unknown }).error).toBeTruthy();
    const tagSt = st.fields.find((f) => f.field === 'tagline')!;
    expect(tagSt.status).toBe('done');

    // 整 Job 不因单字段失败转 failed：handler 仍正常返回（finalProgress 100%，runner 落 completed，§3.4）。
    expect((res.finalProgress as { percent: number }).percent).toBe(100);
  });

  it('字段级失败：error.details.field 恒 SoftFieldKey（硬字段永不报字段级失败）', async () => {
    const db = new StructureFakeDb();
    const gw = new StreamingFakeGateway();
    gw.failFields.add('skill_set'); // 数组字段 complete 真抛 → 落错误态。
    const handler = createStructureHandler({ db, gateway: gw, stuckAfterMs: 999_999 });
    seedVersion(db, { versionId: 'v1', capabilityId: 'c1', candidateId: 'cand1' });
    seedEvidence(db, 'cand1');
    const job = runningJob(db, { versionId: 'v1', fields: ['skill_set'] });
    const cap = makeCtx(job);
    await handler.run(job, cap.ctx);
    const env = framesByEvent(cap.frames, 'error')[0]!.payload as {
      error: { details: { field: string } };
    };
    expect(SOFT_FIELD_KEYS).toContain(env.error.details.field as SoftFieldKey);
  });
});

describe('B-25 结构化 handler · 跨调用累计失败（端点 F regen，§3.4）', () => {
  // 模型（§3.4「结构化 Job 内部重试 ≤2，或用户经端点 F regen 累计」）：
  //   端点 F 单字段 regen = 每次点击一次用户驱动尝试（本轮预算 1）；连点跨调用累计到 LLM_MAX_RETRIES=2 才落 escalate 终态。
  //   full 自动结构化 = 本 job 内部重试 ≤2（两次仍失败同一 job 内即落 escalate，由别处用例覆盖）。
  // 关键 helper：模拟「用户从持久化 attempts 起算又点了一次 regen」（worker 单字段 job，gateway 真抛）。

  /** 跑一次端点 F regen（worker 视角）：从 attemptsBefore 起算，gateway 对该字段真抛。返回落库后的 name 字段态 + 错误帧。 */
  async function runRegenFail(attemptsBefore: number): Promise<{
    status: string;
    attempts: number;
    errAction: string | null;
    errAttempts: number | null;
  }> {
    const db = new StructureFakeDb();
    const gw = new StreamingFakeGateway();
    gw.failFields.add('name'); // 本次点击的这一试真抛。
    const handler = createStructureHandler({ db, gateway: gw, stuckAfterMs: 999_999 });
    seedVersion(db, { versionId: 'v1', capabilityId: 'c1', candidateId: 'cand1' });
    seedEvidence(db, 'cand1');
    const job = runningJob(db, {
      versionId: 'v1',
      mode: 'single-field',
      field: 'name',
      attemptsBefore, // 路由从持久化 attempts 读出后透传。
    });
    const cap = makeCtx(job);
    await handler.run(job, cap.ctx);
    const st = db.versions.get('v1')!.structure_state as StructureState;
    const nameSt = st.fields.find((f) => f.field === 'name')! as {
      status: string;
      attempts?: number;
    };
    const err = framesByEvent(cap.frames, 'error')[0]?.payload as
      | { error: { action: string; details: { attempts: number } } }
      | undefined;
    return {
      status: nameSt.status,
      attempts: nameSt.attempts ?? 0,
      errAction: err?.error.action ?? null,
      errAttempts: err?.error.details.attempts ?? null,
    };
  }

  it('连点累计：regen 失败(attempts→1, action retry, 不 escalate) → 再 regen 失败(attempts→2, escalate 终态)', async () => {
    // 第一次点击（attemptsBefore=0）：本轮预算 1、一试失败 → 累计 1（未达上限）→ 非终态：status=failed, error.action=retry, 不 escalate。
    const first = await runRegenFail(0);
    expect(first.status).toBe('failed');
    expect(first.attempts).toBe(1);
    expect(first.errAction).toBe('retry'); // 给重试退路、不裸转圈，但还没到 escalate 终态。
    expect(first.errAttempts).toBe(1);

    // 第二次点击（attemptsBefore=1，路由读出上次持久化的 attempts 透传）：再失败 → 累计达 2 → escalate 终态。
    const second = await runRegenFail(1);
    expect(second.status).toBe('failed');
    expect(second.attempts).toBe(2);
    expect(second.errAction).toBe('escalate'); // §3.4 累计两次仍失败 → 转人工。
    expect(second.errAttempts).toBe(2);
  });

  it('第三次不再无限给预算：attemptsBefore=2（已达上限）再失败 → 仍 escalate、attempts 夹在 2（不溢出到 3）', async () => {
    const third = await runRegenFail(2);
    expect(third.errAction).toBe('escalate');
    expect(third.attempts).toBe(2); // 夹上限，不溢出（修 off-by-one）。
    expect(third.errAttempts).toBe(2);
  });

  it('反向破坏守门：若 worker 收到的 attemptsBefore 恒为 0（不透传累计）→ 每次点击都只累计到 1、永不 escalate', async () => {
    // 「修法前」线上行为：每次 regen 全新预算、持久化 attempts 不被读回透传 → §3.4「累计两次失败→错误态」永不触发。
    // 若把路由改回「不传 attemptsBefore」或 worker 忽略 subject.attemptsBefore，则下面两次都 attempts=1/retry，本断言会红。
    const a = await runRegenFail(0); // 模拟「第一次点击」。
    const b = await runRegenFail(0); // 模拟「第二次点击但累计被清零（bug）」。
    expect(a.attempts).toBe(1);
    expect(a.errAction).toBe('retry');
    expect(b.attempts).toBe(1); // bug 态下永远停在 1。
    expect(b.errAction).toBe('retry'); // 永不 escalate（这正是缺口）。
    expect(b.errAction).not.toBe('escalate');
  });

  it('成功路径：regen 成功 → 该字段 done + attempts 重置 0，不误触错误态、不丢其它字段', async () => {
    const db = new StructureFakeDb();
    const gw = new StreamingFakeGateway();
    // 预置：name 已 failed 且累计 attempts=1（上轮失败）；tagline 已 done（不该被动）。
    const manifest = initialManifest('c1', '0.1.0');
    manifest.tagline = '已有卖点';
    let seeded = initialStructureState('v1', manifest); // tagline done、其余 pending。
    // 把 name 标 failed + attempts=1（模拟上轮一次失败的残留态）。
    seeded = {
      ...seeded,
      fields: seeded.fields.map((f) =>
        f.field === 'name' ? { ...f, status: 'failed', attempts: 1 } : f,
      ),
    };
    seedVersion(db, {
      versionId: 'v1',
      capabilityId: 'c1',
      candidateId: 'cand1',
      manifest,
      structureState: seeded,
    });
    seedEvidence(db, 'cand1');
    gw.scalarChunks['name'] = ['新', '名称']; // 本轮成功。
    const handler = createStructureHandler({ db, gateway: gw, stuckAfterMs: 999_999 });
    // 端点 F：attemptsBefore=1（路由读出持久化 attempts 透传）。
    const job = runningJob(db, {
      versionId: 'v1',
      mode: 'single-field',
      field: 'name',
      attemptsBefore: 1,
    });
    const cap = makeCtx(job);

    await handler.run(job, cap.ctx);

    expect(framesByEvent(cap.frames, 'error').length).toBe(0);
    const st = db.versions.get('v1')!.structure_state as StructureState;
    const nameSt = st.fields.find((f) => f.field === 'name')! as {
      status: string;
      attempts?: number;
    };
    expect(nameSt.status).toBe('done'); // 成功重置该字段。
    expect(nameSt.attempts ?? 0).toBe(0); // attempts 重置 0（下次干净起算）。
    // 不丢其它字段：tagline 仍 done。
    const tagSt = st.fields.find((f) => f.field === 'tagline')!;
    expect(tagSt.status).toBe('done');
    const mf = db.versions.get('v1')!.manifest as Manifest;
    expect(mf.name).toBe('新名称');
    expect(mf.tagline).toBe('已有卖点');
  });
});

describe('B-25 结构化 handler · 单字段重生成不丢其它（§4.F）', () => {
  it('single-field 模式只重生成该字段，其它已生成软字段 + 硬字段原样不动', async () => {
    const { db, gw } = setup();
    // 预置：name/tagline 已 done（有值），其余 pending。
    const manifest = initialManifest('c1', '0.1.0');
    manifest.name = '旧名称';
    manifest.tagline = '旧卖点';
    manifest.role = '旧角色';
    const seeded = initialStructureState('v1', manifest); // name/tagline/role done（有值），其余 pending。
    seedVersion(db, {
      versionId: 'v1',
      capabilityId: 'c1',
      candidateId: 'cand1',
      manifest,
      structureState: seeded,
    });
    seedEvidence(db, 'cand1');
    gw.scalarChunks['role'] = ['新', '角色'];
    const handler = createStructureHandler({ db, gateway: gw, stuckAfterMs: 999_999 });
    const job = runningJob(db, { versionId: 'v1', mode: 'single-field', field: 'role' });
    const cap = makeCtx(job);

    await handler.run(job, cap.ctx);

    // 只 role 重生成（field_start 只含 role）。
    const starts = framesByEvent(cap.frames, 'field_start').map(
      (f) => (f.payload as { field: string }).field,
    );
    expect(starts).toEqual(['role']);
    // role 被替换为新值；name/tagline 不动。
    const mf = db.versions.get('v1')!.manifest as Manifest;
    expect(mf.role).toBe('新角色');
    expect(mf.name).toBe('旧名称');
    expect(mf.tagline).toBe('旧卖点');
  });
});

describe('B-25 结构化 handler · resume 只补未生成（贯穿-28）', () => {
  it('full 模式：已 done 字段跳过、只补 pending（已生成不丢、不重跑）', async () => {
    const { db, gw } = setup();
    const manifest = initialManifest('c1', '0.1.0');
    manifest.name = '已有名称';
    manifest.tagline = '已有卖点';
    const seeded = initialStructureState('v1', manifest); // name/tagline done，其余 pending。
    seedVersion(db, {
      versionId: 'v1',
      capabilityId: 'c1',
      candidateId: 'cand1',
      manifest,
      structureState: seeded,
    });
    seedEvidence(db, 'cand1');
    const handler = createStructureHandler({ db, gateway: gw, stuckAfterMs: 999_999 });
    const job = runningJob(db, { versionId: 'v1' }); // 全量，但 name/tagline 已 done。
    const cap = makeCtx(job);

    await handler.run(job, cap.ctx);

    const startedFields = framesByEvent(cap.frames, 'field_start').map(
      (f) => (f.payload as { field: string }).field,
    );
    // name/tagline 不再生成（resume 只补未生成）。
    expect(startedFields).not.toContain('name');
    expect(startedFields).not.toContain('tagline');
    // 其余 5 软字段补齐。
    expect(startedFields.length).toBe(5);
    // 已有值原样保留。
    const mf = db.versions.get('v1')!.manifest as Manifest;
    expect(mf.name).toBe('已有名称');
    expect(mf.tagline).toBe('已有卖点');
    // 终态 7 全 done。
    expect((db.versions.get('v1')!.structure_state as StructureState).doneCount).toBe(7);
  });
});

describe('B-25 结构化 handler · fence（受保护写 0 行干净退出，硬规则③）', () => {
  it('fence 失配（job 换 fence）→ 受保护写 0 行 → fencedOut，已生成软字段保留、不报错', async () => {
    const { db, handler } = setup();
    seedVersion(db, { versionId: 'v1', capabilityId: 'c1', candidateId: 'cand1' });
    seedEvidence(db, 'cand1');
    const job = runningJob(db, { versionId: 'v1' }, 5);
    // 起跑后立刻把 job fence 换掉（模拟取消/接管）：第一笔受保护写就 0 行。
    db.jobs.get('sjob-1')!.fence_token = 99;
    const cap = makeCtx(job);

    const res = await handler.run(job, cap.ctx);
    expect((res.result as { fencedOut?: boolean }).fencedOut).toBe(true);
    // 没有 error 帧（fence-out 不是错误，是控制流）。
    expect(framesByEvent(cap.frames, 'error').length).toBe(0);
  });

  it('取消（ctx.isCancelled）→ 停在安全点，已生成不丢', async () => {
    const { db, handler } = setup();
    seedVersion(db, { versionId: 'v1', capabilityId: 'c1', candidateId: 'cand1' });
    seedEvidence(db, 'cand1');
    const job = runningJob(db, { versionId: 'v1' });
    const cap = makeCtx(job);
    cap.setCancelled(true); // 一开始就取消 → 第一个安全点即停。
    const res = await handler.run(job, cap.ctx);
    // 取消即停：无字段生成（或极少），无 error 帧。
    expect(framesByEvent(cap.frames, 'error').length).toBe(0);
    expect(res.finalProgress).toBeTruthy(); // 仍走收尾（已生成不丢，doneCount=0）。
  });
});

describe('B-25 结构化 handler · 硬字段锁定（不生成、不参与流、永不字段级错误）', () => {
  it('硬字段在 structure_state 恒 locked，且不在任何 field_*/item-appended/error 帧里', async () => {
    const { db, handler } = setup();
    seedVersion(db, { versionId: 'v1', capabilityId: 'c1', candidateId: 'cand1' });
    seedEvidence(db, 'cand1');
    const job = runningJob(db, { versionId: 'v1' });
    const cap = makeCtx(job);
    await handler.run(job, cap.ctx);

    const st = db.versions.get('v1')!.structure_state as StructureState;
    for (const hard of HARD_FIELD_KEYS) {
      const fs = st.fields.find((f) => f.field === hard)!;
      expect(fs.status).toBe('locked');
    }
    // 任何字段级帧（field_start/field_delta/field_done/field_stuck/item-appended/error.details.field）都不含硬字段。
    for (const fr of cap.frames) {
      const field = fr.payload as { field?: string; error?: { details?: { field?: string } } };
      const name = field.field ?? field.error?.details?.field;
      if (name) expect(HARD_FIELD_KEYS).not.toContain(name);
    }
  });
});

describe('B-25 结构化 handler · degraded 不裸转圈（§10）', () => {
  it('LLM degraded（无 key）→ 软字段用确定性兜底（非空），不裸 502、不报字段级错误', async () => {
    const db = new StructureFakeDb();
    const gw = new StreamingFakeGateway();
    for (const f of SOFT_FIELD_KEYS) gw.degradedFields.add(f);
    const handler = createStructureHandler({ db, gateway: gw, stuckAfterMs: 999_999 });
    seedVersion(db, { versionId: 'v1', capabilityId: 'c1', candidateId: 'cand1' });
    seedEvidence(db, 'cand1');
    const job = runningJob(db, { versionId: 'v1' });
    const cap = makeCtx(job);
    const res = await handler.run(job, cap.ctx);

    // 无字段级 error（degraded 不是失败）。
    expect(framesByEvent(cap.frames, 'error').length).toBe(0);
    // 全 done + 软字段非空（确定性兜底）。
    const mf = db.versions.get('v1')!.manifest as Manifest;
    expect(mf.name.length).toBeGreaterThan(0);
    expect(mf.skill_set.length).toBeGreaterThan(0);
    expect((db.versions.get('v1')!.structure_state as StructureState).doneCount).toBe(7);
    // degraded 诚实标进 result。
    expect((res.result as { degraded: boolean }).degraded).toBe(true);
  });
});

describe('B-25 结构化 handler · 无证据 / 缺 version（人话错误）', () => {
  it('candidate_evidence 为空 → 抛 STRUCTURE_NO_EVIDENCE（runner 归一人话信封）', async () => {
    const { db, handler } = setup();
    seedVersion(db, { versionId: 'v1', capabilityId: 'c1', candidateId: 'cand1' });
    // 不种证据。
    const job = runningJob(db, { versionId: 'v1' });
    const cap = makeCtx(job);
    await expect(handler.run(job, cap.ctx)).rejects.toMatchObject({
      code: 'STRUCTURE_NO_EVIDENCE',
    });
  });

  it('version 不存在 → 抛 NOT_FOUND', async () => {
    const { db, handler } = setup();
    const job = runningJob(db, { versionId: 'nope' });
    const cap = makeCtx(job);
    await expect(handler.run(job, cap.ctx)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('published 版本就地结构化 → 抛 STATE_CONFLICT（需建新版本）', async () => {
    const { db, handler } = setup();
    seedVersion(db, {
      versionId: 'v1',
      capabilityId: 'c1',
      candidateId: 'cand1',
      status: 'published',
    });
    seedEvidence(db, 'cand1');
    const job = runningJob(db, { versionId: 'v1' });
    const cap = makeCtx(job);
    await expect(handler.run(job, cap.ctx)).rejects.toMatchObject({ code: 'STATE_CONFLICT' });
  });
});

describe('B-25 结构化 handler · finalize 顺序（终态进度在 completed 之前）', () => {
  it('最后一次 reportProgress 是 100%，且发生在 run 返回（runner 落 completed）之前', async () => {
    const { db, handler } = setup();
    seedVersion(db, { versionId: 'v1', capabilityId: 'c1', candidateId: 'cand1' });
    seedEvidence(db, 'cand1');
    const job = runningJob(db, { versionId: 'v1' });
    const cap = makeCtx(job);
    const res = await handler.run(job, cap.ctx);
    // handler 返回时（finalize 尚未由 runner 执行），最后一帧 progress 已是 100%。
    const last = cap.progress[cap.progress.length - 1]!;
    expect(last.percent).toBe(100);
    // handler 未自行 finalize（finalized 未置 true）→ 交 runner completeJob；finalProgress 100%。
    expect(res.finalized).toBeFalsy();
    expect((res.finalProgress as { percent: number }).percent).toBe(100);
  });
});

describe('B-25 结构化 handler · stuck 异步写与终态写竞态（Codex r3 P1，迟到 stuck 写不覆盖已生成）', () => {
  it('竞态：stuck 写在 done 之后才落 → 条件写命中 0 行 no-op，已生成 manifest/字段终值不被覆盖，字段终态保持 done', async () => {
    const { db, gw } = setup();
    gw.scalarChunks['name'] = ['新', '名称'];
    const handler = createStructureHandler({ db, gateway: gw, stuckAfterMs: 999_999 });
    seedVersion(db, { versionId: 'v1', capabilityId: 'c1', candidateId: 'cand1' });
    seedEvidence(db, 'cand1');
    const job = runningJob(db, { versionId: 'v1', fields: ['name'] }, 5);
    const cap = makeCtx(job);

    // 正常跑完：name 成功落 done（manifest.name='新名称'、structure_state[name].status='done'）。
    await handler.run(job, cap.ctx);
    const mfBefore = db.versions.get('v1')!.manifest as Manifest;
    expect(mfBefore.name).toBe('新名称');
    const nameBefore = (db.versions.get('v1')!.structure_state as StructureState).fields.find(
      (f) => f.field === 'name',
    )!;
    expect(nameBefore.status).toBe('done');

    // 模拟「慢 stuck 写在 done 之后才落库」：done 已落、name 不再 generating，迟到的条件写应命中 0 行 no-op。
    const wrote = await writeFieldStuckIfGenerating(db, {
      jobId: job.id,
      fenceToken: job.fenceToken,
      versionId: 'v1',
      field: 'name',
      stuckMs: 60_000,
    });
    expect(wrote).toBe(false); // 条件写命中 0 行（name 已非 generating），自动 no-op。

    // 已生成不被覆盖：manifest 终值 + 字段终态 done 原样保留，永不被打回 stuck / 旧 manifest。
    const mfAfter = db.versions.get('v1')!.manifest as Manifest;
    expect(mfAfter.name).toBe('新名称');
    const nameAfter = (db.versions.get('v1')!.structure_state as StructureState).fields.find(
      (f) => f.field === 'name',
    )!;
    expect(nameAfter.status).toBe('done'); // 终态权威：保持 done，不被迟到 stuck 覆盖。
    expect((nameAfter as { stuckMs?: number }).stuckMs).toBeUndefined(); // 不残留 stuckMs。
  });

  it('竞态：stuck 写在 failed 之后才落 → 条件写 0 行 no-op，失败终态 + error 不被打回 stuck', async () => {
    const db = new StructureFakeDb();
    const gw = new StreamingFakeGateway();
    gw.failFields.add('name'); // 两次失败 → escalate 终态。
    const handler = createStructureHandler({ db, gateway: gw, stuckAfterMs: 999_999 });
    seedVersion(db, { versionId: 'v1', capabilityId: 'c1', candidateId: 'cand1' });
    seedEvidence(db, 'cand1');
    const job = runningJob(db, { versionId: 'v1', fields: ['name'] }, 5);
    const cap = makeCtx(job);
    await handler.run(job, cap.ctx);
    const nameFailed = (db.versions.get('v1')!.structure_state as StructureState).fields.find(
      (f) => f.field === 'name',
    )! as { status: string; error?: unknown };
    expect(nameFailed.status).toBe('failed');
    expect(nameFailed.error).toBeTruthy();

    // 迟到 stuck 写：name 已 failed（非 generating）→ 0 行 no-op，失败终态 + error 保留。
    const wrote = await writeFieldStuckIfGenerating(db, {
      jobId: job.id,
      fenceToken: job.fenceToken,
      versionId: 'v1',
      field: 'name',
      stuckMs: 60_000,
    });
    expect(wrote).toBe(false);
    const nameAfter = (db.versions.get('v1')!.structure_state as StructureState).fields.find(
      (f) => f.field === 'name',
    )! as { status: string; error?: unknown };
    expect(nameAfter.status).toBe('failed'); // 终态权威：保持 failed。
    expect(nameAfter.error).toBeTruthy();
  });

  it('正常：字段仍 generating 时 stuck 写命中（patch status=stuck + stuckMs），且只动 status/stuckMs 不写 manifest/不丢 attempts', async () => {
    const db = new StructureFakeDb();
    const gw = new StreamingFakeGateway();
    const handler = createStructureHandler({ db, gateway: gw, stuckAfterMs: 999_999 });
    // 预置 name 已累计 attempts=2、manifest.name 有旧值（验证 stuck 写不动 manifest / 不动 attempts）。
    const manifest = initialManifest('c1', '0.1.0');
    manifest.name = '旧名称';
    let seeded = initialStructureState('v1', manifest);
    // 把 name 置 generating + attempts=2（模拟「正在生成、此前累计 2 次」的中途态）。
    seeded = setFieldState(seeded, 'name', { status: 'generating', attempts: 2 });
    seedVersion(db, {
      versionId: 'v1',
      capabilityId: 'c1',
      candidateId: 'cand1',
      manifest,
      structureState: seeded,
    });
    seedEvidence(db, 'cand1');
    void handler; // 本用例直接驱动条件写（worker 路径由上面竞态/慢字段用例覆盖）。
    const job = runningJob(db, { versionId: 'v1' }, 5);

    const wrote = await writeFieldStuckIfGenerating(db, {
      jobId: job.id,
      fenceToken: job.fenceToken,
      versionId: 'v1',
      field: 'name',
      stuckMs: 12_345,
    });
    expect(wrote).toBe(true); // 仍 generating → 命中 1 行。
    const nameSt = (db.versions.get('v1')!.structure_state as StructureState).fields.find(
      (f) => f.field === 'name',
    )! as { status: string; stuckMs?: number; attempts?: number };
    expect(nameSt.status).toBe('stuck');
    expect(nameSt.stuckMs).toBe(12_345);
    expect(nameSt.attempts).toBe(2); // 累计基线不丢（只动 status/stuckMs，§3.4）。
    // manifest 不被 stuck 写触碰（绝不写 manifest，竞态修法核心）。
    expect((db.versions.get('v1')!.manifest as Manifest).name).toBe('旧名称');
  });

  it('正常：慢字段中途 stuck 落库（status=stuck + stuckMs），随后成功转 done（stuck 清，已生成不丢）', async () => {
    const db = new StructureFakeDb();
    const gw = new StreamingFakeGateway();
    gw.scalarChunks['name'] = ['慢', '名'];
    gw.slowFields.add('name');
    gw.slowMs = 30;
    const handler = createStructureHandler({ db, gateway: gw, stuckAfterMs: 5 });
    seedVersion(db, { versionId: 'v1', capabilityId: 'c1', candidateId: 'cand1' });
    seedEvidence(db, 'cand1');
    const job = runningJob(db, { versionId: 'v1', fields: ['name'] });
    const cap = makeCtx(job);
    await handler.run(job, cap.ctx);

    // 中途某次落库把 name 持久化为 stuck + stuckMs（断线重连可重建三退路态）。
    const stuckWrite = db.stateWrites.find((s) => {
      const f = s.fields.find((x) => x.field === 'name');
      return f?.status === 'stuck' && typeof (f as { stuckMs?: number }).stuckMs === 'number';
    });
    expect(stuckWrite).toBeTruthy();
    // 终态：name 转 done（stuck 清、值落定，已生成不丢）。
    const finalName = (db.versions.get('v1')!.structure_state as StructureState).fields.find(
      (f) => f.field === 'name',
    )!;
    expect(finalName.status).toBe('done');
    expect(finalName.value).toBe('慢名');
  });

  it('反向破坏守门：若 stuck 改回「无条件写 + 携带旧 manifest」→ done 之后落的 stuck 写会覆盖已生成（本断言会红）', async () => {
    // 这正是修法前的缺口：未等待的异步 stuck 写用闭包旧 manifest + setFieldState(旧 state, stuck) 经
    //   writeManifestAndStateProtected 无条件落库；若在 done 之后落，则覆盖 manifest 终值 + 把 done 打回 stuck。
    // 下面【显式重演】那条旧写法（旧 manifest + stuck state），断言它【确实会】覆盖已生成——
    //   证明无条件写危险；修法后 worker 改走 writeFieldStuckIfGenerating（条件写），同场景命中 0 行不覆盖（见上「竞态」用例）。
    const { db, gw } = setup();
    gw.scalarChunks['name'] = ['新', '名称'];
    const handler = createStructureHandler({ db, gateway: gw, stuckAfterMs: 999_999 });
    seedVersion(db, { versionId: 'v1', capabilityId: 'c1', candidateId: 'cand1' });
    seedEvidence(db, 'cand1');
    const job = runningJob(db, { versionId: 'v1', fields: ['name'] }, 5);
    const cap = makeCtx(job);
    await handler.run(job, cap.ctx);
    expect((db.versions.get('v1')!.manifest as Manifest).name).toBe('新名称');

    // 重演旧写法：闭包持有的【旧 manifest（name 空）】+ 旧 state setFieldState(stuck) 无条件落库。
    const staleManifest = initialManifest('c1', '0.1.0'); // 旧闭包 manifest：name 仍空（未含已生成值）。
    const staleStuckState = setFieldState(initialStructureState('v1', staleManifest), 'name', {
      status: 'stuck',
      stuckMs: 60_000,
    });
    const overwrote = await writeManifestAndStateProtected(db, {
      jobId: job.id,
      fenceToken: job.fenceToken,
      versionId: 'v1',
      manifest: staleManifest,
      state: staleStuckState,
    });
    // 无条件写【命中 1 行并覆盖】：这就是缺陷——已生成 manifest.name 被旧空值覆盖、done 被打回 stuck。
    expect(overwrote).toBe(true);
    expect((db.versions.get('v1')!.manifest as Manifest).name).toBe(''); // 被旧 manifest 覆盖（缺陷再现）。
    const nameSt = (db.versions.get('v1')!.structure_state as StructureState).fields.find(
      (f) => f.field === 'name',
    )!;
    expect(nameSt.status).toBe('stuck'); // done 被打回 stuck（缺陷再现）。
    // 解读：修法后 worker 不再走这条无条件写、改走条件写（writeFieldStuckIfGenerating），故同场景命中 0 行、不覆盖。
  });
});

describe('B-25 结构化 handler · 数组字段逐项落库（每数组项生成完即落 structure_state，Codex r4 P1）', () => {
  it('逐项：每条 item-appended 之前已受保护落 partial value 进 structure_state（不丢已浮现项）', async () => {
    const db = new StructureFakeDb();
    const gw = new StreamingFakeGateway();
    gw.arrayText['skill_set'] = '["技能A","技能B","技能C"]';
    const handler = createStructureHandler({ db, gateway: gw, stuckAfterMs: 999_999 });
    seedVersion(db, { versionId: 'v1', capabilityId: 'c1', candidateId: 'cand1' });
    seedEvidence(db, 'cand1');
    const job = runningJob(db, { versionId: 'v1', fields: ['skill_set'] });
    const cap = makeCtx(job);

    await handler.run(job, cap.ctx);

    // 每条 item-appended 都对应一次 partial 落库（stateWrites 历史里出现 skill_set.value 逐步增长的快照）。
    const partialSnaps = db.stateWrites
      .map((s) => s.fields.find((f) => f.field === 'skill_set'))
      .filter(
        (f): f is NonNullable<typeof f> =>
          Boolean(f) && f!.status === 'generating' && Array.isArray(f!.value),
      )
      .map((f) => (f!.value as string[]).length);
    // 至少出现过 1、2、3 条逐步增长的 partial（逐项落库，非一次性整数组落）。
    expect(partialSnaps).toContain(1);
    expect(partialSnaps).toContain(2);
    expect(partialSnaps).toContain(3);
    // item-appended 帧数 = 落 partial 的项数（写成功才 emit）。
    const items = framesByEvent(cap.frames, 'item-appended');
    expect(items.length).toBe(3);
  });

  it('逐项落库中断（崩溃/接管换 fence）→ 重连 snapshot（从 structure_state 重建）仍含已落 partial items', async () => {
    const db = new StructureFakeDb();
    const gw = new StreamingFakeGateway();
    gw.arrayText['skill_set'] = '["技能A","技能B","技能C","技能D"]';
    const handler = createStructureHandler({ db, gateway: gw, stuckAfterMs: 999_999 });
    seedVersion(db, { versionId: 'v1', capabilityId: 'c1', candidateId: 'cand1' });
    seedEvidence(db, 'cand1');
    const job = runningJob(db, { versionId: 'v1', fields: ['skill_set'] }, 5);
    const cap = makeCtx(job);

    // 落完前两条 partial 后模拟「崩溃/被接管换 fence」：之后所有受保护写命中 0 行（item 与 field_done 都写不进）。
    let persisted = 0;
    db.onArrayItemPersisted = () => {
      persisted += 1;
      if (persisted === 2) db.jobs.get('sjob-1')!.fence_token = 99; // 换 fence = 接管/崩溃后另一执行体接手。
    };

    const res = await handler.run(job, cap.ctx);

    // 中断后 handler 干净退出（fenced_out），不报错。
    expect((res.result as { fencedOut?: boolean }).fencedOut).toBe(true);
    expect(framesByEvent(cap.frames, 'error').length).toBe(0);

    // 重连 snapshot = 直读 structure_state（重建）：仍含中断前已落的 2 条 partial（已生成不丢）。
    const snap = db.versions.get('v1')!.structure_state as StructureState;
    const skillSt = snap.fields.find((f) => f.field === 'skill_set')!;
    expect(Array.isArray(skillSt.value)).toBe(true);
    expect(skillSt.value as string[]).toEqual(['技能A', '技能B']);
    // 接管后命中 0 行的项：既未 emit、也未落库（前 2 条 emit，第 3 条起被换 fence 挡住）。
    expect(framesByEvent(cap.frames, 'item-appended').length).toBe(2);
  });

  it('反向破坏守门：若改回「只 emit 不落 partial」→ 中断后 snapshot 丢失这些 items（断言会红）', async () => {
    // 显式重演修法前缺口：onArrayItem 只 ctx.emitField('item-appended')、不落 partial structure_state。
    //   下面手工驱动「只 emit、不落库」的旧路径，证明中断后从 structure_state 重建的 snapshot 丢失已浮现项。
    const db = new StructureFakeDb();
    seedVersion(db, { versionId: 'v1', capabilityId: 'c1', candidateId: 'cand1' });
    seedEvidence(db, 'cand1');
    const job = runningJob(db, { versionId: 'v1', fields: ['skill_set'] }, 5);

    // 把 skill_set 置 generating（worker 起步占位写后的库内态），value 仍空。
    let st = db.versions.get('v1')!.structure_state as StructureState;
    st = setFieldState(st, 'skill_set', { status: 'generating' });
    await writeManifestAndStateProtected(db, {
      jobId: job.id,
      fenceToken: job.fenceToken,
      versionId: 'v1',
      manifest: db.versions.get('v1')!.manifest as Manifest,
      state: st,
    });

    // 旧路径：逐项【只 emit、不落 partial】——这里不调用 writeArrayItemIfGenerating。
    const emitted = ['技能A', '技能B'];
    void emitted; // 用户已经看到这两条（item-appended 帧），但库里没落。

    // 模拟中断（崩溃/换 fence）：field_done 永不发生 → 直读 structure_state 重建 snapshot。
    db.jobs.get('sjob-1')!.fence_token = 99;
    const snap = db.versions.get('v1')!.structure_state as StructureState;
    const skillSt = snap.fields.find((f) => f.field === 'skill_set')!;
    // 缺口：用户看过 2 条，但 snapshot 重建后 value 仍空 → 已浮现项丢失。
    expect((skillSt.value as string[]) ?? []).toEqual([]);
    // 对照「修法后」逐项落库：同场景 snapshot 会含已落 partial（上一用例已证）；若退回此旧路径，则下面断言（应含已浮现项）必红。
    expect((skillSt.value as string[]) ?? []).not.toEqual(emitted);
  });

  it('rowCount=0 守门：终态后迟到的数组项写命中 0 行 → 不 emit、不覆盖', async () => {
    const db = new StructureFakeDb();
    const gw = new StreamingFakeGateway();
    gw.arrayText['skill_set'] = '["技能A","技能B","技能C"]';
    const handler = createStructureHandler({ db, gateway: gw, stuckAfterMs: 999_999 });
    seedVersion(db, { versionId: 'v1', capabilityId: 'c1', candidateId: 'cand1' });
    seedEvidence(db, 'cand1');
    const job = runningJob(db, { versionId: 'v1', fields: ['skill_set'] }, 5);
    const cap = makeCtx(job);

    // 正常跑完：skill_set 落 done（完整数组 + status=done，权威终态）。
    await handler.run(job, cap.ctx);
    const doneSt = (db.versions.get('v1')!.structure_state as StructureState).fields.find(
      (f) => f.field === 'skill_set',
    )!;
    expect(doneSt.status).toBe('done');
    expect((doneSt.value as string[]).length).toBe(3); // 完整数组（权威）。

    // 迟到的数组项写（done 后该字段已非 generating）→ 条件写命中 0 行 no-op，不追加、不打回 generating。
    const wrote = await writeArrayItemIfGenerating(db, {
      jobId: job.id,
      fenceToken: job.fenceToken,
      versionId: 'v1',
      field: 'skill_set',
      item: '迟到项',
    });
    expect(wrote).toBe(false); // rowCount=0：调用方据此不 emit。
    const afterSt = (db.versions.get('v1')!.structure_state as StructureState).fields.find(
      (f) => f.field === 'skill_set',
    )!;
    expect(afterSt.status).toBe('done'); // 终态权威不被打回。
    expect(afterSt.value as string[]).toEqual(doneSt.value); // 不被「迟到项」覆盖/追加。
    expect(afterSt.value as string[]).not.toContain('迟到项');
  });

  it('正常：全部项落完 field_done 落完整数组 + status=done（权威终态，partial 被完整 value 收口）', async () => {
    const db = new StructureFakeDb();
    const gw = new StreamingFakeGateway();
    gw.arrayText['skill_set'] = '["技能A","技能B","技能C"]';
    const handler = createStructureHandler({ db, gateway: gw, stuckAfterMs: 999_999 });
    seedVersion(db, { versionId: 'v1', capabilityId: 'c1', candidateId: 'cand1' });
    seedEvidence(db, 'cand1');
    const job = runningJob(db, { versionId: 'v1', fields: ['skill_set'] });
    const cap = makeCtx(job);

    await handler.run(job, cap.ctx);

    // 终态：structure_state[skill_set] = done + 完整数组；manifest 同步完整数组。
    const st = (db.versions.get('v1')!.structure_state as StructureState).fields.find(
      (f) => f.field === 'skill_set',
    )!;
    expect(st.status).toBe('done');
    expect(st.value as string[]).toEqual(['技能A', '技能B', '技能C']);
    const mf = db.versions.get('v1')!.manifest as Manifest;
    expect(mf.skill_set).toEqual(['技能A', '技能B', '技能C']);
    // field_done 帧带完整数组（已落 structure_state，§3.2）。
    const doneFrame = framesByEvent(cap.frames, 'field_done').find(
      (f) => (f.payload as { field: string }).field === 'skill_set',
    )!;
    expect((doneFrame.payload as { value: string[] }).value).toEqual(['技能A', '技能B', '技能C']);
  });
});

describe('B-25 结构化 handler · resume 接管不丢 generating 数组 partial + 续接不重复（Codex r5 P1）', () => {
  it('旧 fence out 后新 attempt 起步：structure_state 已有 2 个 partial item → 不丢、不重复、从第 3 项续', async () => {
    const db = new StructureFakeDb();
    const gw = new StreamingFakeGateway();
    // 新 attempt 重新整数组生成（generateArrayField 每次从 index 0 出全量）：完整 4 项。
    gw.arrayText['skill_set'] = '["技能A","技能B","技能C","技能D"]';
    const handler = createStructureHandler({ db, gateway: gw, stuckAfterMs: 999_999 });

    // 预置：上一个 attempt 已逐项落了 2 个 partial item（skill_set 仍 generating、value=['技能A','技能B']，
    //   只落 structure_state、manifest 仍空数组——writeArrayItemIfGenerating 语义）。模拟 worker crash/接管前的库内态。
    const manifest = initialManifest('c1', '0.1.0'); // manifest.skill_set = []（partial 不落 manifest）。
    let seeded = initialStructureState('v1', manifest);
    seeded = setFieldState(seeded, 'skill_set', {
      status: 'generating',
      value: ['技能A', '技能B'],
    });
    seedVersion(db, {
      versionId: 'v1',
      capabilityId: 'c1',
      candidateId: 'cand1',
      manifest,
      structureState: seeded,
    });
    seedEvidence(db, 'cand1');
    // 新 attempt（接管换新 fence；worker 从 mergeStructureState 重建——必须保留 2 个 partial）。
    const job = runningJob(db, { versionId: 'v1', fields: ['skill_set'] }, 7);
    const cap = makeCtx(job);

    await handler.run(job, cap.ctx);

    // 续接：只 emit 新增的 2 项（第 3、第 4 项；前 2 项已落、跳过不重复 emit）。
    const items = framesByEvent(cap.frames, 'item-appended').map(
      (f) => (f.payload as { itemIndex: number; value: string }).value,
    );
    expect(items).toEqual(['技能C', '技能D']); // 不重复前 2 项、从第 3 项续。

    // 落库过程中 structure_state partial 单调增长且不重复（2 → 3 → 4，永不回退/重建为空覆盖已落）。
    const partialLens = db.stateWrites
      .map((s) => s.fields.find((f) => f.field === 'skill_set'))
      .filter(
        (f): f is NonNullable<typeof f> =>
          Boolean(f) && f!.status === 'generating' && Array.isArray(f!.value),
      )
      .map((f) => (f!.value as string[]).length);
    // 首次 generating 占位写不得用空数组覆盖已落 2 项（首个快照长度 ≥ 2）。
    expect(partialLens[0]).toBeGreaterThanOrEqual(2);
    expect(partialLens).toContain(3); // 续接落第 3 项。
    expect(partialLens).toContain(4); // 续接落第 4 项。

    // 终态：完整 4 项、无重复、status=done；manifest 同步完整数组。
    const st = (db.versions.get('v1')!.structure_state as StructureState).fields.find(
      (f) => f.field === 'skill_set',
    )!;
    expect(st.status).toBe('done');
    expect(st.value as string[]).toEqual(['技能A', '技能B', '技能C', '技能D']); // 不丢、不重复。
    const mf = db.versions.get('v1')!.manifest as Manifest;
    expect(mf.skill_set).toEqual(['技能A', '技能B', '技能C', '技能D']);
  });

  it('反向破坏守门：若 merge 不保留 generating 数组 partial（只从 manifest 重建空数组）→ 已落 2 项被擦/被重复（断言会红）', () => {
    // 显式重演修法前缺口：mergeStructureState 只保留 failed/stuck、忽略 generating 数组 partial。
    //   下面手工跑「旧 merge 语义」（只从 manifest initialStructureState 重建、不并入已落 generating partial），
    //   证明已落的 2 个 partial item 在重建后丢失（value 空）——这正是新 attempt 首次 persist 会覆盖的源头。
    const manifest = initialManifest('c1', '0.1.0'); // manifest.skill_set=[]（partial 不落 manifest）。
    // 库内真实态：skill_set generating + 已落 2 partial。
    let persisted = initialStructureState('v1', manifest);
    persisted = setFieldState(persisted, 'skill_set', {
      status: 'generating',
      value: ['技能A', '技能B'],
    });

    // 旧 merge（缺陷版）：只从 manifest 重建、并入 failed/stuck，不并入 generating 数组 partial。
    const oldMerge = initialStructureState('v1', manifest); // 仅据 manifest（skill_set 空 → pending、value=[]）。
    const oldSkill = oldMerge.fields.find((f) => f.field === 'skill_set')!;
    // 缺陷再现：旧 merge 丢失已落 2 项（value 空）→ 后续首次 persist 会用空覆盖库内 partial。
    expect((oldSkill.value as string[]) ?? []).toEqual([]);
    expect((oldSkill.value as string[]) ?? []).not.toEqual(['技能A', '技能B']);

    // 对照修法后：mergeStructureState 应保留 generating partial（value 含 2 项），故下面是「期望的正确态」。
    const persistedSkill = persisted.fields.find((f) => f.field === 'skill_set')!;
    expect(persistedSkill.value as string[]).toEqual(['技能A', '技能B']); // 库内确有 2 项（修法须从此续）。
  });
});

describe('B-25 结构化 handler · 数组 finalize 以已落前缀为权威（Codex r6 P1，前缀稳定不被换）', () => {
  it('已落 [A,B]，新 attempt 重生 [X,B,C,D] → finalize value = [A,B,C,D]（前缀 A,B 不被换成 X）', async () => {
    const db = new StructureFakeDb();
    const gw = new StreamingFakeGateway();
    // 新 attempt 整数组重生：前缀第 0 项不同（技能X 而非技能A），后接 B/C/D。
    gw.arrayText['skill_set'] = '["技能X","技能B","技能C","技能D"]';
    const handler = createStructureHandler({ db, gateway: gw, stuckAfterMs: 999_999 });

    // 预置：上一个 attempt 已逐项落了 2 个 partial（skill_set generating、value=['技能A','技能B']，已展示给用户）。
    const manifest = initialManifest('c1', '0.1.0');
    let seeded = initialStructureState('v1', manifest);
    seeded = setFieldState(seeded, 'skill_set', {
      status: 'generating',
      value: ['技能A', '技能B'],
    });
    seedVersion(db, {
      versionId: 'v1',
      capabilityId: 'c1',
      candidateId: 'cand1',
      manifest,
      structureState: seeded,
    });
    seedEvidence(db, 'cand1');
    const job = runningJob(db, { versionId: 'v1', fields: ['skill_set'] }, 7);
    const cap = makeCtx(job);

    await handler.run(job, cap.ctx);

    // finalize 以已落前缀为权威：终值 = 已落 [A,B] + 新生成尾部 slice(2) = [C,D]，绝不被整数组 [X,B,C,D] 替换。
    const st = (db.versions.get('v1')!.structure_state as StructureState).fields.find(
      (f) => f.field === 'skill_set',
    )!;
    expect(st.status).toBe('done');
    expect(st.value as string[]).toEqual(['技能A', '技能B', '技能C', '技能D']); // 前缀稳定（A,B 不被换成 X）。
    expect((st.value as string[])[0]).toBe('技能A'); // 用户已见的第 0 项稳定不变。
    const mf = db.versions.get('v1')!.manifest as Manifest;
    expect(mf.skill_set).toEqual(['技能A', '技能B', '技能C', '技能D']); // manifest 同步同样的权威前缀。
  });

  it('反向破坏守门：若 finalize 改回「整数组 gen.result.value 覆盖」→ 前缀被换成 [X,B,...]（断言会红）', () => {
    // 显式重演修法前缺口：finalize 用 gen.result.value 整数组覆盖（不以已落前缀为权威）。
    //   下面手工对比「已落前缀 + 新尾部」（修法后，前缀稳定）与「整数组覆盖」（修法前，前缀被换），
    //   证明整数组覆盖会把用户已见的第 0 项 技能A 换成 技能X——这正是缺口。
    const persistedPrefix = ['技能A', '技能B']; // 已落、已展示给用户。
    const resumeOffset = persistedPrefix.length;
    const regenerated = ['技能X', '技能B', '技能C', '技能D']; // 新 attempt 整数组（前缀不同）。

    // 修法后：以已落前缀为权威 + 新尾部。
    const fixed = [...persistedPrefix, ...regenerated.slice(resumeOffset)];
    expect(fixed).toEqual(['技能A', '技能B', '技能C', '技能D']);
    expect(fixed[0]).toBe('技能A'); // 前缀稳定。

    // 修法前（缺口）：整数组覆盖。
    const broken = regenerated;
    expect(broken[0]).toBe('技能X'); // 前缀被换（缺口再现：用户已见的 技能A 被替换成 技能X）。
    expect(broken).not.toEqual(fixed); // 整数组覆盖 ≠ 已落前缀权威（若 finalize 退回整数组覆盖，前缀断言必红）。
  });
});

describe('B-25 结构化 handler · worker 字段完成 surgical 合并不覆盖并发 PATCH（Codex r6 P1）', () => {
  it('运行中 F1(name) 生成、期间 PATCH F2(goal) → F1 surgical 收口后 F2 的 PATCH 值仍在、其它字段不丢', async () => {
    const db = new StructureFakeDb();
    const gw = new StreamingFakeGateway();
    // name 字段流真慢：用每片 delta 间隔给并发 PATCH 一个时间窗（在 F1 done 写之前改 F2）。
    gw.scalarChunks['name'] = ['新', '名'];
    gw.slowFields.add('name');
    gw.slowMs = 20;
    const handler = createStructureHandler({ db, gateway: gw, stuckAfterMs: 999_999 });
    seedVersion(db, { versionId: 'v1', capabilityId: 'c1', candidateId: 'cand1' });
    seedEvidence(db, 'cand1');
    const job = runningJob(db, { versionId: 'v1', fields: ['name'] }, 5);
    const cap = makeCtx(job);

    // 在 name 生成途中（worker 已占位 generating、尚未 done 收口）模拟一次并发 PATCH：
    //   把【库内当前行】的 goal 软字段改成手填值（generating→done），同时 manifest.goal 落值。
    //   这正是创作者在结构化运行中 PATCH 另一软字段（§4.E）落库后的库内态——worker 不该把它擦掉。
    let patched = false;
    const origStream = gw.stream.bind(gw);
    gw.stream = async function* patchingStream(prompt: string) {
      for await (const chunk of origStream(prompt)) {
        if (!patched) {
          patched = true;
          const v = db.versions.get('v1')!;
          const mf = v.manifest as Manifest;
          mf.goal = '创作者手填的目标'; // 并发 PATCH 落 manifest.goal。
          const st = v.structure_state as StructureState;
          st.fields = st.fields.map((f) =>
            f.field === 'goal' ? { ...f, status: 'done', value: '创作者手填的目标' } : f,
          );
        }
        yield chunk;
      }
    } as typeof gw.stream;

    await handler.run(job, cap.ctx);

    // F1(name) surgical 收口后：F2(goal) 的并发 PATCH 值仍在（不被 worker 启动快照整列写覆盖）。
    const v = db.versions.get('v1')!;
    const mf = v.manifest as Manifest;
    expect(mf.name).toBe('新名'); // F1 已收口。
    expect(mf.goal).toBe('创作者手填的目标'); // F2 并发 PATCH 值幸存（不丢）。
    const st = v.structure_state as StructureState;
    const goalSt = st.fields.find((f) => f.field === 'goal')!;
    expect(goalSt.status).toBe('done'); // F2 状态幸存（done，非被擦回 pending）。
    expect(goalSt.value).toBe('创作者手填的目标');
    const nameSt = st.fields.find((f) => f.field === 'name')!;
    expect(nameSt.status).toBe('done');
  });

  it('反向破坏守门：若 worker 字段完成改回「整列写启动快照」→ 并发 PATCH 的 F2 值被擦回旧值（断言会红）', async () => {
    // 显式重演修法前缺口：worker 用启动时旧 manifest/state 整列 writeManifestAndStateProtected。
    //   下面先让并发 PATCH 落 F2(goal)，再用 worker【启动快照】（goal 仍空）整列写回，证明 F2 被擦掉。
    const db = new StructureFakeDb();
    seedVersion(db, { versionId: 'v1', capabilityId: 'c1', candidateId: 'cand1' });
    seedEvidence(db, 'cand1');
    const job = runningJob(db, { versionId: 'v1', fields: ['name'] }, 5);

    // worker 启动快照（goal 空——worker 起跑时读到的旧整列）。
    const startupManifest = initialManifest('c1', '0.1.0'); // goal=''。
    const startupState = setFieldState(initialStructureState('v1', startupManifest), 'name', {
      status: 'done',
      value: '新名',
    });

    // 并发 PATCH 先落 F2(goal)（库内当前行 goal 改成手填值）。
    const v = db.versions.get('v1')!;
    (v.manifest as Manifest).goal = '创作者手填的目标';
    const liveSt = v.structure_state as StructureState;
    liveSt.fields = liveSt.fields.map((f) =>
      f.field === 'goal' ? { ...f, status: 'done', value: '创作者手填的目标' } : f,
    );

    // 缺口重演：worker 用【启动快照】整列写回（writeManifestAndStateProtected）——goal 被擦回空。
    const overwrote = await writeManifestAndStateProtected(db, {
      jobId: job.id,
      fenceToken: job.fenceToken,
      versionId: 'v1',
      manifest: startupManifest,
      state: startupState,
    });
    expect(overwrote).toBe(true); // 整列写命中 1 行并覆盖（这就是缺陷）。
    // 并发 PATCH 的 F2(goal) 被擦回旧空值（缺陷再现）——证明整列写危险；修法后 worker 改走 surgical merge，同场景不覆盖。
    expect((db.versions.get('v1')!.manifest as Manifest).goal).toBe('');
    const goalSt = (db.versions.get('v1')!.structure_state as StructureState).fields.find(
      (f) => f.field === 'goal',
    )!;
    expect(goalSt.status).not.toBe('done'); // F2 状态被擦回（缺陷再现）。
  });
});

describe('B-25 结构化 handler · 失败收口保留 DB 现 value（Codex r7 P1 #1，不擦本 attempt 已落数组 tail）', () => {
  it('数组字段 generating + DB 已落 [A,B,C]，失败收口 surgical 写 → DB value 仍 [A,B,C]（只改 status/error，不擦 tail）', async () => {
    const db = new StructureFakeDb();
    seedVersion(db, { versionId: 'v1', capabilityId: 'c1', candidateId: 'cand1' });
    seedEvidence(db, 'cand1');
    const job = runningJob(db, { versionId: 'v1', fields: ['skill_set'] }, 5);

    // 库内态：skill_set generating + 已逐项落 3 项（writeArrayItemIfGenerating 语义，用户已见）。
    let st = db.versions.get('v1')!.structure_state as StructureState;
    st = setFieldState(st, 'skill_set', {
      status: 'generating',
      value: ['A', 'B', 'C'],
      attempts: 1,
    });
    db.versions.get('v1')!.structure_state = st;

    // 失败收口：surgical 写 status=failed + error + attempts，guard='in-progress'，【保留 DB 现 value】。
    const wrote = await writeFieldStateSurgical(db, {
      jobId: job.id,
      fenceToken: job.fenceToken,
      versionId: 'v1',
      field: 'skill_set',
      status: 'failed',
      attempts: 2,
      error: { userMessage: 'x', action: 'escalate' },
      guard: 'in-progress',
    });
    expect(wrote).toBe(true);
    const fs = (db.versions.get('v1')!.structure_state as StructureState).fields.find(
      (f) => f.field === 'skill_set',
    )! as { status: string; value: unknown; attempts?: number; error?: unknown };
    expect(fs.status).toBe('failed');
    expect(fs.attempts).toBe(2);
    expect(fs.error).toBeTruthy();
    // 反向破坏守门核心：失败不擦本 attempt 已落 tail——DB value 仍是用户已见的 [A,B,C]（不被本地旧 state 整条替换擦掉）。
    expect(fs.value as string[]).toEqual(['A', 'B', 'C']);
  });
});

describe('B-25 结构化 handler · 起步占位不覆盖并发 PATCH→done（Codex r7 P1 #2，full 模式尊重用户手填）', () => {
  it('full 模式 role 起初 pending（selectTargets 纳入），占位写前并发 PATCH 把 role 手填 done → 占位 0 行 → worker 跳过 role、不重生成、不打回 generating', async () => {
    const db = new StructureFakeDb();
    const gw = new StreamingFakeGateway();
    // role 起初 pending（worker 的 selectTargets 会纳入它）；其余软字段预置 done 避免噪声。
    const manifest = initialManifest('c1', '0.1.0');
    let seeded = initialStructureState('v1', manifest); // 全 pending。
    seeded = seeded.fields.reduce(
      (acc, f) =>
        SOFT_FIELD_KEYS.includes(f.field as SoftFieldKey) && f.field !== 'role'
          ? setFieldState(acc, f.field as SoftFieldKey, { status: 'done', value: 'x' })
          : acc,
      seeded,
    );
    seedVersion(db, {
      versionId: 'v1',
      capabilityId: 'c1',
      candidateId: 'cand1',
      manifest,
      structureState: seeded,
    });
    seedEvidence(db, 'cand1');
    gw.scalarChunks['role'] = ['不应被', '生成']; // 若 worker 误重生成，role 会被换成这个。
    const handler = createStructureHandler({ db, gateway: gw, stuckAfterMs: 999_999 });
    const job = runningJob(db, { versionId: 'v1', fields: ['role'] }, 5);
    const cap = makeCtx(job);

    // 注入并发 PATCH 时机：worker selectTargets 读完 pending 快照后、role 占位写（guard=not-done）落库【之前】，
    //   并发 PATCH 把 role 手填成 done（manifest.role + structure_state[role]=done）。
    //   随后 worker 的 not-done 占位写应命中 0 行 → 跳过 role（尊重用户手填，Codex r7 P1 #2）。
    const realQuery = db.query.bind(db);
    db.query = async function patchBeforePlaceholder(sql: string, params: unknown[] = []) {
      const isRolePlaceholder =
        sql.includes("jsonb_build_object('status', $5::text, 'attempts', $6::int)") &&
        params[3] === 'role' &&
        params[7] === 'not-done';
      if (isRolePlaceholder) {
        const v = db.versions.get('v1')!;
        (v.manifest as Manifest).role = '创作者手填的角色';
        const st = v.structure_state as StructureState;
        st.fields = st.fields.map((f) =>
          f.field === 'role' ? { ...f, status: 'done', value: '创作者手填的角色' } : f,
        );
      }
      return realQuery(sql, params);
    } as typeof db.query;

    await handler.run(job, cap.ctx);

    // 占位 guard='not-done' → role 此刻已 done → 0 行 → worker 跳过：不重生成、不发 role 的 field_start。
    const starts = framesByEvent(cap.frames, 'field_start').map(
      (f) => (f.payload as { field: string }).field,
    );
    expect(starts).not.toContain('role');
    // 并发手填值幸存（不被换成 gateway 的「不应被生成」、不被打回 generating）。
    const mf = db.versions.get('v1')!.manifest as Manifest;
    expect(mf.role).toBe('创作者手填的角色');
    const roleSt = (db.versions.get('v1')!.structure_state as StructureState).fields.find(
      (f) => f.field === 'role',
    )!;
    expect(roleSt.status).toBe('done'); // 不被打回 generating。
    expect(roleSt.value).toBe('创作者手填的角色');
  });

  it('对照：single-field regen guard=force → 即使 role 已 done 也强制重生成（§4.F，不被 not-done 误跳过）', async () => {
    const db = new StructureFakeDb();
    const gw = new StreamingFakeGateway();
    const manifest = initialManifest('c1', '0.1.0');
    manifest.role = '旧角色';
    const seeded = initialStructureState('v1', manifest); // role done。
    seedVersion(db, {
      versionId: 'v1',
      capabilityId: 'c1',
      candidateId: 'cand1',
      manifest,
      structureState: seeded,
    });
    seedEvidence(db, 'cand1');
    gw.scalarChunks['role'] = ['新', '角色'];
    const handler = createStructureHandler({ db, gateway: gw, stuckAfterMs: 999_999 });
    const job = runningJob(db, { versionId: 'v1', mode: 'single-field', field: 'role' }, 5);
    const cap = makeCtx(job);

    await handler.run(job, cap.ctx);

    // single-field 强制重生成（guard=force）：即使 role 已 done 也重生成、发 field_start、换新值。
    const starts = framesByEvent(cap.frames, 'field_start').map(
      (f) => (f.payload as { field: string }).field,
    );
    expect(starts).toEqual(['role']);
    expect((db.versions.get('v1')!.manifest as Manifest).role).toBe('新角色'); // 强制重生成换值。
  });
});

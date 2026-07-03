// B-25 · 结构化 Job handler（注册为 3A runner 的 structure JobHandler）。40-step3-4-structure §3/§4.C。
//   直读 candidate_evidence/session_segments（经 source_candidate_id，不依赖 ExperiencePack，§4.C）生成【软字段】：
//     name/tagline/role/goal/instructions/skill_set/starter_prompts —— 经 3A LLM 网关【流式】生成，
//     field-chunk SSE 字段逐个出（field_start/field_delta/field_done）、数组项逐条补（item-appended），
//     已好显终值、在生成显骨架条（永不裸转圈，边生成边显示，硬规则①）。
//   硬字段（id/version/status/inputs/output/boundaries）平台锁定：不生成、不参与流、永不报字段级错误
//     （error.details.field 恒 ∈ SoftFieldKey，§2.2/§3.4）。
//   三条退路（某软字段慢/超时，§3.3）：用已生成部分先继续（前端动作）/ 只重新生成卡住字段（端点 F）/ 再等等（后台继续）；
//     发 field_stuck（continue/regen/wait）+ slow_hint；已生成不丢。
//   同一软字段重试两次仍失败（§3.4）→ 落人话错误态（ErrorEnvelope，action retry/change_input/escalate），不裸转圈不裸 code。
//   写 capability_versions.manifest/structure_state（fence CTE，§11.A 模板 3）；
//   finalize 前上报终态进度、finalize 后不再 reportProgress（Codex r4 P1）；取消/重入不丢已生成软字段（硬规则③）。
import {
  ErrorCode,
  SOFT_FIELD_KEYS,
  LLM_MAX_RETRIES,
  buildError,
  type SoftFieldKey,
  type LlmGatewayPort,
  type ProgressView,
  type Manifest,
  type StructureState,
  type ErrorBody,
} from '@cb/shared';
import type {
  JobContext,
  JobHandler,
  JobResult,
  LeasedJob,
  Queryable,
} from '../../platform/jobs/types.js';
import {
  readVersion,
  readEvidenceForCandidate,
  writeFieldStuckIfGenerating,
  writeArrayItemIfGenerating,
  writeFieldStateSurgical,
  writeFieldDoneSurgical,
  type StructureEvidence,
} from './repo.js';
import {
  applySoftField,
  setFieldState,
  getFieldState,
  isArrayField,
  initialStructureState,
} from './manifest.js';
import { generateFieldWithRetry, type GenContext } from './generate.js';

/** 抛带分类 code 的整体失败错误（runner.normalizeToErrorBody 据 code 归一人话信封）。 */
function codedError(code: (typeof ErrorCode)[keyof typeof ErrorCode], message: string): Error {
  const e = new Error(message) as Error & { code: string };
  e.code = code;
  return e;
}

/**
 * structure job 的 subject_ref 形态（触发期 create-structure-job 写入）：
 *   - versionId：要结构化的 draft 版本（必填）。
 *   - fields：要生成的软字段子集（续传/重生成只补这些；空 = 全部 7 软字段，§4.C StartStructureBody）。
 *   - mode：'full'（默认，全量/续传）| 'single-field'（端点 F 单字段重生成，§4.F）。
 *   - field：mode='single-field' 时要重生成的那个软字段。
 *   - attemptsBefore：该字段此前已累计的生成失败次数（端点 F 跨调用累计，§3.4「同处重试两次」）。
 */
export interface StructureSubjectRef {
  versionId?: string;
  fields?: SoftFieldKey[];
  mode?: 'full' | 'single-field';
  field?: SoftFieldKey;
  attemptsBefore?: number;
}

/** 结构化 handler 依赖面（注入便于 mock；worker 入口用真实 infra 装配）。 */
export interface StructureHandlerDeps {
  /** worker 写库 / 受保护 fence CTE 用的 PG 句柄（与 runner 同库）。 */
  db: Queryable;
  /** 3A LLM 网关（无 key → degraded，单测注入 mock）。 */
  gateway: LlmGatewayPort;
  /** 某软字段生成超阈值 → 发 field_stuck（三退路）。默认 12s。 */
  stuckAfterMs?: number;
}

/** 软字段慢阈值（超过未完成 → field_stuck 三退路，§3.3）。 */
const DEFAULT_STUCK_AFTER_MS = 12_000;

/** 结构化 handler 工厂。 */
export function createStructureHandler(deps: StructureHandlerDeps): JobHandler {
  return {
    type: 'structure',
    async run(job: LeasedJob, ctx: JobContext): Promise<JobResult> {
      return runStructure(deps, job, ctx);
    },
  };
}

async function runStructure(
  deps: StructureHandlerDeps,
  job: LeasedJob,
  ctx: JobContext,
): Promise<JobResult> {
  const { db, gateway } = deps;
  const stuckAfterMs = deps.stuckAfterMs ?? DEFAULT_STUCK_AFTER_MS;
  const subject = (job.subjectRef ?? {}) as StructureSubjectRef;
  const versionId = subject.versionId;
  if (!versionId) {
    throw codedError(ErrorCode.INTERNAL, 'structure subject_ref missing versionId');
  }

  // —— 读 version（manifest/structure_state/血缘）；不存在 = 内部不一致（触发期已校验，§4.C）——
  const version = await readVersion(db, versionId);
  if (!version) {
    throw codedError(ErrorCode.NOT_FOUND, 'structure version not found');
  }
  // published 版本不可就地结构化（需建新版本，§4.C STATE_CONFLICT）；触发期已挡，到此为防御。
  if (version.status !== 'draft') {
    throw codedError(ErrorCode.STATE_CONFLICT, 'structure on non-draft version');
  }

  // —— 直读证据（经 source_candidate_id；不依赖 ExperiencePack，§4.C）——
  let evidence: StructureEvidence = { segments: [] };
  if (version.sourceCandidateId) {
    evidence = await readEvidenceForCandidate(db, version.sourceCandidateId);
  }
  if (evidence.segments.length === 0) {
    // 证据为空 → STRUCTURE_NO_EVIDENCE（§4.C 错误用例：会话内容不足，回上一步换候选/补内容）。
    throw codedError(
      ErrorCode.STRUCTURE_NO_EVIDENCE,
      'no candidate_evidence for structure generation',
    );
  }

  // —— 工作 manifest / structure_state：从已落值起步（断点续传，已生成不丢，硬规则③）——
  let manifest: Manifest = version.manifest;
  // structure_state 真源：以 manifest 已有值重建（done 回显、空 pending、硬 locked）；并入已落 structure_state 的失败/卡住态。
  let state: StructureState = mergeStructureState(versionId, manifest, version.structureState);

  // —— 决定要生成哪些软字段 ——
  //   single-field（端点 F 重生成）：只该字段；full：subject.fields 子集 ∩ 未生成（续传只补未生成，贯穿-28），
  //   不传 fields → 全部未生成软字段。
  const targets = selectTargets(subject, manifest, state);

  await ctx.reportSubtask('fields', 'running', '正在补全字段');
  await ctx.reportProgress({
    percent: pct(state),
    phrase: progressPhrase(state),
    done: state.doneCount,
    total: state.totalCount,
    unit: '字段',
  });

  let anyDegraded = false;

  for (let i = 0; i < targets.length; i++) {
    if (ctx.isCancelled()) break; // 安全点：取消即停（已生成软字段保留，硬规则③）。
    const field = targets[i]!;
    const index = SOFT_FIELD_KEYS.indexOf(field); // 1-based 在 field_start payload 用 index+? — 用契约 index（4/7 风格）。

    // 跨 job 累计起算（Codex P1-6）：每字段从【现有 state】读已累计 attempts 续算，不一刀切清零。
    //   full/resume：subject.attemptsBefore 通常缺省（0），若直接用它会把该字段跨 job 累计清零 → §3.4 永不落错误态；
    //   故取 max(字段现有 attempts, subject.attemptsBefore)。single-field regen：subject.attemptsBefore 是路由读出的
    //   权威累计（受理时该字段被置 generating、attempts 不变），亦 ≥ 字段现有值，max 取它，语义一致。
    const fieldAttempts = getFieldState(state, field)?.attempts ?? 0;
    const attemptsBefore = Math.max(fieldAttempts, subject.attemptsBefore ?? 0);

    const outcome = await generateOneField({
      db,
      gateway,
      job,
      ctx,
      versionId,
      field,
      index,
      stuckAfterMs,
      manifest,
      state,
      evidence,
      attemptsBefore,
      // 端点 F 单字段 regen：每次点击 = 一次用户驱动尝试（本轮预算 1，连点跨调用累计，§3.4）。
      // full 自动结构化：本轮内部重试 ≤ LLM_MAX_RETRIES（两次仍失败即终态，同一 job 内落错误态）。
      singleRegen: subject.mode === 'single-field',
    });

    if (outcome.kind === 'fenced_out') {
      // 被取消/接管换 fence（受保护写 0 行）→ 停在安全点，已生成保留，交还 runner 兜（不 finalize）。
      return { result: { versionId, fencedOut: true } };
    }
    // 推进工作镜像（manifest/state 已含本字段最新结果——done 或 failed）。
    manifest = outcome.manifest;
    state = outcome.state;
    if (outcome.degraded) anyDegraded = true;

    await ctx.reportProgress({
      percent: pct(state),
      phrase: progressPhrase(state),
      done: state.doneCount,
      total: state.totalCount,
      unit: '字段',
    });
  }

  await ctx.reportSubtask('fields', 'done', '已补全字段');

  // —— 收尾：finalize（置 completed）【之前】上报终态 100%（Codex r4 P1；finalize 后不再 reportProgress）——
  const finalProgress = completedStructureProgress(state, anyDegraded);
  await ctx.reportProgress({
    percent: 100,
    phrase: finalProgress.phrase,
    done: state.doneCount,
    total: state.totalCount,
    unit: '字段',
  });

  // finalized:false → runner 受保护 completeJob（fence 守门）。done 帧带 result（含终态 structure_state）。
  //   结构化无同事务 outbox 需求（通知属发布/提取域），故走 runner completeJob 路径。
  return {
    result: { versionId, manifest, structureState: state, degraded: anyDegraded },
    finalProgress,
  };
}

/** 生成一个软字段：流式帧 + 受保护落库 + 三退路 + 两次失败落错误态。 */
async function generateOneField(args: {
  db: Queryable;
  gateway: LlmGatewayPort;
  job: LeasedJob;
  ctx: JobContext;
  versionId: string;
  field: SoftFieldKey;
  index: number;
  stuckAfterMs: number;
  manifest: Manifest;
  state: StructureState;
  evidence: StructureEvidence;
  attemptsBefore: number;
  /** 端点 F 单字段 regen：本轮预算 1（每次点击 = 一次尝试，连点跨调用累计，§3.4）；full = 内部重试 ≤2。 */
  singleRegen: boolean;
}): Promise<
  | { kind: 'done'; manifest: Manifest; state: StructureState; degraded: boolean }
  | { kind: 'failed'; manifest: Manifest; state: StructureState; degraded: boolean }
  | { kind: 'fenced_out' }
> {
  const { db, gateway, job, ctx, versionId, field, stuckAfterMs } = args;
  let { manifest, state } = args;

  // —— resume 续接基线（Codex r5 P1）：数组字段若上一个 attempt 已逐项落了若干 partial（mergeStructureState 已保留），
  //   本 attempt 从已持久化的 item 数【续接】，跳过已落项、不重复 append/emit；单值字段无逐项续接（resumeOffset=0）。
  const existing = getFieldState(state, field)?.value;
  const resumeOffset =
    isArrayField(field) && Array.isArray(existing) ? (existing as string[]).length : 0;
  // —— 已落前缀权威（Codex r6 P1）：数组 finalize 必须以【已落 partial 前缀】为准、不被新 attempt 重生的不同前缀替换
  //   （用户已见前缀稳定不变）。这里快照已展示给用户的前缀（mergeStructureState 已从 DB 当前行带入 state）。
  const persistedPrefix: string[] =
    isArrayField(field) && Array.isArray(existing) ? ([...existing] as string[]) : [];

  // —— 标该字段 generating + surgical 落库（只 patch 本字段 status/attempts、保留 DB 现 value；其它字段/manifest 不动）——
  //   保留已存 attempts（跨调用累计基线，§3.4）：generating 占位写不清零，fence-out 中断也不丢累计。
  //   保留 DB 现 value（不整条替换）：已落数组 partial / 并发改动不被本地旧 state 覆盖（Codex r6/r7 P1）。
  //   full 模式 guard='not-done'：若并发 PATCH 已把本字段手填成 done，占位写命中 0 行 → 跳过本字段（尊重用户手填、不重生成、
  //     不打回 generating，Codex r7 P1 #2）；0 行也可能是 fence out → 回读 DB 区分：done 则 skip、否则 fenced_out。
  //   single-field regen guard='force'：端点 F 显式重生成该字段（即使已 done，§4.F），强制重写占位；0 行 = fence out。
  state = setFieldState(state, field, { status: 'generating', attempts: args.attemptsBefore });
  if (
    !(await writeFieldStateSurgical(db, {
      jobId: job.id,
      fenceToken: job.fenceToken,
      versionId,
      field,
      status: 'generating',
      attempts: args.attemptsBefore,
      guard: args.singleRegen ? 'force' : 'not-done',
    }))
  ) {
    // 0 行：single-field 强制写只会因 fence out 落空（停整 job）；full 模式还需区分「并发已手填 done」（跳过该字段）。
    if (!args.singleRegen) {
      const current = await readVersion(db, versionId);
      if (current && mergeStructureStateStatus(current.structureState, field) === 'done') {
        // 并发手填赢：该字段已 done，worker 不重生成、不发字段级帧；把本地镜像同步成 done（不丢、不覆盖）。
        const v = current.manifest[field as keyof typeof current.manifest] as string | string[];
        state = setFieldState(state, field, { status: 'done', value: v, attempts: 0 });
        return { kind: 'done', manifest: current.manifest, state, degraded: false };
      }
    }
    return { kind: 'fenced_out' };
  }

  // field_start（仅软字段发；硬字段不发，§2.2/§3.2）。
  await ctx.emitField('field_start', {
    field,
    index: state.doneCount + 1,
    total: state.totalCount,
  });

  // —— 软字段慢 → field_stuck（三退路 continue/regen/wait）+ slow_hint（§3.3，永不裸转圈）——
  const startedAt = Date.now();
  let stuckTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
    void (async () => {
      const elapsedMs = Date.now() - startedAt;
      // 持久化 stuck 态（Codex P1-8 + r3 P1）：受保护【条件】写 structure_state[field].status='stuck' + stuckMs，
      //   让断线重连 snapshot 能重建三退路状态（否则只发瞬时帧、重连即丢，违反「已生成不丢/永不裸转圈」）。
      //   竞态修法（Codex r3 P1）：stuck 写【绝不写 manifest、不携带旧 state 快照】，只 surgically patch 库内当前行
      //     该字段 status/stuckMs，且【仅当该字段仍 generating 才写】（writeFieldStuckIfGenerating 内联守护条件）。
      //     若成功/失败终态已先落库 → 该字段不再 generating → 条件写命中 0 行自动 no-op，
      //     迟到的 stuck 写永不覆盖已生成内容 / manifest、永不把 done 打回 stuck（终态权威）。
      //   保留已存 attempts（库内 jsonb_set 只动 status/stuckMs，不触 attempts，§3.4 累计基线不丢）。
      //   fence-out / 已离开 generating（写 0 行）静默忽略（best-effort，是正常控制流）。
      await writeFieldStuckIfGenerating(db, {
        jobId: job.id,
        fenceToken: job.fenceToken,
        versionId,
        field,
        stuckMs: elapsedMs,
      }).catch(() => false);
      // field_stuck 仅对软字段发（field ∈ SoftFieldKey，硬字段永不发，§3.3）。
      await ctx.emitField('field_stuck', {
        field,
        elapsedMs,
        options: ['continue', 'regen', 'wait'],
      });
      await ctx.emitSlowHint('这一步比平时久了，可以继续等或先用已生成的部分。', elapsedMs);
    })();
  }, stuckAfterMs);
  if (stuckTimer && typeof (stuckTimer as { unref?: () => void }).unref === 'function') {
    (stuckTimer as { unref: () => void }).unref();
  }

  const genCtx: GenContext = {
    generated: softGenerated(manifest),
    evidence: args.evidence,
    traceId: ctx.traceId,
    ...(job.ownerUserId ? { ownerUserId: job.ownerUserId } : {}),
  };

  let gen;
  try {
    gen = await generateFieldWithRetry(
      gateway,
      field,
      genCtx,
      {
        async onAttemptStart() {
          // 重试 attempt 重发 field_start（前端重置该字段加载条；其它字段不动）。
          // 首次已发过 field_start；重试时再发一次以重置（attemptNo>1）。
        },
        async onScalarDelta(deltaText) {
          await ctx.emitField('field_delta', { field, deltaText });
        },
        async onArrayItem(itemIndex, value) {
          // resume 续接守门（Codex r5 P1）：上一个 attempt 已落且本 attempt 重新整数组生成的 partial 前缀，
          //   这里【跳过已落 item index】——不重复 append、不重复 emit（generateArrayField 每次从 index 0 重出全量；
          //   resumeOffset = 已持久化项数）。续接从第 resumeOffset 项起，落新增项、emit 新增项。
          if (itemIndex < resumeOffset) return;
          // 数组项逐条浮现（item-appended，§3.2 验收-24）+ 逐项落库（每数组项生成完即落 structure_state，§4.C，Codex r4 P1）。
          //   修法核心：【先】用受保护条件 CTE 把本项 append 进 structure_state[该字段].value（仅当 fence/running 且
          //     该字段仍 generating；只 patch 该字段 value 的数组、不写 manifest、不动其它字段/status/attempts），
          //   【写成功（rowCount>0）后再 emit item-appended】。否则崩溃/取消/断线窗口会丢已浮现给用户的数组项（已生成不丢）。
          //   rowCount=0（终态 / 被接管换 fence / 字段已离开 generating）→ 不 emit、不覆盖（与 stuck no-op 同思路，控制流非错误）。
          const wrote = await writeArrayItemIfGenerating(db, {
            jobId: job.id,
            fenceToken: job.fenceToken,
            versionId,
            field,
            item: value,
          });
          if (!wrote) return; // fence out / 字段已非 generating：迟到项不 emit、不落（已落 partial 不被覆盖）。
          await ctx.emitField('item-appended', { field, itemIndex, value });
        },
      },
      args.attemptsBefore,
      // 端点 F 单字段 regen：本轮预算 1（每次点击 = 一次尝试，连点累计）；full 自动结构化：内部重试 ≤ LLM_MAX_RETRIES。
      args.singleRegen ? 1 : LLM_MAX_RETRIES,
    );
  } finally {
    if (stuckTimer) {
      clearTimeout(stuckTimer);
      stuckTimer = undefined;
    }
  }

  if (gen.kind === 'failed') {
    // 把累计 attempts 写回 structure_state（gen.attempts = 跨 job/跨端点 F 调用累计，已夹 ≤ LLM_MAX_RETRIES）。
    // surgical：只动本字段条目（status=failed + error + attempts），不整列写启动快照（不覆盖并发 PATCH，Codex r6 P1）。
    //   whenGenerating=true：本字段此刻仍 generating（占位写后未收口）→ 命中收口；若已被换 fence/已离开 generating
    //   则 0 行 no-op（与终态权威同思路）。
    const errBody = buildError(ErrorCode.STRUCTURE_FIELD_FAILED, ctx.traceId, {
      userMessage: gen.terminal
        ? '这个字段没生成出来，可重试、改输入或转人工。'
        : '这个字段这次没生成出来，再试一次或改下输入。',
      action: gen.terminal ? 'escalate' : 'retry', // 累计达上限 → escalate 终态；未达 → retry（不裸转圈）。
      retriable: true,
      details: { field, attempts: gen.attempts },
    }).error;
    state = setFieldState(state, field, {
      status: 'failed',
      error: errBody,
      attempts: gen.attempts,
    });
    // surgical：只 patch 本字段 status=failed + error + attempts，【保留 DB 现 value】——本 attempt 已逐项落库的数组 tail
    //   不被本地旧 state 整条替换擦掉（Codex r7 P1 #1）。guard='in-progress'（仍 generating/stuck 才收口；终态/换 fence → no-op）。
    if (
      !(await writeFieldStateSurgical(db, {
        jobId: job.id,
        fenceToken: job.fenceToken,
        versionId,
        field,
        status: 'failed',
        attempts: gen.attempts,
        error: errBody,
        guard: 'in-progress',
      }))
    ) {
      return { kind: 'fenced_out' };
    }
    // error 帧 = 完整对外 ErrorEnvelope（data:{error:{...}}，§3.4；details.field ∈ SoftFieldKey）。
    await emitFieldError(ctx, errBody);
    return { kind: 'failed', manifest, state, degraded: false };
  }

  // —— 成功收口：数组 finalize 以【已落前缀】为权威（Codex r6 P1）——
  //   数组字段：终值 = 已落 persistedPrefix（已展示给用户、稳定不变）+ 本 attempt 新生成的尾部（slice(resumeOffset)）。
  //   新 attempt 即使重生出不同前缀（如 [X,B,C,D]），也只取其 slice(resumeOffset) 的尾部追加，前缀 [A,B] 不被换成 [X,B]。
  //   单值字段：无逐项前缀语义，直接用 gen.result.value（resumeOffset=0）。
  const finalValue: string | string[] = isArrayField(field)
    ? [...persistedPrefix, ...(gen.result.value as string[]).slice(resumeOffset)]
    : gen.result.value;

  // —— 成功：surgical merge 落 manifest 本字段 + structure_state(done)（不整列写启动快照，不覆盖并发 PATCH，Codex r6 P1）——
  manifest = applySoftField(manifest, field, finalValue);
  // 成功即重置该字段累计失败次数（attempts=0）：下次若再 regen 从干净预算起算，不被历史失败连坐（§3.4）。
  state = setFieldState(state, field, { status: 'done', value: finalValue, attempts: 0 });
  // 硬字段 locked 值随 manifest（inputs/output）更新而刷新（仍 locked，不发字段级帧）。
  state = refreshLockedHardFields(state, manifest);
  // instructions 变更才派生硬字段（inputs/output）；其它软字段不动硬字段（derivedHard=null）。
  //   shape 直接取自 applySoftField 已算好的 manifest.inputs/manifest.output（避免重复推断/形态不一致）。
  //   surgical merge 据【库内当前行】只 jsonb_set 本字段 manifest value + 该字段 structure_state 条目（+ 派生硬字段），
  //   保留并发 PATCH 改过的其它软字段值/状态/partial。whenGenerating 守护（迟到/被换 fence → 0 行 no-op）。
  const derivedHard =
    field === 'instructions'
      ? { inputs: manifest.inputs as unknown, output: manifest.output as unknown }
      : null;
  if (
    !(await writeFieldDoneSurgical(db, {
      jobId: job.id,
      fenceToken: job.fenceToken,
      versionId,
      field,
      fieldState: getFieldState(state, field),
      manifestField: finalValue,
      derivedHard,
    }))
  ) {
    return { kind: 'fenced_out' };
  }

  // field_done（已落 structure_state；单值 string / 数组 string[]，§3.2）。
  await ctx.emitField('field_done', { field, value: finalValue });
  return { kind: 'done', manifest, state, degraded: gen.result.degraded };
}

/** 发字段级 error 帧（完整对外 ErrorEnvelope，§3.4 / Codex#2）。整 job 不因此转 failed（§3.4）。 */
async function emitFieldError(ctx: JobContext, errBody: ErrorBody): Promise<void> {
  await ctx.emitField('error', { error: errBody });
}

// ===========================================================================
// helpers
// ===========================================================================

/** 已生成软字段映射（供后字段生成参考；只取非空值）。 */
function softGenerated(manifest: Manifest): Partial<Record<SoftFieldKey, string | string[]>> {
  const out: Partial<Record<SoftFieldKey, string | string[]>> = {};
  for (const f of SOFT_FIELD_KEYS) {
    const v = manifest[f];
    if (
      isArrayField(f) ? Array.isArray(v) && v.length > 0 : typeof v === 'string' && v.length > 0
    ) {
      out[f] = v;
    }
  }
  return out;
}

/**
 * 决定要生成的软字段（续传只补未生成，贯穿-28；single-field 只该字段，§4.F）。
 *   - single-field：[subject.field]（强制重生成，即使已 done，§4.F「只重生成卡住/指定字段」）。
 *   - full：subject.fields 子集（若给）；未给 → 全部软字段。再过滤掉【已 done】的（续传只补未生成）。
 */
function selectTargets(
  subject: StructureSubjectRef,
  manifest: Manifest,
  state: StructureState,
): SoftFieldKey[] {
  if (subject.mode === 'single-field' && subject.field) {
    return [subject.field]; // 强制重生成该字段（替换，不追加；其余不动，§4.F）。
  }
  void manifest;
  const requested =
    subject.fields && subject.fields.length > 0 ? subject.fields : [...SOFT_FIELD_KEYS];
  // 续传只补未生成：跳过已 done 的字段（已生成不丢，贯穿-28）。failed/stuck/pending 仍补。
  return requested.filter((f) => {
    const fs = getFieldState(state, f);
    return !fs || fs.status !== 'done';
  });
}

/**
 * 重建 structure_state：以 manifest 已有值定 done/pending、硬 locked；并入已落 state 的 failed/stuck/generating 态。
 *   关键（Codex r5 P1）：worker crash / sweeper 接管新 attempt 起步必须从【当前 structure_state】重建，不能只靠
 *   manifest——数组项 partial 经 writeArrayItemIfGenerating 只逐项落 structure_state、不落 manifest（§4.C），
 *   若仅从 manifest 重建则空数组覆盖已落 partial（已生成不丢，硬规则③）。
 */
function mergeStructureState(
  versionId: string,
  manifest: Manifest,
  prev: Partial<StructureState>,
): StructureState {
  let state = initialStructureState(versionId, manifest);
  const prevFields = Array.isArray(prev.fields) ? prev.fields : [];
  for (const pf of prevFields) {
    if (!SOFT_FIELD_KEYS.includes(pf.field as SoftFieldKey)) continue;
    // 已落 failed/stuck 态 → 保留（错误态续传可见 + 退路，§3.4/§3.5）；含已存 attempts（跨调用累计基线不丢）。
    //   failed/stuck 态【遮蔽】manifest 里的陈旧值：即使 manifest 仍有旧值（initialStructureState 投成 done），
    //   也保留 failed/stuck + attempts（否则「先 done、再 regen 失败」的字段在 resume/重建时被打回 done、清掉累计，
    //   §3.4 永不落错误态）。单字段 regen 目标态由 markFieldGenerating 置 generating（非 failed），此处不触及，
    //   其累计经 subject_ref.attemptsBefore 透传，不依赖本合并。
    if (pf.status === 'failed' || pf.status === 'stuck') {
      state = setFieldState(state, pf.field as SoftFieldKey, {
        status: pf.status,
        ...(pf.value !== undefined ? { value: pf.value as string | string[] } : {}),
        ...((pf as { error?: ErrorBody }).error
          ? { error: (pf as { error?: ErrorBody }).error! }
          : {}),
        ...(typeof pf.attempts === 'number' ? { attempts: pf.attempts } : {}),
      });
      continue;
    }
    // 已落 generating 的【数组】partial → 保留 value/attempts（Codex r5 P1）：上一个 attempt 已逐项落了若干
    //   partial item（writeArrayItemIfGenerating，只落 structure_state、不落 manifest），新 attempt 从此续接、
    //   不从空数组重建。仍标 generating（待本 attempt 补完整数组才转 done）。
    //   仅对数组字段保留（单值字段 partial 无逐项语义，generating 单值无已落部分值可续，仍据 manifest/pending 起步）。
    if (
      pf.status === 'generating' &&
      isArrayField(pf.field as SoftFieldKey) &&
      Array.isArray(pf.value) &&
      (pf.value as string[]).length > 0
    ) {
      state = setFieldState(state, pf.field as SoftFieldKey, {
        status: 'generating',
        value: pf.value as string[],
        ...(typeof pf.attempts === 'number' ? { attempts: pf.attempts } : {}),
      });
    }
  }
  return state;
}

/**
 * 从【DB 当前行】partial structure_state 读某字段当前 status（占位写命中 0 行时区分「并发 PATCH 已手填 done」与
 *   「fence out」，Codex r7 P1 #2）。条目缺失 → undefined。
 */
function mergeStructureStateStatus(
  prev: Partial<StructureState>,
  field: SoftFieldKey,
): string | undefined {
  const fields = Array.isArray(prev.fields) ? prev.fields : [];
  return fields.find((f) => f.field === field)?.status;
}

/** 软字段（inputs/output 派生）变更后刷新硬字段 locked 值（仍 locked，不发字段级帧，§2.2）。 */
function refreshLockedHardFields(state: StructureState, manifest: Manifest): StructureState {
  const fields = state.fields.map((f) => {
    if (f.status !== 'locked') return f;
    const key = f.field as keyof Manifest;
    return { ...f, value: manifest[key] as unknown };
  });
  return { ...state, fields };
}

/** 进度 percent（按软字段 done/total）。 */
function pct(state: StructureState): number {
  if (state.totalCount === 0) return 100;
  return Math.round((100 * state.doneCount) / state.totalCount);
}

/** 进度短语（「正在补全字段 4 / 7」，§3.2）。 */
function progressPhrase(state: StructureState): string {
  if (state.doneCount >= state.totalCount) return '已补全全部字段';
  return `正在补全字段 ${state.doneCount + 1} / ${state.totalCount}`;
}

/** 收尾完整 ProgressView（100% + fields 子任务 done；degraded 诚实标进短语）。 */
function completedStructureProgress(state: StructureState, degraded: boolean): ProgressView {
  const failed = state.fields.filter(
    (f) => SOFT_FIELD_KEYS.includes(f.field as SoftFieldKey) && f.status === 'failed',
  ).length;
  let phrase: string;
  if (failed > 0)
    phrase = `已补全 ${state.doneCount} / ${state.totalCount} 字段，${failed} 项需重试`;
  else if (degraded) phrase = '已补全全部字段（部分为自动生成）';
  else phrase = '已补全全部字段';
  return {
    percent: 100,
    phrase,
    done: state.doneCount,
    total: state.totalCount,
    unit: '字段',
    subtasks: [{ key: 'fields', label: '补全字段', status: 'done' as const }],
    slow: false,
  };
}

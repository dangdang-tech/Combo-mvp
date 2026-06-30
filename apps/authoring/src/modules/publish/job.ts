// B-29 · 批量发布 Job handler（无连坐 P0，50-step5-publish §2.3/§3/§5；§5.3「全部发布」candidate 编排）。
//   注册为 3A runner 的 publish_batch JobHandler。
//   编排：读批内全部 item → 逐项 try/catch 串子任务【复用 3D/3E 现成逻辑，不重写】：
//     · candidate 项（§5.3 一次性自动整理、批量发布）：create（3D create-capability 建 draft 版本）→ structure
//       （3D 结构化生成补齐 7 软字段、受保护落库）→ publish（3E 发布门 publishOne，各自一条 publications/tiers/outbox）。
//     · version 项（前端已结构化直接发）：直接走 publishing → publishOne。
//   无连坐铁律（决策⑤）：
//     · 每 item 独立 state 状态机 pending→structuring→publishing→published/failed；某 item failed【不停批、不连累其余】。
//     · 失败只落该 item 的人话 error（ErrorBody，非堆栈/非 code）+ missingFields（供「去补齐」回向导），不抛断批。
//     · 已 create 出的版本即使本次结构化/发布未成也【不丢】（已生成不丢）：item 回填 versionId，可单独重试 / 单条向导续补齐。
//     · 每 item 终态迁移 + batch 计数走【受保护合成单条 CTE】（模板 B，§5 Codex#5-r3 计数幂等化）：
//       防重 `state NOT IN(published,failed)` + 计数只按实际迁移行递增 → 重投/重试/双消费不重复递增（不漏不重）。
//   进度（永不裸转圈，硬规则①）：done = processedCount(=published+failed)，total = 批 total；
//     **即便有失败项，进度也照走到 total/100%，批次正常 completed**（禁用 published/total 作完成度，Codex#7）。
//     candidate 项有 structuring→publishing→published 可见态（每步经 ctx.appendItem 浮现），批进度按 item 粒度（诚实简化：
//     批内不发逐字段流式 SSE，那是单条向导 §4.C 的字段流）。
//   逐个浮现（§3 item-appended）：每项进 structuring/publishing/发布完/失败经 ctx.appendItem 浮现一条 PublishBatchItemView。
//   fence（§5/§11.A）：item 终态/中间态写入 + 结构化落库均经 item→batch→job（批 job）内联校验 fence；rowCount=0 = 已被接管，安全跳过本项。
import {
  ErrorCode,
  buildError,
  type ErrorBody,
  type CoverInput,
  type TierInput,
  type Visibility,
  type LlmGatewayPort,
} from '@cb/shared';
import type { JobContext, JobHandler, JobResult, LeasedJob, Queryable } from '../../platform/jobs/types.js';
import type { TxPool } from '../../platform/events/db-tx.js';
import { publishOne } from './publish-one.js';
import { PublishError } from './repo.js';
import {
  readBatchItems,
  readBatch,
  advanceBatchItemTx,
  backfillItemVersionInTx,
  finalizeBatchItemTx,
  type BatchItemRow,
  type BatchItemPublishInput,
} from './batch-repo.js';
import { toBatchItemView } from './batch-view.js';
import { structureCandidateItem } from './batch-structure.js';

/** subject_ref 形态（建批写入 jobs.subject_ref；本 handler 据 batchId 找批，items 真源在 publish_batch_items）。 */
export interface PublishBatchSubjectRef {
  kind?: 'publish_batch';
}

/** 抛带分类 code 的整体失败（罕见：批次级不可继续，如找不到批；runner 归一人话信封）。 */
function codedError(code: (typeof ErrorCode)[keyof typeof ErrorCode], message: string): Error {
  const e = new Error(message) as Error & { code: string };
  e.code = code;
  return e;
}

/** 批量发布 handler 依赖面（注入便于 mock；worker 入口用真实 infra 装配）。 */
export interface PublishBatchHandlerDeps {
  /** worker 写库（受保护 fence CTE：item 中间态/终态 + batch 计数 + candidate 结构化落库）的 PG 句柄（与 runner 同库）。 */
  db: Queryable;
  /** 发布门单事务 + 建体单事务用的 tx pool（asTxPool(db)，每 item 各走独立事务）。 */
  txPool: TxPool;
  /** 3A LLM 网关（candidate 项结构化补软字段；无 key → degraded 确定性兜底，不裸转圈）。 */
  gateway: LlmGatewayPort;
}

/** 批量发布 handler 工厂。 */
export function createPublishBatchHandler(deps: PublishBatchHandlerDeps): JobHandler {
  return {
    type: 'publish_batch',
    async run(job: LeasedJob, ctx: JobContext): Promise<JobResult> {
      return runPublishBatch(deps, job, ctx);
    },
  };
}

/**
 * 把单 item 发布失败的 PublishError(code) 映射为人话 ErrorBody（落 publish_batch_items.error，§2 错误口径，绝不裸露 code）。
 *   与单发布路由层错误用例表（§2.1 / §2.5）同口径：失败保留已生成、给明确退路（change_input/retry/...）。
 *   缺必填 / 候选未补齐 → missingFields + change_input（前端「去补齐」回结构化向导，决策⑤ / F-14）。
 */
function itemErrorBody(
  err: unknown,
  traceId: string,
): { body: ErrorBody; missingFields: string[] | null } {
  if (err instanceof PublishError) {
    switch (err.code) {
      case ErrorCode.PUBLISH_MISSING_FIELDS: {
        const missingFields =
          (err as PublishError & { missingFields?: string[] }).missingFields ?? [];
        return {
          body: buildError(ErrorCode.PUBLISH_MISSING_FIELDS, traceId, {
            userMessage: '这一项还差几个字段，去补齐后再发布。',
            action: 'change_input',
            ...(missingFields.length > 0 ? { details: { missingFields } } : {}),
          }).error,
          missingFields: missingFields.length > 0 ? missingFields : null,
        };
      }
      case ErrorCode.ALREADY_PUBLISHED:
        return {
          body: buildError(ErrorCode.ALREADY_PUBLISHED, traceId, {
            userMessage: '这个能力已发布过了，无需重复发布。',
            action: 'none',
          }).error,
          missingFields: null,
        };
      case ErrorCode.STATE_CONFLICT:
        return {
          body: buildError(ErrorCode.STATE_CONFLICT, traceId, {
            userMessage: '当前状态不支持发布，请基于被拒/旧版编辑生成新版本再发布。',
            action: 'change_input',
          }).error,
          missingFields: null,
        };
      case ErrorCode.NOT_FOUND:
        return {
          body: buildError(ErrorCode.NOT_FOUND, traceId, {
            userMessage: '没找到对应能力，可能已被删除。',
            action: 'change_input',
          }).error,
          missingFields: null,
        };
      case ErrorCode.FORBIDDEN:
        return {
          body: buildError(ErrorCode.FORBIDDEN, traceId, {
            userMessage: '你没有权限发布这个能力。',
            action: 'escalate',
          }).error,
          missingFields: null,
        };
      default:
        break;
    }
  }
  // 其它（DB 抖动等）→ 可重试人话（单 item 可单独重试，不连累其余，§2.5）。
  return {
    body: buildError(ErrorCode.INTERNAL, traceId, {
      userMessage: '这一项没发出去，稍后单独重试一下。',
      action: 'retry',
    }).error,
    missingFields: null,
  };
}

async function runPublishBatch(
  deps: PublishBatchHandlerDeps,
  job: LeasedJob,
  ctx: JobContext,
): Promise<JobResult> {
  const { db, txPool } = deps;

  // —— 找本 job 对应的批（publish_batches.job_id = 本 job）——
  const batch = await findBatchByJob(db, job.id);
  if (!batch) {
    // 批不存在 = 内部不一致（建批与建 job 同事务，理论不发生）→ 批次级失败（runner 归一人话）。
    throw codedError(ErrorCode.INTERNAL, 'publish_batch job has no batch row');
  }

  const items = await readBatchItems(db, batch.id);

  // 初始进度：done = 已终态项（恢复/续跑时非 0），total = 批 total（永不裸转圈，§3）。
  const total = batch.total;
  let processed = countTerminal(items);
  // candidate 项有「逐个整理」子任务（§5.3 一次性自动整理）；version 项只走「逐个发布」。两子任务都点亮（建批已写两条 pending）。
  if (items.some((i) => isCandidateOnly(i))) {
    await ctx.reportSubtask('structuring', 'running', '逐个整理');
  }
  await ctx.reportSubtask('publishing', 'running', '逐个发布');
  await reportBatchProgress(ctx, processed, total);

  for (const item of items) {
    // 取消/接管：在安全点停（已生成的 item 终态由各自模板 B 已落，保留；剩余项交新 attempt 续跑，硬规则③）。
    if (ctx.isCancelled()) break;
    // 已终态项（恢复/重投/重试已处理）跳过——不重复发布、不重复计数（无连坐 + 幂等）。
    if (item.state === 'published' || item.state === 'failed') continue;

    // —— 逐项 try/catch：某项失败【不抛断批】，落该 item error、其余继续（无连坐核心，决策⑤）——
    let finalized: { moved: boolean; batchCompleted: boolean } | null = null;
    try {
      finalized = await publishOneItem(deps, job, ctx, batch.ownerUserId, item, db, txPool);
    } catch (err) {
      // 兜底（理论上 publishOneItem 内已 try/catch 收口为 item error；此处防御不抛断批）。
      const { body, missingFields } = itemErrorBody(err, ctx.traceId);
      finalized = await finalizeBatchItemTx(db, {
        itemId: item.id,
        jobId: job.id,
        fenceToken: ctx.fenceToken,
        state: 'failed',
        error: body,
        missingFields,
        ...(item.versionId ? { versionId: item.versionId } : {}),
      });
      await appendItemFrame(ctx, { ...item, state: 'failed', error: body, missingFields });
    }

    // 进度推进：done = processedCount（=published+failed），有失败也照走到 total（Codex#7，永不裸转圈）。
    if (finalized?.moved) {
      processed += 1;
      await reportBatchProgress(ctx, processed, total);
    }
  }

  // 完成态：批次计数在模板 B 内随各 item 终态自洽（processed===total 即 completed，含部分 failed）。
  //   runner 负责受保护落 job completed（fence 守门）；本 handler 仅推进度，不自行 finalize job（无同事务 outbox 需求）。
  //   逐项的 notify.publish_completed / capability.published outbox 各由 item 自己的发布门事务同事务写（publish-one 内）。
  const finalBatch = await readBatch(db, batch.id);
  return {
    result: {
      batchId: batch.id,
      processedCount: finalBatch?.processedCount ?? processed,
      publishedCount: finalBatch?.publishedCount ?? 0,
      failedCount: finalBatch?.failedCount ?? 0,
    },
  };
}

/**
 * 处理单个 item（无连坐单元）。owner 取自批（建批已鉴权本人，item 血缘焊在批下）。
 *   ① 候选项（仅 candidateId、无 versionId）：§5.3 一次性自动整理、批量发布 —— 串 create→structure→publish 子任务
 *      （复用 3D create-capability + 3D 结构化生成 + 3E 发布门，不重写）。
 *        a) advance → structuring（模板 A，fence；0 行=被接管，安全退出本项）。
 *        b) structureCandidateItem：create 建 draft 版本 + structure 补齐 7 软字段（受保护落库经批 job fence）。回填 versionId。
 *        c) 整理就绪 → 续走版本发布（advance publishing → publishOne → 模板 B published）。
 *        d) 整理失败（无证据/字段两次仍失败/建体失败）→ 模板 B failed + 去补齐（已 create 版本不丢，回填 versionId）。
 *   ② 版本项（前端已结构化直接发）：advance → publishing → publishOne → 模板 B published。
 *   失败：捕获为该 item 人话 error，模板 B 终态 failed（不抛断批，不连坐其余，决策⑤）。返回模板 B 结果（moved/batchCompleted）。
 */
async function publishOneItem(
  deps: PublishBatchHandlerDeps,
  job: LeasedJob,
  ctx: JobContext,
  ownerUserId: string,
  item: BatchItemRow,
  db: Queryable,
  txPool: TxPool,
): Promise<{ moved: boolean; batchCompleted: boolean }> {
  const input: BatchItemPublishInput = item.input;

  let versionId = input.versionId ?? item.versionId ?? null;
  const candidateId = item.candidateId ?? input.candidateId ?? null;

  // ① 候选起源项（§5.3 一次性自动整理、批量发布）：只要本项【仍有 candidateId】就必须经 create→structure 编排，
  //    即使已有 versionId（早回填/上一轮 fencedOut 后留下的【未结构化版本】）——续结构化到 manifest ready 才发布。
  //
  //    P0-1 修（Codex r3）：旧逻辑 `if (!versionId)` 一旦 item 早回填过 versionId 就【跳过 structure 直发未结构化 draft】。
  //      早回填发生在 create 成功、structure 落库之前（已生成不丢，硬规则③）；若随后 fence/crash，下一轮 item 已带 versionId
  //      但 manifest 软字段仍空 → 旧逻辑直接 publishing → publishOne 拿空 name/tagline → 该 item【缺必填 failed】，
  //      违反「复用既有 versionId 继续结构化、不重复建版、已生成不丢」（候选本可结构化后正常发布，却被误判失败）。
  //    修法：判据从「无 versionId」改为「有 candidateId」（candidate 起源）。candidate-origin item 一律调
  //      structureCandidateItem({ existingVersionId })：有 versionId 则复用既有版本【续】结构化（跳过 create、不重复建版），
  //      无 versionId 则 create→structure；结构化 ready（manifest 软字段补齐落库）后才进发布门 publishOne。
  //    version 起源项（前端已结构化直接发，无 candidateId）维持原路径：直接 publishing → publishOne。
  if (candidateId) {
    // a) advance → structuring（模板 A，fence；0 行=被接管，安全退出本项）。
    const advancedToStructuring = await advanceBatchItemTx(db, {
      itemId: item.id,
      jobId: job.id,
      fenceToken: ctx.fenceToken,
      state: 'structuring',
    });
    if (!advancedToStructuring) return { moved: false, batchCompleted: false };
    await appendItemFrame(ctx, { ...item, state: 'structuring' });

    // b) create + structure（复用 3D；受保护落库经批 job fence）。
    //    原子回填（Codex r7 P1，方案 A）：create-capability 建版的 INSERT 与 item.version_id 受保护回填【合成同一事务】——
    //      onVersionCreatedInTx 在建版【同 tx】内 fence 校验 + 回填；命中 0 行（被接管/换 fence）→ 返回 false →
    //      create-capability 抛 fenced 信号回滚整事务（建版一并回滚、version 未提交）→ structureCandidateItem 走 fencedOut。
    //      如此「建版 + 回填」要么同 COMMIT、要么同 ROLLBACK，绝不出现「已提交 version 但 item 无指针」窗口（关掉 create 后回填前接管致重复建版）。
    //      接管后重试据 candidate 重新建（无残留半版，不重复建版）；建版同 COMMIT 后即可凭 item.version_id 复用续结构化。
    let backfilledVersionId: string | null = null;
    let backfilledCapabilityId: string | null = null;
    const outcome = await structureCandidateItem(deps, {
      candidateId,
      ownerUserId,
      jobId: job.id,
      fenceToken: ctx.fenceToken,
      traceId: ctx.traceId,
      // 复用既有版本【续】结构化（原子回填 / 重试 subject 携 versionId 都走这里）：跳过 create-capability、不重复建版（P0-1）。
      ...(versionId ? { existingVersionId: versionId } : {}),
      onVersionCreatedInTx: async (
        tx,
        { versionId: createdVersionId, capabilityId: createdCapabilityId },
      ) => {
        const ok = await backfillItemVersionInTx(tx, {
          itemId: item.id,
          jobId: job.id,
          fenceToken: ctx.fenceToken,
          versionId: createdVersionId,
          ...(createdCapabilityId ? { capabilityId: createdCapabilityId } : {}),
        });
        // 记下回填结果（成功才浮现帧；帧在事务 COMMIT 之后发，避免发未提交态）。
        if (ok) {
          backfilledVersionId = createdVersionId;
          backfilledCapabilityId = createdCapabilityId ?? null;
        }
        return ok;
      },
    });

    // 建版 + 回填同 COMMIT 后，浮现一帧：item 仍 structuring，但已带回填的 versionId（前端/恢复可见已建版本，永不裸转圈）。
    if (backfilledVersionId) {
      await appendItemFrame(ctx, {
        ...item,
        state: 'structuring',
        versionId: backfilledVersionId,
        ...(backfilledCapabilityId ? { capabilityId: backfilledCapabilityId } : {}),
      });
    }

    if (outcome.kind === 'fencedOut') {
      // 结构化落库被接管换 fence → 安全退出本项（已 create 的版本由后续 attempt/重试续补，已生成不丢）。
      return { moved: false, batchCompleted: false };
    }
    if (outcome.kind === 'failed') {
      // 整理失败：模板 B failed + 去补齐。已 create 的版本回填（不丢，可单独重试 / 单条续补）。
      const fin = await finalizeBatchItemTx(db, {
        itemId: item.id,
        jobId: job.id,
        fenceToken: ctx.fenceToken,
        state: 'failed',
        error: outcome.error,
        missingFields: outcome.missingFields,
        ...(outcome.versionId ? { versionId: outcome.versionId } : {}),
      });
      if (fin.moved) {
        await appendItemFrame(ctx, {
          ...item,
          state: 'failed',
          error: outcome.error,
          missingFields: outcome.missingFields,
          ...(outcome.versionId ? { versionId: outcome.versionId } : {}),
        });
      }
      return fin;
    }
    // c) 整理就绪：回填 versionId（manifest 软字段已补齐落库、结构化 ready），续走版本发布（下方 ② 路径）。
    versionId = outcome.versionId;
  }

  // 既无 candidateId 又无 versionId = 内部不一致（建批 refine 已挡，此处防御）→ 该 item failed（去上一步选）。
  if (!versionId) {
    const body = buildError(ErrorCode.VALIDATION_FAILED, ctx.traceId, {
      userMessage: '这一项缺少可发布的内容，回上一步重新选一下。',
      action: 'change_input',
    }).error;
    const res = await finalizeBatchItemTx(db, {
      itemId: item.id,
      jobId: job.id,
      fenceToken: ctx.fenceToken,
      state: 'failed',
      error: body,
      missingFields: null,
    });
    if (res.moved) await appendItemFrame(ctx, { ...item, state: 'failed', error: body });
    return res;
  }

  // ② 版本项（或 candidate 已整理就绪）：先进 publishing 中间态（模板 A，fence；0 行=已被 fence out→安全退出本项，不报错）。
  const advanced = await advanceBatchItemTx(db, {
    itemId: item.id,
    jobId: job.id,
    fenceToken: ctx.fenceToken,
    state: 'publishing',
    versionId,
  });
  if (!advanced) {
    // 已被接管 / 已终态：不处理本项（剩余由新 attempt 续跑；已生成不丢）。
    return { moved: false, batchCompleted: false };
  }

  // 逐项发布门事务（复用 publish-one：各自一条 publications/tiers/outbox 双事件，互不串，§2.3）。
  try {
    const cover: CoverInput = input.cover ?? { source: 'glyph' }; // 缺省字形图标（§2.3）。
    // 「全部发布」缺价默认免费档（开工总纲 §5.3：一次性自动整理、批量发布，跳过逐个调价，价格用默认）：
    //   前端 BatchPublish 只提交 candidateId+visibility，不携 tiers；缺/空 tiers 统一补 {standard, 0} 默认免费档，
    //   保证候选 happy path（create→structure→publish）在默认档下走通（manifest-hash 价格门接受 ≥1 档即过），
    //   绝不因缺价让全部发布候选全失败（Codex r2 P0-3）。创作者可后续单条改价（前端可显「默认免费/可后续改价」）。
    //   retry/fixup 复跑同 worker，缺价仍走本默认（覆盖价格，重试不再缺价失败）。
    const tiers: TierInput[] = defaultFreeTier(input.tiers);
    const visibility: Visibility = input.visibility ?? 'public'; // 缺省 public（§2.3）。
    const result = await publishOne(db, txPool, {
      versionId,
      ownerUserId,
      cover,
      tiers,
      visibility,
      traceId: ctx.traceId,
    });
    // 终态 published + 计数（模板 B，幂等）。
    const fin = await finalizeBatchItemTx(db, {
      itemId: item.id,
      jobId: job.id,
      fenceToken: ctx.fenceToken,
      state: 'published',
      error: null,
      versionId: result.versionId,
      capabilityId: result.capabilityId,
    });
    if (fin.moved) {
      await appendItemFrame(ctx, {
        ...item,
        state: 'published',
        versionId: result.versionId,
        capabilityId: result.capabilityId,
        error: null,
      });
    }
    return fin;
  } catch (err) {
    // 重跑识别已发布产物（Codex#6）：单 item 发布门事务与 item 终态计数分两笔；发布门已 COMMIT（版本已 published）
    //   但 fence 丢失/进程崩在 finalize 之前 → 重跑再发同版命中 ALREADY_PUBLISHED。此版【确已由本批发布】，
    //   绝不当失败标 failed（违「已生成不丢」），而是终态 published（模板 B 防重确保不双计）。
    if (err instanceof PublishError && err.code === ErrorCode.ALREADY_PUBLISHED) {
      const fin = await finalizeBatchItemTx(db, {
        itemId: item.id,
        jobId: job.id,
        fenceToken: ctx.fenceToken,
        state: 'published',
        error: null,
        versionId,
        ...(item.capabilityId ? { capabilityId: item.capabilityId } : {}),
      });
      if (fin.moved) {
        await appendItemFrame(ctx, {
          ...item,
          state: 'published',
          versionId,
          error: null,
        });
      }
      return fin;
    }
    // 其余失败只标该 item（人话 error + 去补齐），不连累其余、不抛断批（决策⑤）。
    const { body, missingFields } = itemErrorBody(err, ctx.traceId);
    const fin = await finalizeBatchItemTx(db, {
      itemId: item.id,
      jobId: job.id,
      fenceToken: ctx.fenceToken,
      state: 'failed',
      error: body,
      missingFields,
      versionId,
    });
    if (fin.moved) {
      await appendItemFrame(ctx, {
        ...item,
        state: 'failed',
        versionId,
        error: body,
        missingFields,
      });
    }
    return fin;
  }
}

/** 读本 job 对应的批（publish_batches.job_id = jobId）。不存在 → null。 */
async function findBatchByJob(
  db: Queryable,
  jobId: string,
): Promise<{ id: string; ownerUserId: string; total: number; processedCount: number } | null> {
  const res = await db.query<{
    id: string;
    owner_user_id: string;
    total: number | string;
    processed_count: number | string;
  }>(`SELECT id, owner_user_id, total, processed_count FROM publish_batches WHERE job_id = $1`, [
    jobId,
  ]);
  const r = res.rows[0];
  if (!r) return null;
  return {
    id: r.id,
    ownerUserId: r.owner_user_id,
    total: Number(r.total),
    processedCount: Number(r.processed_count),
  };
}

function countTerminal(items: BatchItemRow[]): number {
  return items.filter((i) => i.state === 'published' || i.state === 'failed').length;
}

/**
 * 「全部发布」缺价默认免费档（§5.3 价格用默认）。缺 / 空 tiers → [{standard, 0}]（免费），否则原样透传。
 *   保证批量发布候选不因缺价被 manifest-hash 价格门判缺 price 而全失败（Codex r2 P0-3）；单条向导仍可逐个设价。
 */
function defaultFreeTier(tiers: TierInput[] | undefined): TierInput[] {
  return tiers && tiers.length > 0 ? tiers : [{ tierCode: 'standard', priceMicros: 0 }];
}

/** candidate 起的项（无 versionId，需批内 create→structure 整理；§5.3 一次性自动整理）。 */
function isCandidateOnly(item: BatchItemRow): boolean {
  return !(item.input.versionId ?? item.versionId);
}

/** 推批次总进度（done=processed=published+failed，total=批 total；有失败也照走到 100%，Codex#7/§3）。 */
async function reportBatchProgress(
  ctx: JobContext,
  processed: number,
  total: number,
): Promise<void> {
  const percent = total > 0 ? Math.round((processed / total) * 100) : 100;
  await ctx.reportProgress({
    percent,
    phrase: `已处理 ${processed} / ${total} 个能力`,
    done: processed,
    total,
    unit: '个能力',
  });
}

/** 逐个浮现一条 item（§3 item-appended：state=published/failed + error?，无连坐失败只标该项）。 */
async function appendItemFrame(ctx: JobContext, item: BatchItemRow): Promise<void> {
  await ctx.appendItem(toBatchItemView(item));
}

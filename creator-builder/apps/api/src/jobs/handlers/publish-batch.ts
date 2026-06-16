// B-29 · 批量发布 Job handler（无连坐 P0，50-step5-publish §2.3/§3/§5）。注册为 3A runner 的 publish_batch JobHandler。
//   编排：读批内全部 item → 逐项 try/catch 跑「发布门事务」（复用 publish-one，每 item 各自一条 publications/tiers/outbox，互不串）。
//   无连坐铁律（决策⑤）：
//     · 每 item 独立 state 状态机 pending→publishing→published/failed；某 item failed【不停批、不连累其余】（worker 逐项 try/catch）。
//     · 失败只落该 item 的人话 error（ErrorBody，非堆栈/非 code）+ missingFields（供「去补齐」回向导），不抛断批。
//     · 每 item 终态迁移 + batch 计数走【受保护合成单条 CTE】（模板 B，§5 Codex#5-r3 计数幂等化）：
//       防重 `state NOT IN(published,failed)` + 计数只按实际迁移行递增 → 重投/重试/双消费不重复递增（不漏不重）。
//   进度（永不裸转圈，硬规则①）：done = processedCount(=published+failed)，total = 批 total；
//     **即便有失败项，进度也照走到 total/100%，批次正常 completed**（禁用 published/total 作完成度，Codex#7）。
//   逐个浮现（§3 item-appended）：每项发布完/失败经 ctx.appendItem 浮现一条 PublishBatchItemView（state + error?），失败只标该项。
//   fence（§5/§11.A）：item 终态/中间态写入经 item→batch→job 内联校验 fence；rowCount=0 = 已被接管，安全跳过本项（不报错）。
//   候选项（仅 candidateId、未结构化）本期诚实推迟：标 failed + missingFields「去补齐」回向导（不裸转圈、不假成功）。
import {
  ErrorCode,
  buildError,
  type ErrorBody,
  type CoverInput,
  type TierInput,
  type Visibility,
} from '@cb/shared';
import type { JobContext, JobHandler, JobResult, LeasedJob, Queryable } from '../types.js';
import type { TxPool } from '../../events/db-tx.js';
import { publishOne } from '../../publish/publish-one.js';
import { PublishError } from '../../publish/publish-repo.js';
import {
  readBatchItems,
  readBatch,
  advanceBatchItemTx,
  finalizeBatchItemTx,
  type BatchItemRow,
  type BatchItemPublishInput,
} from '../../publish/batch-repo.js';
import { toBatchItemView } from '../../publish/batch-view.js';

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
  /** worker 写库（受保护 fence CTE：item 中间态/终态 + batch 计数）的 PG 句柄（与 runner 同库）。 */
  db: Queryable;
  /** 发布门单事务用的 tx pool（asTxPool(db)，每 item 各走一条独立发布门事务）。 */
  txPool: TxPool;
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

/** 候选项（仅 candidateId、未结构化）本期诚实推迟的人话错误（去补齐回向导，不裸转圈/不假成功）。 */
function candidateNotReadyError(traceId: string): ErrorBody {
  return buildError(ErrorCode.PUBLISH_MISSING_FIELDS, traceId, {
    userMessage: '这一项还没整理成能力，去结构化向导补齐后再发布。',
    action: 'change_input',
  }).error;
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
 * 发布单个 item（无连坐单元）。owner 取自批（建批已鉴权本人，item 血缘焊在批下）。
 *   ① 候选项（仅 candidateId、无 versionId）：本期诚实推迟结构化 → 终态 failed + 「去补齐」（不裸转圈/不假成功）。
 *   ② 版本项：advance → publishing（模板 A，fence；0 行=已被接管，安全退出本项）→ publish-one（独立发布门事务）→ 模板 B 终态 published。
 *   失败：捕获为该 item 人话 error，模板 B 终态 failed（不抛断批）。返回模板 B 结果（moved/batchCompleted）。
 */
async function publishOneItem(
  _deps: PublishBatchHandlerDeps,
  job: LeasedJob,
  ctx: JobContext,
  ownerUserId: string,
  item: BatchItemRow,
  db: Queryable,
  txPool: TxPool,
): Promise<{ moved: boolean; batchCompleted: boolean }> {
  const input: BatchItemPublishInput = item.input;

  // ① 候选项（未结构化、无 versionId）：诚实推迟（结构化批内编排留后续；本期标 failed + 去补齐回向导）。
  if (!input.versionId && !item.versionId) {
    const body = candidateNotReadyError(ctx.traceId);
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

  const versionId = (input.versionId ?? item.versionId)!;

  // ② 版本项：先进 publishing 中间态（模板 A，fence；0 行=已被 fence out→安全退出本项，不报错）。
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
    const tiers: TierInput[] = input.tiers ?? []; // 缺价由 publish-one 必填校验挡（→ item failed 去补齐）。
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

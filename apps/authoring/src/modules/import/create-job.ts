// B-19/B-20 · 导入 Job 创建（manifest 兑换 + 建 jobs(type=import) 行 + BullMQ 入队）。
//   两条上传路径殊途同归到此口径：直传路径（POST /import/jobs，本文件）与本机助手路径（pairings-repo.ts）。
//   - 建 jobs 行：status='queued'、subject_ref 记上传引用（uploadId/source/rawS3Keys，worker 据此从 S3 拉原文）。
//     progress 初始化为五项子任务全 pending（永不裸转圈：连接即有清单可点亮，导入-08）。
//   - 入队：fence_token 初值 1（>0 表「需入队」；领租约时 DB 换发执行 fence，脊柱 §6.2）。
//   原子 + 可恢复（Codex P1-r5，取代旧的「删 job + 503」）：
//     ① 原子：consume(置 consumed_at) + job INSERT + 回写 job_id 放【同一 PG 事务】，要么都成、要么都不成
//        （consumeManifestAndInsertJob 的单条 CTE，与助手路径 createImportJobForPairing 同口径）。
//     ② enqueue 失败保留 queued 交 sweeper：不删/不标 failed 刚建的 queued job——留在 queued，由
//        staleQueued sweeper 按既有 fence 补投（sweeper-reconcile.ts）。返回完整 JobView（queued + 5 子任务 pending），
//        不是 503、不是假转圈（sweeper 保证最终被取走、有进度态）。
//     ③ 幂等可恢复：同一 uploadId 在 manifest 已 consumed 且 job_id 已回写时，恢复返回已存在 job 的 JobView
//        （非 404、不重复建 job）。
//   - 幂等第一道闸：Idempotency-Key（preHandler）；第二道：consumed_at 一次性兑换（同 uploadId 不重复建）。
import { SUBTASK_SEQUENCES, type ImportSource, type JobView, type ProgressView } from '@cb/shared';
import type { QueuePort } from '@cb/shared';
import { withTransaction, type TxPool } from '../../platform/events/db-tx.js';
import type { Queryable } from '../../platform/jobs/types.js';
import {
  consumeManifestAndInsertJob,
  readJobViewForRecovery,
  readUploadManifest,
} from './upload-manifest-repo.js';

/** import job 的 subject_ref（worker 据此从 S3 拉原文；§6 血缘）。 */
export interface ImportSubjectRef {
  uploadId: string;
  source: ImportSource;
  /** 原文对象 key（直传路径来自 presign 的 s3Key 集；助手路径来自转存 key）。worker 逐个 getObject。 */
  rawS3Keys: string[];
  /** 续传草稿挂接（脊柱 §8，可空）。 */
  draftId?: string;
  /**
   * 打包模式（命令行助手路径恒为 'gzip'；直传路径不设）。
   *   'gzip'：每个 rawS3Key 是一个【gzip 压缩】的「打包分片」——解压后含多个整文件、以 BUNDLE_SENTINEL 行分隔；
   *   worker 用 getObject(字节) → gunzip → splitBundlePart 拆回每个文件再逐个当一会话解析（session-parse.ts）。
   *   不设：每个 rawS3Key 就是一个会话文件原文（直传路径口径，getObjectText 直读）。
   */
  bundle?: 'gzip';
}

/** 初始 progress：五项子任务全 pending + 0%（永不裸转圈，导入-08）。 */
export function initialImportProgress(): ProgressView {
  return {
    percent: 0,
    phrase: '正在准备导入…',
    subtasks: SUBTASK_SEQUENCES.import.map((s) => ({ ...s, status: 'pending' as const })),
    items: [],
  };
}

/** 兑换建 job 入参（直传路径，manifest 完整性闸已在 handler 通过）。 */
export interface CreateImportJobArgs {
  ownerUserId: string;
  uploadId: string;
  source: ImportSource;
  /** manifest gate 算出的有序 rawS3Keys（worker 逐个拉原文）。 */
  rawS3Keys: string[];
  draftId?: string;
  traceId?: string;
}

/**
 * 直传路径建 job 结果（Codex P1-r5）。判别联合：
 *   - 'created'：本次原子兑换成功并建 job（不论 enqueue 是否成功——失败留 queued 交 sweeper，enqueued 标记观测用）。
 *   - 'recovered'：manifest 已被兑换、按回写的 job_id 恢复了已存在 job 的真实状态/进度（非 404、不重复建）。
 *   - 'gone'：manifest 已被兑换但 job 行已不存在（极端，理论 FK 阻止）→ handler 退回 404 引导重发。
 *   - 'not_consumed'：兑换 0 行且 manifest 未 consumed（并发竞态 TOCTOU：另一请求刚兑换走）→ handler 重读恢复。
 */
export type CreateImportJobResult =
  | { kind: 'created'; view: JobView; enqueued: boolean }
  | { kind: 'recovered'; view: JobView }
  | { kind: 'gone' }
  | { kind: 'not_consumed' };

/** 据已建/已恢复 job 字段组完整 JobView（queued/真实状态 + 五项子任务进度 + attemptNo/createdAt）。 */
function toJobView(fields: {
  id: string;
  status: JobView['status'];
  progress: ProgressView;
  attemptNo: number;
  createdAt: string;
}): JobView {
  return {
    id: fields.id,
    type: 'import',
    status: fields.status,
    progress: fields.progress,
    attemptNo: fields.attemptNo,
    createdAt: fields.createdAt,
  };
}

/**
 * 直传路径：原子兑换 manifest + 建 import job + 入队（Codex P1-r5，取代旧「删 job + 503」）。
 *
 *   1. 同一 PG 事务内（withTransaction）调 consumeManifestAndInsertJob：consume + INSERT job + 回写 job_id
 *      要么都提交、要么都回滚。txPool 即 asTxPool(infra.db)（同一连接 = 同一事务）。
 *   2. 兑换成功（首建）→ enqueue：
 *        · 成功 → 返回 created（enqueued:true），秒回完整 JobView（queued + 5 子任务 pending），前端立即订阅 SSE。
 *        · 失败 → **不删/不标 failed**，job 留在 queued，由 staleQueued sweeper 按既有 fence 补投；
 *          仍返回 created（enqueued:false）的完整 JobView——sweeper 保证最终被取走、有进度态，不裸转圈。
 *   3. 兑换 0 行（manifest 已 consumed / 不存在 / 并发竞态）→ 重读 manifest：
 *        · consumed 且 job_id 已回写 → 据 job_id 恢复读出已存在 job 的 JobView，返回 recovered（幂等可恢复，非 404）。
 *        · consumed 但 job 行已没（极端）→ gone（handler 退 404）。
 *        · 未 consumed（TOCTOU：另一请求正在兑换、本事务读到其提交前快照）→ not_consumed（handler 短重读恢复）。
 */
export async function createImportJobFromManifest(
  txPool: TxPool,
  readDb: Queryable,
  queue: Pick<QueuePort, 'enqueue'>,
  args: CreateImportJobArgs,
): Promise<CreateImportJobResult> {
  const initialProgressJson = JSON.stringify(initialImportProgress());

  // 1. 原子兑换 + 建 job + 回写 job_id（同一事务，要么都成、要么都不成）。
  const inserted = await withTransaction(txPool, (tx) =>
    consumeManifestAndInsertJob(tx, {
      ownerUserId: args.ownerUserId,
      uploadId: args.uploadId,
      rawS3Keys: args.rawS3Keys,
      source: args.source,
      ...(args.draftId ? { draftId: args.draftId } : {}),
      initialProgressJson,
    }),
  );

  // 2. 首建成功：入队（失败不回滚、留 queued 交 sweeper 补投）。
  if (inserted) {
    let enqueued = true;
    try {
      await queue.enqueue('import', inserted.jobId as never, inserted.fenceToken, args.traceId);
    } catch {
      // 入队失败：job 已原子建成 queued（manifest 同事务已 consumed），**不删/不标 failed**——
      //   留在 queued 由 staleQueued sweeper 按既有 fence 补投（sweeper-reconcile.ts）。
      //   返回真实 queued JobView（非 503、非假转圈：sweeper 保证最终取走、有进度态）。
      enqueued = false;
    }
    const view = toJobView({
      id: inserted.jobId,
      status: 'queued',
      progress: initialImportProgress(),
      attemptNo: inserted.attemptNo,
      createdAt: inserted.createdAt,
    });
    return { kind: 'created', view, enqueued };
  }

  // 3. 兑换 0 行：重读 manifest 恢复已存在 job 或退回。
  const after = await readUploadManifest(readDb, args.ownerUserId, args.uploadId);
  if (after && after.consumedAt && after.jobId) {
    const rec = await readJobViewForRecovery(readDb, args.ownerUserId, after.jobId);
    if (!rec) return { kind: 'gone' }; // job 行已没（极端）→ handler 退 404。
    return {
      kind: 'recovered',
      view: toJobView({
        id: rec.jobId,
        status: rec.status,
        progress: rec.progress,
        attemptNo: rec.attemptNo,
        createdAt: rec.createdAt,
      }),
    };
  }
  // consumed 但 job_id 未回写（不变式下不应出现）→ 当 gone 处理；未 consumed（TOCTOU）→ not_consumed。
  if (after?.consumedAt) return { kind: 'gone' };
  return { kind: 'not_consumed' };
}

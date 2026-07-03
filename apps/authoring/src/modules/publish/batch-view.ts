// 50 · 批量发布视图投影（B-29，50-step5-publish §2.3/§2.4/§6）。纯函数：行 → 对外 PublishBatchView / PublishBatchItemView。
//   完成度三元（Codex#7）：processedCount = publishedCount + failedCount（进度分子、完成判定）；
//     status 由 publish_batches.status 镜像（processed===total 即 completed，含部分 failed 也照常完成、永不裸转圈）。
//   item.error 是人话 ErrorBody（非堆栈/非 code，§2 错误信封口径）；missingFields 供「去补齐」回向导（决策⑤）。
import type { PublishBatchView, PublishBatchItemView } from '@cb/shared';
import type { BatchRow, BatchItemRow } from './batch-repo.js';

/** item 行 → 对外视图（可空字段按存在性收敛，不漏发 undefined 键）。 */
export function toBatchItemView(it: BatchItemRow): PublishBatchItemView {
  return {
    itemId: it.id,
    ...(it.candidateId ? { candidateId: it.candidateId } : {}),
    ...(it.versionId ? { versionId: it.versionId } : {}),
    ...(it.capabilityId ? { capabilityId: it.capabilityId } : {}),
    state: it.state as PublishBatchItemView['state'],
    ...(it.missingFields && it.missingFields.length > 0 ? { missingFields: it.missingFields } : {}),
    ...(it.error ? { error: it.error } : {}),
  };
}

/** 批 + items → 对外 PublishBatchView（§2.3/§2.4 响应 + SSE state_snapshot 摘要源）。 */
export function toBatchView(batch: BatchRow, items: BatchItemRow[]): PublishBatchView {
  return {
    batchId: batch.id,
    jobId: batch.jobId,
    status: batch.status,
    total: batch.total,
    processedCount: batch.processedCount,
    publishedCount: batch.publishedCount,
    failedCount: batch.failedCount,
    items: items.map(toBatchItemView),
  };
}

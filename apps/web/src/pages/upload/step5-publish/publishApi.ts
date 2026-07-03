// STEP⑤ 发布数据层（F-14）——接 50 域端点（单发布 + 市集卡预览 + 批量 + 单项重试）。
//
// 端点真源（50 §2）：
//   - §2.1 `POST /versions/{versionId}/publish`（scope=publish.version）：单条发布门事务，同步返回 PublishResult。
//   - §2.2 `POST /versions/{versionId}/market-card/preview`：市集卡预览（只读、不写库、无 Idempotency-Key，§4.1 豁免）。
//   - §2.3 `POST /publish-batches`（scope=publish_batch.create；每 item 另带独立 key scope=publish_batch.item）：批量发布，202 受理，SSE 走 job 流。
//   - §2.4 `GET /publish-batches/{batchId}`：查批次全量（SSE state_snapshot 互补，刷新/重进恢复）。
//   - §2.5 `POST /publish-batches/{batchId}/items/{itemId}/retry`（scope=publish_batch.item.retry）：单 item 重试（无连坐）。
//   - §2.6.2 `GET /publications/{capabilityId}`：查发布态（创作者只读，拒绝提示 + 重试/编辑入口）。
//
// 合规：写命令必带 Idempotency-Key（client 注入）+ scope；预览是只读 POST（apiPostReadonly，无 scope）。
import {
  IdempotencyScope,
  type PublishResult,
  type PublishVersionBody,
  type MarketCard,
  type MarketCardPreviewBody,
  type PublishBatchView,
  type CreatePublishBatchBody,
  type PublishBatchItemView,
  type RetryBatchItemBody,
  type PublicationView,
} from '@cb/shared';
import {
  apiGetEnvelope,
  apiPost,
  apiPostReadonly,
  type RequestOptions,
} from '../../../api/index.js';

/** §2.1 单发布路径。 */
export function publishPath(versionId: string): string {
  return `/versions/${encodeURIComponent(versionId)}/publish`;
}

/** §2.2 市集卡预览路径。 */
export function previewPath(versionId: string): string {
  return `/versions/${encodeURIComponent(versionId)}/market-card/preview`;
}

/** §2.5 单项重试路径。 */
export function retryItemPath(batchId: string, itemId: string): string {
  return `/publish-batches/${encodeURIComponent(batchId)}/items/${encodeURIComponent(itemId)}/retry`;
}

/**
 * §2.1 单条发布（发布门事务，同步返回；发布即「Alpha·审核中」）。
 * 写命令必带 scope=publish.version；重复点/刷新/双标签页回放首次（同 idempotencyKey，发布-20/贯穿-13/27）。
 * 失败保留已编辑封面/价格/软字段（前端态不清空）；点重试用同 key 重发原 body（§2.1 注）。
 */
export async function publishVersion(
  versionId: string,
  body: PublishVersionBody,
  idempotencyKey?: string,
  opts: RequestOptions = {},
): Promise<PublishResult> {
  return apiPost<PublishResult>(publishPath(versionId), body, {
    ...opts,
    scope: IdempotencyScope.PUBLISH_VERSION,
    ...(idempotencyKey ? { idempotencyKey } : {}),
  });
}

/**
 * §2.2 市集卡预览（只读 POST：带未持久化封面/价格预览入参，不写库、无 Idempotency-Key，§4.1 豁免）。
 * 封面/价格切换不丢由前端态承载（发布-10），本端点纯渲染投影。
 * 占位语义：卡上 installs/rating 恒为 null（发布-07），由 UI 经 UsagePlaceholder 兜底「上线后填充」文案，
 * 不依赖 meta.placeholders（apiPostReadonly 只解包 data；UsagePlaceholder 无 meta 时退化为默认占位句）。
 */
export async function previewMarketCard(
  versionId: string,
  body: MarketCardPreviewBody,
  opts: RequestOptions = {},
): Promise<MarketCard> {
  return apiPostReadonly<MarketCard>(previewPath(versionId), body, opts);
}

/**
 * §2.3 创建批量发布（无连坐 P0，202 受理）。批次级 scope=publish_batch.create；
 * 每 item 在 body 内带独立 idempotencyKey（scope=publish_batch.item，无连坐核心；调用层为每 item 生成）。
 * 返回 PublishBatchView（batchId/jobId/items），SSE 走 job 流（GET /jobs/{jobId}/events）。
 */
export async function createPublishBatch(
  body: CreatePublishBatchBody,
  idempotencyKey?: string,
  opts: RequestOptions = {},
): Promise<PublishBatchView> {
  return apiPost<PublishBatchView>('/publish-batches', body, {
    ...opts,
    scope: IdempotencyScope.PUBLISH_BATCH_CREATE,
    ...(idempotencyKey ? { idempotencyKey } : {}),
  });
}

/** §2.4 查批次全量（SSE state_snapshot 互补；刷新/重进恢复，硬规则③）。 */
export async function fetchPublishBatch(
  batchId: string,
  opts: RequestOptions = {},
): Promise<PublishBatchView> {
  const { data } = await apiGetEnvelope<PublishBatchView>(
    `/publish-batches/${encodeURIComponent(batchId)}`,
    opts,
  );
  return data;
}

/**
 * §2.5 单 item 重试（仅 failed 项；换该 item fence、不连累其余、不重建批次，选择结构化-29）。
 * 写命令必带 scope=publish_batch.item.retry；可携新封面/价格（补齐后重试）。回该 item 回到 pending/structuring。
 */
export async function retryBatchItem(
  batchId: string,
  itemId: string,
  body: RetryBatchItemBody = {},
  idempotencyKey?: string,
  opts: RequestOptions = {},
): Promise<PublishBatchItemView> {
  return apiPost<PublishBatchItemView>(retryItemPath(batchId, itemId), body, {
    ...opts,
    scope: IdempotencyScope.PUBLISH_BATCH_ITEM_RETRY,
    ...(idempotencyKey ? { idempotencyKey } : {}),
  });
}

/**
 * §2.6.2 查发布态（创作者只读）：reviewStatus / rejectReason / rejectedVersionId（拒绝提示 + 重试/编辑入口，发布-31）。
 * reviewStatus='review_rejected' 时前端「编辑重发」指向 40 端点 A 带 fromVersionId=rejectedVersionId（派生新 draft）。
 */
export async function fetchPublication(
  capabilityId: string,
  opts: RequestOptions = {},
): Promise<PublicationView> {
  const { data } = await apiGetEnvelope<PublicationView>(
    `/publications/${encodeURIComponent(capabilityId)}`,
    opts,
  );
  return data;
}

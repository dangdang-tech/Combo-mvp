// Idempotency scope 常量表（脊柱 §4 / §2.10）。
// 所有写命令（POST/PATCH/DELETE）必带 Idempotency-Key + 固定 scope；(scope,key) 唯一。
// DELETE 不因天然幂等而豁免。下表与 _index.md §2.10「写端点 × scope 总表」一一对应
// （草稿 bootstrap `draft.create` 为本期新增，§2.10 文档行随后补；22 → 23）。

/** 写端点固定 scope（端点逻辑名）。值即落 idempotency_keys.scope。 */
export const IdempotencyScope = {
  // —— 草稿 00（脊柱 §8：草稿 bootstrap，五步可续传基线）——
  DRAFT_CREATE: 'draft.create',
  // —— 导入 20 ——
  IMPORT_CREATE: 'import.create',
  IMPORT_CONNECT_PAIR: 'import.connect.pair',
  IMPORT_CONNECT_UPLOAD: 'import.connect.upload',
  // —— 脊柱 00 / 导入 20 ——
  JOB_CANCEL: 'job.cancel',
  // —— 提取 30 ——
  EXTRACT_CREATE: 'extract.create',
  CANDIDATE_RETRY: 'candidate.retry',
  // —— 结构化 40 ——
  DRAFT_SELECTION_PATCH: 'draft.selection.patch',
  CAPABILITY_CREATE: 'capability.create',
  STRUCTURE_START: 'structure.start',
  MANIFEST_PATCH: 'manifest.patch',
  MANIFEST_REGENERATE_FIELD: 'manifest.regenerate_field',
  // —— 发布 50 ——
  PUBLISH_VERSION: 'publish.version',
  PUBLISH_BATCH_CREATE: 'publish_batch.create',
  PUBLISH_BATCH_ITEM: 'publish_batch.item',
  PUBLISH_BATCH_ITEM_RETRY: 'publish_batch.item.retry',
  PUBLISH_REVIEW: 'publish.review',
  // —— 社交 60（§11.F：POST/DELETE 都带 key）——
  SOCIAL_FOLLOW: 'social.follow',
  SOCIAL_UNFOLLOW: 'social.unfollow',
  SOCIAL_LIKE: 'social.like',
  SOCIAL_UNLIKE: 'social.unlike',
  // —— 通知 70 ——
  NOTIFICATION_READ: 'notification.read',
  NOTIFICATION_READ_ALL: 'notification.read_all',
} as const;

export type IdempotencyScopeValue = (typeof IdempotencyScope)[keyof typeof IdempotencyScope];

/**
 * 「带请求体只读」POST 的可选 scope（脊柱 §4.1 豁免：不写库、只签 URL / 只算预览，非写命令、key 可选）。
 */
export const IdempotencyOptionalScope = {
  IMPORT_PRESIGN: 'import.presign',
  MARKET_CARD_PREVIEW: 'market-card.preview',
} as const;
export type IdempotencyOptionalScopeValue =
  (typeof IdempotencyOptionalScope)[keyof typeof IdempotencyOptionalScope];

/** 全部必带 scope 列表（23 项，供守门核验「无写端点遗漏 scope」；含草稿 bootstrap draft.create）。 */
export const REQUIRED_IDEMPOTENCY_SCOPES: IdempotencyScopeValue[] = Object.values(IdempotencyScope);

/** idempotency_keys.status（脊柱 §4 行为矩阵）。 */
export const IdempotencyStatus = {
  LOCKED: 'locked',
  COMPLETED: 'completed',
  FAILED: 'failed',
} as const;
export type IdempotencyStatusValue = (typeof IdempotencyStatus)[keyof typeof IdempotencyStatus];

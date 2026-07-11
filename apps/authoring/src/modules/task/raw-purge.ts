// 原始上传对象的统一清理入口。
// 成功流水线与过期上传对账必须复用同一删除策略：逐键幂等删除，全部成功后调用方才能落
// raw_purged_at；任一键失败就保留数据库追踪状态，下一轮从头重试（S3 DeleteObject 幂等）。
import type { ObjectStorePort } from '@cb/shared';

/** 上传原始件所在桶（处理完或上传过期后即清，不落正式盘）。 */
export const RAW_BUCKET = 'combo-raw' as const;

/** 去重后逐键删除；不吞异常，由调用方决定是否打 raw_purged_at。 */
export async function purgeRawObjects(
  objectStore: ObjectStorePort,
  keys: Iterable<string>,
): Promise<void> {
  for (const key of new Set(keys)) {
    await objectStore.delete(RAW_BUCKET, key);
  }
}

// B-05 · ObjectStore 端口（70 §8.2）。MinIO/S3 四桶。domain 声明，infra/s3 实现。
import type { IsoDateTime } from '../core/ids.js';

/** 四桶（70 §8.2）。原文不落正式盘——导入处理完即弃（技术方案 1.2）。 */
export type Bucket = 'agora-raw' | 'agora-artifacts' | 'agora-exports' | 'agora-experience';

export const BUCKETS: readonly Bucket[] = [
  'agora-raw',
  'agora-artifacts',
  'agora-exports',
  'agora-experience',
];

export interface ObjectStorePort {
  /** 预签名直传（PG 只存 key，前端直传 S3）。 */
  presignPut(
    bucket: Bucket,
    key: string,
    opts?: { contentType?: string; expiresSec?: number },
  ): Promise<{ url: string; key: string }>;
  presignGet(bucket: Bucket, key: string, opts?: { expiresSec?: number }): Promise<{ url: string }>;
  /** worker 拉原文（导入 B-19）。 */
  getObject(bucket: Bucket, key: string): Promise<ReadableStream>;
  /**
   * 直写对象（本机助手 multipart 直传落加密临时桶，B-21 §3.3）。
   * 助手把原文经 api 转存到 agora-raw 桶（前端直传走 presignPut；助手没有预签名 URL，经 api 中转写桶）。
   */
  putObject(
    bucket: Bucket,
    key: string,
    body: Uint8Array,
    opts?: { contentType?: string },
  ): Promise<{ key: string }>;
  /** sweeper orphan 清理（B-16 §6.4）：列举 + 删除（删前比对 PG 引用）。 */
  list(
    bucket: Bucket,
    prefix: string,
  ): Promise<Array<{ key: string; size: number; lastModified: IsoDateTime }>>;
  delete(bucket: Bucket, key: string): Promise<void>;
  head(bucket: Bucket, key: string): Promise<{ size: number; lastModified: IsoDateTime } | null>;
}

/** ObjectStore env 名（70 §8.2）。 */
export const OBJECT_STORE_ENV = {
  endpoint: 'S3_ENDPOINT',
  accessKey: 'S3_ACCESS_KEY',
  secretKey: 'S3_SECRET_KEY',
  region: 'S3_REGION',
} as const;

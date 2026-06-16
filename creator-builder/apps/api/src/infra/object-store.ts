// B-05 · ObjectStore 实现（S3/MinIO，实现 shared ObjectStorePort）。四桶（脊柱 70 §8.2）。
//   - presignPut/presignGet：前端直传，PG 只存 key（原文不落正式盘，技术方案 1.2）。
//   - list/delete/head：sweeper orphan 清理（B-16）。
// 骨架阶段：惰性建 S3Client（forcePathStyle = MinIO 必需），不在 import 期连。
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Bucket, ObjectStorePort } from '@cb/shared';
import type { Env } from '../config/env.js';

let client: S3Client | undefined;

function getClient(env: Env): S3Client {
  if (!client) {
    client = new S3Client({
      endpoint: env.S3_ENDPOINT,
      region: env.S3_REGION,
      forcePathStyle: true, // MinIO 必需（非虚拟主机风格寻址）
      credentials: { accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY },
      maxAttempts: 1, // 骨架阶段不重试（探针/调用连不上时快速失败，不裸挂）
      requestHandler: {
        // 连接/请求超时短，依赖宕机时 /ready 快速判 down。
        requestTimeout: 2_000,
        connectionTimeout: 2_000,
      },
    });
  }
  return client;
}

const DEFAULT_EXPIRES_SEC = 900; // 15min 预签名默认有效期

/** S3/MinIO 实现的 ObjectStorePort。 */
export function createS3ObjectStore(env: Env): ObjectStorePort {
  const s3 = getClient(env);
  return {
    async presignPut(bucket, key, opts) {
      const cmd = new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        ...(opts?.contentType ? { ContentType: opts.contentType } : {}),
      });
      const url = await getSignedUrl(s3, cmd, {
        expiresIn: opts?.expiresSec ?? DEFAULT_EXPIRES_SEC,
      });
      return { url, key };
    },
    async presignGet(bucket, key, opts) {
      const cmd = new GetObjectCommand({ Bucket: bucket, Key: key });
      const url = await getSignedUrl(s3, cmd, {
        expiresIn: opts?.expiresSec ?? DEFAULT_EXPIRES_SEC,
      });
      return { url };
    },
    async getObject(bucket, key) {
      const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      // SDK v3 in node 返回的 Body 是 web ReadableStream（node18+）或可转换流。
      return res.Body as unknown as ReadableStream;
    },
    async putObject(bucket, key, body, opts) {
      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ...(opts?.contentType ? { ContentType: opts.contentType } : {}),
        }),
      );
      return { key };
    },
    async list(bucket, prefix) {
      const res = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }));
      return (res.Contents ?? []).map((o) => ({
        key: o.Key ?? '',
        size: o.Size ?? 0,
        lastModified: (o.LastModified ?? new Date()).toISOString(),
      }));
    },
    async delete(bucket, key) {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
    async head(bucket, key) {
      try {
        const res = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return {
          size: res.ContentLength ?? 0,
          lastModified: (res.LastModified ?? new Date()).toISOString(),
        };
      } catch {
        return null;
      }
    },
  };
}

/** ready 探针：HEAD 一个桶（连不上/凭证错 → down）。骨架用 ListObjectsV2 限 1 条做轻探。 */
export async function pingObjectStore(env: Env, bucket: Bucket = 'agora-raw'): Promise<boolean> {
  try {
    await getClient(env).send(new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 1 }));
    return true;
  } catch {
    return false;
  }
}

/** 优雅关闭。 */
export function closeObjectStore(): void {
  client?.destroy();
  client = undefined;
}

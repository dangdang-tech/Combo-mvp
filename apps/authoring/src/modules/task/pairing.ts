// 配对上传：助手凭配对码分片传输，收齐自动流转提取。
//   - verifyPairingCode：验码 + 验期 + 验上传态（库里只有哈希，明文只在建任务响应出现过一次）。
//   - landPart：分片内容写 MinIO → parts 登记（重复分片幂等覆盖）→ 收齐时 uploads 置 raw、
//     transition 任务到 extract 步、入队。并发收齐由 transition 乐观锁保证只入队一次。
//   - 收齐时【不】把分片拼接成完整原始件：真实规模（上百分片、数百 MB）把全部分片读回
//     内存 join 曾把 api 进程撑爆（issue #25）。worker 直接按 parts 登记表逐片消费。
import type {
  ConnectPrepareResult,
  ConnectUploadResult,
  ObjectStorePort,
  QueuePort,
} from '@cb/shared';
import type { Queryable } from '../../platform/infra/db.js';
import { TASK_PIPELINE_QUEUE } from '../../platform/infra/queue.js';
import { hashPairingCode } from './pairing-code.js';
import { transition } from './service.js';
import {
  findUploadByCodeHash,
  markUploadRaw,
  partsState,
  registerPart,
  replaceUploadManifest,
  trackStaleUploadObject,
  trackExpiredUploadOrphanKey,
  type PartsManifest,
} from './repo.js';
import { RAW_BUCKET } from './raw-purge.js';

export { RAW_BUCKET } from './raw-purge.js';

/** 分片对象键。 */
export function partObjectKey(taskId: string, partIndex: number, bundleId?: string): string {
  return bundleId
    ? `uploads/${taskId}/${bundleId}/part-${partIndex}`
    : `uploads/${taskId}/part-${partIndex}`;
}

export type PairingVerification =
  | { ok: true; taskId: string; ownerUserId: string; parts: PartsManifest }
  | { ok: false; reason: 'invalid' | 'expired' };

/**
 * 验配对码：码不存在 → invalid；已过期 / 上传已推进（收齐或处理完，码已完成使命）/
 * 任务已不在上传中 → expired（对助手同一句人话：回任务页重新生成）。
 */
export async function verifyPairingCode(db: Queryable, code: string): Promise<PairingVerification> {
  const row = await findUploadByCodeHash(db, hashPairingCode(code));
  if (!row) return { ok: false, reason: 'invalid' };
  if (row.expired) return { ok: false, reason: 'expired' };
  if (row.uploadStatus !== 'pending') return { ok: false, reason: 'expired' };
  if (row.taskStep !== 'upload' || row.taskStatus !== 'running') {
    return { ok: false, reason: 'expired' };
  }
  return { ok: true, taskId: row.taskId, ownerUserId: row.ownerUserId, parts: row.parts };
}

/** 脚本下发允许 pending 上传，也允许有效期内的已收齐任务做最终确认。 */
export async function canFetchConnectScript(db: Queryable, code: string): Promise<boolean> {
  const row = await findUploadByCodeHash(db, hashPairingCode(code));
  if (!row || row.expired) return false;
  if (partsState(row.parts).complete) return true;
  return (
    row.uploadStatus === 'pending' && row.taskStep === 'upload' && row.taskStatus === 'running'
  );
}

export interface PrepareUploadInput {
  pairingCode: string;
  protocolVersion: 2;
  bundleId: string;
  totalParts: number;
  replaceExisting: boolean;
}

export type PrepareUploadOutcome =
  | { kind: 'ok'; result: ConnectPrepareResult }
  | { kind: 'invalid_code' }
  | { kind: 'expired' }
  | { kind: 'manifest_conflict' };

function landedIndices(parts: PartsManifest): number[] {
  return Object.keys(parts.landed ?? {})
    .map(Number)
    .filter((n) => Number.isInteger(n) && n >= 0)
    .sort((a, b) => a - b);
}

/** 建立 v2 快照清单；同 bundle 幂等，完成态只做确认，绝不被重置。 */
export async function prepareUpload(
  db: Queryable,
  input: PrepareUploadInput,
): Promise<PrepareUploadOutcome> {
  const row = await findUploadByCodeHash(db, hashPairingCode(input.pairingCode));
  if (!row) return { kind: 'invalid_code' };
  if (row.expired) return { kind: 'expired' };

  const current = partsState(row.parts);
  if (row.uploadStatus !== 'pending' || row.taskStep !== 'upload' || row.taskStatus !== 'running') {
    if (!current.complete) return { kind: 'expired' };
    return {
      kind: 'ok',
      result: {
        protocolVersion: 2,
        bundleId: input.bundleId,
        totalParts: input.totalParts,
        landedParts: Array.from({ length: input.totalParts }, (_, i) => i),
        complete: true,
      },
    };
  }

  if (row.parts.bundleId === input.bundleId && current.total === input.totalParts) {
    return {
      kind: 'ok',
      result: {
        protocolVersion: 2,
        bundleId: input.bundleId,
        totalParts: input.totalParts,
        landedParts: landedIndices(row.parts),
        complete: current.complete,
      },
    };
  }

  const hasExisting = current.total !== null || current.landed > 0 || Boolean(row.parts.bundleId);
  if (hasExisting && !input.replaceExisting) return { kind: 'manifest_conflict' };

  const replaced = await replaceUploadManifest(db, {
    taskId: row.taskId,
    bundleId: input.bundleId,
    totalParts: input.totalParts,
  });
  if (!replaced) {
    const latest = await findUploadByCodeHash(db, hashPairingCode(input.pairingCode));
    if (latest && partsState(latest.parts).complete) {
      return {
        kind: 'ok',
        result: {
          protocolVersion: 2,
          bundleId: input.bundleId,
          totalParts: input.totalParts,
          landedParts: Array.from({ length: input.totalParts }, (_, i) => i),
          complete: true,
        },
      };
    }
    return { kind: 'expired' };
  }
  return {
    kind: 'ok',
    result: {
      protocolVersion: 2,
      bundleId: input.bundleId,
      totalParts: input.totalParts,
      landedParts: [],
      complete: false,
    },
  };
}

export interface LandPartDeps {
  db: Queryable;
  objectStore: ObjectStorePort;
  queue: QueuePort;
}

export interface LandPartInput {
  pairingCode: string;
  bundleId?: string;
  partIndex: number;
  totalParts: number;
  /** 分片内容（utf-8 文本）。 */
  content: string;
  traceId: string;
}

export type LandPartOutcome =
  | { kind: 'ok'; result: ConnectUploadResult }
  | { kind: 'invalid_code' }
  | { kind: 'expired' }
  | { kind: 'bad_part' }; // partIndex 越界 / 与已声明总数矛盾

/**
 * 落一片分片。重复分片幂等覆盖（同 index 再传只是重写同一个对象 + 重登记）。
 * 全部收齐时：uploads 置 raw → 任务流转 extract → 入队；分片留在桶里由 worker 逐片消费。
 * 两个分片并发「同时收齐」时置 raw 是幂等更新，流转与入队由 transition 乐观锁收敛为恰好一次。
 */
export async function landPart(deps: LandPartDeps, input: LandPartInput): Promise<LandPartOutcome> {
  const verified = await verifyPairingCode(deps.db, input.pairingCode);
  if (!verified.ok) {
    return verified.reason === 'invalid' ? { kind: 'invalid_code' } : { kind: 'expired' };
  }
  if (input.partIndex >= input.totalParts) return { kind: 'bad_part' };
  const { taskId } = verified;

  const declaredTotal =
    typeof verified.parts.total === 'number' && verified.parts.total > 0
      ? verified.parts.total
      : null;
  if (input.bundleId) {
    if (verified.parts.bundleId !== input.bundleId || declaredTotal !== input.totalParts) {
      return { kind: 'bad_part' };
    }
  } else if (
    verified.parts.bundleId ||
    (declaredTotal !== null && declaredTotal !== input.totalParts)
  ) {
    return { kind: 'bad_part' };
  }

  // ① 分片内容落桶（先写桶再登记：登记过的分片必已可读，收齐拼接不会扑空）。
  const key = partObjectKey(taskId, input.partIndex, input.bundleId);
  await deps.objectStore.putObject(RAW_BUCKET, key, new TextEncoder().encode(input.content), {
    contentType: 'text/plain; charset=utf-8',
  });

  // ② 登记进 parts（受保护更新；0 行 = 验码后瞬间被推进/过期的竞态）。
  const parts = await registerPart(deps.db, {
    taskId,
    partIndex: input.partIndex,
    objectKey: key,
    totalParts: input.totalParts,
    ...(input.bundleId ? { bundleId: input.bundleId } : {}),
  });
  if (!parts) {
    // putObject 先于登记，若恰在两步之间过期/被对账接管，这一片不会进入 parts 清单。
    // 先把 key 持久登记进 expired 清理清单（并推进 cleanup version），再立即 best-effort
    // 删除；即使 MinIO 此刻失败，worker 下一轮也能重读真删，且不会拿旧清单误打清理戳。
    await trackStaleUploadObject(deps.db, { taskId, objectKey: key }).catch(() => undefined);
    await trackExpiredUploadOrphanKey(deps.db, { taskId, objectKey: key }).catch(() => undefined);
    await deps.objectStore.delete(RAW_BUCKET, key).catch(() => undefined);
    const latest = await findUploadByCodeHash(deps.db, hashPairingCode(input.pairingCode));
    return latest && !latest.expired && latest.uploadStatus === 'pending'
      ? { kind: 'bad_part' }
      : { kind: 'expired' };
  }

  const state = partsState(parts);
  // 声明总数与登记表里首次声明不一致（助手换了切法重传）→ 按登记表为准；越界分片已在上面拒掉。
  if (!state.complete) {
    return {
      kind: 'ok',
      result: { landed: state.landed, total: state.total ?? input.totalParts, complete: false },
    };
  }

  // ③ 收齐：只置状态，不拼接。分片本身就是「整文件打包」的合法文本单元，
  //    worker 按 parts 登记表逐片读取处理，api 进程不再持有全量内容。
  await markUploadRaw(deps.db, taskId);

  // ④ 流转 upload→extract 并入队。乐观锁 0 行 = 另一并发分片已流转过，本次不重复入队。
  const flipped = await transition(
    deps.db,
    taskId,
    { step: 'upload', status: 'running' },
    { step: 'extract' },
  );
  if (flipped) {
    await deps.queue.enqueue(TASK_PIPELINE_QUEUE, taskId, input.traceId);
  }

  return {
    kind: 'ok',
    result: { landed: state.landed, total: state.total ?? input.totalParts, complete: true },
  };
}

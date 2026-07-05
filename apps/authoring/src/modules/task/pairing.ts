// 配对上传：助手凭配对码分片传输，收齐自动流转提取。
//   - verifyPairingCode：验码 + 验期 + 验上传态（库里只有哈希，明文只在建任务响应出现过一次）。
//   - landPart：分片内容写 MinIO → parts 登记（重复分片幂等覆盖）→ 收齐时拼接完整原始件、
//     uploads 置 raw、transition 任务到 extract 步、入队。并发收齐由 transition 乐观锁保证只入队一次。
import type { ConnectUploadResult, ObjectStorePort, QueuePort } from '@cb/shared';
import type { Queryable } from '../../platform/infra/db.js';
import { TASK_PIPELINE_QUEUE } from '../../platform/infra/queue.js';
import { hashPairingCode } from './pairing-code.js';
import { transition } from './service.js';
import { findUploadByCodeHash, markUploadRaw, partsState, registerPart } from './repo.js';

/** 上传原始件所在桶（处理完即清，不落正式盘）。 */
export const RAW_BUCKET = 'agora-raw' as const;

/** 分片对象键。 */
export function partObjectKey(taskId: string, partIndex: number): string {
  return `uploads/${taskId}/part-${partIndex}`;
}

/** 收齐后完整原始件对象键。 */
export function rawObjectKey(taskId: string): string {
  return `uploads/${taskId}/raw.txt`;
}

export type PairingVerification =
  | { ok: true; taskId: string; ownerUserId: string }
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
  return { ok: true, taskId: row.taskId, ownerUserId: row.ownerUserId };
}

export interface LandPartDeps {
  db: Queryable;
  objectStore: ObjectStorePort;
  queue: QueuePort;
}

export interface LandPartInput {
  pairingCode: string;
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
 * 全部收齐时：按序拼接分片为完整原始件 raw.txt → uploads 置 raw → 任务流转 extract → 入队。
 * 两个分片并发「同时收齐」时拼接是幂等重写，流转与入队由 transition 乐观锁收敛为恰好一次。
 */
export async function landPart(deps: LandPartDeps, input: LandPartInput): Promise<LandPartOutcome> {
  const verified = await verifyPairingCode(deps.db, input.pairingCode);
  if (!verified.ok) {
    return verified.reason === 'invalid' ? { kind: 'invalid_code' } : { kind: 'expired' };
  }
  if (input.partIndex >= input.totalParts) return { kind: 'bad_part' };
  const { taskId } = verified;

  // ① 分片内容落桶（先写桶再登记：登记过的分片必已可读，收齐拼接不会扑空）。
  const key = partObjectKey(taskId, input.partIndex);
  await deps.objectStore.putObject(RAW_BUCKET, key, new TextEncoder().encode(input.content), {
    contentType: 'text/plain; charset=utf-8',
  });

  // ② 登记进 parts（受保护更新；0 行 = 验码后瞬间被推进/过期的竞态）。
  const parts = await registerPart(deps.db, {
    taskId,
    partIndex: input.partIndex,
    objectKey: key,
    totalParts: input.totalParts,
  });
  if (!parts) return { kind: 'expired' };

  const state = partsState(parts);
  // 声明总数与登记表里首次声明不一致（助手换了切法重传）→ 按登记表为准；越界分片已在上面拒掉。
  if (!state.complete) {
    return {
      kind: 'ok',
      result: { landed: state.landed, total: state.total ?? input.totalParts, complete: false },
    };
  }

  // ③ 收齐：按序拼接分片 → 完整原始件（分片是按整文件打包的文本，换行拼接对 JSONL 无损）。
  const pieces: string[] = [];
  for (const partKey of state.orderedKeys) {
    pieces.push(await deps.objectStore.getObjectText(RAW_BUCKET, partKey));
  }
  await deps.objectStore.putObject(
    RAW_BUCKET,
    rawObjectKey(taskId),
    new TextEncoder().encode(pieces.join('\n')),
    { contentType: 'text/plain; charset=utf-8' },
  );
  await markUploadRaw(deps.db, taskId, rawObjectKey(taskId));

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

// 任务状态机服务。
//   - transition：全部状态轴变更的【唯一入口】。乐观锁——UPDATE 带上期望的 (current_step, status)，
//     0 行即拒（状态已被并发变更/接管，调用方按 0 行安全退出，绝不覆盖别人的终态）。
//   - createTask：一个事务插 tasks+uploads；幂等键 ON CONFLICT DO NOTHING 后回读返回已存在任务。
//   - retryTask：failed 才可重试——retry_count+1、重置 running、重新入队。
import { randomBytes } from 'node:crypto';
import {
  ErrorCode,
  errorBodyFor,
  type ErrorBody,
  type ObjectStorePort,
  type QueuePort,
  type TaskStatus,
  type TaskStep,
  type TaskView,
} from '@cb/shared';
import type { Queryable } from '../../platform/infra/db.js';
import { withTransaction, type TxPool } from '../../platform/infra/db-tx.js';
import { TASK_PIPELINE_QUEUE } from '../../platform/infra/queue.js';
import { generatePairingCode, hashPairingCode, pairingExpiresAt } from './pairing-code.js';
import {
  expireAbandonedLocalTasks,
  expireIncompleteUploadTasks,
  findTaskByIdempotencyKey,
  insertLocalExecution,
  insertTask,
  insertUpload,
  listStaleUploadPurgeCandidates,
  listExpiredUploadPurgeCandidates,
  clearStaleUploadObjects,
  markExpiredUploadPurged,
  readTaskCore,
  readTaskView,
  rotateLocalBindCode,
  rotatePairingCode,
} from './repo.js';
import { purgeRawObjects } from './raw-purge.js';

/** transition 的期望现态（乐观锁条件）。 */
export interface TaskExpect {
  step: TaskStep;
  status: TaskStatus;
}

/** transition 的目标补丁。未给的轴保持不变；任何 transition 都会清掉租约（当前执行权随状态变更终结）。 */
export interface TaskPatch {
  step?: TaskStep;
  status?: TaskStatus;
  /** 'set' 写入 error；'clear' 清空；缺省不动。 */
  lastError?: ErrorBody | null;
  /** 'increment' 重试 +1；'reset' 清零（成功终态用）；缺省不动。 */
  retry?: 'increment' | 'reset';
}

/**
 * 状态轴变更唯一入口（乐观锁）。命中期望现态才更新，返回是否命中。
 * 0 行的语义：任务不存在 / 已被并发变更（如另一分片请求先完成了流转、worker 已落终态）。
 */
export async function transition(
  db: Queryable,
  taskId: string,
  expect: TaskExpect,
  patch: TaskPatch,
): Promise<boolean> {
  let errMode: 'keep' | 'clear' | 'set' = 'keep';
  if (patch.lastError === null) errMode = 'clear';
  else if (patch.lastError !== undefined) errMode = 'set';
  const res = await db.query(
    `UPDATE tasks
        SET current_step = COALESCE($4, current_step),
            status = COALESCE($5, status),
            last_error = CASE $6 WHEN 'set' THEN $7::jsonb WHEN 'clear' THEN NULL ELSE last_error END,
            retry_count = CASE $8 WHEN 'increment' THEN retry_count + 1 WHEN 'reset' THEN 0 ELSE retry_count END,
            lease_owner = NULL,
            lease_expires_at = NULL,
            updated_at = now()
      WHERE id = $1 AND current_step = $2 AND status = $3`,
    [
      taskId,
      expect.step,
      expect.status,
      patch.step ?? null,
      patch.status ?? null,
      errMode,
      patch.lastError ? JSON.stringify(patch.lastError) : null,
      patch.retry ?? 'keep',
    ],
  );
  return (res.rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// 建任务
// ---------------------------------------------------------------------------

export interface CreateTaskInput {
  ownerUserId: string;
  idempotencyKey: string;
  description?: string;
}

export type CreateTaskOutcome =
  | { kind: 'ok'; taskId: string; pairingCode: string; replayed: boolean }
  | { kind: 'conflict' }; // 幂等键被其他用户占用

/**
 * 建任务：一个事务插 tasks + uploads（配对码只存哈希，明文随返回值出一次）。
 * 幂等：同 key 重试命中 ON CONFLICT → 回读已存在任务；因明文码无法从哈希还原，
 * 回放时对仍未收齐的上传【轮换新码】返回（真重试意味着上一次响应从未送达，旧码没人见过）。
 */
export async function createTask(
  pool: TxPool,
  db: Queryable,
  input: CreateTaskInput,
): Promise<CreateTaskOutcome> {
  const code = generatePairingCode();
  const codeHash = hashPairingCode(code);
  const expiresAt = pairingExpiresAt();

  const createdId = await withTransaction(pool, async (tx) => {
    const taskId = await insertTask(tx, {
      ownerUserId: input.ownerUserId,
      ...(input.description !== undefined ? { description: input.description } : {}),
      idempotencyKey: input.idempotencyKey,
    });
    if (!taskId) return null;
    await insertUpload(tx, { taskId, pairingCodeHash: codeHash, pairingExpiresAt: expiresAt });
    return taskId;
  });

  if (createdId) return { kind: 'ok', taskId: createdId, pairingCode: code, replayed: false };

  // 幂等回放：回读既有任务（他人占用同 key → 409 冲突，不暴露他人任务）。
  const existing = await findTaskByIdempotencyKey(db, input.idempotencyKey);
  if (!existing) return { kind: 'conflict' }; // 竞态下极端读不到：按冲突处理，让客户端换 key 重试
  if (existing.ownerUserId !== input.ownerUserId || existing.executionMode !== 'cloud') {
    return { kind: 'conflict' };
  }
  await rotatePairingCode(db, {
    taskId: existing.id,
    pairingCodeHash: codeHash,
    pairingExpiresAt: expiresAt,
  });
  return { kind: 'ok', taskId: existing.id, pairingCode: code, replayed: true };
}

export type CreateLocalTaskOutcome =
  | {
      kind: 'ok';
      taskId: string;
      bindCode: string;
      bindExpiresAt: string;
      replayed: boolean;
    }
  | { kind: 'conflict' };

/** local Task 直接进入 extract/running，不创建 uploads，也不进入 Cloud Worker 队列。 */
export async function createLocalTask(
  pool: TxPool,
  db: Queryable,
  input: CreateTaskInput,
): Promise<CreateLocalTaskOutcome> {
  // local bind code 由宿主直接交给 Worker，无须人工抄写，使用高熵随机值抵抗无登录 Claim 猜测。
  const bindCode = randomBytes(32).toString('base64url');
  const bindCodeHash = hashPairingCode(bindCode);
  const bindExpiresAt = new Date(Date.now() + 15 * 60_000).toISOString();

  const createdId = await withTransaction(pool, async (tx) => {
    const taskId = await insertTask(tx, {
      ownerUserId: input.ownerUserId,
      ...(input.description !== undefined ? { description: input.description } : {}),
      idempotencyKey: input.idempotencyKey,
      executionMode: 'local',
    });
    if (!taskId) return null;
    await insertLocalExecution(tx, {
      taskId,
      ownerUserId: input.ownerUserId,
      bindCodeHash,
      bindExpiresAt,
    });
    return taskId;
  });

  if (createdId) {
    return { kind: 'ok', taskId: createdId, bindCode, bindExpiresAt, replayed: false };
  }

  const existing = await findTaskByIdempotencyKey(db, input.idempotencyKey);
  if (
    !existing ||
    existing.ownerUserId !== input.ownerUserId ||
    existing.executionMode !== 'local'
  ) {
    return { kind: 'conflict' };
  }
  const rotated = await rotateLocalBindCode(db, {
    taskId: existing.id,
    bindCodeHash,
    bindExpiresAt,
  });
  if (!rotated) return { kind: 'conflict' };
  return {
    kind: 'ok',
    taskId: existing.id,
    bindCode,
    bindExpiresAt,
    replayed: true,
  };
}

// ---------------------------------------------------------------------------
// 重试
// ---------------------------------------------------------------------------

export type RetryOutcome =
  | { kind: 'ok'; view: TaskView }
  | { kind: 'not_found' }
  | { kind: 'not_retriable' }; // 非 failed 态

/**
 * 重试失败任务：failed 才可重试——retry_count+1、清 last_error、重置 running、重新入队。
 * 只有 extract 步会失败后停在 failed（upload 步没有 worker 失败路径）；仍以任务当前 step 为期望
 * 现态做乐观锁，竞态下 0 行按 not_retriable 返回。
 */
export async function retryTask(
  db: Queryable,
  queue: QueuePort,
  input: { taskId: string; ownerUserId: string; traceId: string },
): Promise<RetryOutcome> {
  const core = await readTaskCore(db, input.taskId);
  if (!core || core.ownerUserId !== input.ownerUserId) return { kind: 'not_found' };
  // upload 失败（目前即配对窗口已过期）不能原地重试：明文配对码不可恢复，且旧 parts 清单
  // 不能安全套用到一次新的本机扫描。前端会引导“重新上传”建新任务；这里只允许 extract 重跑。
  if (
    core.status !== 'failed' ||
    core.currentStep !== 'extract' ||
    core.executionMode !== 'cloud'
  ) {
    return { kind: 'not_retriable' };
  }

  const ok = await transition(
    db,
    input.taskId,
    { step: core.currentStep, status: 'failed' },
    { status: 'running', lastError: null, retry: 'increment' },
  );
  if (!ok) return { kind: 'not_retriable' };

  if (core.currentStep === 'extract') {
    await queue.enqueue(TASK_PIPELINE_QUEUE, input.taskId, input.traceId);
  }
  const view = await readTaskView(db, input.taskId, input.ownerUserId);
  if (!view) return { kind: 'not_found' };
  return { kind: 'ok', view };
}

// ---------------------------------------------------------------------------
// 过期任务状态修复
// ---------------------------------------------------------------------------

/**
 * 把已经不可能继续收片的 upload/running 任务持久化为 failed。
 *
 * 这是后端状态归一，不是前端按时间猜状态：列表、详情、SSE 和后续 API 都会看到同一终态。
 * repo 用单条加锁 CTE 同时验证 expiry/manifest/status 并落 upload=expired + task=failed，
 * 不存在候选 SELECT 与状态转换之间的 TOCTOU 窗口。
 */
export async function reconcileExpiredUploadTasks(
  db: Queryable,
  input: { traceId: string; ownerUserId?: string; taskId?: string; limit?: number },
): Promise<number> {
  const lastError = errorBodyFor(ErrorCode.PAIRING_EXPIRED, input.traceId, {
    userMessage: '上传等待已超时，请重新上传。',
  }).body;
  const ids = await expireIncompleteUploadTasks(db, { ...input, lastError });
  return ids.length;
}

/** 把绑定窗口或 Task Token 已到期的 local Task 收口为 failed，避免永久 running。 */
export async function reconcileExpiredLocalTasks(
  db: Queryable,
  input: { traceId: string; limit?: number },
): Promise<number> {
  const lastError = errorBodyFor(ErrorCode.PAIRING_EXPIRED, input.traceId, {
    userMessage: '本地执行凭证已过期，请回到 Combo Plugin 重新创建任务。',
  }).body;
  const ids = await expireAbandonedLocalTasks(db, {
    lastError,
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
  });
  return ids.length;
}

export interface ExpiredUploadPurgeResult {
  purged: number;
  failedTaskIds: string[];
}

/**
 * 清理 expired 上传已经登记的原始对象。
 *
 * raw_purged_at 为空就是持久重试队列：只有全部 key 删除成功才打戳；任一删除或打戳失败都
 * 保持为空，worker 下一轮会重做（DeleteObject 幂等），不会先丢追踪状态。
 */
export async function purgeExpiredUploadParts(
  db: Queryable,
  objectStore: ObjectStorePort,
  input: { limit?: number } = {},
): Promise<ExpiredUploadPurgeResult> {
  const candidates = await listExpiredUploadPurgeCandidates(db, input.limit ?? 100);
  let purged = 0;
  const failedTaskIds: string[] = [];
  for (const candidate of candidates) {
    try {
      await purgeRawObjects(objectStore, candidate.objectKeys);
      if (await markExpiredUploadPurged(db, candidate.taskId, candidate.cleanupVersion)) {
        purged += 1;
      }
    } catch {
      failedTaskIds.push(candidate.taskId);
    }
  }
  return { purged, failedTaskIds };
}

/** 周期清理由快照替换或登记竞态留下的对象；失败项保留在 meta 中供下一轮重试。 */
export async function purgeStaleUploadParts(
  db: Queryable,
  objectStore: ObjectStorePort,
  input: { limit?: number } = {},
): Promise<ExpiredUploadPurgeResult> {
  const candidates = await listStaleUploadPurgeCandidates(db, input.limit ?? 100);
  let purged = 0;
  const failedTaskIds: string[] = [];
  for (const candidate of candidates) {
    try {
      await purgeRawObjects(objectStore, candidate.objectKeys);
      if (await clearStaleUploadObjects(db, candidate.taskId, candidate.cleanupVersion))
        purged += 1;
    } catch {
      failedTaskIds.push(candidate.taskId);
    }
  }
  return { purged, failedTaskIds };
}

// 任务状态机服务。
//   - transition：全部状态轴变更的【唯一入口】。乐观锁——UPDATE 带上期望的 (current_step, status)，
//     0 行即拒（状态已被并发变更/接管，调用方按 0 行安全退出，绝不覆盖别人的终态）。
//   - createTask：一个事务插 tasks+uploads；幂等键 ON CONFLICT DO NOTHING 后回读返回已存在任务。
//   - retryTask：failed 才可重试——retry_count+1、重置 running、重新入队。
import type { ErrorBody, QueuePort, TaskStatus, TaskStep, TaskView } from '@cb/shared';
import type { Queryable } from '../../platform/infra/db.js';
import { withTransaction, type TxPool } from '../../platform/infra/db-tx.js';
import { TASK_PIPELINE_QUEUE } from '../../platform/infra/queue.js';
import { generatePairingCode, hashPairingCode, pairingExpiresAt } from './pairing-code.js';
import {
  findTaskByIdempotencyKey,
  insertTask,
  insertUpload,
  readTaskCore,
  readTaskView,
  rotatePairingCode,
} from './repo.js';

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
  const errMode =
    patch.lastError === undefined ? 'keep' : patch.lastError === null ? 'clear' : 'set';
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
  if (existing.ownerUserId !== input.ownerUserId) return { kind: 'conflict' };
  await rotatePairingCode(db, {
    taskId: existing.id,
    pairingCodeHash: codeHash,
    pairingExpiresAt: expiresAt,
  });
  return { kind: 'ok', taskId: existing.id, pairingCode: code, replayed: true };
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
  if (core.status !== 'failed') return { kind: 'not_retriable' };

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

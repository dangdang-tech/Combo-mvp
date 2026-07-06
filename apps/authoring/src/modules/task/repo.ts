// tasks / uploads 两表 SQL + TaskView 组装。本模块所有落库语句收在这里；
// 状态轴（current_step/status）的变更不在此——唯一入口是 service.transition。
import type { ErrorBody, TaskStatus, TaskStep, TaskView, UploadStatus } from '@cb/shared';
import { toIso, type Queryable } from '../../platform/infra/db.js';
import type { Tx } from '../../platform/infra/db-tx.js';

/** uploads.parts 登记表形态：声明总数 + 已落地分片（index → MinIO 对象键）。 */
export interface PartsManifest {
  total?: number | null;
  landed?: Record<string, string>;
}

/** 从 parts 登记表算已落地数 / 是否收齐（0..total-1 连续全到齐才算齐）。 */
export function partsState(parts: PartsManifest | null | undefined): {
  total: number | null;
  landed: number;
  complete: boolean;
  orderedKeys: string[];
} {
  const landedMap = parts?.landed ?? {};
  const indices = Object.keys(landedMap)
    .map((k) => Number(k))
    .filter((n) => Number.isInteger(n) && n >= 0)
    .sort((a, b) => a - b);
  const total = typeof parts?.total === 'number' && parts.total > 0 ? parts.total : null;
  const complete = total !== null && indices.length === total && indices.every((n, i) => n === i);
  return {
    total,
    landed: indices.length,
    complete,
    orderedKeys: indices.map((i) => landedMap[String(i)]!),
  };
}

// ---------------------------------------------------------------------------
// 建任务（tasks + uploads 同事务两行；幂等键冲突由 service.createTask 处理）
// ---------------------------------------------------------------------------

export interface InsertTaskInput {
  ownerUserId: string;
  description?: string;
  idempotencyKey: string;
}

/** 插 tasks 行（幂等键冲突 → null，调用方回读已存在任务）。 */
export async function insertTask(tx: Tx, input: InsertTaskInput): Promise<string | null> {
  const res = await tx.query<{ id: string }>(
    `INSERT INTO tasks (owner_user_id, description, idempotency_key)
     VALUES ($1, $2, $3)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id`,
    [input.ownerUserId, input.description ?? null, input.idempotencyKey],
  );
  return res.rows[0]?.id ?? null;
}

/** 插 uploads 行（与 task 一对一；库里只存配对码哈希，明文只随建任务响应返一次）。 */
export async function insertUpload(
  tx: Tx,
  input: { taskId: string; pairingCodeHash: string; pairingExpiresAt: string },
): Promise<void> {
  await tx.query(
    `INSERT INTO uploads (task_id, pairing_code_hash, pairing_expires_at)
     VALUES ($1, $2, $3)`,
    [input.taskId, input.pairingCodeHash, input.pairingExpiresAt],
  );
}

/** 按幂等键回读已存在任务（双击/网络重试命中 ON CONFLICT 后走这里）。 */
export async function findTaskByIdempotencyKey(
  db: Queryable,
  idempotencyKey: string,
): Promise<{ id: string; ownerUserId: string } | null> {
  const res = await db.query<{ id: string; owner_user_id: string }>(
    `SELECT id, owner_user_id FROM tasks WHERE idempotency_key = $1`,
    [idempotencyKey],
  );
  const row = res.rows[0];
  return row ? { id: row.id, ownerUserId: row.owner_user_id } : null;
}

/**
 * 幂等回放时轮换配对码（明文码无法从哈希还原，重放必须发新码才能凑齐响应契约）。
 * 仅未收齐的 pending 上传可轮换；已推进的上传不动（回放方拿旧 TaskView 即可）。
 */
export async function rotatePairingCode(
  db: Queryable,
  input: { taskId: string; pairingCodeHash: string; pairingExpiresAt: string },
): Promise<boolean> {
  const res = await db.query(
    `UPDATE uploads
        SET pairing_code_hash = $2, pairing_expires_at = $3, updated_at = now()
      WHERE task_id = $1 AND status = 'pending'`,
    [input.taskId, input.pairingCodeHash, input.pairingExpiresAt],
  );
  return (res.rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// TaskView 读（联 uploads + capabilities 计数）
// ---------------------------------------------------------------------------

interface TaskViewRow {
  id: string;
  current_step: string;
  status: string;
  description: string | null;
  retry_count: number;
  last_error: unknown;
  created_at: string | Date;
  updated_at: string | Date;
  upload_status: string;
  parts: PartsManifest | null;
  pairing_expires_at: string | Date;
  capability_count: number | string;
}

const TASK_VIEW_SELECT = `
  SELECT t.id, t.current_step, t.status, t.description, t.retry_count, t.last_error,
         t.created_at, t.updated_at,
         u.status AS upload_status, u.parts, u.pairing_expires_at,
         (SELECT count(*) FROM capabilities c WHERE c.task_id = t.id) AS capability_count
    FROM tasks t
    JOIN uploads u ON u.task_id = t.id`;

function toTaskView(row: TaskViewRow): TaskView {
  const { total, landed } = partsState(row.parts);
  const lastError = row.last_error as ErrorBody | null;
  return {
    id: row.id,
    currentStep: row.current_step as TaskStep,
    status: row.status as TaskStatus,
    ...(row.description ? { description: row.description } : {}),
    retryCount: row.retry_count,
    ...(lastError ? { lastError } : {}),
    upload: {
      status: row.upload_status as UploadStatus,
      partsExpected: total,
      partsLanded: landed,
      pairingExpiresAt: toIso(row.pairing_expires_at),
    },
    capabilityCount: Number(row.capability_count),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

/** 读单任务视图（owner 限定；非本人/不存在 → null，不暴露存在性）。 */
export async function readTaskView(
  db: Queryable,
  taskId: string,
  ownerUserId: string,
): Promise<TaskView | null> {
  const res = await db.query<TaskViewRow>(
    `${TASK_VIEW_SELECT}
   WHERE t.id = $1 AND t.owner_user_id = $2`,
    [taskId, ownerUserId],
  );
  const row = res.rows[0];
  return row ? toTaskView(row) : null;
}

/**
 * 任务列表（owner 限定，新→旧）。cursor = 上一页末位任务 id（UUID v7 时间有序，id 序即时间序）；
 * 取 limit+1 判 hasMore。
 */
export async function listTaskViews(
  db: Queryable,
  input: { ownerUserId: string; limit: number; cursorId?: string },
): Promise<{ items: TaskView[]; hasMore: boolean }> {
  const res = await db.query<TaskViewRow>(
    `${TASK_VIEW_SELECT}
   WHERE t.owner_user_id = $1 AND ($2::uuid IS NULL OR t.id < $2)
   ORDER BY t.id DESC
   LIMIT $3`,
    [input.ownerUserId, input.cursorId ?? null, input.limit + 1],
  );
  const hasMore = res.rows.length > input.limit;
  return { items: res.rows.slice(0, input.limit).map(toTaskView), hasMore };
}

/** 读任务 owner + 状态轴（SSE 建流 owner 校验 / retry 前置检查用）。 */
export async function readTaskCore(
  db: Queryable,
  taskId: string,
): Promise<{
  id: string;
  ownerUserId: string;
  currentStep: TaskStep;
  status: TaskStatus;
  lastError: ErrorBody | null;
  meta: Record<string, unknown>;
} | null> {
  const res = await db.query<{
    id: string;
    owner_user_id: string;
    current_step: string;
    status: string;
    last_error: unknown;
    meta: Record<string, unknown> | null;
  }>(`SELECT id, owner_user_id, current_step, status, last_error, meta FROM tasks WHERE id = $1`, [
    taskId,
  ]);
  const row = res.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    currentStep: row.current_step as TaskStep,
    status: row.status as TaskStatus,
    lastError: (row.last_error as ErrorBody | null) ?? null,
    meta: row.meta ?? {},
  };
}

// ---------------------------------------------------------------------------
// 配对上传（uploads 登记；配对码验证）
// ---------------------------------------------------------------------------

/** 按配对码哈希找上传行（助手侧无登录态的鉴权真源）。 */
export async function findUploadByCodeHash(
  db: Queryable,
  codeHash: string,
): Promise<{
  taskId: string;
  ownerUserId: string;
  uploadStatus: UploadStatus;
  expired: boolean;
  taskStep: TaskStep;
  taskStatus: TaskStatus;
} | null> {
  const res = await db.query<{
    task_id: string;
    owner_user_id: string;
    upload_status: string;
    expired: boolean;
    current_step: string;
    status: string;
  }>(
    `SELECT u.task_id, t.owner_user_id, u.status AS upload_status,
            (u.pairing_expires_at <= now()) AS expired,
            t.current_step, t.status
       FROM uploads u
       JOIN tasks t ON t.id = u.task_id
      WHERE u.pairing_code_hash = $1`,
    [codeHash],
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    taskId: row.task_id,
    ownerUserId: row.owner_user_id,
    uploadStatus: row.upload_status as UploadStatus,
    expired: row.expired,
    taskStep: row.current_step as TaskStep,
    taskStatus: row.status as TaskStatus,
  };
}

/**
 * 登记一片已落地分片进 parts（重复分片幂等覆盖同一 index）。
 * 受保护更新：仅 pending 且配对未过期的上传可登记；total 以首次声明为准（后续声明不覆盖）。
 * 返回登记后的 parts；0 行（已推进/已过期）→ null。
 */
export async function registerPart(
  db: Queryable,
  input: { taskId: string; partIndex: number; objectKey: string; totalParts: number },
): Promise<PartsManifest | null> {
  const res = await db.query<{ parts: PartsManifest }>(
    `UPDATE uploads
        SET parts = jsonb_build_object(
              'total', COALESCE(parts->'total', to_jsonb($4::int)),
              'landed', COALESCE(parts->'landed', '{}'::jsonb)
                        || jsonb_build_object($2::text, $3::text)
            ),
            updated_at = now()
      WHERE task_id = $1 AND status = 'pending' AND pairing_expires_at > now()
      RETURNING parts`,
    [input.taskId, String(input.partIndex), input.objectKey, input.totalParts],
  );
  return res.rows[0]?.parts ?? null;
}

/**
 * 分片收齐：置 status='raw'（仅 pending 可置，并发收齐只有一个赢家）。
 * 不写 storage_key：收齐后不再拼接完整原始件，worker 直接按 parts 登记表逐片消费；
 * storage_key 列保留只为兼容历史行（清理时若非空仍会删它指向的对象）。
 */
export async function markUploadRaw(db: Queryable, taskId: string): Promise<boolean> {
  const res = await db.query(
    `UPDATE uploads
        SET status = 'raw', updated_at = now()
      WHERE task_id = $1 AND status = 'pending'`,
    [taskId],
  );
  return (res.rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// 流水线侧（worker）
// ---------------------------------------------------------------------------

/** 读上传明细（worker 拉原文 / 清理分片用）。 */
export async function readUploadForPipeline(
  db: Queryable,
  taskId: string,
): Promise<{
  storageKey: string | null;
  status: UploadStatus;
  parts: PartsManifest | null;
} | null> {
  const res = await db.query<{
    storage_key: string | null;
    status: string;
    parts: PartsManifest | null;
  }>(`SELECT storage_key, status, parts FROM uploads WHERE task_id = $1`, [taskId]);
  const row = res.rows[0];
  if (!row) return null;
  return { storageKey: row.storage_key, status: row.status as UploadStatus, parts: row.parts };
}

/**
 * 上传处理完成：置 processed；raw_purged_at 只在原始件真正删除成功时打戳
 * （合规留档字段不允许说谎——清理失败时留空，由下轮补清逻辑或人工处理）。
 */
export async function markUploadProcessed(
  db: Queryable,
  taskId: string,
  purged: boolean,
): Promise<void> {
  await db.query(
    `UPDATE uploads
        SET status = 'processed',
            raw_purged_at = CASE WHEN $2 THEN now() ELSE raw_purged_at END,
            updated_at = now()
      WHERE task_id = $1`,
    [taskId, purged],
  );
}

/** 上传元信息合并写（解析统计 / 去敏报告等）。 */
export async function mergeUploadMeta(
  db: Queryable,
  taskId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  await db.query(
    `UPDATE uploads SET meta = meta || $2::jsonb, updated_at = now() WHERE task_id = $1`,
    [taskId, JSON.stringify(patch)],
  );
}

/** worker 领取租约有效期。 */
export const TASK_LEASE_MS = 10 * 60 * 1000;

/**
 * 认领任务（防双跑）：仅 running+extract 且无有效租约的任务可被认领。
 * 0 行 = 已被别的 worker 认领（有效租约仍在）或任务已不在可跑态 → 调用方直接跳过。
 */
export async function claimTask(
  db: Queryable,
  input: { taskId: string; leaseOwner: string; leaseMs?: number },
): Promise<{ ownerUserId: string; retryCount: number; meta: Record<string, unknown> } | null> {
  const res = await db.query<{
    owner_user_id: string;
    retry_count: number;
    meta: Record<string, unknown> | null;
  }>(
    `UPDATE tasks
        SET lease_owner = $2,
            lease_expires_at = now() + ($3 || ' milliseconds')::interval,
            updated_at = now()
      WHERE id = $1
        AND status = 'running' AND current_step = 'extract'
        AND (lease_expires_at IS NULL OR lease_expires_at < now())
      RETURNING owner_user_id, retry_count, meta`,
    [input.taskId, input.leaseOwner, String(input.leaseMs ?? TASK_LEASE_MS)],
  );
  const row = res.rows[0];
  if (!row) return null;
  return { ownerUserId: row.owner_user_id, retryCount: row.retry_count, meta: row.meta ?? {} };
}

/** 续租（长流水线在安全点续期，防被对账循环误判过期接管）。 */
export async function renewLease(
  db: Queryable,
  input: { taskId: string; leaseOwner: string; leaseMs?: number },
): Promise<boolean> {
  const res = await db.query(
    `UPDATE tasks
        SET lease_expires_at = now() + ($3 || ' milliseconds')::interval, updated_at = now()
      WHERE id = $1 AND lease_owner = $2 AND status = 'running'`,
    [input.taskId, input.leaseOwner, String(input.leaseMs ?? TASK_LEASE_MS)],
  );
  return (res.rowCount ?? 0) > 0;
}

/** 持久化进度快照（SSE state_snapshot 真源；仅 running 期写，终态后不再动）。 */
export async function saveTaskProgress(
  db: Queryable,
  taskId: string,
  progress: unknown,
): Promise<void> {
  await db.query(
    `UPDATE tasks
        SET meta = jsonb_set(meta, '{progress}', $2::jsonb, true), updated_at = now()
      WHERE id = $1 AND status = 'running'`,
    [taskId, JSON.stringify(progress)],
  );
}

/**
 * 租约对账（worker 每 60s 跑一轮）：找出 running+extract 且租约已过期的任务重新入队。
 * lease 为空但长时间无更新的任务也算（覆盖「transition 成功但 enqueue 丢失」的缝隙）。
 */
export async function findStalledExtractTasks(db: Queryable): Promise<string[]> {
  const res = await db.query<{ id: string }>(
    `SELECT id
       FROM tasks
      WHERE status = 'running' AND current_step = 'extract'
        AND (
          (lease_expires_at IS NOT NULL AND lease_expires_at < now())
          OR (lease_expires_at IS NULL AND updated_at < now() - interval '2 minutes')
        )`,
  );
  return res.rows.map((r) => r.id);
}

// jobs 受保护写入仓库（脊柱 §6 / §11.A）。fence 是防重入/防旧覆盖新的唯一令牌。
//   - claimLease：queued/到期 running → 领租约（attempt_no+1、新 fence_token、lease_owner/until），单条原子 UPDATE。
//   - renewLease：续期（脊柱 §6.2 周期续期），带 fence + status='running' 守门。
//   - persistProgress / persistResult / fail / cancel：全部受保护 fence CTE（§11.A 模板 1），0 行 = 已被 fence out。
//   - reclaimExpired：sweeper 重入队（§6.2，仅 lease_until 过期才换 fence，单条原子 UPDATE）。
// 所有写入「fence 校验内联进同一条 SQL 的数据源」，杜绝先查后写（TOCTOU，§11.A 裁定）。
import type { ErrorBody, JobStatus, ProgressView } from '@cb/shared';
import type { JobRow, LeasedJob, Queryable } from './types.js';

/** 默认租约时长（毫秒）：worker 周期续期；过期由 sweeper 接管重入队（脊柱 §6.2）。 */
export const DEFAULT_LEASE_TTL_MS = 30_000;

/** 规整 jobs.progress（可能为 {} / null / 部分）成合法 ProgressView（永不裸转圈：至少 0% + 空子任务）。 */
export function normalizeProgress(p: Partial<ProgressView> | null | undefined): ProgressView {
  const src = p ?? {};
  return {
    percent: typeof src.percent === 'number' ? src.percent : 0,
    phrase: typeof src.phrase === 'string' ? src.phrase : '正在准备…',
    ...(typeof src.done === 'number' ? { done: src.done } : {}),
    ...(typeof src.total === 'number' ? { total: src.total } : {}),
    ...(typeof src.unit === 'string' ? { unit: src.unit } : {}),
    subtasks: Array.isArray(src.subtasks) ? src.subtasks : [],
    ...(Array.isArray(src.items) ? { items: src.items } : {}),
    ...(typeof src.slow === 'boolean' ? { slow: src.slow } : {}),
  };
}

/**
 * 领取租约（脊柱 §6.2）：把 queued、或 running 但 lease_until 已过期（worker 死/卡）的 job 收归本实例。
 *   单条原子 UPDATE（条件内联 WHERE，§11.A），并发只有一个实例命中；0 行 = 没抢到，返回 null。
 *   返回 LeasedJob（含执行 fence + 已落 progress 供断点续传）。
 *
 * attempt_no / fence_token 的递增**恰好发生一次**（Codex P1-r5 修复）。两条互斥路径：
 *   ① 递增路径（queued 首次派发；或 worker 持租后过期但【仍占用】= lease_owner 非空且 lease_until < now()）：
 *      attempt_no+1、fence_token+1、置新 lease_owner/lease_until、status→running——这是「新 attempt」的诞生点。
 *   ② 接管路径（**已被 sweeper.reclaimExpired 接管**的行：status='running' AND lease_owner IS NULL
 *      AND lease_until < now()）：reclaimExpired 已经把 attempt/fence 推到 N+1 并以该 fence 重入 BullMQ，
 *      故 worker 这次 claim **只接管租约**（set lease_owner/lease_until），**绝不再 +1**，并返回 reclaim
 *      设定的当前 fence_token/attempt_no。worker 用该 fence 执行——与 BullMQ 触发 id 对齐、attempt 不跳号、不出现 N+2。
 *
 *   两路径合并进一条 UPDATE：以 CASE 按「是否已被 reclaim（lease_owner IS NULL）」决定是否 +1，
 *   守门条件仍内联 WHERE（杜绝 TOCTOU，§11.A）。
 */
export async function claimLease(
  db: Queryable,
  jobId: string,
  leaseOwner: string,
  ttlMs = DEFAULT_LEASE_TTL_MS,
): Promise<LeasedJob | null> {
  // is_reclaimed = 已被 reclaimExpired 接管（running 无主且租约过去）。这条只接管租约、不再递增（递增在 reclaim 时已发生）。
  const res = await db.query<JobRow>(
    `UPDATE jobs
        SET status        = 'running',
            attempt_no    = CASE WHEN lease_owner IS NULL AND status = 'running'
                                 THEN attempt_no ELSE attempt_no + 1 END,
            fence_token   = CASE WHEN lease_owner IS NULL AND status = 'running'
                                 THEN fence_token ELSE fence_token + 1 END,
            lease_owner   = $2,
            lease_until   = now() + ($3::int || ' milliseconds')::interval,
            started_at    = COALESCE(started_at, now()),
            updated_at    = now()
      WHERE id = $1
        AND ( status = 'queued'
              OR (status = 'running' AND (lease_until IS NULL OR lease_until < now())) )
      RETURNING id, type, owner_user_id, subject_ref, progress, attempt_no, fence_token`,
    [jobId, leaseOwner, ttlMs],
  );
  const row = res.rows[0];
  if (!row) return null; // 没抢到：已被别的活跃实例持有（lease 未过期），不抢（脊柱 §6.2）。
  return {
    id: row.id,
    type: row.type,
    ownerUserId: row.owner_user_id,
    subjectRef: row.subject_ref,
    attemptNo: row.attempt_no,
    fenceToken: row.fence_token,
    progress: normalizeProgress(row.progress),
  };
}

/**
 * 读当前 job 状态（Codex P1-4）。fence-out 后用它区分「真取消」vs「sweeper 重入队接管」：
 *   - status='cancelled' → 真取消 → runner 发 done(cancelled) 终态，前端关流。
 *   - status='running'（被新 attempt 接管，fence 已换）→ 不发取消终态，避免前端误判取消、关流（已生成保留，新 attempt 续推）。
 * 仅读、无 fence 守门（要的就是「当前真状态」，不论谁持租）。job 不存在返回 undefined。
 */
export async function readJobStatus(db: Queryable, jobId: string): Promise<JobStatus | undefined> {
  const res = await db.query<{ status: JobStatus }>('SELECT status FROM jobs WHERE id = $1', [
    jobId,
  ]);
  return res.rows[0]?.status;
}

/**
 * 续期租约（脊柱 §6.2 周期续期）。带 fence + status='running' 守门：
 *   fence 失配（被取消/重入队换了 fence）或已离开 running → 0 行 → 返回 false → runner 据此停（已被接管）。
 */
export async function renewLease(
  db: Queryable,
  jobId: string,
  fenceToken: number,
  ttlMs = DEFAULT_LEASE_TTL_MS,
): Promise<boolean> {
  const res = await db.query(
    `UPDATE jobs
        SET lease_until = now() + ($3::int || ' milliseconds')::interval,
            updated_at  = now()
      WHERE id = $1
        AND fence_token = $2
        AND status = 'running'`,
    [jobId, fenceToken, ttlMs],
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * 受保护持久化进度（§11.A 模板 1）。fence + status='running' 内联进 WHERE。
 *   返回 true = 写入成功；false = 0 行（已被 fence out，不是错误，是「我已不是当前执行」，安全退出）。
 */
export async function persistProgress(
  db: Queryable,
  jobId: string,
  fenceToken: number,
  progress: ProgressView,
): Promise<boolean> {
  const res = await db.query(
    `WITH guard AS (
        SELECT id FROM jobs
         WHERE id = $1 AND fence_token = $2 AND status = 'running'
         FOR UPDATE
     )
     UPDATE jobs j
        SET progress = $3::jsonb, updated_at = now()
       FROM guard
      WHERE j.id = guard.id`,
    [jobId, fenceToken, JSON.stringify(progress)],
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * 受保护落终态：completed（§11.A 模板 1）。fence + status='running' 守门，单条事务 CTE。
 *   completed 时把 progress 拉满（percent=100，phrase 稳定），result 落 jobs.result。
 *   0 行 = 已被 fence out（取消/重入队），不覆盖、安全退出。
 */
export async function completeJob(
  db: Queryable,
  jobId: string,
  fenceToken: number,
  result: unknown,
  finalProgress: ProgressView,
): Promise<boolean> {
  const res = await db.query(
    `WITH guard AS (
        SELECT id FROM jobs
         WHERE id = $1 AND fence_token = $2 AND status = 'running'
         FOR UPDATE
     )
     UPDATE jobs j
        SET status      = 'completed',
            result      = $3::jsonb,
            progress    = $4::jsonb,
            error       = NULL,
            finished_at = now(),
            updated_at  = now()
       FROM guard
      WHERE j.id = guard.id`,
    [jobId, fenceToken, JSON.stringify(result ?? null), JSON.stringify(finalProgress)],
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * 受保护落终态：failed（§11.A 模板 1）。error 存人话 ErrorBody（禁堆栈，脊柱 §3/§11.B）。
 *   已生成的 progress（含 items）原样保留（硬规则③）；仅在 progress 顶层标 slow 不再适用，不清空已生成。
 *   0 行 = 已被 fence out，安全退出。
 */
export async function failJob(
  db: Queryable,
  jobId: string,
  fenceToken: number,
  errorBody: ErrorBody,
): Promise<boolean> {
  const res = await db.query(
    `WITH guard AS (
        SELECT id FROM jobs
         WHERE id = $1 AND fence_token = $2 AND status = 'running'
         FOR UPDATE
     )
     UPDATE jobs j
        SET status      = 'failed',
            error       = $3::jsonb,
            finished_at = now(),
            updated_at  = now()
       FROM guard
      WHERE j.id = guard.id`,
    [jobId, fenceToken, JSON.stringify(errorBody)],
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * 取消（B-11）：标 cancelled 并【换 fence_token】→ 旧执行因 fence 不匹配再也无法回写 → 已生成产物保留。
 *   单条原子 UPDATE，条件内联：仅 queued/running 可取消（终态不可逆，脊柱 §6.1）。
 *   返回换新后的 fence_token（供调用方 BullMQ remove 后日志/对账）；null = 不可取消（已终态或不存在）。
 *   注意：本写入【不带 fence 守门】——取消是「外部对当前执行的接管」，靠换 fence 让旧执行失效，
 *        而非匹配旧 fence；故守门条件是 status，不是 fence（与续期/持久化语义相反）。
 */
export async function cancelJob(
  db: Queryable,
  jobId: string,
  ownerUserId: string,
): Promise<{ fenceToken: number } | null> {
  const res = await db.query<{ fence_token: number }>(
    `UPDATE jobs
        SET status      = 'cancelled',
            fence_token = fence_token + 1,
            lease_owner = NULL,
            lease_until = NULL,
            finished_at = now(),
            updated_at  = now()
      WHERE id = $1
        AND owner_user_id = $2
        AND status IN ('queued', 'running')
      RETURNING fence_token`,
    [jobId, ownerUserId],
  );
  const row = res.rows[0];
  return row ? { fenceToken: row.fence_token } : null;
}

/**
 * sweeper 重入队（脊柱 §6.2 / 70 §6.2）：仅 lease_until 过期的 running job 换 fence + attempt_no+1。
 *   单条原子 UPDATE（条件内联 WHERE，§11.A），两实例并发只一个命中、另一个 0 行。
 *
 *   关键修复（Codex P0-3）：旧实现清 `lease_until = NULL`，但下一轮只扫 `lease_until < now()`——
 *   `NULL` 不满足 `< now()`，于是「换了 fence 但重入队失败」的 running job 永久无主、再也扫不到补入队。
 *   现改为把 `lease_until` 置为【已过去的 now()】而非 NULL：
 *     · 仍是「无主、可被 claimLease 接管」（claimLease 谓词 lease_until < now() 命中）；
 *     · 且【下一轮 sweeper 仍能扫到】（lease_until < now() 命中）→ 重入队失败可补扫。
 *   并以 `lease_owner` 区分两种待对账态，避免补扫时重复 +1 attempt/fence（见 requeuePending）：
 *     · `lease_owner IS NOT NULL`（worker 持租后死/卡）→ 本函数：换 fence + attempt+1（一次性接管）。
 *     · `lease_owner IS NULL`（已被本函数接管、但重入队失败）→ requeuePending：只补入队，不再乱跳 fence/attempt。
 *   旧 worker 即便复活，写入带旧 fence → 0 行 → 安全退出（脊柱 §6.2 铁律）。
 */
export async function reclaimExpired(
  db: Queryable,
  limit = 50,
): Promise<Array<{ id: string; fenceToken: number; attemptNo: number }>> {
  const res = await db.query<{ id: string; fence_token: number; attempt_no: number }>(
    `UPDATE jobs
        SET attempt_no  = attempt_no + 1,
            fence_token = fence_token + 1,
            lease_owner = NULL,
            -- 置为【已过去 1 秒】（而非 NULL，也不取恰好 now()）：
            --   · 严格早于任何后续 now()，故 claimLease / 下一轮 sweeper 的 lease_until < now() 必命中（无边界相等歧义）。
            --   · 标记「已接管待入队」态（配合 lease_owner IS NULL），重入队失败可被 requeuePending 补扫（Codex P0-3）。
            lease_until = now() - interval '1 second',
            updated_at  = now()
      WHERE id IN (
              SELECT id FROM jobs
               WHERE status = 'running'
                 AND lease_owner IS NOT NULL
                 AND lease_until < now()
               ORDER BY lease_until ASC
               LIMIT $1
               FOR UPDATE SKIP LOCKED
            )
      RETURNING id, fence_token, attempt_no`,
    [limit],
  );
  return res.rows.map((r) => ({ id: r.id, fenceToken: r.fence_token, attemptNo: r.attempt_no }));
}

/**
 * 删除一条「刚建、从未入队成功」的 queued job（Codex P1-r2：enqueue 失败回滚，不留悬挂 queued 孤儿）。
 *   受保护：仅 status='queued' AND lease_owner IS NULL（从未被任何 worker 领过）可删——
 *   一旦被领（running/终态）绝不删（已有执行/产物，回滚会丢，硬规则③）。返回 true = 删成功。
 *   语义安全：只删「除了这次失败的入队外、没有任何其它引用/产物」的全新 job（导入 job 此刻尚无快照/段）。
 */
export async function deleteQueuedJob(db: Queryable, jobId: string): Promise<boolean> {
  const res = await db.query(
    `DELETE FROM jobs WHERE id = $1 AND status = 'queued' AND lease_owner IS NULL`,
    [jobId],
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * 直接标 queued job 为 failed（Codex P1-r2 兜底：删不掉时——如被其它引用——退而标 failed，不留转圈）。
 *   error 落人话 ErrorBody（禁堆栈，脊柱 §11.B）。仅 queued 可标（不覆盖 running/终态）。返回 true = 标成功。
 */
export async function failQueuedJob(
  db: Queryable,
  jobId: string,
  errorBody: ErrorBody,
): Promise<boolean> {
  const res = await db.query(
    `UPDATE jobs
        SET status = 'failed', error = $2::jsonb, finished_at = now(), updated_at = now()
      WHERE id = $1 AND status = 'queued'`,
    [jobId, JSON.stringify(errorBody)],
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * 「停滞 queued 补投」列举（Codex P1-r2 防御纵深）：建后入队失败被吞、至今仍 queued 且从未被领、
 *   且停留超过阈值（updated_at < now()-thresholdMs）的 job——sweeper 据此用既有 fence 补投 BullMQ。
 *   - 只读列举（不改 fence/attempt/status）：补投用既有 fence_token（claimLease 领时再换 fence，绝不在此乱跳）。
 *   - 谓词 status='queued' AND lease_owner IS NULL：与 reclaimExpired/requeuePending（均限 running）互斥，不重复处理。
 *   - 阈值避免「刚建还没来得及被 BullMQ 触发」的正常 queued 被误补（给在线入队留窗口）。
 */
export async function staleQueued(
  db: Queryable,
  thresholdMs: number,
  limit = 50,
): Promise<Array<{ id: string; fenceToken: number; attemptNo: number }>> {
  const res = await db.query<{ id: string; fence_token: number; attempt_no: number }>(
    `SELECT id, fence_token, attempt_no
       FROM jobs
      WHERE status = 'queued'
        AND lease_owner IS NULL
        AND updated_at < now() - ($1::int || ' milliseconds')::interval
      ORDER BY created_at ASC
      LIMIT $2`,
    [thresholdMs, limit],
  );
  return res.rows.map((r) => ({ id: r.id, fenceToken: r.fence_token, attemptNo: r.attempt_no }));
}

/**
 * 「重入队待补」列举（Codex P0-3）：已被 reclaimExpired 接管（换过 fence、lease_owner=NULL）、
 * 但上一轮重入队 BullMQ 失败、至今仍 running 无主的 job。
 *   - 只读列举（不改 fence/attempt/lease）：补入队用【当前已有的 fence】，绝不重复 +1（不乱跳）。
 *   - 谓词 `status='running' AND lease_owner IS NULL AND lease_until < now()`：
 *       · 与 reclaimExpired 的 `lease_owner IS NOT NULL` 互斥——同一轮内不会既被接管又被补入队。
 *       · 一旦 claimLease 成功接管（置回 lease_owner / 推后 lease_until），该谓词自然不再命中（已有主）。
 *   入队成功后无需改库（已是 running + 新 fence）；入队再失败下一轮仍命中本谓词、继续补（幂等）。
 */
export async function requeuePending(
  db: Queryable,
  limit = 50,
): Promise<Array<{ id: string; fenceToken: number; attemptNo: number }>> {
  const res = await db.query<{ id: string; fence_token: number; attempt_no: number }>(
    `SELECT id, fence_token, attempt_no
       FROM jobs
      WHERE status = 'running'
        AND lease_owner IS NULL
        AND lease_until < now()
      ORDER BY lease_until ASC
      LIMIT $1`,
    [limit],
  );
  return res.rows.map((r) => ({ id: r.id, fenceToken: r.fence_token, attemptNo: r.attempt_no }));
}

// 40 · 结构化 Job 创建（B-25/B-26，40-step3-4-structure §4.C/§4.F）。建 jobs(type=structure) + BullMQ 入队，
//   秒回 jobId + eventsUrl（前端立连端点 D 跟字段流，永不裸转圈，硬规则①）。两条路径殊途同归到 B-25 structure handler：
//     · 发起结构化（POST /versions/{id}/structure，§4.C）：mode='full'，subject_ref 记 versionId（+ 可选 fields 子集，续传只补未生成）。
//       同 version 已有未终态 structure job → 回放运行中 jobId（不重复跑、不重复字段，验收 选择结构化-26/贯穿-27）。
//     · 单字段重生成（POST /versions/{id}/manifest/fields/{field}/regenerate，§4.F）：mode='single-field'，
//       subject_ref 记 versionId + field（+ attemptsBefore 跨调用累计，§3.4），只重生成该软字段、其余不动。
//   建 job 行：status='queued'、fence_token=1（>0 表「需入队」；领租约时换发执行 fence，脊柱 §6.2）。
//   入队失败【不删/不标 failed】——job 留 queued 交 staleQueued sweeper 按既有 fence 补投（与导入/提取同口径，不裸转圈）。
//   owner/状态闸在路由层先校验（version 属本人 + draft；非 draft/不存在/非本人由 handler 据 readVersion 返 404/403/409）。
import { SSE_ROUTES, type QueuePort, type SoftFieldKey } from '@cb/shared';
import type { Queryable } from '../../platform/jobs/types.js';
import type { QueryableDb } from '../../platform/events/db-tx.js';
import type { StructureSubjectRef } from './job.js';

export type { StructureSubjectRef } from './job.js';

/** 结构化 job 初始 progress（永不裸转圈：连接即有「补全字段」子任务可点亮，§3.2）。structure_state 真源在 capability_versions。 */
function initialStructureProgress(): {
  percent: number;
  phrase: string;
  subtasks: Array<{ key: string; label: string; status: 'pending' }>;
  items: never[];
} {
  return {
    percent: 0,
    phrase: '正在准备结构化…',
    subtasks: [{ key: 'fields', label: '补全字段', status: 'pending' }],
    items: [],
  };
}

/** eventsUrl 构造（端点 D，前端直连结构化字段流 SSE，§4.C StartStructureResult.eventsUrl）。 */
export function structureEventsUrl(versionId: string): string {
  return SSE_ROUTES.structureEvents(versionId);
}

export interface CreatedStructureJob {
  jobId: string;
  versionId: string;
  /** 入队是否成功（失败留 queued 交 sweeper 补投；仅观测/对账用）。 */
  enqueued: boolean;
  /** 是否回放了既有运行中 job（true = 未新建，复用运行中 jobId，§4.C 幂等）。 */
  replayed: boolean;
}

/** version 级硬锁结果：null=非 draft/不存在/非本人；'locked'=已有未终态同 version job（423，Codex P1-4）。 */
export type CreateStructureJobOutcome = CreatedStructureJob | null | 'locked';

/** PG 唯一冲突（version 级硬锁 uq_structure_job_active_version 命中）= 已有未终态同 version structure job。 */
export function isStructureVersionLockConflict(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: unknown; constraint?: unknown };
  return (
    e.code === '23505' &&
    (e.constraint === 'uq_structure_job_active_version' || e.constraint === undefined)
  );
}

/**
 * 查某 version 是否已有【未终态】structure job（subject_ref.versionId == versionId）。有 → 回放其 jobId（不重复跑）。
 *   §4.C「同 version 重复发起回放同一 jobId；已 running 的同 version 直接回放运行中 jobId」。
 *   subject_ref->>'versionId' 内联匹配；status NOT IN 终态；按 created_at 取最近一条。
 */
async function findRunningStructureJob(
  db: Queryable,
  versionId: string,
  ownerUserId: string,
): Promise<string | null> {
  const res = await db.query<{ id: string }>(
    `SELECT id FROM jobs
      WHERE type = 'structure'
        AND owner_user_id = $2
        AND subject_ref->>'versionId' = $1
        AND status IN ('queued','running')
      ORDER BY created_at DESC
      LIMIT 1`,
    [versionId, ownerUserId],
  );
  return res.rows[0]?.id ?? null;
}

/**
 * 受保护建 structure job（§11.A 模板②：INSERT 数据源内联属主 + draft 闸校验，焊死归属，杜绝越权建 job）。
 *   建 job 与「version 属本人 AND status='draft'」绑进同一条 INSERT...SELECT FROM capability_versions JOIN capabilities：
 *     - version 不存在/非本人 → SELECT 无行 → 0 行 → 返回 null（调用方 404，由 handler 据 readVersion 已分类，此处兜底）。
 *     - version 非 draft（已发布）→ WHERE status='draft' 无行 → 0 行 → 返回 null（调用方 409 STATE_CONFLICT，已由 handler 分类）。
 *   owner_user_id 取自 capabilities.creator_user_id（血缘焊死，不靠入参传 owner）。
 */
export async function insertStructureJobTx(
  db: QueryableDb,
  versionId: string,
  ownerUserId: string,
  subjectRef: StructureSubjectRef,
): Promise<string | null> {
  const res = await db.query<{ id: string }>(
    `INSERT INTO jobs (type, status, owner_user_id, subject_ref, progress, fence_token)
     SELECT 'structure', 'queued', c.creator_user_id, $2::jsonb, $3::jsonb, 1
       FROM capability_versions v
       JOIN capabilities c ON c.id = v.capability_id
      WHERE v.id = $1
        AND c.creator_user_id = $4
        AND v.status = 'draft'
     RETURNING id`,
    [
      versionId,
      JSON.stringify(subjectRef),
      JSON.stringify(initialStructureProgress()),
      ownerUserId,
    ],
  );
  return res.rows[0]?.id ?? null;
}

export async function enqueueStructure(
  queue: Pick<QueuePort, 'enqueue'>,
  jobId: string,
  traceId?: string,
): Promise<boolean> {
  try {
    await queue.enqueue('structure', jobId as never, 1, traceId);
    return true;
  } catch {
    // 入队失败：job 已建成 queued，**不删/不标 failed**——交 staleQueued sweeper 按既有 fence 补投。
    return false;
  }
}

/**
 * 发起结构化（§4.C，mode='full'）。同 version 已有未终态 job → 回放其 jobId（不重复跑）。否则建 job + 入队。
 *   fields 子集（可选）随 subject_ref 下发，worker 续传只补未生成（贯穿-28）。
 *   返回 null = version 非 draft/不存在/非本人（由路由层先经 readVersion 分类；此处兜底返回 null → 调用方 404/409）。
 */
export async function createStructureJob(
  db: Queryable,
  queue: Pick<QueuePort, 'enqueue'>,
  args: { versionId: string; ownerUserId: string; fields?: SoftFieldKey[]; traceId?: string },
): Promise<CreatedStructureJob | null> {
  // 1) 版本级幂等：已有未终态 structure job → 回放（不重复跑、不重复字段，§4.C）。
  const running = await findRunningStructureJob(db, args.versionId, args.ownerUserId);
  if (running) {
    return { jobId: running, versionId: args.versionId, enqueued: true, replayed: true };
  }
  // 2) 建新 job（受保护，draft 闸内联）。version 级硬锁（uq_structure_job_active_version）做并发兜底：
  //    「查后插」之间另一并发请求抢先插了同 version 未终态 job → 本次 INSERT 唯一冲突 → 回查回放（不双跑、不覆盖，Codex P1-4）。
  const subjectRef: StructureSubjectRef = {
    versionId: args.versionId,
    mode: 'full',
    ...(args.fields && args.fields.length > 0 ? { fields: args.fields } : {}),
  };
  let jobId: string | null;
  try {
    jobId = await insertStructureJobTx(db, args.versionId, args.ownerUserId, subjectRef);
  } catch (err) {
    if (isStructureVersionLockConflict(err)) {
      // 并发抢锁失败：回查胜出的那个未终态 job 回放（full 语义幂等：同 version 重复发起回放同一 jobId）。
      const winner = await findRunningStructureJob(db, args.versionId, args.ownerUserId);
      if (winner) {
        return { jobId: winner, versionId: args.versionId, enqueued: true, replayed: true };
      }
      return null; // 极端：冲突但回查不到（胜出 job 瞬间终态/取消）→ 让上层兜底（重试）。
    }
    throw err;
  }
  if (!jobId) return null; // 非 draft/不存在/非本人。
  const enqueued = await enqueueStructure(queue, jobId, args.traceId);
  return { jobId, versionId: args.versionId, enqueued, replayed: false };
}

// 注：单字段重生成（§4.F，mode='single-field'）的【建 job + 置 generating】已合并为同事务原子操作，
//   见 structure-edit-repo.ts 的 acquireRegenerateFieldJob（Codex r2 P1：取 version 锁与置 generating 必须原子，
//   锁冲突整体回滚、structure_state 不变）。本文件只导出底层 insertStructureJobTx / enqueueStructure /
//   isStructureVersionLockConflict 供其在事务内复用。

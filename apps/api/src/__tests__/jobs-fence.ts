// 共享测试夹具：内存假 PG（按 jobs 受保护写入语义模拟 fence/lease/状态机，无真 PG）。
//   只实现 runtime 模块用到的 SQL 形态：claimLease / renewLease / persistProgress / completeJob /
//   failJob / cancelJob / reclaimExpired / SELECT type|owner_user_id,progress。
//   语义严格对齐脊柱 §6/§11.A：fence 守门、status='running' 守门、换 fence 等。
import type { Queryable, QueryResultLike } from '../jobs/types.js';

export interface FakeJob {
  id: string;
  type: string;
  status: string;
  owner_user_id: string;
  subject_ref: unknown;
  progress: unknown;
  result: unknown;
  error: unknown;
  attempt_no: number;
  lease_owner: string | null;
  lease_until: number | null; // epoch ms（null = 无租约）
  fence_token: number;
  started_at: number | null;
  finished_at: number | null;
  /** 最近更新时刻（epoch ms）；staleQueued 据 updated_at < now()-threshold 判停滞（Codex P1-r2）。 */
  updated_at: number;
}

export interface FakeClock {
  now: number;
}

/** 建一个 queued job。 */
export function makeJob(id: string, over: Partial<FakeJob> = {}): FakeJob {
  return {
    id,
    type: 'import',
    status: 'queued',
    owner_user_id: 'user-1',
    subject_ref: null,
    progress: {},
    result: null,
    error: null,
    attempt_no: 0,
    lease_owner: null,
    lease_until: null,
    fence_token: 0,
    started_at: null,
    finished_at: null,
    updated_at: 0, // 默认很久以前：queued 视作已停滞（测 staleQueued 补投，可被 over 覆盖）。
    ...over,
  };
}

function ok<R>(rows: R[]): QueryResultLike<R> {
  return { rows, rowCount: rows.length };
}

/**
 * 内存假 PG。按 SQL 关键片段路由到对应 jobs 语义。clock 可注入以测「lease 过期」。
 *   记录 queries 便于断言「未双写」。
 */
export class FakeDb implements Queryable {
  readonly queries: string[] = [];
  constructor(
    private readonly jobs: Map<string, FakeJob>,
    private readonly clock: FakeClock,
  ) {}

  async query<R = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<QueryResultLike<R>> {
    this.queries.push(sql);
    const now = this.clock.now;

    // —— claimLease：UPDATE ... SET status='running', lease_owner=$2, fence/attempt 按 CASE 决定是否 +1 ... ——
    //    （Codex P1-r5：已被 reclaim 的行只接管租约不递增；queued/仍占用过期行才递增。匹配以 lease_owner=$2 区别于 reclaimExpired 的 lease_owner=NULL）
    if (sql.includes("status        = 'running'") && sql.includes('lease_owner   = $2')) {
      const jobId = params[0] as string;
      const leaseOwner = params[1] as string;
      const ttlMs = params[2] as number;
      const j = this.jobs.get(jobId);
      const claimable =
        j &&
        (j.status === 'queued' ||
          (j.status === 'running' && (j.lease_until === null || j.lease_until < now)));
      if (!j || !claimable) return ok<R>([]);
      // 已被 reclaimExpired 接管的行（running 无主 + 租约过去）：只接管租约、不再递增
      //   （递增已在 reclaim 时发生）。否则（queued / 仍占用的过期 running）走递增路径（新 attempt）。
      //   忠实复刻 repo.claimLease 的 CASE（Codex P1-r5：恰好递增一次，绝不 N+2）。
      const isReclaimed = j.status === 'running' && j.lease_owner === null;
      j.status = 'running';
      if (!isReclaimed) {
        j.attempt_no += 1;
        j.fence_token += 1;
      }
      j.lease_owner = leaseOwner;
      j.lease_until = now + ttlMs;
      if (j.started_at === null) j.started_at = now;
      return ok<R>([
        {
          id: j.id,
          type: j.type,
          owner_user_id: j.owner_user_id,
          subject_ref: j.subject_ref,
          progress: j.progress,
          attempt_no: j.attempt_no,
          fence_token: j.fence_token,
        },
      ] as R[]);
    }

    // —— renewLease：UPDATE ... SET lease_until ... WHERE id AND fence_token AND status='running' ——
    if (sql.includes('SET lease_until = now()') && sql.includes('fence_token = $2')) {
      const jobId = params[0] as string;
      const fence = params[1] as number;
      const ttlMs = params[2] as number;
      const j = this.jobs.get(jobId);
      if (!j || j.fence_token !== fence || j.status !== 'running')
        return { rows: [], rowCount: 0 } as QueryResultLike<R>;
      j.lease_until = now + ttlMs;
      return { rows: [], rowCount: 1 } as QueryResultLike<R>;
    }

    // —— persistProgress：WITH guard ... UPDATE jobs SET progress=$3 ... ——
    if (sql.includes('SET progress = $3::jsonb') && sql.includes('guard')) {
      const jobId = params[0] as string;
      const fence = params[1] as number;
      const progress = JSON.parse(params[2] as string);
      const j = this.jobs.get(jobId);
      if (!j || j.fence_token !== fence || j.status !== 'running')
        return { rows: [], rowCount: 0 } as QueryResultLike<R>;
      j.progress = progress;
      return { rows: [], rowCount: 1 } as QueryResultLike<R>;
    }

    // —— completeJob：WITH guard ... SET status='completed', result=$3, progress=$4 ... ——
    if (sql.includes("status      = 'completed'")) {
      const jobId = params[0] as string;
      const fence = params[1] as number;
      const j = this.jobs.get(jobId);
      if (!j || j.fence_token !== fence || j.status !== 'running')
        return { rows: [], rowCount: 0 } as QueryResultLike<R>;
      j.status = 'completed';
      j.result = JSON.parse(params[2] as string);
      j.progress = JSON.parse(params[3] as string);
      j.error = null;
      j.finished_at = now;
      return { rows: [], rowCount: 1 } as QueryResultLike<R>;
    }

    // —— failJob：WITH guard ... SET status='failed', error=$3 ... ——
    if (sql.includes("status      = 'failed'")) {
      const jobId = params[0] as string;
      const fence = params[1] as number;
      const j = this.jobs.get(jobId);
      if (!j || j.fence_token !== fence || j.status !== 'running')
        return { rows: [], rowCount: 0 } as QueryResultLike<R>;
      j.status = 'failed';
      j.error = JSON.parse(params[2] as string);
      j.finished_at = now;
      return { rows: [], rowCount: 1 } as QueryResultLike<R>;
    }

    // —— cancelJob：UPDATE ... SET status='cancelled', fence_token+1 ... WHERE owner AND status IN (queued,running) ——
    if (sql.includes("status      = 'cancelled'")) {
      const jobId = params[0] as string;
      const owner = params[1] as string;
      const j = this.jobs.get(jobId);
      if (!j || j.owner_user_id !== owner || (j.status !== 'queued' && j.status !== 'running'))
        return ok<R>([]);
      j.status = 'cancelled';
      j.fence_token += 1;
      j.lease_owner = null;
      j.lease_until = null;
      j.finished_at = now;
      return ok<R>([{ fence_token: j.fence_token }] as R[]);
    }

    // —— reclaimExpired：UPDATE ... fence_token+1 ... WHERE status='running' AND lease_owner IS NOT NULL AND lease_until<now() ——
    //    （Codex P0-3：只接管 worker 持租后死/卡的；lease_owner IS NULL 的已接管态走 requeuePending）
    if (
      sql.includes('attempt_no  = attempt_no + 1') &&
      sql.includes('fence_token = fence_token + 1')
    ) {
      const limit = params[0] as number;
      const expired = [...this.jobs.values()]
        .filter(
          (j) =>
            j.status === 'running' &&
            j.lease_owner !== null &&
            j.lease_until !== null &&
            j.lease_until < now,
        )
        .slice(0, limit);
      const out = expired.map((j) => {
        j.attempt_no += 1;
        j.fence_token += 1;
        j.lease_owner = null;
        // 关键修复：置为【已过去 1 秒】（now - 1000ms）而非 NULL → 严格早于后续 now()，
        //   仍可被 claimLease 接管，且下一轮 requeuePending（lease_until < now）能补扫到（无边界相等歧义）。
        j.lease_until = now - 1_000;
        return { id: j.id, fence_token: j.fence_token, attempt_no: j.attempt_no };
      });
      return ok<R>(out as R[]);
    }

    // —— staleQueued：SELECT ... WHERE status='queued' AND lease_owner IS NULL AND updated_at<now()-threshold ——
    //    （Codex P1-r2：建后入队失败被吞、长时间仍 queued 无主的 job；sweeper 用既有 fence 补投，不换 fence/attempt）
    if (
      sql.includes('SELECT id, fence_token, attempt_no') &&
      sql.includes("status = 'queued'") &&
      sql.includes('updated_at < now()')
    ) {
      const thresholdMs = params[0] as number;
      const limit = params[1] as number;
      const out = [...this.jobs.values()]
        .filter(
          (j) =>
            j.status === 'queued' && j.lease_owner === null && j.updated_at < now - thresholdMs,
        )
        .slice(0, limit)
        .map((j) => ({ id: j.id, fence_token: j.fence_token, attempt_no: j.attempt_no }));
      return ok<R>(out as R[]);
    }

    // —— deleteQueuedJob：DELETE FROM jobs WHERE id AND status='queued' AND lease_owner IS NULL ——
    if (sql.includes('DELETE FROM jobs')) {
      const jobId = params[0] as string;
      const j = this.jobs.get(jobId);
      if (!j || j.status !== 'queued' || j.lease_owner !== null)
        return { rows: [], rowCount: 0 } as QueryResultLike<R>;
      this.jobs.delete(jobId);
      return { rows: [], rowCount: 1 } as QueryResultLike<R>;
    }

    // —— failQueuedJob：UPDATE jobs SET status='failed' ... WHERE id AND status='queued' ——
    if (sql.includes('UPDATE jobs') && sql.includes("status = 'failed'")) {
      const jobId = params[0] as string;
      const j = this.jobs.get(jobId);
      if (!j || j.status !== 'queued') return { rows: [], rowCount: 0 } as QueryResultLike<R>;
      j.status = 'failed';
      j.error = JSON.parse(params[1] as string);
      j.finished_at = now;
      return { rows: [], rowCount: 1 } as QueryResultLike<R>;
    }

    // —— requeuePending：SELECT ... WHERE status='running' AND lease_owner IS NULL AND lease_until<now() ——
    //    （Codex P0-3：已被接管换过 fence、但入队失败、至今无主的 job；补入队用既有 fence，不再换）
    if (
      sql.includes('SELECT id, fence_token, attempt_no') &&
      sql.includes('lease_owner IS NULL') &&
      sql.includes('lease_until < now()')
    ) {
      const limit = params[0] as number;
      const out = [...this.jobs.values()]
        .filter(
          (j) =>
            j.status === 'running' &&
            j.lease_owner === null &&
            j.lease_until !== null &&
            j.lease_until < now,
        )
        .sort((a, b) => (a.lease_until ?? 0) - (b.lease_until ?? 0))
        .slice(0, limit)
        .map((j) => ({ id: j.id, fence_token: j.fence_token, attempt_no: j.attempt_no }));
      return ok<R>(out as R[]);
    }

    // —— SELECT type FROM jobs WHERE id ——
    if (sql.includes('SELECT type FROM jobs')) {
      const j = this.jobs.get(params[0] as string);
      return ok<R>(j ? ([{ type: j.type }] as R[]) : []);
    }

    // —— readJobStatus：SELECT status FROM jobs WHERE id（Codex P1-4 fence-out 区分真取消 vs 接管）——
    if (sql.includes('SELECT status FROM jobs')) {
      const j = this.jobs.get(params[0] as string);
      return ok<R>(j ? ([{ status: j.status }] as R[]) : []);
    }

    // —— SELECT owner_user_id FROM jobs WHERE id（SSE 建流前 owner 校验，只读 owner——Codex P0-1）——
    if (sql.includes('SELECT owner_user_id FROM jobs')) {
      const j = this.jobs.get(params[0] as string);
      return ok<R>(j ? ([{ owner_user_id: j.owner_user_id }] as R[]) : []);
    }

    // —— SELECT status, progress, result, error FROM jobs WHERE id（SSE snapshot/终态判定——Codex P0-1）——
    //    在 latestId 锚点【之后】读，保证 snapshot 不早于锚点（TOCTOU 消除）。
    if (sql.includes('SELECT status, progress, result, error FROM jobs')) {
      const j = this.jobs.get(params[0] as string);
      return ok<R>(
        j
          ? ([{ status: j.status, progress: j.progress, result: j.result, error: j.error }] as R[])
          : [],
      );
    }

    throw new Error(`FakeDb: unhandled SQL: ${sql.slice(0, 80)}`);
  }
}

/** 收集 publish 的桥（断言推帧）。 */
export class FakeBridge {
  readonly published: Array<{ jobId: string; event: string; payload: unknown }> = [];
  async publish(jobId: string, frame: { event: string; payload: unknown }): Promise<string | null> {
    this.published.push({ jobId, event: frame.event, payload: frame.payload });
    return `${this.published.length}-0`;
  }
}

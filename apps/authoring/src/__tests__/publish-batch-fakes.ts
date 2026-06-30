// 50 批量发布单测夹具：内存假 PG，忠实模拟 batch-repo + publish-batch handler 的查询形态。
//   - 复用 PublishFakeDb 承接 publish-one 的 SQL（版本/能力/publications/tiers/outbox + 发布门单事务记账）。
//   - 本类追加 batch 三表：jobs、publish_batches、publish_batch_items，忠实模拟（合规清单）：
//       · publish_batch_items.idempotency_key UNIQ（ON CONFLICT DO NOTHING）：同 item 重发不重复建项（无连坐第一道）。
//       · publish_batches.processed_count = GENERATED(published_count + failed_count)（不直写，随计数自洽）。
//       · 模板 A（中间态推进）：fence 经 item→batch→job 内联校验（j.fence_token=:fence AND j.status='running'），
//         单语句、终态不可回退；rowCount=0 = 已被 fence out。
//       · 模板 B（item 终态 + 计数，合成单条 CTE）：item 终态 UPDATE 带防重 `state NOT IN(published,failed)`，
//         计数只按实际迁移行递增（0 行→0 递增）；末 SELECT 恒返一行（moved/batch_completed）。
//       · 重试 tx：仅 failed→pending、failed_count-1 复位、job 换 fence + 置 queued。
//   事务记账：connect() 句柄 BEGIN 打快照、COMMIT 落盘、ROLLBACK 还原（验原子性）。
import type { QueryResultLike } from '../platform/jobs/types.js';
import type { ErrorBody } from '@cb/shared';
import {
  PublishFakeDb,
  seedUser as seedPublishUser,
  seedCapabilityVersion as seedPublishCapVersion,
  genId,
} from './publish-fakes.js';

function ok<R>(rows: R[], rowCount = rows.length): QueryResultLike<R> {
  return { rows, rowCount };
}

export interface JobRowFake {
  id: string;
  type: string;
  status: string;
  owner_user_id: string;
  fence_token: number;
  attempt_no: number;
}
export interface BatchRowFake {
  id: string;
  owner_user_id: string;
  job_id: string;
  total: number;
  published_count: number;
  failed_count: number;
  status: string;
}
export interface BatchItemRowFake {
  id: string;
  batch_id: string;
  candidate_id: string | null;
  version_id: string | null;
  capability_id: string | null;
  idempotency_key: string;
  state: string;
  missing_fields: string[] | null;
  error: ErrorBody | null;
  attempt_no: number;
  subject: unknown;
  created_at: number;
}

interface BatchSnapshot {
  jobs: Map<string, JobRowFake>;
  batches: Map<string, BatchRowFake>;
  items: Map<string, BatchItemRowFake>;
}

/** processed_count generated 列（=published+failed）。 */
function processed(b: BatchRowFake): number {
  return b.published_count + b.failed_count;
}

/**
 * 批量发布假 PG。继承 PublishFakeDb（承接 publish-one 全部 SQL + 发布门事务记账），追加 batch 三表 SQL。
 *   同一连接句柄复用 query（事务记账由 BEGIN/COMMIT/ROLLBACK 在 query 内处理，含 batch 三表快照）。
 */
export class PublishBatchFakeDb extends PublishFakeDb {
  jobs = new Map<string, JobRowFake>();
  batches = new Map<string, BatchRowFake>();
  items = new Map<string, BatchItemRowFake>();
  private itemSeq = 0;
  private batchSnapshot: BatchSnapshot | null = null;

  private takeBatchSnapshot(): void {
    this.batchSnapshot = {
      jobs: new Map([...this.jobs].map(([k, v]) => [k, { ...v }])),
      batches: new Map([...this.batches].map(([k, v]) => [k, { ...v }])),
      items: new Map([...this.items].map(([k, v]) => [k, { ...v }])),
    };
  }
  private restoreBatchSnapshot(): void {
    if (!this.batchSnapshot) return;
    this.jobs = this.batchSnapshot.jobs;
    this.batches = this.batchSnapshot.batches;
    this.items = this.batchSnapshot.items;
    this.batchSnapshot = null;
  }

  override async query<R = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<QueryResultLike<R>> {
    // 事务边界：批三表快照与 PublishFakeDb 快照各自记账（同连接同事务）。
    if (sql === 'BEGIN') {
      this.takeBatchSnapshot();
      return super.query<R>(sql, params);
    }
    if (sql === 'COMMIT') {
      this.batchSnapshot = null;
      return super.query<R>(sql, params);
    }
    if (sql === 'ROLLBACK') {
      this.restoreBatchSnapshot();
      return super.query<R>(sql, params);
    }

    // —— 建批：INSERT jobs(type='publish_batch') ——
    if (sql.includes('INSERT INTO jobs') && sql.includes("'publish_batch'")) {
      const id = genId('job');
      this.jobs.set(id, {
        id,
        type: 'publish_batch',
        status: 'queued',
        owner_user_id: params[0] as string,
        fence_token: 1,
        attempt_no: 0,
      });
      return ok<R>([{ id }] as R[], 1);
    }

    // —— 建批：INSERT publish_batches ——
    if (sql.includes('INSERT INTO publish_batches') && sql.includes('VALUES')) {
      const id = genId('batch');
      this.batches.set(id, {
        id,
        owner_user_id: params[0] as string,
        job_id: params[1] as string,
        total: Number(params[2]),
        published_count: 0,
        failed_count: 0,
        status: 'queued',
      });
      return ok<R>([{ id }] as R[], 1);
    }

    // —— 建批：INSERT publish_batch_items ON CONFLICT (idempotency_key) DO NOTHING RETURNING id ——
    if (
      sql.includes('INSERT INTO publish_batch_items') &&
      sql.includes('ON CONFLICT (idempotency_key)')
    ) {
      const batchId = params[0] as string;
      const candidateId = (params[1] as string) ?? null;
      const versionId = (params[2] as string) ?? null;
      const idemKey = params[3] as string;
      const subject = JSON.parse(params[4] as string);
      // idempotency_key UNIQ：已存在（请求内重复 / 全局撞键）→ DO NOTHING，RETURNING 0 行（建批 RETURNING 计数据此判 total 缺口回滚）。
      if ([...this.items.values()].some((i) => i.idempotency_key === idemKey)) {
        return ok<R>([], 0);
      }
      const id = genId('item');
      this.itemSeq += 1;
      this.items.set(id, {
        id,
        batch_id: batchId,
        candidate_id: candidateId,
        version_id: versionId,
        capability_id: null,
        idempotency_key: idemKey,
        state: 'pending',
        missing_fields: null,
        error: null,
        attempt_no: 0,
        subject,
        created_at: this.itemSeq,
      });
      // RETURNING id：成功落库返 1 行（建批据 rows.length 累加 insertedCount）。
      return ok<R>([{ id }] as R[], 1);
    }

    // —— 读批：SELECT ... FROM publish_batches WHERE id = $1 ——
    if (
      sql.includes('FROM publish_batches') &&
      sql.includes('WHERE id = $1') &&
      sql.includes('published_count')
    ) {
      const b = this.batches.get(params[0] as string);
      if (!b) return ok<R>([]);
      return ok<R>([
        {
          id: b.id,
          owner_user_id: b.owner_user_id,
          job_id: b.job_id,
          total: b.total,
          published_count: b.published_count,
          failed_count: b.failed_count,
          processed_count: processed(b),
          status: b.status,
        },
      ] as R[]);
    }

    // —— 读批 by job：SELECT ... FROM publish_batches WHERE job_id = $1 ——
    if (sql.includes('FROM publish_batches') && sql.includes('WHERE job_id = $1')) {
      const b = [...this.batches.values()].find((x) => x.job_id === params[0]);
      if (!b) return ok<R>([]);
      return ok<R>([
        {
          id: b.id,
          owner_user_id: b.owner_user_id,
          total: b.total,
          processed_count: processed(b),
        },
      ] as R[]);
    }

    // —— 读批内全部 item：FROM publish_batch_items WHERE batch_id = $1 ORDER BY created_at ——
    if (
      sql.includes('FROM publish_batch_items') &&
      sql.includes('WHERE batch_id = $1') &&
      sql.includes('ORDER BY created_at')
    ) {
      const rows = [...this.items.values()]
        .filter((i) => i.batch_id === params[0])
        .sort((a, b) => a.created_at - b.created_at)
        .map((i) => this.itemSelectShape(i));
      return ok<R>(rows as R[]);
    }

    // —— 读单 item：WHERE id = $1 AND batch_id = $2 ——
    if (
      sql.includes('FROM publish_batch_items') &&
      sql.includes('WHERE id = $1 AND batch_id = $2')
    ) {
      const i = this.items.get(params[0] as string);
      if (!i || i.batch_id !== params[1]) return ok<R>([]);
      return ok<R>([this.itemSelectShape(i)] as R[]);
    }

    // —— ②.5 早回填 versionId：WITH guard ... UPDATE publish_batch_items ... SET version_id=$4 ... WHERE bi.version_id IS NULL ——
    //   受保护单语句（fence 经 item→batch→job）；仅 item 尚无 version_id 时回填（幂等防覆盖）；不动 state、不触计数。
    if (
      sql.includes('UPDATE publish_batch_items bi') &&
      sql.includes('SET version_id = $4') &&
      sql.includes('bi.version_id IS NULL')
    ) {
      const itemId = params[0] as string;
      const jobId = params[1] as string;
      const fence = Number(params[2]);
      const versionId = params[3] as string;
      const capabilityId = (params[4] as string) ?? null;
      const moved = this.fenceMoveItem(itemId, jobId, fence, (i) => {
        // 幂等：仅尚无 version_id 时回填（重投/并发不覆盖既有值）。
        if (i.version_id) return false;
        i.version_id = versionId;
        if (capabilityId) i.capability_id = capabilityId;
        return true;
      });
      return ok<R>([], moved ? 1 : 0);
    }

    // —— 模板 A：item 进中间态（WITH guard ... UPDATE publish_batch_items ... state NOT IN(published,failed)，单状态参数）——
    if (
      sql.includes('UPDATE publish_batch_items bi') &&
      sql.includes("bi.state NOT IN ('published','failed')") &&
      !sql.includes('moved') // 模板 A 无 moved CTE（区分模板 B）
    ) {
      const itemId = params[0] as string;
      const jobId = params[1] as string;
      const fence = Number(params[2]);
      const state = params[3] as string;
      const versionId = (params[4] as string) ?? null;
      const capabilityId = (params[5] as string) ?? null;
      const moved = this.fenceMoveItem(itemId, jobId, fence, (i) => {
        if (i.state === 'published' || i.state === 'failed') return false;
        i.state = state;
        if (versionId) i.version_id = versionId;
        if (capabilityId) i.capability_id = capabilityId;
        return true;
      });
      return ok<R>([], moved ? 1 : 0);
    }

    // —— 模板 B：item 终态 + batch 计数（合成单条 CTE；含 moved CTE）——
    if (sql.includes('moved AS (') && sql.includes('UPDATE publish_batches b')) {
      const itemId = params[0] as string;
      const jobId = params[1] as string;
      const fence = Number(params[2]);
      const state = params[3] as string; // 'published' | 'failed'
      const error = params[4] != null ? (JSON.parse(params[4] as string) as ErrorBody) : null;
      const missingFields = (params[5] as string[]) ?? null;
      const versionId = (params[6] as string) ?? null;
      const capabilityId = (params[7] as string) ?? null;

      let moved = false;
      let batchCompleted = false;
      this.fenceMoveItem(itemId, jobId, fence, (i, b) => {
        // 防重：仅「非终态→终态」迁移（重复回写命中 0 行、计数 +0）。
        if (i.state === 'published' || i.state === 'failed') return false;
        i.state = state;
        i.error = error;
        i.missing_fields = missingFields;
        if (versionId) i.version_id = versionId;
        if (capabilityId) i.capability_id = capabilityId;
        moved = true;
        // batch 计数只按实际迁移行递增。
        if (state === 'published') b.published_count += 1;
        else b.failed_count += 1;
        if (processed(b) >= b.total) {
          b.status = 'completed';
          batchCompleted = true;
        } else {
          b.status = 'running';
        }
        return true;
      });
      return ok<R>([{ batch_completed: batchCompleted, moved }] as R[], 1);
    }

    // —— 重试：守门复位 UPDATE publish_batch_items ... state='pending' ... WHERE state='failed' ——
    if (
      sql.includes('UPDATE publish_batch_items') &&
      sql.includes("state = 'pending'") &&
      sql.includes("state = 'failed'")
    ) {
      const itemId = params[0] as string;
      const batchId = params[1] as string;
      const subject = JSON.parse(params[2] as string);
      const i = this.items.get(itemId);
      if (!i || i.batch_id !== batchId || i.state !== 'failed') return ok<R>([], 0);
      i.state = 'pending';
      i.error = null;
      i.missing_fields = null;
      i.attempt_no += 1;
      i.subject = subject;
      return ok<R>([], 1);
    }

    // —— 重试：批计数复位 failed_count-1 + status='running' ——
    if (
      sql.includes('UPDATE publish_batches') &&
      sql.includes('failed_count = GREATEST(failed_count - 1, 0)')
    ) {
      const b = this.batches.get(params[0] as string);
      if (!b) return ok<R>([], 0);
      b.failed_count = Math.max(b.failed_count - 1, 0);
      b.status = 'running';
      return ok<R>([], 1);
    }

    // —— 重试：批 job 换 fence + 置 queued ——
    if (
      sql.includes('UPDATE jobs') &&
      sql.includes("status = 'queued'") &&
      sql.includes('fence_token = fence_token + 1') &&
      sql.includes('RETURNING fence_token')
    ) {
      const j = this.jobs.get(params[0] as string);
      if (!j) return ok<R>([], 0);
      j.status = 'queued';
      j.fence_token += 1;
      j.attempt_no += 1;
      return ok<R>([{ fence_token: j.fence_token }] as R[], 1);
    }

    // 其余 SQL（publish-one：版本/能力/publications/tiers/outbox/发布门）下沉 PublishFakeDb。
    return super.query<R>(sql, params);
  }

  /** 模板 A/B 公用：fence 经 item→batch→job 内联校验通过则执行 mut（返回 mut 结果作 moved）。 */
  private fenceMoveItem(
    itemId: string,
    jobId: string,
    fence: number,
    mut: (item: BatchItemRowFake, batch: BatchRowFake) => boolean,
  ): boolean {
    const i = this.items.get(itemId);
    if (!i) return false;
    const b = this.batches.get(i.batch_id);
    if (!b) return false;
    const j = this.jobs.get(jobId);
    // fence 守门：j.id=:jobId AND j.fence_token=:fence AND j.status='running'（失配 → 0 行，安全退出）。
    if (!j || j.id !== b.job_id || j.fence_token !== fence || j.status !== 'running') return false;
    return mut(i, b);
  }

  private itemSelectShape(i: BatchItemRowFake): Record<string, unknown> {
    return {
      id: i.id,
      batch_id: i.batch_id,
      candidate_id: i.candidate_id,
      version_id: i.version_id,
      capability_id: i.capability_id,
      idempotency_key: i.idempotency_key,
      state: i.state,
      missing_fields: i.missing_fields,
      error: i.error,
      attempt_no: i.attempt_no,
      subject: i.subject,
    };
  }

  /** 测试辅助：把批 job 置 running + 指定 fence（模拟 worker 领租约后执行态）。 */
  startJob(jobId: string, fenceToken = 1): void {
    const j = this.jobs.get(jobId);
    if (j) {
      j.status = 'running';
      j.fence_token = fenceToken;
    }
  }
}

export { seedPublishUser as seedUser, seedPublishCapVersion as seedCapabilityVersion, genId };

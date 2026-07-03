// 提取域单测共享夹具：内存假 PG（jobs / session_segments / capability_candidates / candidate_evidence）+ mock LLM 网关 + mock txPool。
//   忠实模拟 extract-repo.ts / handlers/extract.ts 用到的受保护写入 SQL 形态与 fence/去重/复合 FK 语义：
//     - 建候选（INSERT...SELECT FROM jobs WHERE fence+running ON CONFLICT(extract_job_id,slug) DO NOTHING）：fence 失配/去重 → 0 行。
//     - 写证据（INSERT...SELECT FROM jobs WHERE fence+running ON CONFLICT(candidate_id,segment_id) DO NOTHING）：复合 FK 钉死同快照（跨快照 → 抛 FK 违反）。
//     - 回填 segment_count（UPDATE...FROM jobs WHERE fence+running）：fence 失配 → 0 行。
//     - retry：DELETE 旧证据 / UPDATE ready / UPDATE failed（fence 守门）。
//   无真 PG / 无 Docker。
import type { Queryable, QueryResultLike } from '../platform/jobs/types.js';
import type { LlmGatewayPort, LlmResult } from '@cb/shared';

export interface JobRowF {
  id: string;
  type: string;
  status: string;
  owner_user_id: string;
  subject_ref: unknown;
  progress: unknown;
  fence_token: number;
}

export interface SegmentRowF {
  id: string;
  snapshot_id: string;
  title: string | null;
  source: string | null;
  project: string | null;
  happened_at: string | null;
  content: string;
  message_count: number;
}

export interface CandidateRowF {
  id: string;
  extract_job_id: string;
  snapshot_id: string;
  owner_user_id: string;
  status: string;
  error: unknown | null;
  retry_cnt: number;
  slug: string;
  name: string | null;
  intent: string | null;
  type: string | null;
  confidence: string | null;
  segment_count: number | null;
  frequency_ratio: number | null;
  reusability: number | null;
  scope_coherence: number | null;
  split_suggested: boolean;
  scope: unknown | null;
  reusability_breakdown: unknown | null;
  created_at: string;
}

export interface EvidenceRowF {
  id: string;
  candidate_id: string;
  segment_id: string;
  snapshot_id: string;
}

function ok<R>(rows: R[]): QueryResultLike<R> {
  return { rows, rowCount: rows.length };
}

let seq = 0;
function genId(prefix: string): string {
  seq += 1;
  return `${prefix}-${String(seq).padStart(6, '0')}`;
}

/** 内存假 PG（提取域）。记录 queries 供断言（如「未两步查写」）。 */
export class ExtractFakeDb implements Queryable {
  readonly queries: Array<{ sql: string; params: unknown[] }> = [];
  readonly jobs = new Map<string, JobRowF>();
  readonly segments = new Map<string, SegmentRowF>();
  readonly candidates = new Map<string, CandidateRowF>();
  readonly evidence = new Map<string, EvidenceRowF>();
  now = 1_000_000;

  async connect(): Promise<{ query: Queryable['query']; release: () => void }> {
    return { query: this.query.bind(this) as Queryable['query'], release: () => {} };
  }

  async query<R = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<QueryResultLike<R>> {
    this.queries.push({ sql, params });

    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
      return { rows: [], rowCount: 0 } as QueryResultLike<R>;
    }

    // ---- 单候选落库/重试事务开头【独立】FOR UPDATE guard（SELECT id FROM jobs WHERE id+fence+running FOR UPDATE，Codex r2#1）----
    //   fence 匹配 + running → 1 行（行锁，忠实模拟）；失配/非 running → 0 行（调用方抛 CandidateLandingFencedOut → ROLLBACK）。
    //   排除带 UPDATE jobs 的 completeJobInTx CTE（其在 txPool 处理）。
    if (
      sql.includes('SELECT id FROM jobs') &&
      sql.includes('FOR UPDATE') &&
      !sql.includes('UPDATE jobs')
    ) {
      const jobId = params[0] as string;
      const fence = params[1] as number;
      const j = this.jobs.get(jobId);
      if (!j || j.fence_token !== fence || j.status !== 'running') return ok<R>([]);
      return ok<R>([{ id: jobId }] as R[]);
    }

    // ---- readSnapshotSegments（SELECT ... FROM session_segments WHERE snapshot_id=$1 ORDER BY id ASC）----
    if (sql.includes('FROM session_segments') && sql.includes('message_count')) {
      const snapshotId = params[0] as string;
      const rows = [...this.segments.values()]
        .filter((s) => s.snapshot_id === snapshotId)
        .sort((a, b) => (a.id < b.id ? -1 : 1));
      return ok<R>(
        rows.map((s) => ({
          id: s.id,
          snapshot_id: s.snapshot_id,
          title: s.title,
          source: s.source,
          project: s.project,
          happened_at: s.happened_at,
          content: s.content,
          message_count: s.message_count,
        })) as R[],
      );
    }

    // ---- insertCandidateProtected（INSERT INTO capability_candidates ... SELECT FROM jobs WHERE fence+running ON CONFLICT(extract_job_id,slug) DO NOTHING）----
    if (sql.includes('INSERT INTO capability_candidates')) {
      const jobId = params[0] as string;
      const fence = params[1] as number;
      const j = this.jobs.get(jobId);
      if (!j || j.fence_token !== fence || j.status !== 'running') return ok<R>([]); // fence out
      const snapshotId = params[2] as string;
      const slug = params[5] as string;
      // (extract_job_id, slug) 去重。
      for (const c of this.candidates.values()) {
        if (c.extract_job_id === jobId && c.slug === slug) return ok<R>([]); // ON CONFLICT DO NOTHING
      }
      const id = genId('cand');
      this.candidates.set(id, {
        id,
        extract_job_id: jobId,
        snapshot_id: snapshotId,
        owner_user_id: j.owner_user_id,
        status: params[3] as string,
        error: params[4] === null ? null : JSON.parse(params[4] as string),
        retry_cnt: 0,
        slug,
        name: (params[6] as string) ?? null,
        intent: (params[7] as string) ?? null,
        type: (params[8] as string) ?? null,
        confidence: (params[9] as string) ?? null,
        segment_count: (params[10] as number) ?? null,
        frequency_ratio: (params[11] as number) ?? null,
        reusability: (params[12] as number) ?? null,
        scope_coherence: (params[13] as number) ?? null,
        split_suggested: Boolean(params[14]),
        scope: params[15] === null ? null : JSON.parse(params[15] as string),
        reusability_breakdown: params[16] === null ? null : JSON.parse(params[16] as string),
        created_at: new Date(this.now).toISOString(),
      });
      return ok<R>([{ id }] as R[]);
    }

    // ---- insertEvidenceProtected / retry 重写证据（INSERT INTO candidate_evidence ... SELECT FROM jobs WHERE fence+running ON CONFLICT(candidate_id,segment_id) DO NOTHING）----
    if (sql.includes('INSERT INTO candidate_evidence')) {
      const jobId = params[0] as string;
      const fence = params[1] as number;
      const j = this.jobs.get(jobId);
      if (!j || j.fence_token !== fence || j.status !== 'running') return ok<R>([]); // fence out
      const candidateId = params[2] as string;
      const segmentId = params[3] as string;
      const snapshotId = params[4] as string;
      // 复合 FK 校验（§11.E）：候选 + 快照同源、段 + 快照同源；否则抛 FK 违反（DB 层焊死血缘）。
      const cand = this.candidates.get(candidateId);
      const seg = this.segments.get(segmentId);
      if (!cand || cand.snapshot_id !== snapshotId) {
        throw new Error('fk_evidence_candidate_snapshot violation: candidate/snapshot mismatch');
      }
      if (!seg || seg.snapshot_id !== snapshotId) {
        throw new Error('fk_evidence_segment_snapshot violation: segment/snapshot mismatch');
      }
      // (candidate_id, segment_id) 去重。
      for (const e of this.evidence.values()) {
        if (e.candidate_id === candidateId && e.segment_id === segmentId) return ok<R>([]);
      }
      const id = genId('ev');
      this.evidence.set(id, {
        id,
        candidate_id: candidateId,
        segment_id: segmentId,
        snapshot_id: snapshotId,
      });
      return ok<R>([{ id }] as R[]);
    }

    // ---- retry 删旧证据（DELETE FROM candidate_evidence ce USING jobs j WHERE ce.candidate_id=$3 AND fence+running）----
    if (sql.includes('DELETE FROM candidate_evidence')) {
      const jobId = params[0] as string;
      const fence = params[1] as number;
      const candidateId = params[2] as string;
      const j = this.jobs.get(jobId);
      if (!j || j.fence_token !== fence || j.status !== 'running')
        return { rows: [], rowCount: 0 } as QueryResultLike<R>; // fence out → 0 行
      let n = 0;
      for (const [k, e] of this.evidence) {
        if (e.candidate_id === candidateId) {
          this.evidence.delete(k);
          n++;
        }
      }
      return { rows: [], rowCount: n } as QueryResultLike<R>;
    }

    // ---- retry 回写 ready（UPDATE capability_candidates ... SET status='ready' ... FROM jobs WHERE fence+running）----
    if (sql.includes('UPDATE capability_candidates') && sql.includes("status = 'ready'")) {
      const jobId = params[0] as string;
      const fence = params[1] as number;
      const candidateId = params[2] as string;
      const j = this.jobs.get(jobId);
      const c = this.candidates.get(candidateId);
      if (!j || j.fence_token !== fence || j.status !== 'running' || !c) {
        return { rows: [], rowCount: 0 } as QueryResultLike<R>; // fence out
      }
      c.status = 'ready';
      c.error = null;
      c.name = params[3] as string;
      c.intent = params[4] as string;
      c.type = params[5] as string;
      c.confidence = params[6] as string;
      c.frequency_ratio = params[7] as number;
      c.reusability = params[8] as number;
      c.scope_coherence = params[9] as number;
      c.split_suggested = Boolean(params[10]);
      c.scope = JSON.parse(params[11] as string);
      c.reusability_breakdown = JSON.parse(params[12] as string);
      // retry_cnt 不在 worker 收尾再 +1（Codex#3 双重加一）：受理 CTE 已 +1，此处只翻状态。
      return { rows: [], rowCount: 1 } as QueryResultLike<R>;
    }

    // ---- retry 回写 failed（UPDATE capability_candidates ... SET status='failed' ... FROM jobs WHERE fence+running）----
    if (sql.includes('UPDATE capability_candidates') && sql.includes("status = 'failed'")) {
      const jobId = params[0] as string;
      const fence = params[1] as number;
      const candidateId = params[2] as string;
      const j = this.jobs.get(jobId);
      const c = this.candidates.get(candidateId);
      if (!j || j.fence_token !== fence || j.status !== 'running' || !c) {
        return { rows: [], rowCount: 0 } as QueryResultLike<R>;
      }
      c.status = 'failed';
      c.error = JSON.parse(params[3] as string);
      // retry_cnt 不在 worker 收尾再 +1（Codex#3 双重加一）：受理 CTE 已 +1，此处只翻状态。
      return { rows: [], rowCount: 1 } as QueryResultLike<R>;
    }

    // ---- updateCandidateSegmentCountProtected（UPDATE capability_candidates SET segment_count=$4 FROM jobs WHERE fence+running）----
    if (sql.includes('UPDATE capability_candidates') && sql.includes('SET segment_count = $4')) {
      const jobId = params[0] as string;
      const fence = params[1] as number;
      const candidateId = params[2] as string;
      const count = params[3] as number;
      const j = this.jobs.get(jobId);
      const c = this.candidates.get(candidateId);
      if (!j || j.fence_token !== fence || j.status !== 'running' || !c) {
        return { rows: [], rowCount: 0 } as QueryResultLike<R>;
      }
      c.segment_count = count;
      return { rows: [], rowCount: 1 } as QueryResultLike<R>;
    }

    // ---- readAllCandidatesForJob（SELECT ... FROM capability_candidates WHERE extract_job_id=$1 ORDER BY created_at ASC, id ASC，Codex r3 P1 收尾合并重建真源）----
    if (
      sql.includes('FROM capability_candidates') &&
      sql.includes('extract_job_id = $1') &&
      sql.includes('segment_count')
    ) {
      const extractJobId = params[0] as string;
      const rows = [...this.candidates.values()]
        .filter((c) => c.extract_job_id === extractJobId)
        .sort((a, b) =>
          a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id < b.id ? -1 : 1,
        );
      return ok<R>(
        rows.map((c) => ({
          id: c.id,
          status: c.status,
          name: c.name,
          intent: c.intent,
          type: c.type,
          confidence: c.confidence,
          segment_count: c.segment_count,
          scope_coherence: c.scope_coherence,
          split_suggested: c.split_suggested,
          error: c.error,
        })) as R[],
      );
    }

    // ---- readCandidateForOwner（SELECT id, snapshot_id, status, slug, name, retry_cnt FROM capability_candidates WHERE id=$1 AND owner_user_id=$2）----
    if (
      sql.includes('FROM capability_candidates') &&
      sql.includes('retry_cnt') &&
      sql.includes('owner_user_id = $2')
    ) {
      const id = params[0] as string;
      const owner = params[1] as string;
      const c = this.candidates.get(id);
      if (!c || c.owner_user_id !== owner) return ok<R>([]);
      return ok<R>([
        {
          id: c.id,
          snapshot_id: c.snapshot_id,
          status: c.status,
          slug: c.slug,
          name: c.name,
          retry_cnt: c.retry_cnt,
        },
      ] as R[]);
    }

    throw new Error(`ExtractFakeDb: unhandled SQL: ${sql.slice(0, 100)}`);
  }
}

/**
 * mock tx pool（withTransaction：BEGIN/COMMIT 到同一 conn；记录 outbox INSERT + 同事务 completeJob）。
 *   Codex P0-3：同事务把「最终业务状态(completed) + outbox」原子提交（缓冲 → COMMIT 才落、ROLLBACK 丢弃）。
 *   Codex#4：单候选 candidate+evidence+segment_count 同事务原子——candidates/evidence map 在 BEGIN 处快照，
 *     ROLLBACK 时整体还原（任一步抛错 → 候选/证据一并不落，绝不留半残 ready）。throwOnOutbox 模拟中途抛错回滚。
 *   throwOnEvidence 模拟单候选事务里证据 INSERT 抛错（验证「证据失败 → 不出 ready」反向破坏，Codex#4）。
 */
export class ExtractFakeTxPool {
  readonly outbox: Array<{ eventId: string; topic: string; payload: unknown }> = [];
  readonly committed: boolean[] = [];
  readonly rolledBack: boolean[] = [];
  throwOnOutbox = false;
  /** true → 单候选事务里第一条证据 INSERT 抛错（模拟 evidence/回填失败，触发整单 ROLLBACK，不出 ready）。 */
  throwOnEvidence = false;
  /**
   * true → 单候选/重试事务里 segment_count 回填 UPDATE 返回 0 行（模拟该步 fence out，Codex r2#1）：
   *   验证「受保护回填 0 行 → 抛 CandidateLandingFencedOut → 整单 ROLLBACK → 无半 ready / 无证据残留」。
   */
  zeroRowSegmentCount = false;
  constructor(private readonly db: ExtractFakeDb) {}

  async connect(): Promise<{ query: Queryable['query']; release: () => void }> {
    const db = this.db;
    const outbox = this.outbox;
    const committed = this.committed;
    const rolledBack = this.rolledBack;
    const throwOnOutbox = this.throwOnOutbox;
    const throwOnEvidence = this.throwOnEvidence;
    const zeroRowSegmentCount = this.zeroRowSegmentCount;
    // 事务内缓冲（COMMIT 才落、ROLLBACK 丢弃）。
    const pendingJob: Array<{ id: string; status: string; progress: unknown }> = [];
    const pendingOutbox: Array<{ eventId: string; topic: string; payload: unknown }> = [];
    // 单候选/重试写入直接作用于 db.candidates/db.evidence，但 BEGIN 处快照 → ROLLBACK 整体还原（事务原子，Codex#4）。
    let snapCandidates: Map<string, CandidateRowF> | null = null;
    let snapEvidence: Map<string, EvidenceRowF> | null = null;
    return {
      async query<R = Record<string, unknown>>(
        sql: string,
        params: unknown[] = [],
      ): Promise<QueryResultLike<R>> {
        if (sql.startsWith('BEGIN')) {
          // 深拷贝快照（行对象浅拷贝即可：候选/证据写入是整行替换或新增/删除，不就地改嵌套）。
          snapCandidates = new Map([...db.candidates].map(([k, v]) => [k, { ...v }]));
          snapEvidence = new Map([...db.evidence].map(([k, v]) => [k, { ...v }]));
          return ok<R>([] as R[]);
        }
        // 单候选落库/重试事务开头的【独立】FOR UPDATE guard（Codex r2#1）：转交 db 受保护读（fence 失配 → 0 行 → 哨兵 → ROLLBACK）。
        //   ⚠️ 排除 completeJobInTx（其 CTE 也含 SELECT id FROM jobs ... FOR UPDATE，但带 UPDATE jobs SET completed，由下方分支处理）。
        if (
          sql.includes('SELECT id FROM jobs') &&
          sql.includes('FOR UPDATE') &&
          !sql.includes('UPDATE jobs')
        ) {
          return db.query<R>(sql, params);
        }
        // completeJobInTx（WITH guard ... UPDATE jobs SET status='completed'）→ 缓冲，COMMIT 才落。
        if (sql.includes("status      = 'completed'")) {
          const jobId = params[0] as string;
          const fence = params[1] as number;
          const j = db.jobs.get(jobId);
          if (!j || j.fence_token !== fence || j.status !== 'running') {
            return { rows: [], rowCount: 0 } as QueryResultLike<R>; // fence out
          }
          pendingJob.push({
            id: jobId,
            status: 'completed',
            progress: JSON.parse(params[3] as string),
          });
          return { rows: [], rowCount: 1 } as QueryResultLike<R>;
        }
        if (sql.includes('INSERT INTO outbox_events')) {
          if (throwOnOutbox) throw new Error('injected outbox failure');
          pendingOutbox.push({
            eventId: params[0] as string,
            topic: params[1] as string,
            payload: JSON.parse(params[3] as string),
          });
          return ok<R>([{ seq: outbox.length + pendingOutbox.length }] as R[]);
        }
        // 注入证据失败（Codex#4 反向破坏：单候选事务里 evidence INSERT 抛错 → 整单 ROLLBACK → 不出 ready）。
        if (throwOnEvidence && sql.includes('INSERT INTO candidate_evidence')) {
          throw new Error('injected evidence failure');
        }
        // 注入 segment_count 回填 0 行（Codex r2#1 反向破坏：受保护回填该步 fence out → 抛哨兵 → 整单 ROLLBACK → 无半 ready）。
        if (
          zeroRowSegmentCount &&
          sql.includes('UPDATE capability_candidates') &&
          sql.includes('SET segment_count = $4')
        ) {
          return { rows: [], rowCount: 0 } as QueryResultLike<R>;
        }
        // 单候选/重试同事务写入：复用 ExtractFakeDb 的受保护写入语义，直接作用于 db（BEGIN 快照兜 ROLLBACK 还原）。
        if (
          sql.includes('INSERT INTO capability_candidates') ||
          sql.includes('UPDATE capability_candidates') ||
          sql.includes('DELETE FROM candidate_evidence') ||
          sql.includes('INSERT INTO candidate_evidence')
        ) {
          return db.query<R>(sql, params);
        }
        if (sql.startsWith('COMMIT')) {
          for (const pj of pendingJob) {
            const j = db.jobs.get(pj.id);
            if (j) {
              j.status = pj.status;
              j.progress = pj.progress;
            }
          }
          outbox.push(...pendingOutbox);
          committed.push(true);
          snapCandidates = null;
          snapEvidence = null;
        }
        if (sql.startsWith('ROLLBACK')) {
          pendingJob.length = 0;
          pendingOutbox.length = 0;
          // 还原候选/证据快照（事务原子：单候选事务中途抛错 → 候选/证据一并不落，Codex#4）。
          if (snapCandidates) {
            db.candidates.clear();
            for (const [k, v] of snapCandidates) db.candidates.set(k, v);
          }
          if (snapEvidence) {
            db.evidence.clear();
            for (const [k, v] of snapEvidence) db.evidence.set(k, v);
          }
          snapCandidates = null;
          snapEvidence = null;
          rolledBack.push(true);
        }
        return ok<R>([] as R[]);
      },
      release() {},
    };
  }
}

/**
 * mock LLM 网关（complete 命名）。可注入：degraded（无 key/降级）、抛错（上游异常 escape）、按调用序定制返回。
 *   stream/embed 不在提取用，给 no-op 实现以满足端口。
 */
type FakeLlmResponse = Partial<LlmResult> & { throwIt?: boolean };

export class FakeLlmGateway implements LlmGatewayPort {
  /** 每次 complete 的返回（按调用序消费；用尽回退 default）。 */
  responses: FakeLlmResponse[] = [];
  default: FakeLlmResponse = { text: '{"name":"测试能力","intent":"用途描述"}', degraded: false };
  calls: string[] = [];

  async complete(prompt: string): Promise<LlmResult> {
    this.calls.push(prompt);
    const r = this.responses.shift() ?? this.default;
    if (r.throwIt) throw new Error('llm upstream exception');
    return {
      text: r.text,
      degraded: r.degraded ?? false,
      usage: r.usage ?? { promptTokens: 10, completionTokens: 5, costMicros: 0 },
    };
  }
  async *stream(): AsyncIterable<{ deltaText: string }> {
    /* not used in extract */
  }
  async embed(): Promise<LlmResult> {
    return { degraded: true, usage: { promptTokens: 0, completionTokens: 0, costMicros: 0 } };
  }
}

// B-23 提取接入 API 单测夹具：内存假 PG，忠实模拟 create-extract-job.ts / candidates-repo.ts 的查询形态
//   + 属主/就绪/状态闸 + cursor 分页 + 复合 FK 血缘。无真 PG / 无 Docker。
//   （与 extract-fakes.ts 的 ExtractFakeDb 区分：那个模拟 B-22 worker 受保护写入；本文件模拟 B-23 API 建 job + 只读列。）
//   覆盖的 SQL：
//     - insertFullExtractJob：INSERT INTO jobs SELECT FROM raw_snapshots WHERE owner + segment_count>0；0 行后轻查 ready。
//     - createRetryJob：WITH target(failed FOR UPDATE) → new_job INSERT → flipped UPDATE（status/retry_cnt）；0 行后轻查 status。
//     - listCandidates：属主+type 轻查 → cursor 分页 asc/desc + status 过滤 + 置信分布聚合。
//     - getCandidateForOwner / listCandidateEvidence（JOIN session_segments 去敏 quote）。
import type { Queryable, QueryResultLike } from '../platform/jobs/types.js';
import type { QueuePort } from '@cb/shared';

export interface SnapRow {
  id: string;
  owner_user_id: string;
  segment_count: number;
}
export interface JobRow {
  id: string;
  type: string;
  status: string;
  owner_user_id: string;
  subject_ref: unknown;
  progress: unknown;
  fence_token: number;
  attempt_no: number;
  created_at: string;
}
export interface CandRow {
  id: string;
  extract_job_id: string;
  snapshot_id: string;
  owner_user_id: string;
  status: string;
  name: string | null;
  intent: string | null;
  slug: string;
  type: string | null;
  confidence: string | null;
  segment_count: number | null;
  frequency_ratio: number | null;
  reusability: number | null;
  scope_coherence: number | null;
  split_suggested: boolean | null;
  scope: unknown;
  reusability_breakdown: unknown;
  error: unknown;
  retry_cnt: number;
  created_at: string;
}
export interface SegRow {
  id: string;
  snapshot_id: string;
  title: string | null;
  source: string | null;
  content: string | null;
  happened_at: string | null;
  project: string | null;
}
export interface EvRow {
  id: string;
  candidate_id: string;
  segment_id: string;
  snapshot_id: string;
}
export interface DraftRow {
  id: string;
  owner_user_id: string;
  status: string;
  current_step: string;
  extract_job_id: string | null;
  step_progress: { percent?: number; phrase?: string };
}

function ok<R>(rows: R[]): QueryResultLike<R> {
  return { rows, rowCount: rows.length };
}
let seq = 0;
function genId(prefix: string): string {
  seq += 1;
  return `${prefix}-${String(seq).padStart(6, '0')}`;
}

export class ExtractRoutesFakeDb implements Queryable {
  readonly queries: Array<{ sql: string; params: unknown[] }> = [];
  readonly snapshots = new Map<string, SnapRow>();
  readonly jobs = new Map<string, JobRow>();
  readonly candidates = new Map<string, CandRow>();
  readonly segments = new Map<string, SegRow>();
  readonly evidence = new Map<string, EvRow>();
  readonly drafts = new Map<string, DraftRow>();
  now = 1_000_000;
  failOn: string | null = null;

  async query<R = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<QueryResultLike<R>> {
    this.queries.push({ sql, params });
    if (this.failOn && sql.includes(this.failOn)) throw new Error('injected db failure');

    // —— 触发萃取建 job + 同事务回填草稿（WITH new_job AS (INSERT INTO jobs SELECT FROM raw_snapshots ...),
    //    draft_backfill AS (UPDATE drafts SET extract_job_id ...) SELECT FROM new_job）——
    if (
      sql.includes('INSERT INTO jobs') &&
      sql.includes('FROM raw_snapshots') &&
      sql.includes('segment_count > 0')
    ) {
      const snapshotId = params[0] as string;
      const owner = params[3] as string;
      const draftId = (params[4] ?? null) as string | null;
      const s = this.snapshots.get(snapshotId);
      if (!s || s.owner_user_id !== owner || s.segment_count <= 0) return ok<R>([]); // new_job 空 → 不回填草稿
      const id = genId('exjob');
      const createdAt = new Date(this.now).toISOString();
      this.jobs.set(id, {
        id,
        type: 'extract',
        status: 'queued',
        owner_user_id: owner,
        subject_ref: JSON.parse(params[1] as string),
        progress: JSON.parse(params[2] as string),
        fence_token: 1,
        attempt_no: 0,
        created_at: createdAt,
      });
      // draft_backfill：同事务回填本草稿（owner 守卫 + status='active' + current_step 永不倒退）。draftId NULL/错配 → 0 行（不挡 job）。
      if (sql.includes('UPDATE drafts') && draftId) {
        const d = this.drafts.get(draftId);
        if (d && d.owner_user_id === owner && d.status === 'active') {
          d.extract_job_id = id; // extract_job_id 焊上（续传指针落 draft）
          const rank: Record<string, number> = {
            import: 0,
            extract: 1,
            select: 2,
            structure: 3,
            publish: 4,
          };
          if ((rank[d.current_step] ?? 0) <= 1) {
            d.current_step = 'extract'; // 永不倒退
            if (sql.includes('step_progress')) {
              d.step_progress = { percent: 0, phrase: '正在识别 Agent' };
            }
          }
        }
      }
      return ok<R>([{ id, fence_token: 1, attempt_no: 0, created_at: createdAt }] as R[]);
    }

    // —— readDraftView（SELECT ... FROM drafts WHERE id=$1 AND owner_user_id=$2 AND status='active'）——
    //    续传恢复：萃取同事务回填后按 draftId 读回 DraftView.extractJobId（P0 端到端续传断点）。
    if (
      sql.includes('FROM drafts') &&
      sql.trimStart().startsWith('SELECT') &&
      sql.includes('extract_job_id')
    ) {
      const id = params[0] as string;
      const owner = params[1] as string;
      const d = this.drafts.get(id);
      if (!d || d.owner_user_id !== owner || d.status !== 'active') return ok<R>([]);
      const nowIso = new Date(this.now).toISOString();
      return ok<R>([
        {
          id: d.id,
          status: d.status,
          current_step: d.current_step,
          step_progress: d.step_progress,
          title: null,
          snapshot_id: null,
          extract_job_id: d.extract_job_id,
          selection: null,
          version_id: null,
          capability_id: null,
          batch_id: null,
          created_at: nowIso,
          updated_at: nowIso,
        },
      ] as R[]);
    }

    // —— insertFullExtractJob 0 行后轻查（SELECT (segment_count>0) AS ready ...）——
    if (sql.includes('FROM raw_snapshots') && sql.includes('AS ready')) {
      const snapshotId = params[0] as string;
      const owner = params[1] as string;
      const s = this.snapshots.get(snapshotId);
      if (!s || s.owner_user_id !== owner) return ok<R>([]);
      return ok<R>([{ ready: s.segment_count > 0 }] as R[]);
    }

    // —— 单候选重试 CTE（WITH target ... INSERT INTO jobs ... flipped UPDATE ...）——
    if (
      sql.includes('WITH target AS') &&
      sql.includes('capability_candidates') &&
      sql.includes('INSERT INTO jobs')
    ) {
      const candidateId = params[0] as string;
      const owner = params[1] as string;
      const threshold = Number(params[3]);
      const c = this.candidates.get(candidateId);
      if (!c || c.owner_user_id !== owner || c.status !== 'failed') return ok<R>([]); // target 空
      const id = genId('rtjob');
      const createdAt = new Date(this.now).toISOString();
      const newRetryCnt = c.retry_cnt + 1;
      // progress.items 注入该候选 generating 态（Codex r2#4，忠实模拟 SQL 的 jsonb_set(progress,'{items}',[…])）：
      //   retry 新流首帧 state_snapshot 含该候选在生成（不裸转圈）。name 取自候选行（to_jsonb(t.name)，null 即 null）。
      const baseProgress = JSON.parse(params[2] as string) as Record<string, unknown>;
      const progressWithItem = {
        ...baseProgress,
        items: [{ id: c.id, status: 'generating', isNew: false, name: c.name }],
      };
      this.jobs.set(id, {
        id,
        type: 'extract',
        status: 'queued',
        owner_user_id: c.owner_user_id,
        subject_ref: {
          snapshotId: c.snapshot_id,
          mode: 'single-candidate',
          candidateId: c.id,
          escalate: newRetryCnt >= threshold,
        },
        progress: progressWithItem,
        fence_token: 1,
        attempt_no: 0,
        created_at: createdAt,
      });
      // flipped：候选 failed→generating + retry_cnt+1（同一行只改一次）。
      c.status = 'generating';
      c.error = null;
      c.retry_cnt = newRetryCnt;
      return ok<R>([
        {
          id,
          fence_token: 1,
          attempt_no: 0,
          created_at: createdAt,
          retry_cnt: newRetryCnt,
          extract_job_id: c.extract_job_id,
        },
      ] as R[]);
    }

    // —— createRetryJob 0 行后轻查（SELECT status FROM capability_candidates WHERE id AND owner）——
    if (
      sql.includes('SELECT status FROM capability_candidates') &&
      sql.includes('owner_user_id = $2')
    ) {
      const candidateId = params[0] as string;
      const owner = params[1] as string;
      const c = this.candidates.get(candidateId);
      if (!c || c.owner_user_id !== owner) return ok<R>([]);
      return ok<R>([{ status: c.status }] as R[]);
    }

    // —— listCandidates 属主+type 轻查（SELECT 1 AS ok FROM jobs WHERE id AND owner AND type='extract'）——
    if (sql.includes('SELECT 1 AS ok FROM jobs') && sql.includes("type = 'extract'")) {
      const jobId = params[0] as string;
      const owner = params[1] as string;
      const j = this.jobs.get(jobId);
      return ok<R>(
        j && j.owner_user_id === owner && j.type === 'extract' ? ([{ ok: 1 }] as R[]) : [],
      );
    }

    // —— 置信分布聚合（count(*) AS n ... WHERE status='ready' GROUP BY confidence）——
    if (sql.includes('count(*) AS n') && sql.includes("status = 'ready'")) {
      const jobId = params[0] as string;
      const byConf = new Map<string | null, number>();
      for (const c of this.candidates.values()) {
        if (c.extract_job_id === jobId && c.status === 'ready') {
          byConf.set(c.confidence, (byConf.get(c.confidence) ?? 0) + 1);
        }
      }
      return ok<R>([...byConf.entries()].map(([confidence, n]) => ({ confidence, n })) as R[]);
    }

    // —— listCandidates 取页（FROM capability_candidates WHERE extract_job_id=$1 ... ORDER BY id ...）——
    if (
      sql.includes('FROM capability_candidates') &&
      sql.includes('extract_job_id = $1') &&
      sql.includes('frequency_ratio')
    ) {
      const jobId = params[0] as string;
      const isDesc = sql.includes('ORDER BY cc.id DESC') || sql.includes('ORDER BY id DESC');
      let rows = [...this.candidates.values()].filter((c) => c.extract_job_id === jobId);
      let pi = 1;
      if (sql.includes('= ANY(')) {
        const statuses = params[pi] as string[];
        rows = rows.filter((c) => statuses.includes(c.status));
        pi += 1;
      }
      if (sql.includes('id < $') || sql.includes('id > $')) {
        const cursor = params[pi] as string;
        rows = rows.filter((c) => (isDesc ? c.id < cursor : c.id > cursor));
        pi += 1;
      }
      const limit = params[params.length - 1] as number;
      rows.sort((a, b) => (isDesc ? (a.id < b.id ? 1 : -1) : a.id < b.id ? -1 : 1));
      rows = rows.slice(0, limit);
      return ok<R>(rows.map((c) => ({ ...c })) as R[]);
    }

    // —— getCandidateForOwner（FROM capability_candidates WHERE id=$1 AND owner_user_id=$2，含 frequency_ratio）——
    if (
      sql.includes('FROM capability_candidates') &&
      (sql.includes('WHERE id = $1 AND owner_user_id = $2') ||
        sql.includes('WHERE cc.id = $1 AND cc.owner_user_id = $2')) &&
      sql.includes('frequency_ratio')
    ) {
      const id = params[0] as string;
      const owner = params[1] as string;
      const c = this.candidates.get(id);
      if (!c || c.owner_user_id !== owner) return ok<R>([]);
      return ok<R>([{ ...c }] as R[]);
    }

    // —— listCandidateEvidence 属主轻查（SELECT 1 AS ok FROM capability_candidates WHERE id AND owner）——
    if (
      sql.includes('SELECT 1 AS ok FROM capability_candidates') &&
      sql.includes('owner_user_id = $2')
    ) {
      const id = params[0] as string;
      const owner = params[1] as string;
      const c = this.candidates.get(id);
      return ok<R>(c && c.owner_user_id === owner ? ([{ ok: 1 }] as R[]) : []);
    }

    // —— listCandidateEvidence 取页（FROM candidate_evidence e JOIN session_segments seg ...）——
    if (sql.includes('FROM candidate_evidence e') && sql.includes('JOIN session_segments seg')) {
      const candidateId = params[0] as string;
      const isDesc = sql.includes('DESC');
      let rows = [...this.evidence.values()].filter((e) => e.candidate_id === candidateId);
      let pi = 1;
      if (sql.includes('e.id < $') || sql.includes('e.id > $')) {
        const cursor = params[pi] as string;
        rows = rows.filter((e) => (isDesc ? e.id < cursor : e.id > cursor));
        pi += 1;
      }
      const limit = params[params.length - 1] as number;
      rows.sort((a, b) => (isDesc ? (a.id < b.id ? 1 : -1) : a.id < b.id ? -1 : 1));
      rows = rows.slice(0, limit);
      return ok<R>(
        rows.map((e) => {
          const seg = this.segments.get(e.segment_id);
          return {
            id: e.id,
            candidate_id: e.candidate_id,
            segment_id: e.segment_id,
            snapshot_id: e.snapshot_id,
            title: seg?.title ?? null,
            source: seg?.source ?? null,
            quote: seg?.content ?? null,
            happened_at: seg?.happened_at ?? null,
            project: seg?.project ?? null,
          };
        }) as R[],
      );
    }

    throw new Error(
      `ExtractRoutesFakeDb: unhandled SQL: ${sql.replace(/\s+/g, ' ').slice(0, 120)}`,
    );
  }
}

/** mock 队列（记录 enqueue；可注入 fail 测「入队失败留 queued 不裸转圈」）。 */
export class FakeQueue implements Pick<QueuePort, 'enqueue'> {
  readonly enqueued: Array<{ type: string; jobId: string; fence: number }> = [];
  fail = false;
  async enqueue(type: string, jobId: string, fence: number): Promise<void> {
    if (this.fail) throw new Error('redis down');
    this.enqueued.push({ type, jobId, fence });
  }
}

// —— 播种 helpers ——
export function seedSnapshot(db: ExtractRoutesFakeDb, owner: string, segmentCount = 5): string {
  const id = genId('snap');
  db.snapshots.set(id, { id, owner_user_id: owner, segment_count: segmentCount });
  return id;
}
export function seedExtractJob(db: ExtractRoutesFakeDb, owner: string): string {
  const id = genId('exjob');
  db.jobs.set(id, {
    id,
    type: 'extract',
    status: 'completed',
    owner_user_id: owner,
    subject_ref: { mode: 'extract' },
    progress: {},
    fence_token: 1,
    attempt_no: 0,
    created_at: new Date(db.now).toISOString(),
  });
  return id;
}
export function seedCandidate(
  db: ExtractRoutesFakeDb,
  args: {
    extractJobId: string;
    snapshotId: string;
    owner: string;
    status?: string;
    confidence?: string | null;
    retryCnt?: number;
    error?: unknown;
    name?: string | null;
  },
): string {
  const id = genId('cand');
  db.candidates.set(id, {
    id,
    extract_job_id: args.extractJobId,
    snapshot_id: args.snapshotId,
    owner_user_id: args.owner,
    status: args.status ?? 'ready',
    name: args.name ?? '港险资格打分器',
    intent: '根据客户资料判断投保资格',
    slug: `slug-${id}`,
    type: 'core-workflow',
    confidence: args.confidence === undefined ? 'high' : args.confidence,
    segment_count: 3,
    frequency_ratio: 0.8,
    reusability: 0.7,
    scope_coherence: 0.9,
    split_suggested: false,
    scope: null,
    reusability_breakdown: null,
    error: args.error ?? null,
    retry_cnt: args.retryCnt ?? 0,
    created_at: new Date(db.now).toISOString(),
  });
  return id;
}
/** 播种一行 active 草稿（续传基线；触发萃取同事务回填 extract_job_id 落点用）。 */
export function seedDraft(
  db: ExtractRoutesFakeDb,
  args: { owner: string; currentStep?: string; status?: string },
): string {
  const id = genId('draft');
  db.drafts.set(id, {
    id,
    owner_user_id: args.owner,
    status: args.status ?? 'active',
    current_step: args.currentStep ?? 'extract',
    extract_job_id: null,
    step_progress: {},
  });
  return id;
}
export function seedEvidence(
  db: ExtractRoutesFakeDb,
  args: {
    candidateId: string;
    snapshotId: string;
    content: string;
    title?: string;
    source?: string;
  },
): string {
  const segId = genId('seg');
  db.segments.set(segId, {
    id: segId,
    snapshot_id: args.snapshotId,
    title: args.title ?? '会话标题',
    source: args.source ?? 'claude',
    content: args.content,
    happened_at: null,
    project: null,
  });
  const evId = genId('ev');
  db.evidence.set(evId, {
    id: evId,
    candidate_id: args.candidateId,
    segment_id: segId,
    snapshot_id: args.snapshotId,
  });
  return evId;
}

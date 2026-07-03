// 导入域单测共享夹具：内存假 PG（raw_snapshots / session_segments / jobs 联表 / import_pairings）。
//   忠实模拟 snapshot-repo.ts / create-job.ts / handlers/import.ts 用到的 SQL 形态与 fence/去重语义：
//     - 建快照（INSERT...SELECT FROM jobs WHERE fence+running）：fence 失配 → 0 行。
//     - 写段（INSERT...SELECT FROM raw_snapshots JOIN jobs WHERE fence+running ON CONFLICT(snapshot_id,content_hash) DO NOTHING）：
//       fence 失配 → 0 行；快照内 content_hash 撞重 → 0 行（去重）。
//     - supersede / markRawPurged / 只读查询 / 建 job / list 等。
//   无真 PG / 无 Docker。
import { Readable } from 'node:stream';
import type { Queryable, QueryResultLike } from '../platform/jobs/types.js';
import { readStreamToString } from '../platform/infra/object-store.js';

export interface SnapshotRow {
  id: string;
  owner_user_id: string;
  import_job_id: string;
  source: string;
  sources: string[];
  raw_s3_key: string | null;
  raw_purged_at: number | null;
  segment_count: number;
  message_count: number;
  project_count: number;
  time_span_from: string | null;
  time_span_to: string | null;
  redaction_report: unknown;
  redaction_ruleset_ver: string;
  superseded_by: string | null;
  created_at: string;
}

export interface SegmentRow {
  id: string;
  snapshot_id: string;
  content_hash: string;
  source: string;
  title: string | null;
  date_label: string | null;
  happened_at: string | null;
  project: string | null;
  message_count: number;
  content: string;
  created_at: string;
}

export interface JobRowF {
  id: string;
  type: string;
  status: string;
  owner_user_id: string;
  subject_ref: unknown;
  progress: unknown;
  result?: unknown;
  error?: unknown;
  fence_token: number;
  /** lease 持有者（null = 从未被领/已被接管待补；deleteQueuedJob/staleQueued 谓词用）。 */
  lease_owner?: string | null;
  attempt_no?: number;
  created_at?: string;
  started_at?: string | null;
  finished_at?: string | null;
}

/** 直传 upload manifest 行（import_uploads，B-20 §2.1/§2.2，Codex P1-r2/P1-r5）。 */
export interface UploadRowF {
  id: string;
  owner_user_id: string;
  upload_id: string;
  source: string;
  expected_parts: Record<string, { s3Key: string; contentSha256: string | null }>;
  total_bytes: number;
  consumed_at: number | null;
  /** 兑换时回写的 job_id（Codex P1-r5：consumed_at 非空 ⇒ job_id 非空，恢复回放据此定位 job）。 */
  job_id: string | null;
}

export interface PairingRowF {
  id: string;
  owner_user_id: string;
  pairing_code_hash: string;
  phase: string;
  job_id: string | null;
  uploaded_parts: number;
  total_parts: number | null;
  attempt_count: number;
  max_attempts: number;
  expires_at: number; // epoch ms
  used_at: number | null;
  draft_id: string | null;
}

function ok<R>(rows: R[]): QueryResultLike<R> {
  return { rows, rowCount: rows.length };
}

let seq = 0;
function genId(prefix: string): string {
  seq += 1;
  // 形如 prefix-000007（递增、字典序稳定，便于 cursor 测试 id<$ / id>$ ）。
  return `${prefix}-${String(seq).padStart(6, '0')}`;
}

/** 内存假 PG（导入域）。clock 注入以测过期；记录 queries 供断言（如「未两步查写」）。 */
export class ImportFakeDb implements Queryable {
  readonly queries: Array<{ sql: string; params: unknown[] }> = [];
  readonly snapshots = new Map<string, SnapshotRow>();
  readonly segments = new Map<string, SegmentRow>();
  readonly jobs = new Map<string, JobRowF>();
  readonly pairings = new Map<string, PairingRowF>();
  readonly uploads = new Map<string, UploadRowF>(); // key: `${owner}:${uploadId}`
  now = 1_000_000;

  /** 注入故障：匹配子串的 SQL 抛错（测 S3/DB 异常归一）。 */
  failOn: string | null = null;

  /**
   * 领单连接做事务（asTxPool(infra.db) 用，Codex P1-r5）。本 fake 是单内存实例，
   *   领出的「连接」直接复用同一实例 query（BEGIN/COMMIT/ROLLBACK 在 query 内 no-op）——
   *   忠实「同一连接 = 同一事务」语义（consumeManifestAndInsertJob 是单条 CTE 原子语句，无跨语句缓冲需求）。
   */
  async connect(): Promise<{ query: Queryable['query']; release: () => void }> {
    return {
      query: this.query.bind(this) as Queryable['query'],
      release: () => {
        /* noop */
      },
    };
  }

  async query<R = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<QueryResultLike<R>> {
    this.queries.push({ sql, params });
    if (this.failOn && sql.includes(this.failOn)) throw new Error('injected db failure');

    // ---- presign 持久化 manifest（INSERT INTO import_uploads ... ON CONFLICT DO UPDATE）----
    if (sql.includes('INSERT INTO import_uploads')) {
      const owner = params[0] as string;
      const uploadId = params[1] as string;
      const source = params[2] as string;
      const expected = JSON.parse(params[3] as string) as Record<
        string,
        { s3Key: string; contentSha256: string | null }
      >;
      const totalBytes = Number(params[4] ?? 0);
      const key = `${owner}:${uploadId}`;
      const existing = this.uploads.get(key);
      if (existing) {
        existing.expected_parts = expected;
        existing.source = source;
        existing.total_bytes = totalBytes;
      } else {
        this.uploads.set(key, {
          id: genId('upl'),
          owner_user_id: owner,
          upload_id: uploadId,
          source,
          expected_parts: expected,
          total_bytes: totalBytes,
          consumed_at: null,
          job_id: null,
        });
      }
      return { rows: [], rowCount: 1 } as QueryResultLike<R>;
    }

    // ---- 事务边界（withTransaction：BEGIN/COMMIT/ROLLBACK）——本 fake 直接落 map（无缓冲），事务边界 no-op。----
    //   注：consumeManifestAndInsertJob 是单条 CTE 原子语句（PG 层原子，active 守门 → INSERT → 单次 UPDATE），故无需缓冲也能忠实测「要么都成、要么都不成」。
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
      return { rows: [], rowCount: 0 } as QueryResultLike<R>;
    }

    // ---- consumeManifestAndInsertJob（建 job + 兑换 manifest + 回写 job_id 的 data-modifying CTE，Codex P1-r6）----
    //   忠实真实 PG 语义：**每个 data-modifying CTE 都执行**（与最终 SELECT 是否引用它无关，Codex P1-r2）；
    //     且**单语句二次改同一行不可靠**：同一条 SQL 里第二个 UPDATE 看到的是语句开始的行快照，
    //     不会可靠地命中已被前一个 CTE 改过的同一行（Codex P1-r6）——本 mock 据此对「旧两次 UPDATE 同一行」形态
    //     模拟「第二次回写 job_id 不生效」，从而能抓到「consumed_at 非空 但 job_id IS NULL」的不变式破坏。
    //   逐 CTE 解释执行（按本实现的 SQL 形态判别新/旧）：
    //     · 新实现（Codex P1-r6）：active = SELECT ... FOR UPDATE 守门（仅产出 active 行，不写）；
    //         new_job = INSERT ... SELECT FROM active（active 空→0 行，不建孤儿）；
    //         redeemed = **单次** UPDATE 同时写 consumed_at/job_id（一行只改一次 → job_id 与 consumed_at 同写、绝不脱节）。
    //     · 旧 buggy（Codex r5 命中）：consumed = UPDATE 先置 consumed_at；linked = **二次** UPDATE 同一行回写 job_id
    //         （真实 PG 不可靠 → mock 模拟 job_id 不落回 → 留下 consumed_at 非空 + job_id=null 的破坏，被回归测抓住）。
    //   注入 'INSERT INTO jobs' 失败（failOn）→ 整条 CTE 抛错 → withTransaction ROLLBACK → consumed_at 未提交（原子）。
    if (
      sql.includes('INSERT INTO jobs') &&
      sql.includes('import_uploads') &&
      (sql.includes('WITH active AS') || sql.includes('WITH consumed AS'))
    ) {
      if (this.failOn && 'INSERT INTO jobs'.includes(this.failOn)) {
        // 模拟 job INSERT 失败：整条原子语句失败，consumed_at 不落（事务回滚）。
        throw new Error('injected db failure');
      }
      const owner = params[0] as string;
      const uploadId = params[1] as string;
      const u = this.uploads.get(`${owner}:${uploadId}`);
      const createdAt = new Date(this.now).toISOString();
      // 守门命中 = 本人行存在且未兑换（active SELECT / 旧 consumed UPDATE 的 WHERE 谓词同义）。
      const gateHit = Boolean(u && u.owner_user_id === owner && u.consumed_at === null);

      // —— 形态判别：旧 buggy 用「consumed UPDATE 先兑换 + linked 二次 UPDATE 回写 job_id」；新实现用「active SELECT ... FOR UPDATE 守门 + redeemed 单次 UPDATE」。
      const usesConsumedUpdate =
        /consumed AS \(\s*UPDATE/.test(sql) || /linked AS \(\s*UPDATE/.test(sql);

      // ① 旧 consumed 守门是 UPDATE：第一次即置 consumed_at（此时 job_id 仍未回写）。
      if (gateHit && usesConsumedUpdate && u) {
        u.consumed_at = this.now;
      }

      // ② new_job：INSERT 行数 = 守门命中数（INSERT ... SELECT FROM active/consumed；active 空 → 0 行，不建孤儿）。
      if (!gateHit) return { rows: [], rowCount: 0 } as QueryResultLike<R>;
      const id = genId('job');
      const row: JobRowF = {
        id,
        type: 'import',
        status: 'queued',
        owner_user_id: owner,
        subject_ref: JSON.parse(params[2] as string),
        progress: JSON.parse(params[3] as string),
        fence_token: 1,
        lease_owner: null,
        attempt_no: 0,
        created_at: createdAt,
      };
      this.jobs.set(id, row);

      // ③ 末尾 UPDATE 回写。
      if (u) {
        if (usesConsumedUpdate) {
          // 旧 buggy：这是对同一行的【第二次】UPDATE（同语句二次改同一行）。
          //   忠实真实 PG：第二次改不可靠——模拟 job_id **不落回**（consumed_at 已被第一次置，job_id 留 null）。
          //   → 留下 consumed_at 非空 AND job_id IS NULL 的不变式破坏（回归测据此抓到旧实现）。
          /* 故意不写 u.job_id：模拟二次 UPDATE 未命中已改行 */
        } else {
          // 新实现（Codex P1-r6）：单次 UPDATE 一并写 consumed_at/job_id（一行只改一次 → 两列同时落）。
          u.consumed_at = this.now;
          u.job_id = id;
        }
      }
      return ok<R>([{ id, fence_token: 1, attempt_no: 0, created_at: createdAt }] as R[]);
    }

    // ---- readJobViewForRecovery（SELECT id, status, progress, attempt_no, created_at FROM jobs WHERE id=$1 AND owner_user_id=$2 AND type='import'）----
    if (
      sql.includes('FROM jobs') &&
      sql.includes('attempt_no, created_at') &&
      sql.includes("type = 'import'")
    ) {
      const jobId = params[0] as string;
      const owner = params[1] as string;
      const j = this.jobs.get(jobId);
      if (!j || j.owner_user_id !== owner || j.type !== 'import') return ok<R>([]);
      return ok<R>([
        {
          id: j.id,
          status: j.status,
          progress: j.progress,
          attempt_no: j.attempt_no ?? 0,
          created_at: j.created_at ?? new Date(this.now).toISOString(),
        },
      ] as R[]);
    }

    // ---- readImportJobSnapshotForOwner / readImportJobSnapshotForDraft（刷新恢复，只读）----
    if (
      sql.includes('LEFT JOIN LATERAL') &&
      sql.includes('COALESCE(j.result->>') &&
      sql.includes('FROM jobs j')
    ) {
      let rows: JobRowF[];
      if (sql.includes('WHERE j.id = $1')) {
        const jobId = params[0] as string;
        const owner = params[1] as string;
        const j = this.jobs.get(jobId);
        rows = j && j.owner_user_id === owner && j.type === 'import' ? [j] : [];
      } else {
        const owner = params[0] as string;
        const draftId = params[1] as string;
        rows = [...this.jobs.values()]
          .filter(
            (j) =>
              j.owner_user_id === owner &&
              j.type === 'import' &&
              (j.status === 'queued' || j.status === 'running' || j.status === 'completed') &&
              (j.subject_ref as { draftId?: string } | null)?.draftId === draftId,
          )
          .sort((a, b) => {
            const ap = a.status === 'queued' || a.status === 'running' ? 0 : 1;
            const bp = b.status === 'queued' || b.status === 'running' ? 0 : 1;
            if (ap !== bp) return ap - bp;
            return (b.created_at ?? '').localeCompare(a.created_at ?? '');
          })
          .slice(0, 1);
      }
      return ok<R>(
        rows.map((j) => {
          const fromResult =
            typeof j.result === 'object' && j.result !== null
              ? (j.result as { snapshotId?: unknown }).snapshotId
              : undefined;
          const fromSnapshot = [...this.snapshots.values()]
            .filter((s) => s.import_job_id === j.id)
            .sort((a, b) => b.created_at.localeCompare(a.created_at))[0]?.id;
          return {
            id: j.id,
            status: j.status,
            progress: j.progress,
            result: j.result ?? null,
            error: j.error ?? null,
            attempt_no: j.attempt_no ?? 0,
            created_at: j.created_at ?? new Date(this.now).toISOString(),
            started_at: j.started_at ?? null,
            finished_at: j.finished_at ?? null,
            subject_ref: j.subject_ref,
            snapshot_id: typeof fromResult === 'string' ? fromResult : (fromSnapshot ?? null),
          };
        }) as R[],
      );
    }

    // ---- readUploadManifest（SELECT ... FROM import_uploads WHERE owner_user_id=$1 AND upload_id=$2）----
    if (sql.includes('FROM import_uploads') && sql.includes('SELECT')) {
      const owner = params[0] as string;
      const uploadId = params[1] as string;
      const u = this.uploads.get(`${owner}:${uploadId}`);
      if (!u) return ok<R>([]);
      return ok<R>([
        {
          upload_id: u.upload_id,
          source: u.source,
          expected_parts: u.expected_parts,
          consumed_at: u.consumed_at !== null ? new Date(u.consumed_at).toISOString() : null,
          job_id: u.job_id,
        },
      ] as R[]);
    }

    // ---- requeuePending 列举（SELECT id, fence_token, attempt_no FROM jobs WHERE status='running' AND lease_owner IS NULL AND lease_until < now()）----
    //   已被 reclaimExpired 接管但重入队失败的无主 running job。本 fake 无此态（测里 running 行带 lease_owner）→ 返回空。
    if (
      sql.includes('FROM jobs') &&
      sql.includes("status = 'running'") &&
      sql.includes('lease_owner IS NULL') &&
      sql.includes('SELECT id, fence_token, attempt_no')
    ) {
      const rows = [...this.jobs.values()]
        .filter((j) => j.status === 'running' && (j.lease_owner ?? null) === null)
        .map((j) => ({ id: j.id, fence_token: j.fence_token, attempt_no: j.attempt_no ?? 0 }));
      return ok<R>(rows as R[]);
    }

    // ---- staleQueued 列举（SELECT id, fence_token, attempt_no FROM jobs WHERE status='queued' AND lease_owner IS NULL AND updated_at < ...）----
    //   sweeper 补投停滞 queued：本 fake 简化为「所有 queued 且未被领（lease_owner null）」即视作停滞（测里 now 不流逝）。
    if (
      sql.includes('FROM jobs') &&
      sql.includes("status = 'queued'") &&
      sql.includes('lease_owner IS NULL') &&
      sql.includes('SELECT id, fence_token, attempt_no')
    ) {
      const rows = [...this.jobs.values()]
        .filter((j) => j.status === 'queued' && (j.lease_owner ?? null) === null)
        .map((j) => ({
          id: j.id,
          fence_token: j.fence_token,
          attempt_no: j.attempt_no ?? 0,
        }));
      return ok<R>(rows as R[]);
    }

    // ---- reclaimExpired（UPDATE jobs SET attempt_no=attempt_no+1, fence_token=fence_token+1 ... WHERE status='running' AND lease_owner IS NOT NULL ...）----
    //   接管过期 running job。本 fake 无此态（测里 running 行未过期）→ 0 行接管。
    if (
      sql.includes('UPDATE jobs') &&
      sql.includes('attempt_no  = attempt_no + 1') &&
      sql.includes("status = 'running'")
    ) {
      return ok<R>([] as R[]);
    }

    // ---- pgTypeLookup（SELECT type FROM jobs WHERE id=$1）----
    if (sql.includes('SELECT type FROM jobs WHERE id = $1')) {
      const jobId = params[0] as string;
      const j = this.jobs.get(jobId);
      return ok<R>(j ? ([{ type: j.type }] as R[]) : []);
    }

    // ---- deleteQueuedJob（DELETE FROM jobs WHERE id=$1 AND status='queued' AND lease_owner IS NULL）----
    if (sql.includes('DELETE FROM jobs')) {
      const jobId = params[0] as string;
      const j = this.jobs.get(jobId);
      if (!j || j.status !== 'queued') return { rows: [], rowCount: 0 } as QueryResultLike<R>;
      this.jobs.delete(jobId);
      return { rows: [], rowCount: 1 } as QueryResultLike<R>;
    }

    // ---- failQueuedJob（UPDATE jobs SET status='failed' ... WHERE id=$1 AND status='queued'）----
    if (sql.includes('UPDATE jobs') && sql.includes("status = 'failed'")) {
      const jobId = params[0] as string;
      const j = this.jobs.get(jobId);
      if (!j || j.status !== 'queued') return { rows: [], rowCount: 0 } as QueryResultLike<R>;
      j.status = 'failed';
      return { rows: [], rowCount: 1 } as QueryResultLike<R>;
    }

    // ---- 建 job（INSERT INTO jobs ... RETURNING id, fence_token）——助手路径 pairings-repo 等仍用 ----
    if (sql.includes('INSERT INTO jobs')) {
      const id = genId('job');
      const row: JobRowF = {
        id,
        type: 'import',
        status: 'queued',
        owner_user_id: params[0] as string,
        subject_ref: JSON.parse(params[1] as string),
        progress: JSON.parse(params[2] as string),
        fence_token: 0,
      };
      this.jobs.set(id, row);
      return ok<R>([{ id, fence_token: 0 }] as R[]);
    }

    // ---- 建快照（INSERT INTO raw_snapshots ... SELECT ... FROM jobs WHERE fence+running）----
    if (sql.includes('INSERT INTO raw_snapshots')) {
      const jobId = params[0] as string;
      const fence = params[1] as number;
      const j = this.jobs.get(jobId);
      if (!j || j.fence_token !== fence || j.status !== 'running') return ok<R>([]); // fence out
      const id = genId('snap');
      const row: SnapshotRow = {
        id,
        owner_user_id: j.owner_user_id,
        import_job_id: j.id,
        source: params[2] as string,
        sources: params[3] as string[],
        raw_s3_key: (params[4] as string) ?? null,
        raw_purged_at: null,
        segment_count: params[5] as number,
        message_count: params[6] as number,
        project_count: params[7] as number,
        time_span_from: (params[8] as string) ?? null,
        time_span_to: (params[9] as string) ?? null,
        redaction_report: JSON.parse(params[10] as string),
        redaction_ruleset_ver: params[11] as string,
        superseded_by: null,
        created_at: new Date(this.now).toISOString(),
      };
      this.snapshots.set(id, row);
      return ok<R>([{ id }] as R[]);
    }

    // ---- 写段（INSERT INTO session_segments ... ON CONFLICT DO NOTHING RETURNING id）----
    if (sql.includes('INSERT INTO session_segments')) {
      const snapshotId = params[0] as string;
      const fence = params[1] as number;
      const contentHash = params[2] as string;
      const snap = this.snapshots.get(snapshotId);
      const j = snap ? this.jobs.get(snap.import_job_id) : undefined;
      // fence 经 snapshot→job 联表内联校验。
      if (!snap || !j || j.fence_token !== fence || j.status !== 'running') return ok<R>([]); // fence out
      // 快照内去重：(snapshot_id, content_hash) 撞重 → ON CONFLICT DO NOTHING → 0 行。
      for (const s of this.segments.values()) {
        if (s.snapshot_id === snapshotId && s.content_hash === contentHash) return ok<R>([]);
      }
      const id = genId('seg');
      const row: SegmentRow = {
        id,
        snapshot_id: snapshotId,
        content_hash: contentHash,
        source: params[3] as string,
        title: (params[4] as string) ?? null,
        date_label: (params[5] as string) ?? null,
        happened_at: (params[6] as string) ?? null,
        project: (params[7] as string) ?? null,
        message_count: params[8] as number,
        content: params[9] as string,
        created_at: new Date(this.now).toISOString(),
      };
      this.segments.set(id, row);
      return ok<R>([{ id }] as R[]);
    }

    // ---- insertSegmentProtected 的 0 行分类轻查（SELECT 1 ... raw_snapshots JOIN jobs WHERE fence+running）----
    if (
      sql.includes('SELECT 1 AS ok') &&
      sql.includes('FROM raw_snapshots s') &&
      sql.includes('JOIN jobs j')
    ) {
      const snapshotId = params[0] as string;
      const fence = params[1] as number;
      const snap = this.snapshots.get(snapshotId);
      const j = snap ? this.jobs.get(snap.import_job_id) : undefined;
      const live = Boolean(snap && j && j.fence_token === fence && j.status === 'running');
      return ok<R>(live ? ([{ ok: 1 }] as R[]) : []);
    }

    // ---- supersedePriorSnapshots（WITH guard(jobs fence+running) UPDATE raw_snapshots SET superseded_by=$1 FROM guard）----
    //   忠实 PG：guard 0 行（job 不存在/fence 失配/非 running）→ FROM guard 无行 → UPDATE 0 行（绝不污染血缘，Codex P1-r3）。
    if (sql.includes('SET superseded_by = $1')) {
      const newId = params[0] as string;
      const owner = params[1] as string;
      const fence = params[2] as number;
      const jobId = params[3] as string;
      const j = this.jobs.get(jobId);
      // guard：赢家 fence + running 才动血缘；否则 0 行。
      if (!j || j.fence_token !== fence || j.status !== 'running') {
        return { rows: [], rowCount: 0 } as QueryResultLike<R>;
      }
      let n = 0;
      for (const s of this.snapshots.values()) {
        if (s.owner_user_id === owner && s.id !== newId && s.superseded_by === null) {
          s.superseded_by = newId;
          n += 1;
        }
      }
      return { rows: [], rowCount: n } as QueryResultLike<R>;
    }

    // ---- markRawPurgedProtected（UPDATE raw_snapshots s SET raw_purged_at=now() FROM jobs j WHERE fence+running）----
    if (sql.includes('SET raw_purged_at = now()')) {
      const snapshotId = params[0] as string;
      const fence = params[1] as number;
      const snap = this.snapshots.get(snapshotId);
      const j = snap ? this.jobs.get(snap.import_job_id) : undefined;
      if (!snap || !j || j.fence_token !== fence || j.status !== 'running')
        return { rows: [], rowCount: 0 } as QueryResultLike<R>;
      snap.raw_purged_at = this.now;
      return { rows: [], rowCount: 1 } as QueryResultLike<R>;
    }

    // ---- getSnapshotForOwner（SELECT ... FROM raw_snapshots WHERE id=$1 AND owner_user_id=$2）----
    if (
      sql.includes('FROM raw_snapshots') &&
      sql.includes('WHERE id = $1 AND owner_user_id = $2') &&
      sql.includes('redaction_report')
    ) {
      const id = params[0] as string;
      const owner = params[1] as string;
      const s = this.snapshots.get(id);
      if (!s || s.owner_user_id !== owner) return ok<R>([]);
      return ok<R>([
        {
          id: s.id,
          owner_user_id: s.owner_user_id,
          source: s.source,
          sources: s.sources,
          segment_count: s.segment_count,
          message_count: s.message_count,
          project_count: s.project_count,
          time_span_from: s.time_span_from,
          time_span_to: s.time_span_to,
          redaction_report: s.redaction_report,
          created_at: s.created_at,
          superseded_by: s.superseded_by,
        },
      ] as R[]);
    }

    // ---- listSnapshotSegments 属主轻查（SELECT 1 AS ok FROM raw_snapshots WHERE id=$1 AND owner_user_id=$2）----
    if (
      sql.includes('SELECT 1 AS ok FROM raw_snapshots') &&
      sql.includes('WHERE id = $1 AND owner_user_id = $2')
    ) {
      const id = params[0] as string;
      const owner = params[1] as string;
      const s = this.snapshots.get(id);
      return ok<R>(s && s.owner_user_id === owner ? ([{ ok: 1 }] as R[]) : []);
    }

    // ---- listSnapshotSegments 取段（SELECT id, date_label, title, message_count, project FROM session_segments ...）----
    if (sql.includes('FROM session_segments') && sql.includes('date_label')) {
      const snapshotId = params[0] as string;
      const isDesc = sql.includes('DESC');
      let rows = [...this.segments.values()].filter((s) => s.snapshot_id === snapshotId);
      // cursor（id < $ / id > $）+ limit（最后一个参数）。
      const limit = params[params.length - 1] as number;
      let cursor: string | undefined;
      if (sql.includes('id < $') || sql.includes('id > $')) cursor = params[1] as string;
      if (cursor) {
        rows = rows.filter((s) => (isDesc ? s.id < cursor! : s.id > cursor!));
      }
      rows.sort((a, b) => (isDesc ? (a.id < b.id ? 1 : -1) : a.id < b.id ? -1 : 1));
      rows = rows.slice(0, limit);
      return ok<R>(
        rows.map((s) => ({
          id: s.id,
          date_label: s.date_label,
          title: s.title,
          message_count: s.message_count,
          project: s.project,
        })) as R[],
      );
    }

    // ---- listOwnerSnapshots（SELECT id, source, segment_count, created_at, superseded_by FROM raw_snapshots WHERE owner_user_id ...）----
    if (sql.includes('FROM raw_snapshots') && sql.includes('segment_count, created_at')) {
      const owner = params[0] as string;
      const isDesc = sql.includes('DESC');
      let rows = [...this.snapshots.values()].filter((s) => s.owner_user_id === owner);
      const limit = params[params.length - 1] as number;
      let cursor: string | undefined;
      if (sql.includes('id < $') || sql.includes('id > $')) cursor = params[1] as string;
      if (cursor) rows = rows.filter((s) => (isDesc ? s.id < cursor! : s.id > cursor!));
      rows.sort((a, b) => (isDesc ? (a.id < b.id ? 1 : -1) : a.id < b.id ? -1 : 1));
      rows = rows.slice(0, limit);
      return ok<R>(
        rows.map((s) => ({
          id: s.id,
          source: s.source,
          segment_count: s.segment_count,
          created_at: s.created_at,
          superseded_by: s.superseded_by,
        })) as R[],
      );
    }

    throw new Error(`ImportFakeDb: unhandled SQL: ${sql.slice(0, 90)}`);
  }
}

/**
 * mock 对象存储。getObjectText 直接走「读流→文本」的真实读路径（readStreamToString 喂真实 Node Readable），
 *   绝不再把字符串当文本直接吐回——否则会像旧 mock 一样把「流读法不对」的 P0 bug 盖住（live E2E 才抓到）。
 *   putObject 写入同一 map；缺 key / failKeys 命中抛错模拟 S3 失败。
 */
export class FakeObjectStore {
  constructor(private readonly objects: Map<string, string> = new Map()) {}
  failKeys = new Set<string>();
  /** putObject 失败开关（测 S3 不可用 503 落桶失败）。 */
  failPut = false;
  /** 记录所有 putObject 落桶（断言「真实落桶」，Codex P0-2）。 */
  readonly puts: Array<{ key: string; bytes: number }> = [];
  /** 二进制对象（gzip 打包分片用）：getObject 优先返回这里的字节。 */
  readonly rawBytes = new Map<string, Uint8Array>();
  async getObjectText(_bucket: string, key: string): Promise<string> {
    if (this.failKeys.has(key)) throw new Error('s3 failure');
    const text = this.objects.get(key);
    if (text === undefined) throw new Error(`no object: ${key}`);
    // 用真实 Node Readable（生产真值：S3 Body 在 Node 下是 Node Readable）喂统一读法——
    //   测试链路与生产同一条读路径，绝不让 mock 盖住流读法 bug。
    return readStreamToString(Readable.from([Buffer.from(text, 'utf-8')]));
  }
  /** 拉字节（gzip 分片）：优先 rawBytes，否则把文本对象按 utf-8 编码返回。 */
  async getObject(_bucket: string, key: string): Promise<Uint8Array> {
    if (this.failKeys.has(key)) throw new Error('s3 failure');
    const bin = this.rawBytes.get(key);
    if (bin !== undefined) return bin;
    const text = this.objects.get(key);
    if (text === undefined) throw new Error(`no object: ${key}`);
    return new TextEncoder().encode(text);
  }
  async putObject(_bucket: string, key: string, body: Uint8Array): Promise<{ key: string }> {
    if (this.failPut) throw new Error('s3 put failure');
    this.objects.set(key, new TextDecoder('utf-8').decode(body));
    this.puts.push({ key, bytes: body.length });
    return { key };
  }
}

/**
 * mock tx pool（withTransaction：BEGIN/COMMIT 到同一 conn；记录 outbox INSERT + 同事务 completeJob）。
 *   Codex P0-3：同事务把「最终业务状态(completed) + outbox」原子提交。fakeJobs 注入则把 completed 落到 jobs map，
 *   fence 失配 → guard 0 行 → completeJobInTx false（回滚分支）。throwOn 模拟同事务中途抛错（整体回滚）。
 */
export class FakeTxPool {
  readonly outbox: Array<{ eventId: string; topic: string; payload: unknown }> = [];
  readonly committed: boolean[] = [];
  readonly rolledBack: boolean[] = [];
  /** 注入：同事务里 completeJobInTx 写的 jobs map（默认共享 ImportFakeDb.jobs，断言 status='completed'）。 */
  jobs?: Map<string, JobRowF>;
  /** 注入：同事务里 supersedePriorSnapshots 写的 snapshots map（默认共享 ImportFakeDb.snapshots，断言血缘）。 */
  snapshots?: Map<string, SnapshotRow>;
  /** 注入：emitInTx 抛错（测同事务整体失败/回滚）。 */
  throwOnOutbox = false;
  /**
   * 注入：supersede **之后、complete 之前**的交错回调（Codex P1-r4 交错回归）。
   *   模拟「同事务内 supersede 已写（仍缓冲未提交），随即 fence/status 失效」——complete guard 0 行 → 抛哨兵 → 整事务回滚，
   *   缓冲的 supersede 一并丢弃（旧快照 superseded_by 保持不变）。典型用法：在此把 jobs 行 fence_token 换掉/status 改非 running。
   */
  afterSupersede?: () => void;
  constructor(jobs?: Map<string, JobRowF>, snapshots?: Map<string, SnapshotRow>) {
    this.jobs = jobs;
    this.snapshots = snapshots;
  }
  async connect(): Promise<{ query: Queryable['query']; release: () => void }> {
    const jobsMap = this.jobs;
    const snapshotsMap = this.snapshots;
    const outbox = this.outbox;
    const committed = this.committed;
    const rolledBack = this.rolledBack;
    const throwOnOutbox = this.throwOnOutbox;
    const afterSupersede = this.afterSupersede;
    // 事务内缓冲（COMMIT 才落、ROLLBACK 丢弃）：忠实 PG 事务原子性（Codex P0-3/P1-r3 回滚测试可成立）。
    const pendingJob: Array<{ id: string; status: string; progress: unknown }> = [];
    const pendingOutbox: Array<{ eventId: string; topic: string; payload: unknown }> = [];
    const pendingSupersede: Array<{ id: string; superseded_by: string }> = [];
    return {
      async query<R = Record<string, unknown>>(
        sql: string,
        params: unknown[] = [],
      ): Promise<QueryResultLike<R>> {
        // 收尾事务开头锁 job 行（SELECT id FROM jobs WHERE id=$1 AND fence_token=$2 AND status='running' FOR UPDATE）（Codex P1-r4）。
        //   忠实 PG：锁不到（job 不存在/fence 失配/非 running）→ 0 行（调用方据此判 fence-out → 抛哨兵回滚）。
        //   仅匹配【纯锁查询】（SELECT...FOR UPDATE，无写）；completeJobInTx 虽含 FOR UPDATE 但是 UPDATE...SET status='completed'，
        //   靠 `!UPDATE jobs && !completed` 排除，避免误吞 complete 分支。
        if (
          sql.includes('FOR UPDATE') &&
          sql.includes('FROM jobs') &&
          sql.includes("status = 'running'") &&
          !sql.includes('UPDATE jobs') &&
          !sql.includes("'completed'")
        ) {
          const jobId = params[0] as string;
          const fence = params[1] as number;
          const j = jobsMap?.get(jobId);
          if (!j || j.fence_token !== fence || j.status !== 'running') {
            return { rows: [], rowCount: 0 } as QueryResultLike<R>;
          }
          return ok<R>([{ id: jobId }] as R[]);
        }
        // 受保护 supersedePriorSnapshots（WITH guard(jobs fence+running) UPDATE raw_snapshots SET superseded_by=$1 FROM guard）。
        //   忠实 PG：guard 0 行（取消/接管换 fence/job 非 running）→ FROM guard 无行 → UPDATE 0 行（绝不污染血缘，Codex P1-r3）。
        //   命中 guard → 把待接替的旧快照缓冲到 pendingSupersede，COMMIT 才落（同事务原子；ROLLBACK 则血缘不变）。
        if (sql.includes('SET superseded_by = $1') && sql.includes('FROM guard')) {
          const newId = params[0] as string;
          const owner = params[1] as string;
          const fence = params[2] as number;
          const jobId = params[3] as string;
          const j = jobsMap?.get(jobId);
          // guard：job 命中且 fence 匹配且 status='running' 才动血缘（赢家 fence）。
          if (!j || j.fence_token !== fence || j.status !== 'running') {
            return { rows: [], rowCount: 0 } as QueryResultLike<R>; // 取消/fence-out → 不动血缘
          }
          let n = 0;
          for (const s of snapshotsMap?.values() ?? []) {
            const alreadyPending = pendingSupersede.some((p) => p.id === s.id);
            if (
              s.owner_user_id === owner &&
              s.id !== newId &&
              s.superseded_by === null &&
              !alreadyPending
            ) {
              pendingSupersede.push({ id: s.id, superseded_by: newId });
              n += 1;
            }
          }
          // 交错注入点（Codex P1-r4）：supersede 已缓冲，complete 之前触发 fence/status 失效。
          //   complete guard 随后 0 行 → handler 抛哨兵 → ROLLBACK → 这批 pendingSupersede 被丢弃（血缘不污染）。
          afterSupersede?.();
          return { rows: [], rowCount: n } as QueryResultLike<R>;
        }
        // 受保护 completeJobInTx（WITH guard ... UPDATE jobs SET status='completed'）：缓冲到 pendingJob，COMMIT 才落。
        if (sql.includes("status      = 'completed'")) {
          const jobId = params[0] as string;
          const fence = params[1] as number;
          const j = jobsMap?.get(jobId);
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
        if (sql.startsWith('COMMIT')) {
          // 提交：把缓冲的 血缘 + job 状态 + outbox 一并落（同事务原子，Codex P0-3/P1-r3）。
          for (const ps of pendingSupersede) {
            const s = snapshotsMap?.get(ps.id);
            if (s) s.superseded_by = ps.superseded_by;
          }
          for (const pj of pendingJob) {
            const j = jobsMap?.get(pj.id);
            if (j) {
              j.status = pj.status;
              j.progress = pj.progress;
            }
          }
          outbox.push(...pendingOutbox);
          committed.push(true);
        }
        if (sql.startsWith('ROLLBACK')) {
          // 回滚：丢弃缓冲（血缘/job 状态/outbox 都不落）。
          pendingSupersede.length = 0;
          pendingJob.length = 0;
          pendingOutbox.length = 0;
          rolledBack.push(true);
        }
        return ok<R>([] as R[]);
      },
      release() {
        /* noop */
      },
    };
  }
}

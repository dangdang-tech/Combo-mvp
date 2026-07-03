// 40 结构化 API handler 单测夹具：内存假 PG，忠实模拟 create-capability / structure-edit-repo / create-structure-job
//   的查询形态 + 属主/draft/状态闸 + 单 PG 事务（BEGIN/COMMIT/ROLLBACK no-op，回调内复用同一 query）。无真 PG / 无 Docker。
//   覆盖的 SQL：
//     - readVersion（SELECT v.* JOIN capabilities WHERE v.id=$1）。
//     - readCandidateForCreate / readCapabilityForNewVersion。
//     - createCapabilityWithVersionInTx（INSERT capabilities + INSERT capability_versions）。
//     - insertNewVersionInTx（INSERT capability_versions）。
//     - backfillDraftInTx（UPDATE drafts SET version_id/current_step/selection）。
//     - patchSelection（UPDATE drafts ... RETURNING；0 行轻查 owner）。
//     - patchManifestSoftFields / markFieldGenerating（UPDATE capability_versions ... WHERE status='draft'）。
//     - findRunningStructureJob（SELECT id FROM jobs WHERE type='structure' AND subject_ref->>'versionId'）。
//     - insertStructureJob（INSERT INTO jobs SELECT 'structure' FROM capability_versions JOIN capabilities WHERE draft）。
import type { Queryable, QueryResultLike } from '../platform/jobs/types.js';
import type { QueuePort } from '@cb/shared';
import { initialManifest, manifestToStructureState } from '../modules/structure/manifest.js';

export interface CapRow {
  id: string;
  creator_user_id: string;
  slug: string;
  current_version_id: string | null;
}
export interface VerRow {
  id: string;
  capability_id: string;
  version: string;
  status: string; // draft|published|review_rejected|...
  manifest: unknown;
  structure_state: unknown;
  source_candidate_id: string | null;
  /** 行 updated_at（ISO）；PATCH 乐观锁 ETag 来源。每次受保护写推进（now()）。 */
  updated_at: string;
}
export interface CandRow {
  id: string;
  owner_user_id: string;
  name: string | null;
  slug: string;
  status: string;
  snapshot_id: string | null;
}
export interface DraftRow {
  id: string;
  owner_user_id: string;
  status: string;
  current_step: string;
  step_progress: unknown;
  title: string | null;
  snapshot_id: string | null;
  extract_job_id: string | null;
  selection: unknown;
  version_id: string | null;
  batch_id: string | null;
  created_at: string;
  updated_at: string;
}
export interface JobRow {
  id: string;
  type: string;
  status: string;
  owner_user_id: string;
  subject_ref: {
    versionId?: string;
    mode?: string;
    field?: string;
    attemptsBefore?: number;
  } & Record<string, unknown>;
  progress: unknown;
  fence_token: number;
  created_at: string;
}

function ok<R>(rows: R[]): QueryResultLike<R> {
  return { rows, rowCount: rows.length };
}
let seq = 0;
function genId(prefix: string): string {
  seq += 1;
  return `${prefix}-${String(seq).padStart(6, '0')}`;
}

/**
 * 假 PG：实现 Queryable.query + Pool.connect（供 asTxPool 在事务内复用同一假库）。
 *   事务（BEGIN/COMMIT/ROLLBACK）为 no-op：回调内所有写直落本库（单测不验真隔离，只验语句序与产物）。
 */
export class StructureRoutesFakeDb implements Queryable {
  readonly queries: Array<{ sql: string; params: unknown[] }> = [];
  readonly capabilities = new Map<string, CapRow>();
  readonly versions = new Map<string, VerRow>();
  readonly candidates = new Map<string, CandRow>();
  readonly drafts = new Map<string, DraftRow>();
  readonly jobs = new Map<string, JobRow>();
  now = 1_700_000_000_000;
  failOn: string | null = null;
  /** 注入：下一次 INSERT capabilities 抛 slug 唯一冲突（测重试加后缀）。 */
  slugConflictOnce = false;
  /**
   * 注入：下一次 INSERT capabilities 抛指定错误（测「非 slug 的 23505 不能被误判成 slug 冲突」负例）。
   *   消费一次后清空。优先于 slugConflictOnce 与 slug 唯一约束模拟。
   */
  nextInsertCapabilityError: unknown = null;

  async query<R = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<QueryResultLike<R>> {
    this.queries.push({ sql, params });
    if (this.failOn && sql.includes(this.failOn)) throw new Error('injected db failure');

    // 事务控制：no-op。
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return ok<R>([]);

    // —— readVersion（JOIN capabilities，SELECT v.id, v.capability_id, c.slug ...）——
    if (
      sql.includes('FROM capability_versions v') &&
      sql.includes('JOIN capabilities c') &&
      sql.includes('WHERE v.id = $1') &&
      sql.includes('v.source_candidate_id')
    ) {
      const id = params[0] as string;
      const v = this.versions.get(id);
      if (!v) return ok<R>([]);
      const cap = this.capabilities.get(v.capability_id)!;
      return ok<R>([
        {
          id: v.id,
          capability_id: v.capability_id,
          slug: cap.slug,
          version: v.version,
          status: v.status,
          manifest: v.manifest,
          structure_state: v.structure_state,
          source_candidate_id: v.source_candidate_id,
          creator_user_id: cap.creator_user_id,
          updated_at: v.updated_at,
        },
      ] as R[]);
    }

    // —— patchManifestSoftFields 锁行读（SELECT ... FROM capability_versions v JOIN capabilities c WHERE v.id=$1 FOR UPDATE OF v）——
    if (
      sql.includes('FROM capability_versions v') &&
      sql.includes('JOIN capabilities c') &&
      sql.includes('FOR UPDATE OF v')
    ) {
      const id = params[0] as string;
      const v = this.versions.get(id);
      if (!v) return ok<R>([]);
      const cap = this.capabilities.get(v.capability_id)!;
      return ok<R>([
        {
          capability_id: v.capability_id,
          slug: cap.slug,
          status: v.status,
          creator_user_id: cap.creator_user_id,
          manifest: v.manifest,
          structure_state: v.structure_state,
          updated_at: v.updated_at,
        },
      ] as R[]);
    }

    // —— patchManifestSoftFields 锁内回读新 updated_at（SELECT updated_at FROM capability_versions WHERE id=$1）——
    if (
      sql.includes('SELECT updated_at FROM capability_versions WHERE id = $1') &&
      !sql.includes('JOIN')
    ) {
      const v = this.versions.get(params[0] as string);
      return ok<R>(v ? ([{ updated_at: v.updated_at }] as R[]) : []);
    }

    // —— readDraftVersionForCandidate（source_candidate_id + owner + draft 复用）——
    if (
      sql.includes('FROM capability_versions v') &&
      sql.includes('v.source_candidate_id = $1') &&
      sql.includes("v.status = 'draft'")
    ) {
      const candidateId = params[0] as string;
      const owner = params[1] as string;
      const found = [...this.versions.values()]
        .filter((v) => v.source_candidate_id === candidateId && v.status === 'draft')
        .map((v) => ({ v, c: this.capabilities.get(v.capability_id) }))
        .find(({ c }) => c?.creator_user_id === owner);
      if (!found) return ok<R>([]);
      return ok<R>([
        {
          id: found.v.id,
          capability_id: found.v.capability_id,
          slug: found.c!.slug,
          version: found.v.version,
          status: found.v.status,
          manifest: found.v.manifest,
          structure_state: found.v.structure_state,
          source_candidate_id: found.v.source_candidate_id,
          creator_user_id: found.c!.creator_user_id,
          updated_at: found.v.updated_at,
        },
      ] as R[]);
    }

    // —— readCandidateForCreate（SELECT id, name, intent, slug, status FROM capability_candidates WHERE id AND owner）——
    if (
      sql.includes('FROM capability_candidates') &&
      sql.includes('id = $1 AND owner_user_id = $2')
    ) {
      const id = params[0] as string;
      const owner = params[1] as string;
      const c = this.candidates.get(id);
      if (!c || c.owner_user_id !== owner) return ok<R>([]);
      return ok<R>(
        [{ id: c.id, name: c.name, intent: null, slug: c.slug, status: c.status }] as R[],
      );
    }

    // —— readCapabilityForNewVersion（SELECT c.id, c.slug, cur.status, cur.version ...）——
    if (
      sql.includes('FROM capabilities c') &&
      sql.includes('LEFT JOIN capability_versions cur') &&
      sql.includes('c.id = $1 AND c.creator_user_id = $2')
    ) {
      const id = params[0] as string;
      const owner = params[1] as string;
      const cap = this.capabilities.get(id);
      if (!cap || cap.creator_user_id !== owner) return ok<R>([]);
      const cur = cap.current_version_id ? this.versions.get(cap.current_version_id) : undefined;
      return ok<R>([
        {
          id: cap.id,
          slug: cap.slug,
          current_version_status: cur?.status ?? null,
          current_version: cur?.version ?? null,
        },
      ] as R[]);
    }

    // —— createCapabilityWithVersionInTx: INSERT capabilities ——
    if (sql.includes('INSERT INTO capabilities') && sql.includes('VALUES ($1, $2, $3')) {
      if (this.nextInsertCapabilityError != null) {
        const e = this.nextInsertCapabilityError;
        this.nextInsertCapabilityError = null;
        throw e;
      }
      if (this.slugConflictOnce) {
        this.slugConflictOnce = false;
        const e = new Error(
          'duplicate key value violates unique constraint "uq_capabilities_slug"',
        ) as Error & {
          code: string;
          constraint: string;
        };
        e.code = '23505';
        e.constraint = 'uq_capabilities_slug';
        throw e;
      }
      const id = params[0] as string;
      const creator = params[1] as string;
      const slug = params[2] as string;
      // slug 唯一约束模拟。
      for (const c of this.capabilities.values()) {
        if (c.slug === slug) {
          const e = new Error('uq_capabilities_slug') as Error & {
            code: string;
            constraint: string;
          };
          e.code = '23505';
          e.constraint = 'uq_capabilities_slug';
          throw e;
        }
      }
      this.capabilities.set(id, { id, creator_user_id: creator, slug, current_version_id: null });
      return ok<R>([]);
    }

    // —— createCapabilityWithVersionInTx / insertNewVersionInTx: INSERT capability_versions ——
    if (sql.includes('INSERT INTO capability_versions') && sql.includes("'draft'")) {
      const id = params[0] as string;
      const capabilityId = params[1] as string;
      const version = params[2] as string;
      const manifest = JSON.parse(params[3] as string);
      const structure_state = JSON.parse(params[4] as string);
      const source_candidate_id = (params[5] as string) ?? null;
      // 版本号唯一（capability_id, version）。
      for (const v of this.versions.values()) {
        if (v.capability_id === capabilityId && v.version === version) {
          const e = new Error('uq_capability_version') as Error & { code: string };
          e.code = '23505';
          throw e;
        }
      }
      this.versions.set(id, {
        id,
        capability_id: capabilityId,
        version,
        status: 'draft',
        manifest,
        structure_state,
        source_candidate_id,
        updated_at: new Date(this.now).toISOString(),
      });
      return ok<R>([]);
    }

    // —— backfillDraftInTx（UPDATE drafts SET version_id, current_step='structure', selection
    //    WHERE id=$1 AND owner_user_id=$3 AND status='active'；owner 守卫，rowCount 守门，Codex P0-2）——
    if (
      sql.includes('UPDATE drafts') &&
      sql.includes("current_step = 'structure'") &&
      sql.includes('version_id = $2') &&
      sql.includes('owner_user_id = $3') &&
      sql.includes("status = 'active'")
    ) {
      const draftId = params[0] as string;
      const versionId = params[1] as string;
      const owner = params[2] as string;
      const selection = params[3] != null ? JSON.parse(params[3] as string) : null;
      const d = this.drafts.get(draftId);
      // owner 守卫：不存在 / 非本人 / 非 active → 0 行（调用方回滚整事务 + 404，不覆盖他人草稿）。
      if (!d || d.owner_user_id !== owner || d.status !== 'active') {
        return { rows: [] as R[], rowCount: 0 };
      }
      d.version_id = versionId;
      d.current_step = 'structure';
      if (selection != null) d.selection = selection;
      return { rows: [] as R[], rowCount: 1 };
    }

    // —— patchSelection 前置读 draft（SELECT owner_user_id, snapshot_id FROM drafts WHERE id=$1）——
    if (sql.includes('SELECT owner_user_id, snapshot_id FROM drafts WHERE id = $1')) {
      const d = this.drafts.get(params[0] as string);
      return ok<R>(
        d ? ([{ owner_user_id: d.owner_user_id, snapshot_id: d.snapshot_id }] as R[]) : [],
      );
    }

    // —— validateSelectionCandidates 命中集（SELECT id FROM capability_candidates WHERE id=ANY AND owner AND snapshot AND ready）——
    if (
      sql.includes('SELECT id FROM capability_candidates') &&
      sql.includes('id = ANY($1::uuid[])') &&
      sql.includes("status = 'ready'")
    ) {
      const ids = params[0] as string[];
      const owner = params[1] as string;
      const snapshotId = params[2] as string;
      const rows = ids
        .map((id) => this.candidates.get(id))
        .filter(
          (c): c is CandRow =>
            !!c &&
            c.owner_user_id === owner &&
            c.snapshot_id === snapshotId &&
            c.status === 'ready',
        )
        .map((c) => ({ id: c.id }));
      return ok<R>(rows as R[]);
    }

    // —— validateSelectionCandidates 全 ready 计数（SELECT count(*) FROM capability_candidates WHERE owner AND snapshot AND ready）——
    if (
      sql.includes('count(*)::text AS n FROM capability_candidates') &&
      sql.includes('owner_user_id = $1') &&
      sql.includes("status = 'ready'")
    ) {
      const owner = params[0] as string;
      const snapshotId = params[1] as string;
      const n = [...this.candidates.values()].filter(
        (c) => c.owner_user_id === owner && c.snapshot_id === snapshotId && c.status === 'ready',
      ).length;
      return ok<R>([{ n: String(n) }] as R[]);
    }

    // —— patchSelection（UPDATE drafts SET selection, current_step='select' WHERE id AND owner RETURNING ...）——
    if (
      sql.includes('UPDATE drafts') &&
      sql.includes("current_step = 'select'") &&
      sql.includes('owner_user_id = $2') &&
      sql.includes('RETURNING')
    ) {
      const draftId = params[0] as string;
      const owner = params[1] as string;
      const selection = JSON.parse(params[2] as string);
      const d = this.drafts.get(draftId);
      if (!d || d.owner_user_id !== owner) return ok<R>([]);
      d.selection = selection;
      d.current_step = 'select';
      d.step_progress = { percent: 0, phrase: '选择中' };
      d.updated_at = new Date(this.now).toISOString();
      return ok<R>([{ ...d }] as R[]);
    }

    // —— patchSelection 0 行轻查（SELECT owner_user_id FROM drafts WHERE id=$1）——
    if (sql.includes('SELECT owner_user_id FROM drafts WHERE id = $1')) {
      const draftId = params[0] as string;
      const d = this.drafts.get(draftId);
      return ok<R>(d ? ([{ owner_user_id: d.owner_user_id }] as R[]) : []);
    }

    // —— patchManifestSoftFields 锁内写回（UPDATE capability_versions SET manifest=$2, structure_state=$3 WHERE id=$1）——
    //    新形态：status/owner 闸在锁行读后由 app 校验；本 UPDATE 仅按 id 写（同事务、已锁行）。推进 updated_at（ETag 锚点）。
    if (
      sql.includes('UPDATE capability_versions') &&
      sql.includes('manifest = $2::jsonb') &&
      sql.includes('structure_state = $3::jsonb')
    ) {
      const id = params[0] as string;
      const v = this.versions.get(id);
      if (!v) return { rows: [] as R[], rowCount: 0 };
      v.manifest = JSON.parse(params[1] as string);
      v.structure_state = JSON.parse(params[2] as string);
      v.updated_at = new Date(++this.now).toISOString(); // 推进 ETag（每次写后 now 先自增，ETag 必变）。
      return { rows: [] as R[], rowCount: 1 };
    }

    // —— markFieldGenerating（UPDATE capability_versions SET structure_state WHERE id AND status='draft'）——
    if (
      sql.includes('UPDATE capability_versions') &&
      sql.includes('structure_state = $2::jsonb') &&
      sql.includes("status = 'draft'") &&
      !sql.includes('manifest')
    ) {
      const id = params[0] as string;
      const v = this.versions.get(id);
      if (!v || v.status !== 'draft') return ok<R>([]);
      v.structure_state = JSON.parse(params[1] as string);
      return { rows: [] as R[], rowCount: 1 };
    }

    // —— findRunningStructureJob（SELECT id FROM jobs WHERE type='structure' AND subject_ref->>'versionId'=$1 AND status IN(...)）——
    if (
      sql.includes("type = 'structure'") &&
      sql.includes("subject_ref->>'versionId' = $1") &&
      sql.includes("status IN ('queued','running')")
    ) {
      const versionId = params[0] as string;
      const owner = params[1] as string;
      const found = [...this.jobs.values()]
        .filter(
          (j) =>
            j.type === 'structure' &&
            j.owner_user_id === owner &&
            j.subject_ref?.versionId === versionId &&
            (j.status === 'queued' || j.status === 'running'),
        )
        .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
      return ok<R>(found[0] ? ([{ id: found[0].id }] as R[]) : []);
    }

    // —— insertStructureJob（INSERT INTO jobs SELECT 'structure' FROM capability_versions JOIN capabilities WHERE draft）——
    if (
      sql.includes('INSERT INTO jobs') &&
      sql.includes("'structure'") &&
      sql.includes('FROM capability_versions v') &&
      sql.includes("v.status = 'draft'")
    ) {
      const versionId = params[0] as string;
      const subjectRef = JSON.parse(params[1] as string);
      const progress = JSON.parse(params[2] as string);
      const owner = params[3] as string;
      const v = this.versions.get(versionId);
      if (!v || v.status !== 'draft') return ok<R>([]); // 非 draft/不存在 → 0 行
      const cap = this.capabilities.get(v.capability_id)!;
      if (cap.creator_user_id !== owner) return ok<R>([]); // 非本人 → 0 行
      // version 级硬锁（部分唯一索引 uq_structure_job_active_version，Codex P1-4）：
      //   同 version 已有未终态 structure job → 唯一冲突 23505（模拟 PG 部分唯一索引）。
      for (const j of this.jobs.values()) {
        if (
          j.type === 'structure' &&
          j.subject_ref?.versionId === versionId &&
          (j.status === 'queued' || j.status === 'running')
        ) {
          const e = new Error(
            'duplicate key value violates unique constraint "uq_structure_job_active_version"',
          ) as Error & { code: string; constraint: string };
          e.code = '23505';
          e.constraint = 'uq_structure_job_active_version';
          throw e;
        }
      }
      const id = genId('strjob');
      this.jobs.set(id, {
        id,
        type: 'structure',
        status: 'queued',
        owner_user_id: cap.creator_user_id,
        subject_ref: subjectRef,
        progress,
        fence_token: 1,
        created_at: new Date(this.now++).toISOString(),
      });
      return ok<R>([{ id }] as R[]);
    }

    throw new Error(
      `StructureRoutesFakeDb: unhandled SQL: ${sql.replace(/\s+/g, ' ').slice(0, 140)}`,
    );
  }

  /** Pool.connect 适配（供 asTxPool）：返回复用本库 query 的连接（release no-op）。 */
  async connect(): Promise<{ query: Queryable['query']; release: () => void }> {
    return {
      query: this.query.bind(this) as Queryable['query'],
      release: () => undefined,
    };
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
export function seedCandidate(
  db: StructureRoutesFakeDb,
  owner: string,
  opts?: { name?: string; snapshotId?: string | null; status?: string },
): string {
  const id = genId('cand');
  db.candidates.set(id, {
    id,
    owner_user_id: owner,
    name: opts?.name ?? '需求炼金师',
    slug: `slug-${id}`,
    status: opts?.status ?? 'ready',
    snapshot_id: opts?.snapshotId ?? null,
  });
  return id;
}

export function seedCapabilityWithVersion(
  db: StructureRoutesFakeDb,
  owner: string,
  opts?: { versionStatus?: string; version?: string; manifest?: unknown; isCurrent?: boolean },
): { capabilityId: string; versionId: string; slug: string } {
  const capabilityId = genId('cap');
  const versionId = genId('ver');
  const slug = `slug-${capabilityId}`;
  const version = opts?.version ?? '0.1.0';
  const status = opts?.versionStatus ?? 'draft';
  const manifest = opts?.manifest ?? initialManifest(capabilityId, version);
  db.capabilities.set(capabilityId, {
    id: capabilityId,
    creator_user_id: owner,
    slug,
    current_version_id: opts?.isCurrent ? versionId : null,
  });
  db.versions.set(versionId, {
    id: versionId,
    capability_id: capabilityId,
    version,
    status,
    manifest,
    structure_state: manifestToStructureState(versionId, manifest as never),
    source_candidate_id: null,
    updated_at: new Date(db.now).toISOString(),
  });
  return { capabilityId, versionId, slug };
}

export function seedDraft(
  db: StructureRoutesFakeDb,
  owner: string,
  opts?: { snapshotId?: string | null },
): string {
  const id = genId('draft');
  const ts = new Date(db.now).toISOString();
  db.drafts.set(id, {
    id,
    owner_user_id: owner,
    status: 'active',
    current_step: 'extract',
    step_progress: {},
    title: null,
    snapshot_id: opts?.snapshotId ?? null,
    extract_job_id: null,
    selection: null,
    version_id: null,
    batch_id: null,
    created_at: ts,
    updated_at: ts,
  });
  return id;
}

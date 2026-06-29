// 结构化域单测共享夹具：内存假 PG（jobs / capabilities / capability_versions / candidate_evidence / session_segments / drafts）
//   + 可编程流式 mock LLM 网关 + mock txPool。忠实模拟 structure-repo.ts / create-capability.ts 用到的 SQL 形态与 fence 语义：
//     - 受保护写 manifest+structure_state（UPDATE capability_versions v ... FROM jobs j WHERE id+fence+running AND v.id）：fence 失配/非 running → 0 行。
//     - 读 version（JOIN capabilities）、读 evidence（JOIN session_segments）。
//     - 建体三分支：INSERT capabilities / INSERT capability_versions / drafts 回填。
//   无真 PG / 无 Docker。
import type { Queryable, QueryResultLike } from '../jobs/types.js';
import type { LlmGatewayPort, LlmResult, Manifest, StructureState } from '@cb/shared';

export interface JobRowF {
  id: string;
  status: string;
  owner_user_id: string;
  fence_token: number;
}
export interface CapabilityRowF {
  id: string;
  creator_user_id: string;
  slug: string;
  current_version_id: string | null;
  status: string;
}
export interface VersionRowF {
  id: string;
  capability_id: string;
  version: string;
  status: string;
  manifest: Manifest | Record<string, unknown>;
  structure_state: Partial<StructureState>;
  source_candidate_id: string | null;
  /** 行 updated_at（ISO）；PATCH 乐观锁 ETag 来源。缺省置 epoch。 */
  updated_at?: string;
}
export interface SegmentRowF {
  id: string;
  snapshot_id: string;
  title: string | null;
  source: string | null;
  project: string | null;
  content: string;
}
export interface EvidenceRowF {
  id: string;
  candidate_id: string;
  segment_id: string;
}
export interface DraftRowF {
  id: string;
  owner_user_id?: string;
  status?: string;
  version_id: string | null;
  capability_id?: string | null;
  current_step: string | null;
  selection: unknown;
}

function ok<R>(rows: R[]): QueryResultLike<R> {
  return { rows, rowCount: rows.length };
}

export class StructureFakeDb implements Queryable {
  readonly queries: Array<{ sql: string; params: unknown[] }> = [];
  readonly jobs = new Map<string, JobRowF>();
  readonly capabilities = new Map<string, CapabilityRowF>();
  readonly versions = new Map<string, VersionRowF>();
  readonly segments = new Map<string, SegmentRowF>();
  readonly evidence = new Map<string, EvidenceRowF>();
  readonly candidates = new Map<
    string,
    { id: string; owner_user_id: string; name: string | null; slug: string; status: string }
  >();
  readonly drafts = new Map<string, DraftRowF>();
  /** 受保护写 structure_state/manifest 的累计次数（断言「逐字段落库」）。 */
  manifestWrites = 0;
  /** 每次受保护写落库的 structure_state 历史（断言 stuck 中途态持久化等，Codex P1-8）。 */
  readonly stateWrites: StructureState[] = [];
  /** 成功落一条数组 partial item 后回调（测试注入「逐项落库过程中崩溃/接管」中断点，Codex r4 P1）。 */
  onArrayItemPersisted?: (ctx: { versionId: string; field: string; item: string }) => void;

  async connect(): Promise<{ query: Queryable['query']; release: () => void }> {
    return { query: this.query.bind(this) as Queryable['query'], release: () => {} };
  }

  async query<R = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<QueryResultLike<R>> {
    this.queries.push({ sql, params });
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return ok<R>([]);

    // ---- 受保护写 manifest+structure_state（UPDATE capability_versions v SET manifest=$4, structure_state=$5 FROM jobs WHERE id+fence+running AND v.id=$3）----
    if (
      sql.includes('UPDATE capability_versions v') &&
      sql.includes('SET manifest = $4::jsonb, structure_state = $5::jsonb')
    ) {
      const jobId = params[0] as string;
      const fence = params[1] as number;
      const versionId = params[2] as string;
      const j = this.jobs.get(jobId);
      const v = this.versions.get(versionId);
      if (!j || j.fence_token !== fence || j.status !== 'running' || !v) return ok<R>([]); // fence out
      v.manifest = JSON.parse(params[3] as string);
      v.structure_state = JSON.parse(params[4] as string);
      this.stateWrites.push(v.structure_state as StructureState);
      this.manifestWrites += 1;
      return { rows: [], rowCount: 1 } as QueryResultLike<R>;
    }

    // ---- 受保护【条件】写 stuck 态（writeFieldStuckIfGenerating，Codex r3 P1）----
    //   仅 surgically patch structure_state.fields[该字段] 的 status='stuck' + stuckMs，绝不写 manifest；
    //   守护条件叠加「该字段当前仍 generating」：fence/running + v.id + elem.status='generating'。
    //   终态已先落库（该字段非 generating）→ 命中 0 行 no-op（不覆盖已生成/manifest，竞态兜底）。
    if (
      sql.includes('UPDATE capability_versions v') &&
      sql.includes("'status'") &&
      sql.includes('\'"stuck"\'::jsonb') &&
      sql.includes('WITH ORDINALITY')
    ) {
      const jobId = params[0] as string;
      const fence = params[1] as number;
      const versionId = params[2] as string;
      const field = params[3] as string;
      const stuckMs = params[4] as number;
      const j = this.jobs.get(jobId);
      const v = this.versions.get(versionId);
      if (!j || j.fence_token !== fence || j.status !== 'running' || !v) return ok<R>([]); // fence out
      const st = v.structure_state as StructureState;
      const fs = st.fields?.find((f) => f.field === field);
      // 守护：该字段必须仍 generating，否则迟到的 stuck 写命中 0 行 no-op（终态权威，不覆盖已生成）。
      if (!fs || fs.status !== 'generating') return ok<R>([]);
      // 只动 status/stuckMs（库内 jsonb_set 语义），不触 value/attempts/error（累计基线/已生成不丢）。
      fs.status = 'stuck';
      (fs as { stuckMs?: number }).stuckMs = stuckMs;
      // 历史快照存【写时点深拷贝】（真 PG 每行各自独立；存活引用会被后续 surgical 写 in-place 改写而污染本快照）。
      this.stateWrites.push(JSON.parse(JSON.stringify(st)) as StructureState);
      return { rows: [], rowCount: 1 } as QueryResultLike<R>;
    }

    // ---- 受保护【条件】写数组字段逐项 partial value（writeArrayItemIfGenerating，Codex r4 P1）----
    //   仅 surgically append 本项进 structure_state.fields[该数组字段].value（jsonb 数组追加），绝不写 manifest；
    //   守护条件叠加「该字段当前仍 generating」：fence/running + v.id + elem.status='generating'。
    //   终态已先落库 / 被换 fence（该字段非 generating）→ 命中 0 行 no-op（不 emit、不覆盖已落 partial，竞态兜底）。
    if (
      sql.includes('UPDATE capability_versions v') &&
      sql.includes("ARRAY['fields', (idx.i)::text, 'value']") &&
      sql.includes('to_jsonb($5::text)') &&
      sql.includes('WITH ORDINALITY')
    ) {
      const jobId = params[0] as string;
      const fence = params[1] as number;
      const versionId = params[2] as string;
      const field = params[3] as string;
      const item = params[4] as string;
      const j = this.jobs.get(jobId);
      const v = this.versions.get(versionId);
      if (!j || j.fence_token !== fence || j.status !== 'running' || !v) return ok<R>([]); // fence out
      const st = v.structure_state as StructureState;
      const fs = st.fields?.find((f) => f.field === field);
      // 守护：该字段必须仍 generating，否则迟到的 item 写命中 0 行 no-op（终态权威，不覆盖已落 partial）。
      if (!fs || fs.status !== 'generating') return ok<R>([]);
      // 只 append 进该字段 value 数组（不动 status/attempts/error、不写 manifest）。
      const cur = Array.isArray(fs.value) ? (fs.value as string[]) : [];
      fs.value = [...cur, item];
      // 历史快照存【写时点深拷贝】（真 PG 每行各自独立；存活引用会被后续 in-place 追加污染，掩盖逐项增长）。
      this.stateWrites.push(JSON.parse(JSON.stringify(st)) as StructureState);
      // 测试钩子：落完一条 partial 后注入中断点（崩溃/接管换 fence），验证已落 partial 不丢、后续命中 0 行不 emit。
      this.onArrayItemPersisted?.({ versionId, field, item });
      return { rows: [], rowCount: 1 } as QueryResultLike<R>;
    }

    // ---- 受保护 surgical 写单字段 status/attempts(/error)、保留 value（writeFieldStateSurgical，Codex r6/r7 P1）----
    //   只 patch 本字段条目 status/attempts（failed 带 error、清 stuckMs），【保留该字段 DB 现 value】（不擦本 attempt 已落 tail）；
    //   不写 manifest、不动其它字段。guard='not-done'（占位：status!=done）/'in-progress'（失败收口：generating/stuck）。
    if (
      sql.includes('UPDATE capability_versions v') &&
      sql.includes("ARRAY['fields', (idx.i)::text]") &&
      sql.includes("jsonb_build_object('status', $5::text, 'attempts', $6::int)") &&
      sql.includes("$8::text = 'not-done'") &&
      !sql.includes('SET manifest')
    ) {
      const jobId = params[0] as string;
      const fence = params[1] as number;
      const versionId = params[2] as string;
      const field = params[3] as string;
      const status = params[4] as string;
      const attempts = params[5] as number;
      const error = params[6] === null ? undefined : JSON.parse(params[6] as string);
      const guard = params[7] as 'not-done' | 'in-progress' | 'force';
      const j = this.jobs.get(jobId);
      const v = this.versions.get(versionId);
      if (!j || j.fence_token !== fence || j.status !== 'running' || !v) return ok<R>([]); // fence out
      const st = v.structure_state as StructureState;
      const idx = st.fields?.findIndex((f) => {
        if (f.field !== field) return false;
        if (guard === 'force') return true; // 强制（single-field regen，§4.F）。
        if (guard === 'not-done') return f.status !== 'done'; // 占位：并发已 done → skip。
        return f.status === 'generating' || f.status === 'stuck'; // in-progress：失败收口。
      });
      // 守护：条目须满足 guard，否则命中 0 行 no-op（占位：并发已 done → skip；收口：终态/换 fence → 迟到写不覆盖）。
      if (idx === undefined || idx < 0) return ok<R>([]);
      // 只 patch status/attempts（failed 带 error、清 stuckMs），保留该字段 value/其它键（jsonb 逐键改语义）。
      const cur = st.fields[idx] as Record<string, unknown>;
      delete cur.stuckMs;
      cur.status = status;
      cur.attempts = attempts;
      if (error !== undefined) cur.error = error;
      this.stateWrites.push(JSON.parse(JSON.stringify(st)) as StructureState);
      return { rows: [], rowCount: 1 } as QueryResultLike<R>;
    }

    // ---- 受保护 surgical merge 写单字段【完成/收口】（writeFieldDoneSurgical，Codex r6 P1）----
    //   只 jsonb_set manifest[本字段]（+ instructions 派生 inputs/output）+ 整条替换 structure_state.fields[本字段] 终态
    //   （+ 刷新 inputs/output 两条 locked 条目值）；保留当前行其它字段（含并发 PATCH 改过的软字段）。
    //   守护：fence/running + v.id + 该字段当前仍 generating（终态/换 fence 已先落库 → 0 行 no-op，终态权威）。
    if (
      sql.includes('UPDATE capability_versions v') &&
      sql.includes('SET manifest =') &&
      sql.includes('WHEN $6::jsonb IS NULL') &&
      sql.includes('next_state.next')
    ) {
      const jobId = params[0] as string;
      const fence = params[1] as number;
      const versionId = params[2] as string;
      const field = params[3] as string;
      const manifestField = JSON.parse(params[4] as string) as string | string[];
      const derivedHard =
        params[5] === null
          ? null
          : (JSON.parse(params[5] as string) as { inputs: unknown; output: unknown });
      const fieldState = JSON.parse(params[6] as string) as { field: string; status: string };
      const j = this.jobs.get(jobId);
      const v = this.versions.get(versionId);
      if (!j || j.fence_token !== fence || j.status !== 'running' || !v) return ok<R>([]); // fence out
      const st = v.structure_state as StructureState;
      // 守护：本字段须仍 generating 或 stuck（stuck 是 generating 瞬时子态）；否则迟到写命中 0 行 no-op（终态权威）。
      const idx = st.fields?.findIndex(
        (f) => f.field === field && (f.status === 'generating' || f.status === 'stuck'),
      );
      if (idx === undefined || idx < 0) return ok<R>([]);
      // manifest surgical：只动本字段（+ instructions 派生硬字段），其余键从【库内当前行】带走（不覆盖并发 PATCH）。
      const mf = v.manifest as Record<string, unknown>;
      mf[field] = manifestField;
      if (derivedHard) {
        mf.inputs = derivedHard.inputs;
        mf.output = derivedHard.output;
      }
      // structure_state surgical：本字段条目换终态；inputs/output locked 条目刷新派生值；其它字段条目原样。
      st.fields = st.fields.map((f, i) => {
        if (i === idx) return fieldState as (typeof st.fields)[number];
        if (derivedHard && f.field === 'inputs')
          return { ...f, value: derivedHard.inputs } as (typeof st.fields)[number];
        if (derivedHard && f.field === 'output')
          return { ...f, value: derivedHard.output } as (typeof st.fields)[number];
        return f;
      });
      // doneCount/totalCount 从重建后 fields 即时重算（只数软字段；硬字段 locked 不计 total）——计数自洽，不留 stale。
      const SOFT = [
        'name',
        'tagline',
        'role',
        'goal',
        'instructions',
        'skill_set',
        'starter_prompts',
      ];
      const soft = st.fields.filter((f) => SOFT.includes(f.field));
      st.doneCount = soft.filter((f) => f.status === 'done').length;
      st.totalCount = soft.length;
      this.stateWrites.push(JSON.parse(JSON.stringify(st)) as StructureState);
      this.manifestWrites += 1;
      return { rows: [], rowCount: 1 } as QueryResultLike<R>;
    }

    // ---- 受保护写仅 structure_state（writeStructureStateProtected，部分测试用）----
    if (
      sql.includes('UPDATE capability_versions v') &&
      sql.includes('SET structure_state = $4::jsonb') &&
      !sql.includes('manifest')
    ) {
      const jobId = params[0] as string;
      const fence = params[1] as number;
      const versionId = params[2] as string;
      const j = this.jobs.get(jobId);
      const v = this.versions.get(versionId);
      if (!j || j.fence_token !== fence || j.status !== 'running' || !v) return ok<R>([]);
      v.structure_state = JSON.parse(params[3] as string);
      return { rows: [], rowCount: 1 } as QueryResultLike<R>;
    }

    // ---- readVersionForStructure（批编排起步：SELECT v.manifest, v.source_candidate_id, v.capability_id, v.status FROM capability_versions v WHERE v.id=$1，无 JOIN）----
    if (
      sql.includes('FROM capability_versions v') &&
      sql.includes('v.source_candidate_id, v.capability_id, v.status') &&
      sql.includes('WHERE v.id = $1') &&
      !sql.includes('JOIN capabilities c')
    ) {
      const v = this.versions.get(params[0] as string);
      if (!v) return ok<R>([]);
      return ok<R>([
        {
          manifest: v.manifest,
          source_candidate_id: v.source_candidate_id,
          capability_id: v.capability_id,
          status: v.status,
        },
      ] as R[]);
    }

    // ---- readVersion（SELECT v.* , c.slug, c.creator_user_id FROM capability_versions v JOIN capabilities c WHERE v.id=$1）----
    if (
      sql.includes('FROM capability_versions v') &&
      sql.includes('JOIN capabilities c') &&
      sql.includes('WHERE v.id = $1')
    ) {
      const v = this.versions.get(params[0] as string);
      if (!v) return ok<R>([]);
      const c = this.capabilities.get(v.capability_id);
      return ok<R>([
        {
          id: v.id,
          capability_id: v.capability_id,
          slug: c?.slug ?? '',
          version: v.version,
          status: v.status,
          manifest: v.manifest,
          structure_state: v.structure_state,
          source_candidate_id: v.source_candidate_id,
          creator_user_id: c?.creator_user_id ?? '',
          updated_at: v.updated_at ?? new Date(0).toISOString(),
        },
      ] as R[]);
    }

    // ---- readEvidenceForCandidate（SELECT e.segment_id, seg.* FROM candidate_evidence e JOIN session_segments seg WHERE e.candidate_id=$1 ORDER BY e.id ASC）----
    if (
      sql.includes('FROM candidate_evidence e') &&
      sql.includes('JOIN session_segments seg') &&
      sql.includes('e.candidate_id = $1')
    ) {
      const candidateId = params[0] as string;
      const rows = [...this.evidence.values()]
        .filter((e) => e.candidate_id === candidateId)
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .map((e) => this.segments.get(e.segment_id))
        .filter((s): s is SegmentRowF => Boolean(s))
        .map((s) => ({
          segment_id: s.id,
          title: s.title,
          source: s.source,
          project: s.project,
          content: s.content,
        }));
      return ok<R>(rows as R[]);
    }

    // ---- readCandidateForCreate（SELECT id, name, slug, status FROM capability_candidates WHERE id=$1 AND owner_user_id=$2）----
    if (
      sql.includes('FROM capability_candidates') &&
      sql.includes('WHERE id = $1 AND owner_user_id = $2')
    ) {
      const c = this.candidates.get(params[0] as string);
      if (!c || c.owner_user_id !== params[1]) return ok<R>([]);
      return ok<R>([{ id: c.id, name: c.name, slug: c.slug, status: c.status }] as R[]);
    }

    // ---- readCapabilityForNewVersion（SELECT c.id, c.slug, cur.status, cur.version FROM capabilities c LEFT JOIN ... WHERE c.id=$1 AND c.creator_user_id=$2）----
    if (
      sql.includes('FROM capabilities c') &&
      sql.includes('LEFT JOIN capability_versions cur') &&
      sql.includes('c.creator_user_id = $2')
    ) {
      const c = this.capabilities.get(params[0] as string);
      if (!c || c.creator_user_id !== params[1]) return ok<R>([]);
      const cur = c.current_version_id ? this.versions.get(c.current_version_id) : null;
      return ok<R>([
        {
          id: c.id,
          slug: c.slug,
          current_version_status: cur?.status ?? null,
          current_version: cur?.version ?? null,
        },
      ] as R[]);
    }

    // ---- INSERT capabilities ----
    if (sql.includes('INSERT INTO capabilities')) {
      this.capabilities.set(params[0] as string, {
        id: params[0] as string,
        creator_user_id: params[1] as string,
        slug: params[2] as string,
        current_version_id: null,
        status: 'active',
      });
      return ok<R>([]);
    }

    // ---- INSERT capability_versions ----
    if (sql.includes('INSERT INTO capability_versions')) {
      this.versions.set(params[0] as string, {
        id: params[0] as string,
        capability_id: params[1] as string,
        version: params[2] as string,
        status: 'draft',
        manifest: JSON.parse(params[3] as string),
        structure_state: JSON.parse(params[4] as string),
        source_candidate_id: (params[5] as string | null) ?? null,
      });
      return ok<R>([]);
    }

    // ---- drafts 回填（UPDATE drafts SET version_id=$2, capability_id=$5, current_step='structure',
    //    selection=$4 WHERE id=$1 AND owner_user_id=$3 AND status='active'；owner 守卫 + rowCount，Codex P0-2/P1-5）----
    if (sql.includes('UPDATE drafts') && sql.includes("current_step = 'structure'")) {
      const draftId = params[0] as string;
      const owner = params[2] as string;
      const d = this.drafts.get(draftId);
      // owner 守卫：不存在 / 非本人 / 非 active（本夹具种的 draft 默认 active）→ 0 行。
      if (!d || (d as { owner_user_id?: string }).owner_user_id !== owner) {
        return { rows: [] as R[], rowCount: 0 } as QueryResultLike<R>;
      }
      d.version_id = params[1] as string;
      d.current_step = 'structure';
      d.selection = JSON.parse(params[3] as string);
      d.capability_id = (params[4] as string) ?? null; // 真实 capabilityId 回填（P1-5）。
      return { rows: [] as R[], rowCount: 1 } as QueryResultLike<R>;
    }

    throw new Error(`StructureFakeDb: unhandled SQL: ${sql.slice(0, 110)}`);
  }
}

/** mock txPool：BEGIN/COMMIT/ROLLBACK 到同一 db（建体写直接作用于 db；ROLLBACK 还原快照）。 */
export class StructureFakeTxPool {
  readonly committed: boolean[] = [];
  readonly rolledBack: boolean[] = [];
  constructor(private readonly db: StructureFakeDb) {}
  async connect(): Promise<{ query: Queryable['query']; release: () => void }> {
    const db = this.db;
    const committed = this.committed;
    const rolledBack = this.rolledBack;
    let snapCaps: Map<string, CapabilityRowF> | null = null;
    let snapVers: Map<string, VersionRowF> | null = null;
    let snapDrafts: Map<string, DraftRowF> | null = null;
    return {
      async query<R = Record<string, unknown>>(
        sql: string,
        params: unknown[] = [],
      ): Promise<QueryResultLike<R>> {
        if (sql.startsWith('BEGIN')) {
          snapCaps = new Map([...db.capabilities].map(([k, v]) => [k, { ...v }]));
          snapVers = new Map([...db.versions].map(([k, v]) => [k, { ...v }]));
          snapDrafts = new Map([...db.drafts].map(([k, v]) => [k, { ...v }]));
          return ok<R>([]);
        }
        if (sql.startsWith('COMMIT')) {
          committed.push(true);
          snapCaps = snapVers = snapDrafts = null;
          return ok<R>([]);
        }
        if (sql.startsWith('ROLLBACK')) {
          if (snapCaps) {
            db.capabilities.clear();
            for (const [k, v] of snapCaps) db.capabilities.set(k, v);
          }
          if (snapVers) {
            db.versions.clear();
            for (const [k, v] of snapVers) db.versions.set(k, v);
          }
          if (snapDrafts) {
            db.drafts.clear();
            for (const [k, v] of snapDrafts) db.drafts.set(k, v);
          }
          snapCaps = snapVers = snapDrafts = null;
          rolledBack.push(true);
          return ok<R>([]);
        }
        return db.query<R>(sql, params);
      },
      release() {},
    };
  }
}

/**
 * 可编程流式 mock LLM 网关（结构化用 stream + complete）。
 *   - scalar（stream）：按 field 返回分片序列（deltaText 累积成终值）；缺省按 field 给默认分片。
 *   - array（complete）：按 field 返回 JSON 数组文本。
 *   - 失败注入：failFields 集合里的字段每次调用都真抛（验证 ≤2 重试 → 落错误态）。
 *   - degraded：degradedFields 里的字段返回 degraded（验证兜底）。
 */
export class StreamingFakeGateway implements LlmGatewayPort {
  /** field → 流式分片序列（scalar 用）。 */
  scalarChunks: Partial<Record<string, string[]>> = {};
  /** field → complete 返回文本（array 用）。 */
  arrayText: Partial<Record<string, string>> = {};
  /** 这些字段每次 stream/complete 调用都真抛（escape，非 degraded）。 */
  failFields = new Set<string>();
  /**
   * 这些字段【前 N 次】stream/complete 调用真抛、之后成功（模拟「单次重生成内首试失败、内部重试可愈」）。
   *   §3.4 跨调用累计验证用：每次真抛递减计数（counter→0 后该字段成功）。
   */
  failNextByField: Map<string, number> = new Map();
  /** 这些字段返回 degraded（complete）/空（stream）。 */
  degradedFields = new Set<string>();
  /** 这些字段每片 delta 之间延迟 slowMs（让 field_stuck 定时器先触发）。 */
  slowFields = new Set<string>();
  slowMs = 30;
  /** 记录调用序（字段名）。 */
  streamCalls: string[] = [];
  completeCalls: string[] = [];

  private fieldFromPrompt(prompt: string): string {
    // 只看【首行指令】（evidenceBlurb 里的「已知信息」含旧字段值，会误判，故只匹配指令行）。
    const head = prompt.split('\n')[0] ?? '';
    if (head.includes('名称')) return 'name';
    if (head.includes('卖点') || head.includes('定位')) return 'tagline';
    if (head.includes('角色')) return 'role';
    if (head.includes('目标')) return 'goal';
    if (head.includes('系统指令') || head.includes('工作步骤')) return 'instructions';
    if (head.includes('拿手本事') || head.includes('技能集')) return 'skill_set';
    if (head.includes('起手')) return 'starter_prompts';
    return 'unknown';
  }

  /** 该字段本次调用是否应真抛（failFields 永抛；failNextByField 前 N 次抛后愈）。 */
  private shouldFail(field: string): boolean {
    if (this.failFields.has(field)) return true;
    const left = this.failNextByField.get(field) ?? 0;
    if (left > 0) {
      this.failNextByField.set(field, left - 1);
      return true;
    }
    return false;
  }

  async complete(prompt: string): Promise<LlmResult> {
    const field = this.fieldFromPrompt(prompt);
    this.completeCalls.push(field);
    if (this.shouldFail(field)) throw new Error('llm upstream exception');
    if (this.degradedFields.has(field)) {
      return { degraded: true, usage: { promptTokens: 1, completionTokens: 0, costMicros: 0 } };
    }
    const text = this.arrayText[field] ?? '["技能A","技能B","技能C"]';
    return {
      text,
      degraded: false,
      usage: { promptTokens: 5, completionTokens: 5, costMicros: 0 },
    };
  }

  async *stream(prompt: string): AsyncIterable<{ deltaText: string }> {
    const field = this.fieldFromPrompt(prompt);
    this.streamCalls.push(field);
    if (this.shouldFail(field)) throw new Error('llm upstream exception');
    if (this.degradedFields.has(field)) {
      return; // 无分片 → 空输出 → handler 兜底（degraded）。
    }
    const chunks = this.scalarChunks[field] ?? [`${field}-值`];
    for (const c of chunks) {
      if (this.slowFields.has(field)) {
        await new Promise((r) => setTimeout(r, this.slowMs));
      }
      yield { deltaText: c };
    }
  }

  async embed(): Promise<LlmResult> {
    return { degraded: true, usage: { promptTokens: 0, completionTokens: 0, costMicros: 0 } };
  }
}

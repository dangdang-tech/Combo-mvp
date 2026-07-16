// 测试共用假件：忠实假 PG（按 repo 的真实 SQL 形态逐条模拟）+ 假对象存储 + 假 agent 工厂。
// 「忠实」指：守卫条件（owner/唯一约束/过滤）与真实 SQL 语义一致，命中/未命中行数可断言。
import type { Bucket } from '@cb/shared';
import type { Queryable, QueryResultLike, TxConn, TxPool } from '../platform/infra/db.js';
import type { RuntimeObjectStore } from '../platform/infra/object-store.js';
import type { TurnAgent, TurnAgentFactory, TurnAgentInput } from '../modules/agent/run-turn.js';
import type { ArtifactAgentTool } from '../modules/artifact/tool.js';
import {
  compareStreamIds,
  EVENT_STREAM_MAXLEN,
  type SessionEventLog,
  type StreamEventEntry,
} from '../modules/agent/event-log.js';

let seq = 0;
/** 递增的假 UUID（保持 id 可比较排序，模拟 UUID v7 时间有序）。 */
export function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}-${String(seq).padStart(6, '0')}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

export interface CapabilityRowF {
  id: string;
  task_id: string;
  owner_user_id: string;
  name: string;
  summary: string;
  kind: string;
  storage_key: string;
  published: boolean;
  created_at: string;
}

export interface SessionRowF {
  id: string;
  capability_id: string;
  owner_user_id: string;
  title: string | null;
  status: 'active' | 'closed';
  created_at: string;
  updated_at: string;
}

export interface MessageRowF {
  id: string;
  session_id: string;
  seq: number | null;
  turn_id: string | null;
  idx: number | null;
  role: string;
  content: unknown[];
  status: string;
  created_at: string;
}

export interface TurnRowF {
  id: string;
  session_id: string;
  status: 'running' | 'completed' | 'failed' | 'interrupted';
  last_error: { code: string; message: string } | null;
  created_at: string;
  finished_at: string | null;
}

export interface ArtifactRowF {
  id: string;
  session_id: string;
  kind: string;
  title: string | null;
  storage_key: string;
  meta: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export class FakeSessionEventLog implements SessionEventLog {
  private readonly streams = new Map<string, StreamEventEntry[]>();
  private lastMilliseconds = -1;
  private sequence = 0;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly maxlen = EVENT_STREAM_MAXLEN,
  ) {}

  async append(sessionId: string, event: Record<string, unknown>): Promise<string> {
    const milliseconds = Math.max(this.now(), this.lastMilliseconds);
    this.sequence = milliseconds === this.lastMilliseconds ? this.sequence + 1 : 0;
    this.lastMilliseconds = milliseconds;
    const entry = { id: `${milliseconds}-${this.sequence}`, event };
    const stream = this.streams.get(sessionId) ?? [];
    stream.push(entry);
    if (stream.length > this.maxlen) stream.splice(0, stream.length - this.maxlen);
    this.streams.set(sessionId, stream);
    return entry.id;
  }

  async rangeAfter(sessionId: string, afterId: string, count: number): Promise<StreamEventEntry[]> {
    return (this.streams.get(sessionId) ?? [])
      .filter((entry) => compareStreamIds(entry.id, afterId) > 0)
      .slice(0, count);
  }

  entries(sessionId: string): StreamEventEntry[] {
    return [...(this.streams.get(sessionId) ?? [])];
  }
}

/** 忠实假 PG（capabilities / sessions / messages / artifacts）。也可当 TxPool 用。 */
export class FakeDb implements Queryable, TxPool {
  capabilities = new Map<string, CapabilityRowF>();
  sessions = new Map<string, SessionRowF>();
  messages: MessageRowF[] = [];
  turns = new Map<string, TurnRowF>();
  artifacts = new Map<string, ArtifactRowF>();
  /** 事务轨迹（断言 BEGIN/COMMIT/ROLLBACK 收口）。 */
  txLog: string[] = [];
  queries: string[] = [];

  seedCapability(input: Partial<CapabilityRowF> & { owner_user_id: string }): CapabilityRowF {
    const id = input.id ?? nextId('cap');
    const row: CapabilityRowF = {
      id,
      task_id: input.task_id ?? nextId('task'),
      owner_user_id: input.owner_user_id,
      name: input.name ?? '测试能力',
      summary: input.summary ?? '一句话简介',
      kind: input.kind ?? 'writing',
      storage_key: input.storage_key ?? `capabilities/${id}/definition.json`,
      published: input.published ?? false,
      created_at: input.created_at ?? nowIso(),
    };
    this.capabilities.set(row.id, row);
    return row;
  }

  async connect(): Promise<TxConn> {
    return {
      query: (sql: string, params?: unknown[]) => this.query(sql, params),
      release: () => undefined,
    };
  }

  async query<R = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<QueryResultLike<R>> {
    const s = sql.replace(/\s+/g, ' ').trim();
    this.queries.push(s);

    if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') {
      this.txLog.push(s);
      return { rows: [], rowCount: null };
    }

    // ---------- capabilities ----------
    if (s.includes('FROM capabilities WHERE id = $1') && s.includes('storage_key')) {
      const c = this.capabilities.get(params[0] as string);
      return c ? { rows: [{ ...c }] as R[], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (s.includes('SELECT id, name, summary, kind FROM capabilities WHERE id = $1')) {
      const c = this.capabilities.get(params[0] as string);
      if (!c) return { rows: [], rowCount: 0 };
      return {
        rows: [{ id: c.id, name: c.name, summary: c.summary, kind: c.kind }] as R[],
        rowCount: 1,
      };
    }
    if (s.includes('FROM capabilities WHERE owner_user_id = $1 OR published = true')) {
      const owner = params[0] as string;
      const rows = [...this.capabilities.values()]
        .filter((c) => c.owner_user_id === owner || c.published)
        .sort((a, b) => (a.id < b.id ? 1 : -1)) // created_at DESC（id 时间有序等价）
        .slice(0, 100)
        .map((c) => ({ ...c }));
      return { rows: rows as R[], rowCount: rows.length };
    }

    // ---------- sessions ----------
    if (s.startsWith('INSERT INTO sessions')) {
      const [capabilityId, ownerUserId] = params as [string, string];
      const now = nowIso();
      const row: SessionRowF = {
        id: nextId('sess'),
        capability_id: capabilityId,
        owner_user_id: ownerUserId,
        title: null,
        status: 'active',
        created_at: now,
        updated_at: now,
      };
      this.sessions.set(row.id, row);
      return { rows: [{ ...row }] as R[], rowCount: 1 };
    }
    if (
      s.includes('FROM sessions WHERE owner_user_id = $1') &&
      s.includes('ORDER BY updated_at DESC')
    ) {
      // 对齐真 SQL：$2 为 null 不过滤，否则只留该能力下的会话。
      const owner = params[0] as string;
      const capabilityId = (params[1] ?? null) as string | null;
      const rows = [...this.sessions.values()]
        .filter((x) => x.owner_user_id === owner)
        .filter((x) => capabilityId === null || x.capability_id === capabilityId)
        .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))
        .slice(0, 100)
        .map((x) => ({ ...x }));
      return { rows: rows as R[], rowCount: rows.length };
    }
    if (s.includes('FROM sessions WHERE id = $1 AND owner_user_id = $2')) {
      const x = this.sessions.get(params[0] as string);
      if (!x || x.owner_user_id !== params[1]) return { rows: [], rowCount: 0 };
      return { rows: [{ ...x }] as R[], rowCount: 1 };
    }
    if (s.includes('SELECT id, title FROM sessions WHERE id = $1 FOR UPDATE')) {
      const x = this.sessions.get(params[0] as string);
      if (!x) return { rows: [], rowCount: 0 };
      return { rows: [{ id: x.id, title: x.title }] as R[], rowCount: 1 };
    }
    if (s.includes('UPDATE sessions SET updated_at = now(), title = COALESCE(title, $2)')) {
      const [id, title] = params as [string, string | null];
      const x = this.sessions.get(id);
      if (!x) return { rows: [], rowCount: 0 };
      x.updated_at = nowIso();
      x.title = x.title ?? title;
      return { rows: [], rowCount: 1 };
    }

    // ---------- turns ----------
    if (s.startsWith('INSERT INTO turns')) {
      const [id, sessionId] = params as [string, string];
      const row: TurnRowF = {
        id,
        session_id: sessionId,
        status: 'running',
        last_error: null,
        created_at: nowIso(),
        finished_at: null,
      };
      this.turns.set(id, row);
      return { rows: [{ ...row }] as R[], rowCount: 1 };
    }
    if (s.startsWith('UPDATE turns SET status = $2')) {
      const [id, status, errorJson] = params as [string, TurnRowF['status'], string | null];
      const row = this.turns.get(id);
      if (!row || row.status !== 'running') return { rows: [], rowCount: 0 };
      row.status = status;
      row.finished_at = nowIso();
      row.last_error = errorJson ? (JSON.parse(errorJson) as TurnRowF['last_error']) : null;
      return { rows: [], rowCount: 1 };
    }
    if (s.startsWith("UPDATE turns SET status = 'failed'")) {
      const [id, errorJson] = params as [string, string];
      const row = this.turns.get(id);
      if (!row || row.status !== 'running') return { rows: [], rowCount: 0 };
      row.status = 'failed';
      row.finished_at = nowIso();
      row.last_error = JSON.parse(errorJson) as TurnRowF['last_error'];
      return { rows: [], rowCount: 1 };
    }
    if (s.startsWith('SELECT EXISTS (SELECT 1 FROM turns')) {
      const exists = [...this.turns.values()].some(
        (row) => row.session_id === params[0] && row.status === 'running',
      );
      return { rows: [{ exists }] as R[], rowCount: 1 };
    }
    if (s.startsWith('SELECT id, session_id FROM turns')) {
      const cutoff = (params[0] as Date).getTime();
      const rows = [...this.turns.values()]
        .filter((row) => row.status === 'running' && new Date(row.created_at).getTime() < cutoff)
        .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
        .map(({ id, session_id }) => ({ id, session_id }));
      return { rows: rows as R[], rowCount: rows.length };
    }

    // ---------- messages ----------
    if (s.includes('SELECT MAX(seq) AS m FROM messages WHERE session_id = $1')) {
      const rows = this.messages.filter((m) => m.session_id === params[0]);
      const seqs = rows.flatMap((r) => (r.seq === null ? [] : [r.seq]));
      const m = seqs.length > 0 ? Math.max(...seqs) : null;
      return { rows: [{ m }] as R[], rowCount: 1 };
    }
    if (
      s.startsWith('INSERT INTO messages') &&
      s.includes('SELECT $1, $2, COALESCE(MAX(idx), 0)')
    ) {
      const [sessionId, turnId, contentJson] = params as [string, string, string];
      const indexes = this.messages.flatMap((m) =>
        m.turn_id === turnId && m.idx !== null ? [m.idx] : [],
      );
      const idx = (indexes.length ? Math.max(...indexes) : 0) + 1;
      const row: MessageRowF = {
        id: nextId('msg'),
        session_id: sessionId,
        turn_id: turnId,
        idx,
        seq: null,
        role: 'assistant',
        content: JSON.parse(contentJson) as unknown[],
        status: 'failed',
        created_at: nowIso(),
      };
      this.messages.push(row);
      return { rows: [], rowCount: 1 };
    }
    if (s.startsWith('INSERT INTO messages') && s.includes('VALUES ($1, $2, $3, NULL')) {
      const [sessionId, turnId, idx, role, contentJson, status] = params as [
        string,
        string,
        number,
        string,
        string,
        string,
      ];
      if (this.messages.some((m) => m.turn_id === turnId && m.idx === idx)) {
        const err = Object.assign(
          new Error('duplicate key value violates "uq_messages_turn_idx"'),
          { code: '23505' },
        );
        throw err;
      }
      const row: MessageRowF = {
        id: nextId('msg'),
        session_id: sessionId,
        turn_id: turnId,
        idx,
        seq: null,
        role,
        content: JSON.parse(contentJson) as unknown[],
        status,
        created_at: nowIso(),
      };
      this.messages.push(row);
      return { rows: [{ ...row }] as R[], rowCount: 1 };
    }
    if (s.startsWith('INSERT INTO messages')) {
      const [sessionId, msgSeq, role, contentJson, status] = params as [
        string,
        number,
        string,
        string,
        string,
      ];
      // uq_messages_session_seq 唯一约束（兜底撞车语义与真库一致）。
      if (this.messages.some((m) => m.session_id === sessionId && m.seq === msgSeq)) {
        const err = new Error('duplicate key value violates "uq_messages_session_seq"') as Error & {
          code: string;
        };
        err.code = '23505';
        throw err;
      }
      const row: MessageRowF = {
        id: nextId('msg'),
        session_id: sessionId,
        seq: msgSeq,
        turn_id: null,
        idx: null,
        role,
        content: JSON.parse(contentJson) as unknown[],
        status,
        created_at: nowIso(),
      };
      this.messages.push(row);
      return {
        rows: [
          {
            id: row.id,
            seq: row.seq,
            role: row.role,
            content: row.content,
            status: row.status,
            created_at: row.created_at,
          },
        ] as R[],
        rowCount: 1,
      };
    }
    if (s.startsWith('SELECT count(*) AS count FROM messages')) {
      const count = this.messages.filter((m) => m.session_id === params[0]).length;
      return { rows: [{ count: String(count) }] as R[], rowCount: 1 };
    }
    if (s.includes('FROM messages m LEFT JOIN turns t')) {
      // 忠实于真 SQL:不做可见性过滤(详情要看到运行中/失败轮的消息),只按会话取全量后合并排序。
      const rows = this.messages
        .filter((m) => m.session_id === params[0])
        .sort((a, b) => {
          const ta = a.turn_id
            ? (this.turns.get(a.turn_id)?.created_at ?? a.created_at)
            : a.created_at;
          const tb = b.turn_id
            ? (this.turns.get(b.turn_id)?.created_at ?? b.created_at)
            : b.created_at;
          return (
            ta.localeCompare(tb) ||
            (a.idx ?? a.seq ?? 0) - (b.idx ?? b.seq ?? 0) ||
            a.created_at.localeCompare(b.created_at)
          );
        })
        .map((m) => ({
          ...m,
          turn_status: m.turn_id ? (this.turns.get(m.turn_id)?.status ?? null) : null,
          turn_created_at: m.turn_id ? (this.turns.get(m.turn_id)?.created_at ?? null) : null,
        }));
      return { rows: rows as R[], rowCount: rows.length };
    }

    // ---------- artifacts ----------
    if (s.startsWith('INSERT INTO artifacts')) {
      const [id, sessionId, kind, title, storageKey, metaJson] = params as [
        string,
        string,
        string,
        string,
        string,
        string,
      ];
      const existing = this.artifacts.get(id);
      const now = nowIso();
      const row: ArtifactRowF = existing
        ? { ...existing, kind, title, meta: JSON.parse(metaJson), updated_at: now }
        : {
            id,
            session_id: sessionId,
            kind,
            title,
            storage_key: storageKey,
            meta: JSON.parse(metaJson) as Record<string, unknown>,
            created_at: now,
            updated_at: now,
          };
      this.artifacts.set(id, row);
      return {
        rows: [
          {
            id: row.id,
            session_id: row.session_id,
            kind: row.kind,
            title: row.title,
            storage_key: row.storage_key,
            updated_at: row.updated_at,
          },
        ] as R[],
        rowCount: 1,
      };
    }
    if (s.includes('SELECT id FROM artifacts WHERE id = $1 AND session_id = $2')) {
      const a = this.artifacts.get(params[0] as string);
      if (!a || a.session_id !== params[1]) return { rows: [], rowCount: 0 };
      return { rows: [{ id: a.id }] as R[], rowCount: 1 };
    }
    if (s.includes('FROM artifacts WHERE session_id = $1 ORDER BY created_at ASC')) {
      const rows = [...this.artifacts.values()]
        .filter((a) => a.session_id === params[0])
        .sort((a, b) => (a.created_at < b.created_at ? -1 : 1))
        .map((a) => ({
          id: a.id,
          session_id: a.session_id,
          kind: a.kind,
          title: a.title,
          storage_key: a.storage_key,
          updated_at: a.updated_at,
        }));
      return { rows: rows as R[], rowCount: rows.length };
    }
    if (s.includes('FROM artifacts a JOIN sessions s ON s.id = a.session_id')) {
      const a = this.artifacts.get(params[0] as string);
      if (!a) return { rows: [], rowCount: 0 };
      const owner = this.sessions.get(a.session_id);
      if (!owner || owner.owner_user_id !== params[1]) return { rows: [], rowCount: 0 };
      return {
        rows: [{ id: a.id, kind: a.kind, storage_key: a.storage_key }] as R[],
        rowCount: 1,
      };
    }

    throw new Error(`FakeDb: unhandled SQL: ${s.slice(0, 140)}`);
  }
}

/** 假对象存储（内存 Map，实现 runtime 的三方法子集）。 */
export class FakeObjectStore implements RuntimeObjectStore {
  objects = new Map<string, Uint8Array>();

  private k(bucket: string, key: string): string {
    return `${bucket}/${key}`;
  }
  async putObject(bucket: Bucket, key: string, body: Uint8Array): Promise<{ key: string }> {
    this.objects.set(this.k(bucket, key), body);
    return { key };
  }
  async getObjectText(bucket: Bucket, key: string): Promise<string> {
    const v = this.objects.get(this.k(bucket, key));
    if (!v) throw new Error(`FakeObjectStore: missing ${bucket}/${key}`);
    return new TextDecoder().decode(v);
  }
  async getObject(bucket: Bucket, key: string): Promise<Uint8Array> {
    const v = this.objects.get(this.k(bucket, key));
    if (!v) throw new Error(`FakeObjectStore: missing ${bucket}/${key}`);
    return v;
  }
  /** 测试便捷：直接放一段文本对象。 */
  seedText(bucket: string, key: string, text: string): void {
    this.objects.set(this.k(bucket, key), new TextEncoder().encode(text));
  }
}

// ───────────────────────────── 假 agent 工厂 ─────────────────────────────

/** 假 agent 剧本：按序发文本增量 → 可选调产物工具 → 按脚本成功/抛错/挂起等待打断。 */
export interface FakeAgentScript {
  deltas?: string[];
  /** 本轮新消息（拼在 history + user 之后成为 transcript 尾部）。 */
  finalMessages?: unknown[];
  /** prompt 期间调一次产物工具（覆盖 run-turn 的 onArtifact 接线）。 */
  invokeTool?: { title: string; content: string; artifactId?: string };
  /** prompt 直接 reject。 */
  promptError?: Error;
  /** pi 把失败编码进消息的形态。 */
  runtimeError?: string;
  /** prompt 挂起直到 abort（打断路径）。 */
  hangUntilAbort?: boolean;
}

export interface FakeAgentFactoryHandle {
  factory: TurnAgentFactory;
  /** 每次构造 agent 收到的入参（断言 definition/history/tools 接线）。 */
  calls: TurnAgentInput[];
}

export function makeFakeAgentFactory(script: FakeAgentScript = {}): FakeAgentFactoryHandle {
  const calls: TurnAgentInput[] = [];
  const factory: TurnAgentFactory = (input) => {
    calls.push(input);
    const listeners = new Set<(delta: string) => void>();
    let aborted = false;
    let abortHook: (() => void) | undefined;

    const agent: TurnAgent = {
      subscribeTextDelta(fn) {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      async prompt() {
        for (const delta of script.deltas ?? []) {
          for (const fn of listeners) fn(delta);
        }
        if (script.invokeTool) {
          const tool = input.tools[0] as ArtifactAgentTool;
          await tool.execute('tc-1', {
            kind: 'html',
            title: script.invokeTool.title,
            content: script.invokeTool.content,
            ...(script.invokeTool.artifactId ? { artifactId: script.invokeTool.artifactId } : {}),
          });
        }
        if (script.hangUntilAbort) {
          await new Promise<void>((_resolve, reject) => {
            abortHook = () => reject(new Error('aborted'));
            if (aborted) reject(new Error('aborted'));
          });
        }
        if (script.promptError) throw script.promptError;
      },
      abort() {
        aborted = true;
        abortHook?.();
      },
      transcript() {
        return [
          ...input.history,
          { role: 'user', content: [{ type: 'text', text: '(prompt)' }] },
          ...(script.finalMessages ?? []),
        ];
      },
      runtimeError() {
        return script.runtimeError;
      },
    };
    return agent;
  };
  return { factory, calls };
}

/** 静默 TurnLogger（测试里不刷屏）。 */
export const silentLog = { error: () => undefined };

/** 轮询等待条件成立（异步轮次收尾用）。 */
export async function waitFor(
  cond: () => boolean | Promise<boolean>,
  timeoutMs = 2_000,
): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
}

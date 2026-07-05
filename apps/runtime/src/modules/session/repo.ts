// sessions / messages 两表 SQL。owner 校验统一收在 SQL 的 owner_user_id 条件里：
// 非本人与不存在同样 0 行（不暴露存在性）。
import type { MessageRole, MessageStatus, MessageView, SessionView } from '@cb/shared';
import { withTransaction, type Queryable, type RuntimeDb } from '../../platform/infra/db.js';
import { parseMessageContent } from './message-content.js';

/** timestamptz → ISO 字符串（pg 可能回 Date 或字符串）。 */
export function toIso(v: string | Date): string {
  if (v instanceof Date) return v.toISOString();
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : d.toISOString();
}

interface SessionDbRow {
  id: string;
  capability_id: string;
  owner_user_id: string;
  title: string | null;
  status: 'active' | 'closed';
  created_at: string | Date;
  updated_at: string | Date;
}

/** 会话内部行（含 ownerUserId，仅服务端用；对外形态是 SessionView）。 */
export interface SessionRow {
  id: string;
  capabilityId: string;
  ownerUserId: string;
  title: string | null;
  status: 'active' | 'closed';
  createdAt: string;
  updatedAt: string;
}

const SESSION_COLUMNS = `id, capability_id, owner_user_id, title, status, created_at, updated_at`;

function toSessionRow(r: SessionDbRow): SessionRow {
  return {
    id: r.id,
    capabilityId: r.capability_id,
    ownerUserId: r.owner_user_id,
    title: r.title,
    status: r.status,
    createdAt: toIso(r.created_at),
    updatedAt: toIso(r.updated_at),
  };
}

export function toSessionView(row: SessionRow): SessionView {
  return {
    id: row.id,
    capabilityId: row.capabilityId,
    ...(row.title ? { title: row.title } : {}),
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** 建会话（loader 校验通过后调用）。 */
export async function createSession(
  db: Queryable,
  input: { capabilityId: string; ownerUserId: string },
): Promise<SessionRow> {
  const res = await db.query<SessionDbRow>(
    `INSERT INTO sessions (capability_id, owner_user_id)
     VALUES ($1, $2)
     RETURNING ${SESSION_COLUMNS}`,
    [input.capabilityId, input.ownerUserId],
  );
  const row = res.rows[0];
  if (!row) throw new Error('createSession: insert returned no row');
  return toSessionRow(row);
}

/** 我的会话列表，按 updated_at 降序；给 capabilityId 时只列该能力下的会话（侧栏按能力隔离）。 */
export async function listSessions(
  db: Queryable,
  ownerUserId: string,
  capabilityId?: string,
): Promise<SessionRow[]> {
  const res = await db.query<SessionDbRow>(
    `SELECT ${SESSION_COLUMNS}
       FROM sessions
      WHERE owner_user_id = $1
        AND ($2::uuid IS NULL OR capability_id = $2)
      ORDER BY updated_at DESC
      LIMIT 100`,
    [ownerUserId, capabilityId ?? null],
  );
  return res.rows.map(toSessionRow);
}

/** owner-scoped 取会话；非本人/不存在 → null。 */
export async function getSession(
  db: Queryable,
  id: string,
  ownerUserId: string,
): Promise<SessionRow | null> {
  const res = await db.query<SessionDbRow>(
    `SELECT ${SESSION_COLUMNS} FROM sessions WHERE id = $1 AND owner_user_id = $2 LIMIT 1`,
    [id, ownerUserId],
  );
  const row = res.rows[0];
  return row ? toSessionRow(row) : null;
}

// ───────────────────────────── messages ─────────────────────────────

interface MessageDbRow {
  id: string;
  seq: number;
  role: MessageRole;
  content: unknown[];
  status: MessageStatus;
  created_at: string | Date;
}

/** 消息行（= 对外 MessageView 同形态；build-agent 也直接消费它重建历史）。 */
export interface MessageRecord extends MessageView {
  role: MessageRole;
}

function toMessageRecord(r: MessageDbRow): MessageRecord {
  return {
    id: r.id,
    seq: r.seq,
    role: r.role,
    content: Array.isArray(r.content) ? r.content : [],
    status: r.status,
    createdAt: toIso(r.created_at),
  };
}

/** 会话全部消息，按 seq 升序。 */
export async function getMessages(db: Queryable, sessionId: string): Promise<MessageRecord[]> {
  const res = await db.query<MessageDbRow>(
    `SELECT id, seq, role, content, status, created_at
       FROM messages
      WHERE session_id = $1
      ORDER BY seq ASC`,
    [sessionId],
  );
  return res.rows.map(toMessageRecord);
}

/** 从首条用户消息文本派生会话标题（首轮自动命名）。 */
function deriveTitle(content: unknown[]): string | null {
  const first = content.find(
    (b): b is { type: 'text'; text: string } =>
      typeof b === 'object' &&
      b !== null &&
      (b as { type?: unknown }).type === 'text' &&
      typeof (b as { text?: unknown }).text === 'string',
  );
  const title = first?.text.trim().slice(0, 30);
  return title || null;
}

/**
 * 追加一条消息：锁会话行 → max(seq)+1 插入（并发轮次串行化 seq 分配；
 * uq_messages_session_seq 唯一约束兜底撞车）。同事务里 touch sessions.updated_at，
 * 首条用户消息时顺手补会话标题。content 写入前必过 parseMessageContent（坏块拒写）。
 */
export async function appendMessage(
  db: RuntimeDb,
  input: {
    sessionId: string;
    role: MessageRole;
    content: unknown[];
    status?: MessageStatus;
  },
): Promise<MessageRecord> {
  const content = parseMessageContent(input.role, input.content);
  const status: MessageStatus = input.status ?? 'completed';

  return withTransaction(db, async (tx) => {
    const locked = await tx.query<{ id: string; title: string | null }>(
      `SELECT id, title FROM sessions WHERE id = $1 FOR UPDATE`,
      [input.sessionId],
    );
    if (!locked.rows[0]) throw new Error(`appendMessage: session ${input.sessionId} not found`);

    const seqRes = await tx.query<{ m: number | null }>(
      `SELECT MAX(seq) AS m FROM messages WHERE session_id = $1`,
      [input.sessionId],
    );
    const seq = (seqRes.rows[0]?.m ?? 0) + 1;

    const inserted = await tx.query<MessageDbRow>(
      `INSERT INTO messages (session_id, seq, role, content, status)
       VALUES ($1, $2, $3, $4::jsonb, $5)
       RETURNING id, seq, role, content, status, created_at`,
      [input.sessionId, seq, input.role, JSON.stringify(content), status],
    );
    const row = inserted.rows[0];
    if (!row) throw new Error('appendMessage: insert returned no row');

    // 首条用户消息 + 会话还没标题 → 用输入前 30 字补标题；其余只 touch updated_at。
    const derivedTitle =
      input.role === 'user' && !locked.rows[0].title ? deriveTitle(content) : null;
    await tx.query(
      `UPDATE sessions SET updated_at = now(), title = COALESCE(title, $2) WHERE id = $1`,
      [input.sessionId, derivedTitle],
    );

    return toMessageRecord(row);
  });
}

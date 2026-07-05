// stream_events 表 SQL：流式生成的过程记录，断线续传/排障回放的真源。
//   id 是 bigserial（= SSE 帧 id）；断线重连带 Last-Event-ID，从 id > afterId 处补发。
import type { Queryable } from '../../platform/infra/db.js';

export interface StreamEventRow {
  id: number;
  /** AG-UI 标准事件对象。 */
  event: Record<string, unknown>;
}

/** 落一条流式事件，返回自增 id（pg bigint 以字符串回来，统一转 number）。 */
export async function insertStreamEvent(
  db: Queryable,
  input: { sessionId: string; messageId?: string | null; event: Record<string, unknown> },
): Promise<number> {
  const res = await db.query<{ id: string | number }>(
    `INSERT INTO stream_events (session_id, message_id, event)
     VALUES ($1, $2, $3::jsonb)
     RETURNING id`,
    [input.sessionId, input.messageId ?? null, JSON.stringify(input.event)],
  );
  const row = res.rows[0];
  if (!row) throw new Error('insertStreamEvent: insert returned no row');
  return Number(row.id);
}

/** 读某会话 id > afterId 的历史事件（升序），单批上限 limit（调用方循环取到不足一批为止）。 */
export async function listStreamEventsAfter(
  db: Queryable,
  sessionId: string,
  afterId: number,
  limit = 500,
): Promise<StreamEventRow[]> {
  const res = await db.query<{ id: string | number; event: Record<string, unknown> }>(
    `SELECT id, event
       FROM stream_events
      WHERE session_id = $1 AND id > $2
      ORDER BY id ASC
      LIMIT $3`,
    [sessionId, afterId, limit],
  );
  return res.rows.map((r) => ({ id: Number(r.id), event: r.event }));
}

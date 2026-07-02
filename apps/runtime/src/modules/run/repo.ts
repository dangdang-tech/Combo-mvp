// 显式 Run 资源与可重放事件日志。Run 生命周期独立于 HTTP 连接：
// POST /runs 触发执行，GET /runs/:id/events 只是订阅/恢复事件流。
import type { Pool } from 'pg';
import type { RunInput, RunStatus, RuntimeRun } from '@cb/shared';

interface RunDbRow {
  id: string;
  session_id: string;
  owner_id: string;
  status: RunStatus;
  input: RunInput;
  error: string | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

export interface RunEventRow {
  id: number;
  runId: string;
  event: Record<string, unknown>;
  createdAt: string;
}

function toRun(r: RunDbRow): RuntimeRun {
  return {
    id: r.id,
    sessionId: r.session_id,
    status: r.status,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
    completedAt: r.completed_at ? r.completed_at.toISOString() : null,
  };
}

export async function createRun(
  pool: Pool,
  input: {
    sessionId: string;
    ownerId: string;
    body: RunInput;
  },
): Promise<RuntimeRun> {
  const res = await pool.query<RunDbRow>(
    `INSERT INTO rt_chat_runs (session_id, owner_id, status, input)
     VALUES ($1, $2, 'running', $3::jsonb)
     RETURNING *`,
    [input.sessionId, input.ownerId, JSON.stringify(input.body)],
  );
  const row = res.rows[0];
  if (!row) throw new Error('createRun: insert returned no row');
  return toRun(row);
}

export async function getRun(pool: Pool, id: string, ownerId: string): Promise<RuntimeRun | null> {
  const res = await pool.query<RunDbRow>(
    `SELECT * FROM rt_chat_runs WHERE id = $1 AND owner_id = $2 LIMIT 1`,
    [id, ownerId],
  );
  const row = res.rows[0];
  return row ? toRun(row) : null;
}

export async function appendRunEvent(
  pool: Pool,
  runId: string,
  event: Record<string, unknown>,
): Promise<RunEventRow> {
  const res = await pool.query<{
    id: string;
    run_id: string;
    event: Record<string, unknown>;
    created_at: Date;
  }>(
    `INSERT INTO rt_chat_run_events (run_id, event)
     VALUES ($1, $2::jsonb)
     RETURNING id, run_id, event, created_at`,
    [runId, JSON.stringify(event)],
  );
  const row = res.rows[0];
  if (!row) throw new Error('appendRunEvent: insert returned no row');
  return {
    id: Number(row.id),
    runId: row.run_id,
    event: row.event,
    createdAt: row.created_at.toISOString(),
  };
}

export async function listRunEvents(
  pool: Pool,
  runId: string,
  after: number,
): Promise<RunEventRow[]> {
  const res = await pool.query<{
    id: string;
    run_id: string;
    event: Record<string, unknown>;
    created_at: Date;
  }>(
    `SELECT id, run_id, event, created_at
       FROM rt_chat_run_events
      WHERE run_id = $1 AND id > $2
      ORDER BY id ASC
      LIMIT 200`,
    [runId, after],
  );
  return res.rows.map((r) => ({
    id: Number(r.id),
    runId: r.run_id,
    event: r.event,
    createdAt: r.created_at.toISOString(),
  }));
}

export async function setRunStatus(
  pool: Pool,
  id: string,
  status: Exclude<RunStatus, 'queued' | 'running'>,
  error: string | null = null,
): Promise<RuntimeRun | null> {
  const res = await pool.query<RunDbRow>(
    `UPDATE rt_chat_runs
        SET status = $2,
            error = $3,
            completed_at = COALESCE(completed_at, now()),
            updated_at = now()
      WHERE id = $1
      RETURNING *`,
    [id, status, error],
  );
  const row = res.rows[0];
  return row ? toRun(row) : null;
}

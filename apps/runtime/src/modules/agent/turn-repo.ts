import { withTransaction, type Queryable, type RuntimeDb } from '../../platform/infra/db.js';
import { toIso } from '../session/repo.js';

export const TURN_ABANDON_AFTER_MS = 1_800_000;
export const TURN_SWEEP_INTERVAL_MS = 60_000;

type TurnStatus = 'running' | 'completed' | 'failed' | 'interrupted';
interface TurnDbRow {
  id: string;
  session_id: string;
  status: TurnStatus;
  created_at: string | Date;
  finished_at: string | Date | null;
}
export interface TurnRow {
  id: string;
  sessionId: string;
  status: TurnStatus;
  createdAt: string;
  finishedAt: string | null;
}

function toTurnRow(row: TurnDbRow): TurnRow {
  return {
    id: row.id,
    sessionId: row.session_id,
    status: row.status,
    createdAt: toIso(row.created_at),
    finishedAt: row.finished_at === null ? null : toIso(row.finished_at),
  };
}

export async function createTurn(
  db: Queryable,
  input: { id: string; sessionId: string },
): Promise<TurnRow> {
  const result = await db.query<TurnDbRow>(
    `INSERT INTO turns (id, session_id, status)
     VALUES ($1, $2, 'running')
     RETURNING id, session_id, status, created_at, finished_at`,
    [input.id, input.sessionId],
  );
  const row = result.rows[0];
  if (!row) throw new Error('createTurn: insert returned no row');
  return toTurnRow(row);
}

export async function finishTurnCas(
  db: Queryable,
  input: {
    id: string;
    status: Exclude<TurnStatus, 'running'>;
    lastError?: { code: string; message: string } | null;
  },
): Promise<boolean> {
  const result = await db.query(
    `UPDATE turns SET status = $2, finished_at = now(), last_error = $3::jsonb
      WHERE id = $1 AND status = 'running'`,
    [input.id, input.status, input.lastError ? JSON.stringify(input.lastError) : null],
  );
  return result.rowCount === 1;
}

export async function hasRunningTurn(db: Queryable, sessionId: string): Promise<boolean> {
  const result = await db.query<{ exists: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM turns WHERE session_id = $1 AND status = 'running') AS exists`,
    [sessionId],
  );
  return result.rows[0]?.exists ?? false;
}

export async function sweepExpiredTurns(
  db: RuntimeDb,
  cutoff: Date,
): Promise<{ id: string; sessionId: string }[]> {
  const candidates = await db.query<{ id: string; session_id: string }>(
    `SELECT id, session_id FROM turns
      WHERE status = 'running' AND created_at < $1
      ORDER BY created_at, id`,
    [cutoff],
  );
  const swept: { id: string; sessionId: string }[] = [];
  for (const candidate of candidates.rows) {
    const won = await withTransaction(db, async (tx) => {
      const updated = await tx.query(
        `UPDATE turns SET status = 'failed', finished_at = now(),
                last_error = $2::jsonb
          WHERE id = $1 AND status = 'running'`,
        [
          candidate.id,
          JSON.stringify({ code: 'TURN_ABANDONED', message: '轮次运行超时，已由清扫器终止。' }),
        ],
      );
      if (updated.rowCount !== 1) return false;
      await tx.query(
        `INSERT INTO messages (session_id, turn_id, idx, seq, role, content, status)
         SELECT $1, $2, COALESCE(MAX(idx), 0) + 1, NULL, 'assistant', $3::jsonb, 'failed'
           FROM messages WHERE turn_id = $2`,
        [
          candidate.session_id,
          candidate.id,
          JSON.stringify([{ type: 'text', text: '服务异常中断,本轮已终止,请重试。' }]),
        ],
      );
      return true;
    });
    if (won) swept.push({ id: candidate.id, sessionId: candidate.session_id });
  }
  return swept;
}

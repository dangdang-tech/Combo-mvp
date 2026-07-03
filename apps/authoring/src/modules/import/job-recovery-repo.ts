// 导入 job 恢复查询（issue #5）：刷新后按 jobId / draftId 恢复真实 jobs 状态。
import {
  SSE_ROUTES,
  type ErrorBody,
  type ImportJobSnapshotView,
  type JobStatus,
  type JobView,
  type ProgressView,
} from '@cb/shared';
import { normalizeProgress } from '../../platform/jobs/repo.js';
import type { Queryable } from '../../platform/jobs/types.js';

interface ImportJobSnapshotRow {
  id: string;
  status: JobStatus;
  progress: Partial<ProgressView> | null;
  result: unknown;
  error: ErrorBody | null;
  attempt_no: number;
  created_at: string | Date;
  started_at: string | Date | null;
  finished_at: string | Date | null;
  subject_ref: { draftId?: unknown } | null;
  snapshot_id: string | null;
}

function toIso(value: string | Date | null | undefined): string | undefined {
  if (!value) return undefined;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function snapshotIdFromResult(result: unknown): string | undefined {
  if (typeof result !== 'object' || result === null) return undefined;
  const id = (result as { snapshotId?: unknown }).snapshotId;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

function rowToSnapshot(row: ImportJobSnapshotRow): ImportJobSnapshotView {
  const job: JobView = {
    id: row.id,
    type: 'import',
    status: row.status,
    progress: normalizeProgress(row.progress),
    attemptNo: Number(row.attempt_no ?? 0),
    createdAt: toIso(row.created_at) ?? new Date().toISOString(),
    ...(row.result !== null ? { result: row.result } : {}),
    ...(row.error !== null ? { error: row.error } : {}),
    ...(toIso(row.started_at) ? { startedAt: toIso(row.started_at) } : {}),
    ...(toIso(row.finished_at) ? { finishedAt: toIso(row.finished_at) } : {}),
  };
  const draftId =
    typeof row.subject_ref?.draftId === 'string' && row.subject_ref.draftId.length > 0
      ? row.subject_ref.draftId
      : undefined;
  const snapshotId = snapshotIdFromResult(row.result) ?? row.snapshot_id ?? undefined;
  return {
    job,
    eventsUrl: SSE_ROUTES.jobEvents(row.id),
    ...(draftId ? { draftId } : {}),
    ...(snapshotId ? { snapshotId } : {}),
  };
}

const IMPORT_JOB_SNAPSHOT_SELECT = `
  SELECT j.id,
         j.status,
         j.progress,
         j.result,
         j.error,
         j.attempt_no,
         j.created_at,
         j.started_at,
         j.finished_at,
         j.subject_ref,
         COALESCE(j.result->>'snapshotId', rs.id::text) AS snapshot_id
    FROM jobs j
    LEFT JOIN LATERAL (
      SELECT id
        FROM raw_snapshots
       WHERE import_job_id = j.id
       ORDER BY created_at DESC
       LIMIT 1
    ) rs ON true
`;

export async function readImportJobSnapshotForOwner(
  db: Queryable,
  args: { jobId: string; ownerUserId: string },
): Promise<ImportJobSnapshotView | null> {
  const res = await db.query<ImportJobSnapshotRow>(
    `${IMPORT_JOB_SNAPSHOT_SELECT}
     WHERE j.id = $1
       AND j.owner_user_id = $2
       AND j.type = 'import'`,
    [args.jobId, args.ownerUserId],
  );
  const row = res.rows[0];
  return row ? rowToSnapshot(row) : null;
}

export async function readImportJobSnapshotForDraft(
  db: Queryable,
  args: { draftId: string; ownerUserId: string },
): Promise<ImportJobSnapshotView | null> {
  const res = await db.query<ImportJobSnapshotRow>(
    `${IMPORT_JOB_SNAPSHOT_SELECT}
     WHERE j.owner_user_id = $1
       AND j.type = 'import'
       AND j.status IN ('queued', 'running', 'completed')
       AND j.subject_ref->>'draftId' = $2
     ORDER BY CASE WHEN j.status IN ('queued', 'running') THEN 0 ELSE 1 END,
              j.created_at DESC
     LIMIT 1`,
    [args.ownerUserId, args.draftId],
  );
  const row = res.rows[0];
  return row ? rowToSnapshot(row) : null;
}

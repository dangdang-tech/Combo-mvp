import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type {
  ArtifactRef,
  StudioRevision,
  StudioState,
  StudioTest,
  StudioTestStatus,
} from '@cb/shared';

interface RevisionDbRow {
  id: string;
  revision_no: number;
  artifact_key: string;
  artifact_version: number;
  source_run_id: string | null;
  summary: string;
  created_at: Date;
  verified: boolean;
}

interface TestDbRow {
  id: string;
  revision_id: string;
  revision_no: number;
  test_session_id: string;
  run_id: string;
  status: StudioTestStatus;
  created_at: Date;
  completed_at: Date | null;
}

interface ActiveDesignRunDbRow {
  id: string;
  last_activity_at: Date;
}

// Design generation normally emits run events while it is making progress.
// A silent run beyond this window most likely belongs to a process that was
// restarted or lost before it could persist a terminal status. Keeping the
// window generous avoids treating normal provider latency as a crashed run.
const STUDIO_DESIGN_RUN_STALE_AFTER_MS = 30 * 60 * 1000;

interface StudioForkSourceRow {
  source_session_id: string;
  source_revision_id: string;
  source_run_input: Record<string, unknown>;
  source_user_text: string;
  source_assistant_text: string;
  transcript: unknown[];
  artifact_key: string;
  artifact_title: string;
  artifact_language: string | null;
  artifact_content: string;
  summary: string;
}

export interface StudioForkResult {
  sourceSessionId: string;
  sourceRevisionId: string;
  targetRevisionId: string;
  targetRunId: string;
}

function toRevision(row: RevisionDbRow): StudioRevision {
  return {
    id: row.id,
    revisionNo: row.revision_no,
    artifactKey: row.artifact_key,
    artifactVersion: row.artifact_version,
    sourceRunId: row.source_run_id,
    summary: row.summary,
    createdAt: row.created_at.toISOString(),
    verified: row.verified,
  };
}

function toTest(row: TestDbRow): StudioTest {
  return {
    id: row.id,
    revisionId: row.revision_id,
    revisionNo: row.revision_no,
    testSessionId: row.test_session_id,
    runId: row.run_id,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    completedAt: row.completed_at?.toISOString() ?? null,
  };
}

/**
 * Copy the latest durable UI from a frozen published/rejected version into a
 * brand-new draft Studio session. The copied page starts a new local history
 * at R1 while the source revision remains immutable.
 *
 * The caller has already creator-loaded both authoring versions. This write
 * still repeats owner/capability/version/hash guards at the runtime boundary so
 * a forged sourceVersionId cannot cross tenants or capabilities. For the
 * narrowly scoped same-semantic-version recovery path, sourceManifestHash may
 * be omitted so a harmless draft metadata edit does not strand a durable UI.
 *
 * No Studio test row is copied. A forked R1 must be tested again in its new
 * draft/version context.
 */
export async function forkLatestStudioRevision(
  pool: Pool,
  input: {
    ownerId: string;
    capabilityId: string;
    targetSessionId: string;
    targetVersion: string;
    targetManifestHash: string;
    sourceVersion: string;
    sourceManifestHash?: string;
    /** 由上层原子化 Studio 恢复流程持有的事务连接。 */
    transactionClient?: PoolClient;
  },
): Promise<StudioForkResult | null> {
  const ownsTransaction = !input.transactionClient;
  const client: PoolClient = input.transactionClient ?? (await pool.connect());
  try {
    if (ownsTransaction) await client.query('BEGIN');

    // The destination must be the untouched draft trial session just created
    // for this owner/version. Refuse to graft into an existing conversation.
    const target = await client.query<{ id: string }>(
      `SELECT s.id
         FROM rt_chat_sessions s
        WHERE s.id = $1
          AND s.owner_id = $2
          AND s.capability_id = $3
          AND s.version = $4
          AND s.manifest_hash = $5
          AND s.mode = 'trial'
          AND s.status = 'active'
          AND s.public_view ->> 'status' = 'draft'
          AND NOT EXISTS (SELECT 1 FROM rt_chat_messages m WHERE m.session_id = s.id)
          AND NOT EXISTS (SELECT 1 FROM rt_chat_runs run WHERE run.session_id = s.id)
          AND NOT EXISTS (SELECT 1 FROM rt_chat_artifacts a WHERE a.session_id = s.id)
          AND NOT EXISTS (
            SELECT 1 FROM rt_studio_revisions revision WHERE revision.studio_session_id = s.id
          )
        FOR UPDATE`,
      [
        input.targetSessionId,
        input.ownerId,
        input.capabilityId,
        input.targetVersion,
        input.targetManifestHash,
      ],
    );
    if (!target.rows[0]) {
      throw new Error('forkLatestStudioRevision: target is not an empty owned draft Studio');
    }

    // A revision only qualifies when its design run completed, the exact HTML
    // version exists, and a persisted assistant message references it. This is
    // the same durability boundary used by getStudioState/finalizeRevision.
    const sourceParams: unknown[] = [input.ownerId, input.capabilityId, input.sourceVersion];
    const sourceManifestGuard = input.sourceManifestHash
      ? `AND source_session.manifest_hash = $${sourceParams.push(input.sourceManifestHash)}`
      : '';
    const sourceResult = await client.query<StudioForkSourceRow>(
      `SELECT source_session.id AS source_session_id,
              source_session.transcript,
              revision.id AS source_revision_id,
              source_run.input AS source_run_input,
              COALESCE(source_user.text, '继续设计已发布页面') AS source_user_text,
              source_assistant.text AS source_assistant_text,
              revision.artifact_key,
              artifact_version.title AS artifact_title,
              artifact_version.language AS artifact_language,
              artifact_version.content AS artifact_content,
              revision.summary
         FROM rt_studio_revisions revision
         JOIN rt_chat_sessions source_session
           ON source_session.id = revision.studio_session_id
         JOIN rt_chat_runs source_run
           ON source_run.id = revision.source_run_id
          AND source_run.session_id = source_session.id
          AND source_run.owner_id = source_session.owner_id
          AND source_run.status = 'completed'
          AND source_run.input ->> 'intent' = 'design'
         JOIN rt_chat_artifacts artifact
           ON artifact.session_id = source_session.id
          AND artifact.artifact_key = revision.artifact_key
         JOIN rt_chat_artifact_versions artifact_version
           ON artifact_version.artifact_id = artifact.id
          AND artifact_version.version = revision.artifact_version
          AND artifact_version.kind = 'html'
         JOIN rt_chat_messages source_assistant
           ON source_assistant.session_id = source_session.id
          AND source_assistant.run_id = source_run.id
          AND source_assistant.role = 'assistant'
          AND source_assistant.artifacts @> jsonb_build_array(
            jsonb_build_object(
              'artifactKey', revision.artifact_key,
              'version', revision.artifact_version,
              'kind', 'html',
              'title', artifact_version.title
            )
          )
         LEFT JOIN LATERAL (
           SELECT message.text
             FROM rt_chat_messages message
            WHERE message.session_id = source_session.id
              AND message.run_id = source_run.id
              AND message.role = 'user'
            ORDER BY message.seq DESC
            LIMIT 1
         ) source_user ON true
        WHERE source_session.owner_id = $1
          AND source_session.capability_id = $2
          AND source_session.version = $3
          ${sourceManifestGuard}
          AND source_session.mode = 'trial'
          AND revision.artifact_key = 'main'
          AND artifact.kind = 'html'
          AND NOT EXISTS (
            SELECT 1
              FROM rt_studio_tests child
             WHERE child.test_session_id = source_session.id
          )
        ORDER BY revision.created_at DESC, revision.revision_no DESC, source_session.updated_at DESC
        LIMIT 1`,
      sourceParams,
    );
    const source = sourceResult.rows[0];
    if (!source) {
      if (ownsTransaction) await client.query('COMMIT');
      return null;
    }

    const targetArtifactId = randomUUID();
    const targetRunId = randomUUID();
    const targetRevisionId = randomUUID();
    const targetArtifactRef = {
      artifactKey: source.artifact_key,
      version: 1,
      kind: 'html' as const,
      title: source.artifact_title,
    };

    await client.query(
      `INSERT INTO rt_chat_runs (
         id, session_id, owner_id, status, input, completed_at
       ) VALUES ($1, $2, $3, 'completed', $4::jsonb, now())`,
      [targetRunId, input.targetSessionId, input.ownerId, JSON.stringify(source.source_run_input)],
    );
    await client.query(
      `INSERT INTO rt_chat_artifacts (
         id, session_id, artifact_key, kind, title, latest_version
       ) VALUES ($1, $2, $3, 'html', $4, 1)`,
      [targetArtifactId, input.targetSessionId, source.artifact_key, source.artifact_title],
    );
    await client.query(
      `INSERT INTO rt_chat_artifact_versions (
         artifact_id, version, kind, title, language, content
       ) VALUES ($1, 1, 'html', $2, $3, $4)`,
      [targetArtifactId, source.artifact_title, source.artifact_language, source.artifact_content],
    );
    await client.query(
      `INSERT INTO rt_chat_messages (
         id, session_id, run_id, seq, role, text, artifacts
       ) VALUES
         ($1, $2, $3, 1, 'user', $4, '[]'::jsonb),
         ($5, $2, $3, 2, 'assistant', $6, $7::jsonb)`,
      [
        randomUUID(),
        input.targetSessionId,
        targetRunId,
        source.source_user_text,
        randomUUID(),
        source.source_assistant_text,
        JSON.stringify([targetArtifactRef]),
      ],
    );
    await client.query(
      `INSERT INTO rt_studio_revisions (
         id, studio_session_id, revision_no, artifact_key, artifact_version,
         source_run_id, restored_from_revision_id, summary
       ) VALUES ($1, $2, 1, $3, 1, $4, $5, $6)`,
      [
        targetRevisionId,
        input.targetSessionId,
        source.artifact_key,
        targetRunId,
        source.source_revision_id,
        source.summary,
      ],
    );
    await client.query(
      `UPDATE rt_chat_sessions
          SET transcript = $2::jsonb,
              updated_at = now()
        WHERE id = $1`,
      [
        input.targetSessionId,
        JSON.stringify(Array.isArray(source.transcript) ? source.transcript : []),
      ],
    );

    if (ownsTransaction) await client.query('COMMIT');
    return {
      sourceSessionId: source.source_session_id,
      sourceRevisionId: source.source_revision_id,
      targetRevisionId,
      targetRunId,
    };
  } catch (error) {
    if (ownsTransaction) await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    if (ownsTransaction) client.release();
  }
}

/**
 * A Studio revision is finalized only after the design turn and its UI message
 * have both been saved. source_run_id makes retries idempotent.
 */
export async function finalizeStudioRevision(
  pool: Pool,
  input: {
    studioSessionId: string;
    sourceRunId: string;
    artifact: ArtifactRef;
    summary: string;
  },
): Promise<StudioRevision> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT id FROM rt_chat_sessions WHERE id = $1 FOR UPDATE`, [
      input.studioSessionId,
    ]);

    const existing = await client.query<RevisionDbRow>(
      `SELECT r.*,
              EXISTS (
                SELECT 1 FROM rt_studio_tests t
                JOIN rt_chat_runs tr
                  ON tr.id = t.run_id
                 AND tr.session_id = t.test_session_id
                 AND tr.status = 'completed'
                JOIN rt_chat_messages tm
                  ON tm.run_id = tr.id
                 AND tm.session_id = t.test_session_id
                 AND tm.role = 'assistant'
                 WHERE t.revision_id = r.id
                   AND t.status = 'completed'
                   AND (
                     btrim(tm.text) <> ''
                     OR jsonb_array_length(COALESCE(tm.artifacts, '[]'::jsonb)) > 0
                   )
              ) AS verified
         FROM rt_studio_revisions r
        WHERE r.source_run_id = $1
        LIMIT 1`,
      [input.sourceRunId],
    );
    if (existing.rows[0]) {
      await client.query('COMMIT');
      return toRevision(existing.rows[0]);
    }

    const visibleArtifact = await client.query(
      `SELECT 1
         FROM rt_chat_messages m
        WHERE m.session_id = $1
          AND m.run_id = $2
          AND m.role = 'assistant'
          AND m.artifacts @> jsonb_build_array(
            jsonb_build_object(
              'artifactKey', $3::text,
              'version', $4::integer,
              'kind', $5::text,
              'title', $6::text
            )
          )
        LIMIT 1`,
      [
        input.studioSessionId,
        input.sourceRunId,
        input.artifact.artifactKey,
        input.artifact.version,
        input.artifact.kind,
        input.artifact.title,
      ],
    );
    if (!visibleArtifact.rows[0]) {
      throw new Error('finalizeStudioRevision: design artifact is not attached to the saved turn');
    }

    const inserted = await client.query<RevisionDbRow>(
      `INSERT INTO rt_studio_revisions (
         id, studio_session_id, revision_no, artifact_key, artifact_version,
         source_run_id, summary
       )
       SELECT $1, $2, COALESCE(MAX(revision_no), 0) + 1, $3, $4, $5, $6
         FROM rt_studio_revisions
        WHERE studio_session_id = $2
       RETURNING *, false AS verified`,
      [
        randomUUID(),
        input.studioSessionId,
        input.artifact.artifactKey,
        input.artifact.version,
        input.sourceRunId,
        input.summary.trim().slice(0, 240),
      ],
    );
    const row = inserted.rows[0];
    if (!row) throw new Error('finalizeStudioRevision: insert returned no row');
    await client.query('COMMIT');
    return toRevision(row);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function getStudioRevision(
  pool: Pool,
  studioSessionId: string,
  revisionId: string,
): Promise<StudioRevision | null> {
  const result = await pool.query<RevisionDbRow>(
    `SELECT r.*,
            EXISTS (
              SELECT 1 FROM rt_studio_tests t
              JOIN rt_chat_runs tr
                ON tr.id = t.run_id
               AND tr.session_id = t.test_session_id
               AND tr.status = 'completed'
              JOIN rt_chat_messages tm
                ON tm.run_id = tr.id
               AND tm.session_id = t.test_session_id
               AND tm.role = 'assistant'
               WHERE t.revision_id = r.id
                 AND t.status = 'completed'
                 AND (
                   btrim(tm.text) <> ''
                   OR jsonb_array_length(COALESCE(tm.artifacts, '[]'::jsonb)) > 0
                 )
            ) AS verified
       FROM rt_studio_revisions r
      JOIN rt_chat_runs source_run
        ON source_run.id = r.source_run_id
       AND source_run.status = 'completed'
       AND source_run.input ->> 'intent' = 'design'
      WHERE r.id = $1 AND r.studio_session_id = $2
      LIMIT 1`,
    [revisionId, studioSessionId],
  );
  return result.rows[0] ? toRevision(result.rows[0]) : null;
}

export async function getStudioState(
  pool: Pool,
  studioSessionId: string,
  now = new Date(),
): Promise<StudioState> {
  const [revisionsResult, testResult, activeRunResult] = await Promise.all([
    pool.query<RevisionDbRow>(
      `SELECT r.*,
              EXISTS (
                SELECT 1 FROM rt_studio_tests t
                JOIN rt_chat_runs tr
                  ON tr.id = t.run_id
                 AND tr.session_id = t.test_session_id
                 AND tr.status = 'completed'
                JOIN rt_chat_messages tm
                  ON tm.run_id = tr.id
                 AND tm.session_id = t.test_session_id
                 AND tm.role = 'assistant'
                 WHERE t.revision_id = r.id
                   AND t.status = 'completed'
                   AND (
                     btrim(tm.text) <> ''
                     OR jsonb_array_length(COALESCE(tm.artifacts, '[]'::jsonb)) > 0
                   )
              ) AS verified
         FROM rt_studio_revisions r
        JOIN rt_chat_runs source_run
          ON source_run.id = r.source_run_id
         AND source_run.status = 'completed'
         AND source_run.input ->> 'intent' = 'design'
        WHERE r.studio_session_id = $1
        ORDER BY r.revision_no ASC`,
      [studioSessionId],
    ),
    pool.query<TestDbRow>(
      `SELECT t.*, r.revision_no
         FROM rt_studio_tests t
         JOIN rt_studio_revisions r ON r.id = t.revision_id
        WHERE t.studio_session_id = $1
        ORDER BY t.created_at DESC
        LIMIT 1`,
      [studioSessionId],
    ),
    pool.query<ActiveDesignRunDbRow>(
      `SELECT run.id,
              GREATEST(
                run.created_at,
                run.updated_at,
                COALESCE(last_event.created_at, run.created_at)
              ) AS last_activity_at
         FROM rt_chat_runs run
         LEFT JOIN LATERAL (
           SELECT event.created_at
             FROM rt_chat_run_events event
            WHERE event.run_id = run.id
            ORDER BY event.id DESC
            LIMIT 1
         ) last_event ON true
        WHERE run.session_id = $1
          AND run.status IN ('queued', 'running')
          AND run.input ->> 'intent' = 'design'
        ORDER BY last_activity_at DESC, run.created_at DESC
        LIMIT 1`,
      [studioSessionId],
    ),
  ]);

  const revisions = revisionsResult.rows.map(toRevision);
  const activeRun = activeRunResult.rows[0];
  let activeDesignRunId = activeRun?.id ?? null;
  if (
    activeRun &&
    now.getTime() - activeRun.last_activity_at.getTime() > STUDIO_DESIGN_RUN_STALE_AFTER_MS
  ) {
    const cutoff = new Date(now.getTime() - STUDIO_DESIGN_RUN_STALE_AFTER_MS);
    const interrupted = await pool.query<{ id: string }>(
      `UPDATE rt_chat_runs run
          SET status = 'interrupted',
              error = COALESCE(run.error, 'design run expired after 30 minutes without activity'),
              completed_at = COALESCE(run.completed_at, $3::timestamptz),
              updated_at = $3::timestamptz
        WHERE run.id = $1
          AND run.status IN ('queued', 'running')
          AND run.input ->> 'intent' = 'design'
          AND GREATEST(run.created_at, run.updated_at) < $2::timestamptz
          AND NOT EXISTS (
            SELECT 1
              FROM rt_chat_run_events event
             WHERE event.run_id = run.id
               AND event.created_at >= $2::timestamptz
          )
      RETURNING run.id`,
      [activeRun.id, cutoff.toISOString(), now.toISOString()],
    );
    // If a fresh event raced with this recovery check, the guarded UPDATE does
    // not match and the run remains the active bootstrap lock.
    if (interrupted.rows[0]) activeDesignRunId = null;
  }
  return {
    sessionId: studioSessionId,
    revisions,
    currentRevision: revisions.at(-1) ?? null,
    latestTest: testResult.rows[0] ? toTest(testResult.rows[0]) : null,
    activeDesignRunId,
  };
}

export async function createStudioTestRecord(
  pool: Pool,
  input: {
    studioSessionId: string;
    revisionId: string;
    testSessionId: string;
    runId: string;
  },
): Promise<StudioTest> {
  const result = await pool.query<TestDbRow>(
    `WITH target AS (
       SELECT id, revision_no
         FROM rt_studio_revisions
        WHERE id = $5 AND studio_session_id = $2
     ), inserted AS (
       INSERT INTO rt_studio_tests (
         id, studio_session_id, revision_id, test_session_id, run_id, status
       )
       SELECT $1, $2, target.id, $3, $4, 'running'
         FROM target
       RETURNING *
     )
     SELECT inserted.*, target.revision_no
       FROM inserted
       JOIN target ON target.id = inserted.revision_id`,
    [randomUUID(), input.studioSessionId, input.testSessionId, input.runId, input.revisionId],
  );
  const row = result.rows[0];
  if (!row) throw new Error('createStudioTestRecord: revision does not belong to Studio');
  return toTest(row);
}

export async function setStudioTestStatus(
  pool: Pool,
  runId: string,
  status: Exclude<StudioTestStatus, 'running'>,
): Promise<void> {
  await pool.query(
    `UPDATE rt_studio_tests
        SET status = $2,
            completed_at = COALESCE(completed_at, now())
      WHERE run_id = $1`,
    [runId, status],
  );
}

export async function isStudioTestSession(pool: Pool, sessionId: string): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1
       FROM rt_studio_tests
      WHERE test_session_id = $1
      LIMIT 1`,
    [sessionId],
  );
  return Boolean(result.rows[0]);
}

export async function discardStudioRevisionForRun(pool: Pool, sourceRunId: string): Promise<void> {
  await pool.query(`DELETE FROM rt_studio_revisions WHERE source_run_id = $1`, [sourceRunId]);
}

import type { Pool, PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { forkLatestStudioRevision, getStudioState } from './repo.js';

const input = {
  ownerId: 'creator-1',
  capabilityId: '11111111-1111-4111-8111-111111111111',
  targetSessionId: '22222222-2222-4222-8222-222222222222',
  targetVersion: '0.2.0',
  targetManifestHash: 'target-hash',
  sourceVersion: '0.1.0',
  sourceManifestHash: 'source-hash',
};

function sourceRow() {
  return {
    source_session_id: '33333333-3333-4333-8333-333333333333',
    source_revision_id: '44444444-4444-4444-8444-444444444444',
    source_run_input: {
      intent: 'design',
      contentParts: [{ type: 'text', text: '把按钮改成红色' }],
    },
    source_user_text: '把按钮改成红色',
    source_assistant_text: '已更新主按钮。',
    transcript: [
      { role: 'user', content: '把按钮改成红色' },
      { role: 'assistant', content: '已更新主按钮。' },
    ],
    artifact_key: 'main',
    artifact_title: 'Agent 任务助手',
    artifact_language: null,
    artifact_content: '<!doctype html><html><body>published ui</body></html>',
    summary: '已更新主按钮。',
  };
}

function fakePool(source: ReturnType<typeof sourceRow> | null, targetExists = true) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    if (sql.includes('FROM rt_chat_sessions s') && sql.includes('FOR UPDATE')) {
      return { rows: targetExists ? [{ id: input.targetSessionId }] : [] };
    }
    if (sql.includes('SELECT source_session.id AS source_session_id')) {
      return { rows: source ? [source] : [] };
    }
    return { rows: [] };
  });
  const release = vi.fn();
  const client = { query, release } as unknown as PoolClient;
  const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
  return { pool, client, calls, release };
}

describe('forkLatestStudioRevision', () => {
  it('shallow-forks the latest durable HTML as an unverified R1', async () => {
    const db = fakePool(sourceRow());

    const result = await forkLatestStudioRevision(db.pool, input);

    expect(result).toEqual(
      expect.objectContaining({
        sourceSessionId: '33333333-3333-4333-8333-333333333333',
        sourceRevisionId: '44444444-4444-4444-8444-444444444444',
      }),
    );
    const sourceQuery = db.calls.find((call) =>
      call.sql.includes('SELECT source_session.id AS source_session_id'),
    );
    const targetQuery = db.calls.find(
      (call) => call.sql.includes('SELECT s.id') && call.sql.includes('FOR UPDATE'),
    );
    expect(targetQuery?.params).toEqual([
      input.targetSessionId,
      input.ownerId,
      input.capabilityId,
      input.targetVersion,
      input.targetManifestHash,
    ]);
    expect(sourceQuery?.sql).toContain('source_session.owner_id = $1');
    expect(sourceQuery?.sql).toContain('source_session.capability_id = $2');
    expect(sourceQuery?.sql).toContain('source_session.version = $3');
    expect(sourceQuery?.sql).toContain('source_session.manifest_hash = $4');
    expect(sourceQuery?.sql).toContain("source_run.status = 'completed'");
    expect(sourceQuery?.sql).toContain("source_run.input ->> 'intent' = 'design'");
    expect(sourceQuery?.sql).toContain("artifact_version.kind = 'html'");
    expect(sourceQuery?.sql).toContain('source_assistant.artifacts @>');
    expect(sourceQuery?.params).toEqual([
      input.ownerId,
      input.capabilityId,
      input.sourceVersion,
      input.sourceManifestHash,
    ]);

    const artifactVersionInsert = db.calls.find((call) =>
      call.sql.includes('INSERT INTO rt_chat_artifact_versions'),
    );
    expect(artifactVersionInsert?.sql).toContain("VALUES ($1, 1, 'html'");
    expect(artifactVersionInsert?.params.at(-1)).toBe(
      '<!doctype html><html><body>published ui</body></html>',
    );

    const revisionInsert = db.calls.find((call) =>
      call.sql.includes('INSERT INTO rt_studio_revisions'),
    );
    expect(revisionInsert?.sql).toContain('revision_no');
    expect(revisionInsert?.sql).toContain('VALUES ($1, $2, 1, $3, 1');
    expect(revisionInsert?.params).toContain('44444444-4444-4444-8444-444444444444');

    const transcriptUpdate = db.calls.find((call) => call.sql.includes('UPDATE rt_chat_sessions'));
    expect(JSON.parse(String(transcriptUpdate?.params[1]))).toEqual(sourceRow().transcript);

    // Verification belongs to the new revision and must be run again.
    expect(db.calls.some((call) => call.sql.includes('INSERT INTO rt_studio_tests'))).toBe(false);
    expect(db.calls.at(-1)?.sql).toBe('COMMIT');
    expect(db.release).toHaveBeenCalledOnce();
  });

  it('keeps a normal empty draft session when the published version has no durable revision', async () => {
    const db = fakePool(null);

    await expect(forkLatestStudioRevision(db.pool, input)).resolves.toBeNull();

    expect(db.calls.some((call) => call.sql.startsWith('INSERT INTO'))).toBe(false);
    expect(db.calls.at(-1)?.sql).toBe('COMMIT');
    expect(db.release).toHaveBeenCalledOnce();
  });

  it('recovers the latest UI from the same semantic version after its manifest hash changes', async () => {
    const db = fakePool(sourceRow());

    await forkLatestStudioRevision(db.pool, {
      ...input,
      sourceVersion: input.targetVersion,
      sourceManifestHash: undefined,
    });

    const sourceQuery = db.calls.find((call) =>
      call.sql.includes('SELECT source_session.id AS source_session_id'),
    );
    expect(sourceQuery?.sql).toContain('source_session.owner_id = $1');
    expect(sourceQuery?.sql).toContain('source_session.capability_id = $2');
    expect(sourceQuery?.sql).toContain('source_session.version = $3');
    expect(sourceQuery?.sql).not.toContain('source_session.manifest_hash');
    expect(sourceQuery?.params).toEqual([input.ownerId, input.capabilityId, input.targetVersion]);
    expect(db.calls.some((call) => call.sql.includes('INSERT INTO rt_studio_tests'))).toBe(false);
  });

  it('participates in the caller transaction for atomic resume-or-create', async () => {
    const db = fakePool(sourceRow());

    await forkLatestStudioRevision(db.pool, { ...input, transactionClient: db.client });

    expect(db.calls.some((call) => call.sql === 'BEGIN')).toBe(false);
    expect(db.calls.some((call) => call.sql === 'COMMIT')).toBe(false);
    expect(db.calls.some((call) => call.sql === 'ROLLBACK')).toBe(false);
    expect(db.release).not.toHaveBeenCalled();
  });

  it('refuses to graft into a non-empty or mismatched target session', async () => {
    const db = fakePool(sourceRow(), false);

    await expect(forkLatestStudioRevision(db.pool, input)).rejects.toThrow(
      'target is not an empty owned draft Studio',
    );

    expect(db.calls.some((call) => call.sql === 'ROLLBACK')).toBe(true);
    expect(
      db.calls.some((call) => call.sql.includes('SELECT source_session.id AS source_session_id')),
    ).toBe(false);
    expect(db.release).toHaveBeenCalledOnce();
  });
});

describe('getStudioState', () => {
  const studioSessionId = '55555555-5555-4555-8555-555555555555';
  const runId = '66666666-6666-4666-8666-666666666666';
  const now = new Date('2026-07-22T12:00:00.000Z');

  function statePool(lastActivityAt: Date, staleUpdateMatches = true) {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const query = vi.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.includes('FROM rt_chat_runs run')) {
        return { rows: [{ id: runId, last_activity_at: lastActivityAt }] };
      }
      if (sql.includes('UPDATE rt_chat_runs run')) {
        return { rows: staleUpdateMatches ? [{ id: runId }] : [] };
      }
      return { rows: [] };
    });
    return { pool: { query } as unknown as Pool, calls };
  }

  it('keeps a recently active design run, including long runs with fresh events', async () => {
    const db = statePool(new Date('2026-07-22T11:31:00.000Z'));

    const state = await getStudioState(db.pool, studioSessionId, now);

    expect(state.activeDesignRunId).toBe(runId);
    const activeRunQuery = db.calls.find((call) => call.sql.includes('FROM rt_chat_runs run'));
    expect(activeRunQuery?.sql).toContain('LEFT JOIN LATERAL');
    expect(activeRunQuery?.sql).toContain('FROM rt_chat_run_events event');
    expect(activeRunQuery?.sql).toContain('ORDER BY event.id DESC');
    expect(activeRunQuery?.sql).toContain("run.status IN ('queued', 'running')");
    expect(activeRunQuery?.sql).toContain("run.input ->> 'intent' = 'design'");
    expect(activeRunQuery?.params).toEqual([studioSessionId]);
    expect(db.calls.some((call) => call.sql.includes('UPDATE rt_chat_runs run'))).toBe(false);
  });

  it('interrupts a silent orphaned design run so it cannot block a new bootstrap forever', async () => {
    const db = statePool(new Date('2026-07-22T11:29:59.999Z'));

    const state = await getStudioState(db.pool, studioSessionId, now);

    expect(state.activeDesignRunId).toBeNull();
    const staleUpdate = db.calls.find((call) => call.sql.includes('UPDATE rt_chat_runs run'));
    expect(staleUpdate?.sql).toContain("SET status = 'interrupted'");
    expect(staleUpdate?.sql).toContain("run.status IN ('queued', 'running')");
    expect(staleUpdate?.sql).toContain('event.created_at >= $2::timestamptz');
    expect(staleUpdate?.params).toEqual([
      runId,
      '2026-07-22T11:30:00.000Z',
      '2026-07-22T12:00:00.000Z',
    ]);
  });

  it('keeps the bootstrap lock when concurrent activity refreshes a stale candidate', async () => {
    const db = statePool(new Date('2026-07-22T11:29:59.999Z'), false);

    const state = await getStudioState(db.pool, studioSessionId, now);

    expect(state.activeDesignRunId).toBe(runId);
  });
});

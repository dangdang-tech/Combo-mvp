import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { getArtifacts } from './repo.js';

describe('getArtifacts', () => {
  it('only exposes versions referenced by a persisted assistant message', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });

    await getArtifacts({ query } as unknown as Pool, 'session-1');

    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain("'artifactKey', a.artifact_key, 'version', v.version");
    expect(sql).toContain('MAX(v.version)::int AS latest_version');
    expect(sql).not.toContain('a.latest_version,');
  });
});

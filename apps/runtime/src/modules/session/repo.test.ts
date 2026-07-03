import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { findEmptyTrialSession } from './repo.js';

describe('findEmptyTrialSession', () => {
  it('scopes empty trial reuse by capability and version', async () => {
    let captured:
      | {
          sql: string;
          params: unknown[];
        }
      | undefined;
    const pool = {
      query: async (sql: string, params: unknown[]) => {
        captured = { sql, params };
        return { rows: [] };
      },
    } as unknown as Pool;

    await findEmptyTrialSession(pool, {
      ownerId: 'user-1',
      capabilityId: 'cap-1',
      version: '0.1.0',
    });

    expect(captured?.sql).toContain('s.version = $3');
    expect(captured?.params).toEqual(['user-1', 'cap-1', '0.1.0']);
  });
});

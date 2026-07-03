import { describe, expect, it } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Queryable, QueryResultLike } from '../platform/jobs/types.js';
import { connectPairHandler } from '../modules/import/import-connect.js';
import { buildConnectCommand } from '../modules/import/pairings-repo.js';

class PairingInsertDb implements Queryable {
  async query<R = Record<string, unknown>>(
    sql: string,
    _params: unknown[] = [],
  ): Promise<QueryResultLike<R>> {
    if (sql.includes('INSERT INTO import_pairings')) {
      return {
        rows: [
          {
            id: 'pair-1',
            expires_at: '2026-07-03T12:00:00.000Z',
          },
        ] as R[],
        rowCount: 1,
      };
    }
    throw new Error(`unhandled SQL: ${sql.slice(0, 80)}`);
  }
}

describe('import connect command', () => {
  it('quotes the script URL so zsh/bash do not expand ?code', () => {
    expect(buildConnectCommand('http://localhost', '521956')).toBe(
      "curl -fsSL 'http://localhost/api/v1/import/connect/script?code=521956' | sh",
    );
  });

  it('trims trailing slash before appending the script path', () => {
    expect(buildConnectCommand('https://agora.example/', '123456')).toBe(
      "curl -fsSL 'https://agora.example/api/v1/import/connect/script?code=123456' | sh",
    );
  });

  it('escapes single quotes in the URL using POSIX shell quoting', () => {
    expect(buildConnectCommand("https://exa'mple.test", '000001')).toBe(
      "curl -fsSL 'https://exa'\\''mple.test/api/v1/import/connect/script?code=000001' | sh",
    );
  });

  it('connect pair handler returns a quoted command using forwarded host and protocol', async () => {
    const handler = connectPairHandler();
    let statusCode = 200;
    let payload: unknown;
    const reply = {
      code(code: number) {
        statusCode = code;
        return this;
      },
      send(body: unknown) {
        payload = body;
        return this;
      },
    } as unknown as FastifyReply;
    const req = {
      auth: { userId: 'user-1' },
      body: {},
      headers: {
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'app.example',
        host: 'localhost:3000',
      },
      protocol: 'http',
      server: { infra: { db: new PairingInsertDb() } },
      id: 'trace-command',
    } as unknown as FastifyRequest;

    await handler(req, reply);

    expect(statusCode).toBe(201);
    const body = payload as {
      data: { pairingCode: string; command: string; curlOneLiner: string };
    };
    expect(body.data.command).toBe(
      `curl -fsSL 'https://app.example/api/v1/import/connect/script?code=${body.data.pairingCode}' | sh`,
    );
    expect(body.data.curlOneLiner).toBe('curl -fsSL agora.app/import | sh');
  });
});

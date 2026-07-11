import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MeView } from '@cb/shared';
import { fetchMe, reconcileRuntimeMeProbe } from './AuthGate.js';

const ME: MeView = {
  id: '11111111-1111-4111-8111-111111111111',
  account: 'combo-user',
  email: 'combo@example.com',
  roles: ['creator'],
  createdAt: '2026-07-11T00:00:00.000Z',
  lastLoginAt: null,
};

const originalFetch = globalThis.fetch;

function response(status: number, body?: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as Response;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('runtime AuthGate /me probe', () => {
  it('retains an authenticated identity across a retryable refresh outage', () => {
    const authed = { status: 'authed', me: ME } as const;
    expect(reconcileRuntimeMeProbe(authed, { status: 'error' })).toBe(authed);
  });

  it('lets an explicit anonymous result revoke the previous runtime identity', () => {
    const authed = { status: 'authed', me: ME } as const;
    expect(reconcileRuntimeMeProbe(authed, { status: 'anon' })).toEqual({ status: 'anon' });
  });

  it('lets an authenticated user proceed with the parsed identity without refreshing', async () => {
    const fetchMock = vi.fn(async () => response(200, { data: ME, meta: { traceId: 'trace-me' } }));
    globalThis.fetch = fetchMock;

    await expect(fetchMe()).resolves.toEqual({ status: 'authed', me: ME });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/me',
      expect.objectContaining({ method: 'GET', credentials: 'include' }),
    );
  });

  it('refreshes once after an initial 401 and retries /me once', async () => {
    const replies = [
      response(401),
      response(204),
      response(200, { data: ME, meta: { traceId: 'trace-me-after-refresh' } }),
    ];
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        replies.shift() ?? response(500),
    );
    globalThis.fetch = fetchMock;

    await expect(fetchMe()).resolves.toEqual({ status: 'authed', me: ME });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/v1/me',
      '/api/v1/auth/refresh',
      '/api/v1/me',
    ]);
    expect(fetchMock.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({ method: 'POST', credentials: 'include' }),
    );
  });

  it('classifies a rejected refresh as anonymous without retrying /me', async () => {
    const replies = [response(401), response(401)];
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        replies.shift() ?? response(500),
    );
    globalThis.fetch = fetchMock;

    await expect(fetchMe()).resolves.toEqual({ status: 'anon' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps a forbidden refresh as a retryable policy error without retrying /me', async () => {
    const replies = [response(401), response(403)];
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        replies.shift() ?? response(500),
    );
    globalThis.fetch = fetchMock;

    await expect(fetchMe()).resolves.toEqual({ status: 'error' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('stops after the retried /me returns 401 instead of refreshing in a loop', async () => {
    const replies = [response(401), response(204), response(401)];
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        replies.shift() ?? response(500),
    );
    globalThis.fetch = fetchMock;

    await expect(fetchMe()).resolves.toEqual({ status: 'anon' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/v1/me',
      '/api/v1/auth/refresh',
      '/api/v1/me',
    ]);
  });

  it('keeps refresh 5xx as a retryable error', async () => {
    const replies = [response(401), response(503)];
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        replies.shift() ?? response(500),
    );
    globalThis.fetch = fetchMock;

    await expect(fetchMe()).resolves.toEqual({ status: 'error' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps refresh rate limiting as a retryable error', async () => {
    const replies = [response(401), response(429)];
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        replies.shift() ?? response(500),
    );
    globalThis.fetch = fetchMock;

    await expect(fetchMe()).resolves.toEqual({ status: 'error' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps other refresh failures as retryable errors', async () => {
    const replies = [response(401), response(400)];
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        replies.shift() ?? response(500),
    );
    globalThis.fetch = fetchMock;

    await expect(fetchMe()).resolves.toEqual({ status: 'error' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps /me 5xx as a retryable error without attempting refresh', async () => {
    const fetchMock = vi.fn(async () => response(503));
    globalThis.fetch = fetchMock;

    await expect(fetchMe()).resolves.toEqual({ status: 'error' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the retried /me 5xx as a retryable error', async () => {
    const replies = [response(401), response(204), response(503)];
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        replies.shift() ?? response(500),
    );
    globalThis.fetch = fetchMock;

    await expect(fetchMe()).resolves.toEqual({ status: 'error' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('keeps a network failure as a retryable error', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    globalThis.fetch = fetchMock;

    await expect(fetchMe()).resolves.toEqual({ status: 'error' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps a refresh network failure as a retryable error', async () => {
    let callCount = 0;
    const fetchMock = vi.fn(async () => {
      callCount += 1;
      if (callCount === 1) return response(401);
      throw new TypeError('Failed to fetch refresh');
    });
    globalThis.fetch = fetchMock;

    await expect(fetchMe()).resolves.toEqual({ status: 'error' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('times out a hanging probe into a retryable error instead of loading forever', async () => {
    globalThis.fetch = vi.fn(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('The operation was aborted.', 'AbortError')),
            { once: true },
          );
        }),
    ) as typeof fetch;

    await expect(fetchMe(undefined, 5)).resolves.toEqual({ status: 'error' });
  });

  it('bounds a hanging refresh with the same probe timeout', async () => {
    let callCount = 0;
    const fetchMock = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      callCount += 1;
      if (callCount === 1) return Promise.resolve(response(401));
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('The operation was aborted.', 'AbortError')),
          { once: true },
        );
      });
    });
    globalThis.fetch = fetchMock;

    await expect(fetchMe(undefined, 5)).resolves.toEqual({ status: 'error' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

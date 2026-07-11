import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiGet, apiPost } from './client.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function json(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('runtime API session refresh', () => {
  it('refreshes once and replays the original request with its body', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(401, { error: { userMessage: 'expired' } }))
      .mockResolvedValueOnce(json(204))
      .mockResolvedValueOnce(json(200, { data: { id: 'm1' } }));
    globalThis.fetch = fetchMock;

    await expect(apiPost('/runtime/sessions/s1/messages', { text: 'hello' })).resolves.toEqual({
      id: 'm1',
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/v1/runtime/sessions/s1/messages',
      '/api/v1/auth/refresh',
      '/api/v1/runtime/sessions/s1/messages',
    ]);
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({ text: 'hello' }));
    expect(fetchMock.mock.calls[2]?.[1]?.body).toBe(JSON.stringify({ text: 'hello' }));
  });

  it('does not replay when refresh is rejected', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(401, { error: { userMessage: 'expired' } }))
      .mockResolvedValueOnce(json(401));
    globalThis.fetch = fetchMock;

    const error = await apiGet('/runtime/sessions').catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('treats refresh 403 as a retryable policy error, not anonymous', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(401, { error: { userMessage: 'expired' } }))
      .mockResolvedValueOnce(json(403));
    globalThis.fetch = fetchMock;

    const error = await apiGet('/runtime/sessions').catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

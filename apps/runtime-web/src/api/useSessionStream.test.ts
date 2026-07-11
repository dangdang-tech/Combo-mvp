import { afterEach, describe, expect, it, vi } from 'vitest';
import { subscribeSessionEvents } from './useSessionStream.js';

class MockEventSource {
  static readonly CLOSED = 2;
  static instances: MockEventSource[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn();

  constructor(
    readonly url: string,
    readonly options: EventSourceInit,
  ) {
    MockEventSource.instances.push(this);
  }

  failClosed(): void {
    this.readyState = MockEventSource.CLOSED;
    this.onerror?.();
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  MockEventSource.instances = [];
});

describe('runtime session EventSource auth recovery', () => {
  it('refreshes and rebuilds once after a CLOSED stream', async () => {
    vi.stubGlobal('EventSource', MockEventSource);
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const onFatal = vi.fn();
    const stop = subscribeSessionEvents('/stream', { onMessage: vi.fn(), onFatal });

    MockEventSource.instances[0]!.failClosed();
    await vi.waitFor(() => expect(MockEventSource.instances).toHaveLength(2));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(MockEventSource.instances[1]!.options.withCredentials).toBe(true);

    // 新连接尚未成功 open 就再次 CLOSED：不再 refresh，避免循环。
    MockEventSource.instances[1]!.failClosed();
    expect(onFatal).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    stop();
  });

  it('surfaces a fatal state when refresh is rejected', async () => {
    vi.stubGlobal('EventSource', MockEventSource);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 401 })),
    );
    const onFatal = vi.fn();
    subscribeSessionEvents('/stream', { onMessage: vi.fn(), onFatal });

    MockEventSource.instances[0]!.failClosed();
    await vi.waitFor(() => expect(onFatal).toHaveBeenCalledTimes(1));
    expect(MockEventSource.instances).toHaveLength(1);
  });
});

import {
  buildTraceparent,
  newTraceId,
  TRACE_ID_HEADER,
  TRACEPARENT_HEADER,
  type TraceId,
} from '@cb/shared';

export type ClientEventKind = 'api_error' | 'sse_error' | 'window_error' | 'unhandled_rejection';

export interface TraceHeaders {
  traceId: TraceId;
  headers: Record<string, string>;
}

export function clientTraceHeaders(traceId: TraceId = newTraceId()): TraceHeaders {
  return {
    traceId,
    headers: {
      [TRACE_ID_HEADER]: traceId,
      [TRACEPARENT_HEADER]: buildTraceparent(traceId),
    },
  };
}

function telemetryEnabled(): boolean {
  return (
    import.meta.env.MODE !== 'test' && import.meta.env.VITE_CLIENT_TELEMETRY_ENABLED !== 'false'
  );
}

function currentRoute(): string {
  if (typeof window === 'undefined') return '';
  return `${window.location.pathname}${window.location.search}`;
}

export function reportClientEvent(
  kind: ClientEventKind,
  event: { traceId?: string; message?: string; stack?: string; url?: string; source?: string } = {},
): void {
  if (!telemetryEnabled()) return;
  const trace = clientTraceHeaders(event.traceId);
  const body = JSON.stringify({
    kind,
    traceId: trace.traceId,
    message: event.message,
    stack: event.stack,
    url: event.url ?? (typeof window === 'undefined' ? undefined : window.location.href),
    route: currentRoute(),
    source: event.source ?? 'runtime-web',
  });

  if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
    navigator.sendBeacon('/api/v1/client-events', new Blob([body], { type: 'application/json' }));
    return;
  }

  void fetch('/api/v1/client-events', {
    method: 'POST',
    credentials: 'include',
    keepalive: true,
    headers: { 'content-type': 'application/json', ...trace.headers },
    body,
  }).catch(() => undefined);
}

export function installGlobalClientErrorHandlers(): void {
  if (!telemetryEnabled() || typeof window === 'undefined') return;
  window.addEventListener('error', (event) => {
    reportClientEvent('window_error', {
      message: event.message,
      stack: event.error instanceof Error ? event.error.stack : undefined,
      source: 'runtime-web',
    });
  });
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    reportClientEvent('unhandled_rejection', {
      message: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
      source: 'runtime-web',
    });
  });
}

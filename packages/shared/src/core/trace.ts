// Trace ID helpers shared by browser and Node code.
// Public feedback codes stay as UUID strings, while OpenTelemetry/W3C uses 32 hex chars.

export const TRACE_ID_HEADER = 'x-trace-id';
export const TRACEPARENT_HEADER = 'traceparent';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TRACE_HEX_RE = /^[0-9a-f]{32}$/i;
const SPAN_HEX_RE = /^[0-9a-f]{16}$/i;
const TRACEPARENT_RE = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(?:-.+)?$/i;

function nonZeroHex(value: string): boolean {
  return !/^0+$/.test(value);
}

export function isUuidTraceId(value: string): boolean {
  return UUID_RE.test(value);
}

export function isTraceHex(value: string): boolean {
  return TRACE_HEX_RE.test(value) && nonZeroHex(value);
}

export function isSpanHex(value: string): boolean {
  return SPAN_HEX_RE.test(value) && nonZeroHex(value);
}

export function uuidToTraceHex(traceId: string): string | undefined {
  if (!isUuidTraceId(traceId)) return undefined;
  const hex = traceId.replaceAll('-', '').toLowerCase();
  return isTraceHex(hex) ? hex : undefined;
}

export function traceHexToUuid(traceHex: string): string | undefined {
  const hex = traceHex.toLowerCase();
  if (!isTraceHex(hex)) return undefined;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function normalizeTraceId(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (isUuidTraceId(trimmed)) return trimmed.toLowerCase();
  if (isTraceHex(trimmed)) return traceHexToUuid(trimmed);
  return undefined;
}

export interface ParsedTraceparent {
  version: string;
  traceId: string;
  traceHex: string;
  spanId: string;
  flags: string;
}

export function parseTraceparent(value: string | undefined): ParsedTraceparent | undefined {
  if (!value) return undefined;
  const match = TRACEPARENT_RE.exec(value.trim());
  if (!match) return undefined;
  const [, version, traceHexRaw, spanIdRaw, flagsRaw] = match;
  if (!version || !traceHexRaw || !spanIdRaw || !flagsRaw) return undefined;
  const traceHex = traceHexRaw.toLowerCase();
  const spanId = spanIdRaw.toLowerCase();
  if (!isTraceHex(traceHex) || !isSpanHex(spanId)) return undefined;
  const traceId = traceHexToUuid(traceHex);
  if (!traceId) return undefined;
  return {
    version: version.toLowerCase(),
    traceId,
    traceHex,
    spanId,
    flags: flagsRaw.toLowerCase(),
  };
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function traceIdFromHeaders(
  headers: Record<string, string | string[] | undefined>,
): string | undefined {
  const traceparent =
    firstHeaderValue(headers[TRACEPARENT_HEADER]) ?? firstHeaderValue(headers['Traceparent']);
  const parsed = parseTraceparent(traceparent);
  if (parsed) return parsed.traceId;

  const traceId =
    firstHeaderValue(headers[TRACE_ID_HEADER]) ?? firstHeaderValue(headers['X-Trace-Id']);
  return normalizeTraceId(traceId);
}

export function traceIdFromUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const queryStart = url.indexOf('?');
  if (queryStart < 0) return undefined;
  const params = new URLSearchParams(url.slice(queryStart + 1));
  return normalizeTraceId(params.get('traceId') ?? undefined);
}

export function newTraceId(): string {
  return globalThis.crypto.randomUUID().toLowerCase();
}

export function newSpanId(): string {
  return newTraceId().replaceAll('-', '').slice(0, 16);
}

export function buildTraceparent(traceId: string, spanId = newSpanId(), flags = '01'): string {
  const traceHex = uuidToTraceHex(traceId) ?? uuidToTraceHex(newTraceId())!;
  const safeSpanId = isSpanHex(spanId) ? spanId.toLowerCase() : newSpanId();
  return `00-${traceHex}-${safeSpanId}-${flags}`;
}

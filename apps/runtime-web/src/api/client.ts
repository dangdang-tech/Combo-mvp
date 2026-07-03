// 极简类型化 fetch 封装。credentials:'include' 携带匿名身份 cookie（rt_uid）。
//   后端路由在 /api/v1/runtime/*；错误统一 ErrorEnvelope（只读 userMessage，绝不暴露 code/状态码给用户）。
import { TRACE_ID_HEADER, TRACEPARENT_HEADER } from '@cb/shared';
import { clientTraceHeaders, reportClientEvent } from './telemetry.js';

const API_PREFIX = '/api/v1';

export class ApiError extends Error {
  constructor(
    public readonly userMessage: string,
    public readonly status: number,
    public readonly traceId?: string,
  ) {
    super(userMessage);
    this.name = 'ApiError';
  }
}

function buildUrl(path: string): string {
  if (path.startsWith('/api/')) return path;
  return `${API_PREFIX}${path}`;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const trace = clientTraceHeaders();
  const url = buildUrl(path);
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      credentials: 'include',
      headers:
        body === undefined
          ? trace.headers
          : {
              'content-type': 'application/json',
              [TRACE_ID_HEADER]: trace.traceId,
              [TRACEPARENT_HEADER]: trace.headers[TRACEPARENT_HEADER]!,
            },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (cause) {
    reportClientEvent('api_error', {
      traceId: trace.traceId,
      message: cause instanceof Error ? cause.message : 'network error',
      stack: cause instanceof Error ? cause.stack : undefined,
      url,
    });
    throw new ApiError('网络好像不太稳，检查连接后重试。', 0, trace.traceId);
  }
  if (!res.ok) {
    let userMessage = '请求失败，请稍后重试。';
    let traceId: string | undefined;
    try {
      const env = (await res.json()) as {
        userMessage?: string;
        traceId?: string;
        error?: { userMessage?: string; traceId?: string };
      };
      if (env.error?.userMessage) userMessage = env.error.userMessage;
      else if (env.userMessage) userMessage = env.userMessage;
      traceId = env.error?.traceId ?? env.traceId;
    } catch {
      /* 非 JSON 错误体：用兜底文案 */
    }
    reportClientEvent('api_error', {
      traceId: traceId ?? trace.traceId,
      message: userMessage,
      url,
    });
    throw new ApiError(userMessage, res.status, traceId);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const apiGet = <T>(path: string): Promise<T> => request<T>('GET', path);
export const apiPost = <T>(path: string, body?: unknown): Promise<T> =>
  request<T>('POST', path, body);

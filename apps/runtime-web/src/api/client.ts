// 极简类型化 fetch 封装。credentials:'include' 携带匿名身份 cookie（rt_uid）。
//   后端路由在 /api/v1/runtime/*；错误统一 ErrorEnvelope（只读 userMessage，绝不暴露 code/状态码给用户）。
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
  const res = await fetch(buildUrl(path), {
    method,
    credentials: 'include',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
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
    throw new ApiError(userMessage, res.status, traceId);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const apiGet = <T>(path: string): Promise<T> => request<T>('GET', path);
export const apiPost = <T>(path: string, body?: unknown): Promise<T> =>
  request<T>('POST', path, body);

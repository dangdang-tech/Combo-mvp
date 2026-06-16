// 轻量 fetch mock —— typed client 组件/单元测试用（无运行后端）。
//
// 用 vi.fn 替换 globalThis.fetch，记录每次调用的 url/method/headers/body，并按队列或
// 单一响应返回。比 msw 更轻、对「断言注入了 Idempotency-Key / X-Idempotency-Scope」更直接。
import { vi, type Mock } from 'vitest';

export interface MockResponseSpec {
  status?: number;
  /** JSON body（会被 JSON.stringify 进 Response.json）。undefined → 空体。 */
  json?: unknown;
  /** true 时模拟 res.json() 抛错（非 JSON 响应，如 HTML 错误页）。 */
  notJson?: boolean;
  /** true 时模拟 fetch 本身 reject（网络断）。 */
  networkError?: boolean;
}

export interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  credentials?: RequestCredentials;
}

function makeResponse(spec: MockResponseSpec): Response {
  const status = spec.status ?? 200;
  const ok = status >= 200 && status < 300;
  return {
    status,
    ok,
    json: async () => {
      if (spec.notJson) throw new SyntaxError('Unexpected token < in JSON');
      return spec.json;
    },
  } as unknown as Response;
}

export interface FetchMock {
  /** 被安装的 vi.fn（可直接断言 .toHaveBeenCalled 等）。 */
  fn: Mock;
  /** 按调用序记录的请求（断言 header/body/url 用）。 */
  calls: CapturedRequest[];
  /** 还原原始 fetch。 */
  restore: () => void;
}

/**
 * 安装 fetch mock。
 * @param responses 单个响应（所有调用复用）或响应队列（按调用序消费，超出复用最后一个）。
 */
export function installFetchMock(responses: MockResponseSpec | MockResponseSpec[]): FetchMock {
  const queue = Array.isArray(responses) ? responses : [responses];
  const calls: CapturedRequest[] = [];
  let i = 0;

  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    let body: unknown;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const captured: CapturedRequest = {
      url,
      method: init?.method ?? 'GET',
      headers,
      body,
    };
    if (init?.credentials) captured.credentials = init.credentials;
    calls.push(captured);
    const spec = queue[Math.min(i, queue.length - 1)] ?? {};
    i += 1;
    if (spec.networkError) throw new TypeError('Failed to fetch');
    return makeResponse(spec);
  });

  const original = globalThis.fetch;
  globalThis.fetch = fn as unknown as typeof fetch;

  return {
    fn,
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

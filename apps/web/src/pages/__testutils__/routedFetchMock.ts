// 按 URL 路径路由的 fetch mock（F-07 多端点页面测试用）。
//
// 工作台共享数据层并发触发多个 useQuery（metrics / token-trend 等），请求顺序不确定，
// 按队列序的 installFetchMock 无法稳定区分。本 mock 按 URL 子串匹配路由表选响应，顺序无关。
import { vi, type Mock } from 'vitest';

export interface RoutedResponse {
  status?: number;
  json?: unknown;
}

export interface RoutedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
}

export interface RoutedFetchMock {
  fn: Mock;
  calls: RoutedCall[];
  restore: () => void;
}

/**
 * 安装按路径路由的 fetch mock。
 * @param routes URL 子串 → 响应（首个命中的子串生效）。未命中 → 404（便于发现漏配）。
 */
export function installRoutedFetchMock(
  routes: Array<{ match: string; response: RoutedResponse }>,
): RoutedFetchMock {
  const calls: RoutedCall[] = [];

  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    const hit = routes.find((r) => url.includes(r.match));
    const spec = hit?.response ?? {
      status: 404,
      json: {
        error: { userMessage: '未配置路由', retriable: false, action: 'none', traceId: 't' },
      },
    };
    const status = spec.status ?? 200;
    return {
      status,
      ok: status >= 200 && status < 300,
      json: async () => spec.json,
    } as unknown as Response;
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

// typed client 测试：解包 {data,meta}、写命令注入 Idempotency-Key+scope、
// 非 2xx → ApiError（只人话 + action，绝不裸状态码）、非契约/网络兜底人话。
import { describe, it, expect, afterEach } from 'vitest';
import { IdempotencyScope, IdempotencyOptionalScope, type ErrorEnvelope } from '@cb/shared';
import {
  apiGet,
  apiGetEnvelope,
  apiPost,
  apiPostReadonly,
  apiPatch,
  apiDelete,
  ApiError,
} from './client.js';
import { installFetchMock, type FetchMock } from '../test/mockFetch.js';

let mock: FetchMock;
afterEach(() => mock?.restore());

describe('apiGet / 解包', () => {
  it('解包 { data } 只返回 data', async () => {
    mock = installFetchMock({ json: { data: { id: 'cap_1', name: '能力A' } } });
    const data = await apiGet<{ id: string; name: string }>('/capabilities/cap_1');
    expect(data).toEqual({ id: 'cap_1', name: '能力A' });
    expect(mock.calls[0]?.url).toBe('/api/v1/capabilities/cap_1');
    expect(mock.calls[0]?.method).toBe('GET');
  });

  it('apiGetEnvelope 同时暴露 meta（占位/分页语义）', async () => {
    mock = installFetchMock({
      json: {
        data: { value: null },
        meta: { placeholders: { monthlyInvocations: '暂无数据 / 上线后填充' } },
      },
    });
    const { data, meta } = await apiGetEnvelope<{ value: null }>('/dashboard/summary');
    expect(data.value).toBeNull();
    expect(meta?.placeholders?.['monthlyInvocations']).toBe('暂无数据 / 上线后填充');
  });

  it('query 参数被 URL 编码（undefined 跳过）', async () => {
    mock = installFetchMock({ json: { data: [] } });
    await apiGet('/capabilities', { query: { page: 2, status: 'published', q: undefined } });
    const url = mock.calls[0]?.url ?? '';
    expect(url).toContain('page=2');
    expect(url).toContain('status=published');
    expect(url).not.toContain('q=');
  });

  it('GET 不注入 Idempotency-Key（只读）', async () => {
    mock = installFetchMock({ json: { data: {} } });
    await apiGet('/capabilities/cap_1');
    expect(mock.calls[0]?.headers['Idempotency-Key']).toBeUndefined();
    expect(mock.calls[0]?.headers['X-Idempotency-Scope']).toBeUndefined();
    expect(mock.calls[0]?.headers['x-trace-id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(mock.calls[0]?.headers['traceparent']).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  });
});

describe('写命令注入 Idempotency-Key + scope', () => {
  it('apiPost 带 scope → 注入随机 Idempotency-Key + X-Idempotency-Scope', async () => {
    mock = installFetchMock({ json: { data: { id: 'cap_new' } } });
    await apiPost('/capabilities', { name: 'X' }, { scope: IdempotencyScope.CAPABILITY_CREATE });
    const h = mock.calls[0]?.headers ?? {};
    expect(h['X-Idempotency-Scope']).toBe('capability.create');
    expect(typeof h['Idempotency-Key']).toBe('string');
    expect(h['Idempotency-Key']?.length).toBeGreaterThan(0);
    expect(h['Content-Type']).toBe('application/json');
    expect(mock.calls[0]?.body).toEqual({ name: 'X' });
  });

  it('idempotencyKey 覆盖项被使用（断点续传复用同一 key→已生成内容不丢）', async () => {
    mock = installFetchMock({ json: { data: {} } });
    await apiPost(
      '/structure/start',
      { v: 1 },
      {
        scope: IdempotencyScope.STRUCTURE_START,
        idempotencyKey: 'fixed-key-123',
      },
    );
    expect(mock.calls[0]?.headers['Idempotency-Key']).toBe('fixed-key-123');
  });

  it('apiPatch 带 scope 注入头', async () => {
    mock = installFetchMock({ json: { data: {} } });
    await apiPatch('/manifest', { tagline: 'hi' }, { scope: IdempotencyScope.MANIFEST_PATCH });
    expect(mock.calls[0]?.method).toBe('PATCH');
    expect(mock.calls[0]?.headers['X-Idempotency-Scope']).toBe('manifest.patch');
  });

  it('apiDelete 不豁免幂等（带 scope 仍注入 key）', async () => {
    mock = installFetchMock({ status: 204 });
    await apiDelete('/social/follow/u1', { scope: IdempotencyScope.SOCIAL_UNFOLLOW });
    expect(mock.calls[0]?.method).toBe('DELETE');
    expect(mock.calls[0]?.headers['Idempotency-Key']).toBeTruthy();
    expect(mock.calls[0]?.headers['X-Idempotency-Scope']).toBe('social.unfollow');
  });

  it('204 空体 → data 为 undefined（不抛错）', async () => {
    mock = installFetchMock({ status: 204 });
    const data = await apiDelete('/notifications/n1', {
      scope: IdempotencyScope.NOTIFICATION_READ,
    });
    expect(data).toBeUndefined();
  });

  it('请求始终带同源 Cookie（credentials=include）', async () => {
    mock = installFetchMock({ json: { data: {} } });
    await apiGet('/me');
    expect(mock.calls[0]?.credentials).toBe('include');
  });
});

describe('只读 POST helper（apiPostReadonly，脊柱 §4.1 豁免）', () => {
  it('不带 scope → 不注入任何幂等头（纯只读 POST，如 market-card/preview）', async () => {
    mock = installFetchMock({ json: { data: { preview: 'ok' } } });
    await apiPostReadonly('/market-card/preview', { manifest: {} });
    const h = mock.calls[0]?.headers ?? {};
    expect(mock.calls[0]?.method).toBe('POST');
    expect(h['Idempotency-Key']).toBeUndefined();
    expect(h['X-Idempotency-Scope']).toBeUndefined();
  });

  it('带可选 scope（presign）→ 注入幂等头', async () => {
    mock = installFetchMock({ json: { data: { url: 'https://x' } } });
    await apiPostReadonly(
      '/import/presign',
      { name: 'a.zip' },
      {
        scope: IdempotencyOptionalScope.IMPORT_PRESIGN,
      },
    );
    expect(mock.calls[0]?.headers['X-Idempotency-Scope']).toBe('import.presign');
    expect(typeof mock.calls[0]?.headers['Idempotency-Key']).toBe('string');
  });
});

describe('非 2xx → ApiError（只人话 + action，绝不裸状态码）', () => {
  it('契约 ErrorEnvelope 透传 userMessage/action/retriable/traceId', async () => {
    const env: ErrorEnvelope = {
      error: {
        userMessage: '登录态失效了，请重新登录。',
        retriable: false,
        action: 'escalate',
        traceId: 'trace-xyz',
      },
    };
    mock = installFetchMock({ status: 401, json: env });
    await expect(apiGet('/me')).rejects.toMatchObject({ name: 'ApiError' });
    try {
      await apiGet('/me');
    } catch (e) {
      const err = e as ApiError;
      expect(err.userMessage).toBe('登录态失效了，请重新登录。');
      expect(err.action).toBe('escalate');
      expect(err.retriable).toBe(false);
      expect(err.traceId).toBe('trace-xyz');
      // 对外信封无 code：envelope.error 不该带 code 键。
      expect((err.envelope.error as Record<string, unknown>)['code']).toBeUndefined();
    }
  });

  it('契约信封夹带禁止字段（code/status/stack）→ 白名单重建，envelope 不留泄漏字段（#2）', async () => {
    mock = installFetchMock({
      status: 500,
      json: {
        error: {
          userMessage: '服务开小差了，请重试。',
          retriable: true,
          action: 'retry',
          traceId: 'tr-1',
          code: 'INTERNAL',
          status: 500,
          stack: 'Error: boom\n    at f (/srv/a.ts:1:1)',
          details: { attempts: 1, code: 'INTERNAL', stack: 'at g (x:1:1)' },
        },
      },
    });
    try {
      await apiGet('/x');
      throw new Error('should have thrown');
    } catch (e) {
      const err = e as ApiError;
      const body = err.envelope.error as Record<string, unknown>;
      expect(body['userMessage']).toBe('服务开小差了，请重试。');
      expect(body['code']).toBeUndefined();
      expect(body['status']).toBeUndefined();
      expect(body['stack']).toBeUndefined();
      expect(body['details']).toEqual({ attempts: 1 }); // 仅安全键保留。
      const json = JSON.stringify(err.envelope);
      expect(json).not.toContain('INTERNAL');
      expect(json).not.toMatch(/\bstack\b/);
    }
  });

  it('非契约 4xx/5xx body（无 error.userMessage）→ 兜底人话，不露状态码', async () => {
    mock = installFetchMock({ status: 500, json: { oops: true } });
    try {
      await apiGet('/dashboard/summary');
      throw new Error('should have thrown');
    } catch (e) {
      const err = e as ApiError;
      expect(err).toBeInstanceOf(ApiError);
      expect(err.userMessage).toBe('服务开小差了，请稍后重试。');
      expect(err.userMessage).not.toMatch(/500/);
      expect(err.action).toBe('retry');
    }
  });

  it('HTML 错误页（json 解析失败）+ 非 2xx → 兜底人话', async () => {
    mock = installFetchMock({ status: 502, notJson: true });
    try {
      await apiGet('/x');
      throw new Error('should have thrown');
    } catch (e) {
      const err = e as ApiError;
      expect(err).toBeInstanceOf(ApiError);
      expect(err.userMessage).toBe('服务暂时没有正确响应，请稍后重试。');
      expect(err.userMessage).not.toMatch(/502/);
    }
  });

  it('网络断（fetch reject）→ 兜底人话信封', async () => {
    mock = installFetchMock({ networkError: true });
    try {
      await apiPost('/capabilities', {}, { scope: IdempotencyScope.CAPABILITY_CREATE });
      throw new Error('should have thrown');
    } catch (e) {
      const err = e as ApiError;
      expect(err).toBeInstanceOf(ApiError);
      expect(err.userMessage).toBe('网络好像不太稳，检查连接后重试。');
      expect(err.retriable).toBe(true);
    }
  });
});

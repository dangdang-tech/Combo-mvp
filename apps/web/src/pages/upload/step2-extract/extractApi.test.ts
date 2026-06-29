// F-11 STEP② 数据层测试：触发/重试 写命令注入 Idempotency-Key + scope；列候选解包置信分布。
import { describe, it, expect, afterEach } from 'vitest';
import { installFetchMock, type FetchMock } from '../../../test/mockFetch.js';
import { createExtractJob, fetchCandidates, retryCandidate, jobEventsUrl } from './extractApi.js';

let mock: FetchMock;
afterEach(() => mock?.restore());

describe('extractApi', () => {
  it('createExtractJob → POST /snapshots/{id}/extract 注入 scope=extract.create', async () => {
    mock = installFetchMock({
      status: 202,
      json: {
        data: {
          jobId: 'j1',
          snapshotId: 's1',
          status: 'queued',
          eventsUrl: '/api/v1/jobs/j1/events',
        },
      },
    });
    const res = await createExtractJob('s1');
    expect(res.jobId).toBe('j1');
    const call = mock.calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.url).toBe('/api/v1/snapshots/s1/extract');
    expect(call.headers['Idempotency-Key']).toBeTruthy();
    expect(call.headers['X-Idempotency-Scope']).toBe('extract.create');
  });

  it('createExtractJob 复用 idempotencyKey → 同 key（重复点/刷新只跑一次）', async () => {
    mock = installFetchMock({
      status: 202,
      json: { data: { jobId: 'j1', snapshotId: 's1', status: 'queued', eventsUrl: '/x' } },
    });
    await createExtractJob('s1', 'fixed-key');
    expect(mock.calls[0]!.headers['Idempotency-Key']).toBe('fixed-key');
  });

  it('createExtractJob({ draftId }) → POST body 串真实 draftId（后端据它同事务回填 drafts.extract_job_id，续传回断点，P0）', async () => {
    mock = installFetchMock({
      status: 202,
      json: { data: { jobId: 'j1', snapshotId: 's1', status: 'queued', eventsUrl: '/x' } },
    });
    await createExtractJob('s1', 'fixed-key', { draftId: 'draft-real' });
    const call = mock.calls[0]!;
    // 反向破坏守门：body 必含真实 draftId；退回「空 body 不传 draftId」即此断言测红（fresh flow 萃取指针不落 draft）。
    expect(call.body).toEqual({ draftId: 'draft-real' });
    expect((call.body as { draftId?: string }).draftId).toBe('draft-real');
  });

  it('createExtractJob 无 draftId → body 空 {}（向后兼容，契约 §2.1 body 可空）', async () => {
    mock = installFetchMock({
      status: 202,
      json: { data: { jobId: 'j1', snapshotId: 's1', status: 'queued', eventsUrl: '/x' } },
    });
    await createExtractJob('s1', 'fixed-key');
    expect(mock.calls[0]!.body).toEqual({});
  });

  it('fetchCandidates → GET asc + status=ready,failed；解包候选 + confidenceSummary（meta 扩展）', async () => {
    mock = installFetchMock({
      status: 200,
      json: {
        data: [
          {
            id: 'c1',
            extractJobId: 'j1',
            snapshotId: 's1',
            status: 'ready',
            name: 'x',
            intent: null,
            slug: 'x',
            type: null,
            confidence: 'high',
            segmentCount: 9,
            frequencyRatio: null,
            reusability: null,
            scopeCoherence: null,
            splitSuggested: null,
            scope: null,
            error: null,
            retryCount: 0,
            createdAt: '2026-06-10T00:00:00Z',
          },
        ],
        meta: {
          page: { hasMore: false, nextCursor: null, limit: 50, order: 'asc' },
          confidenceSummary: { high: 4, med: 3, low: 2 },
        },
      },
    });
    const res = await fetchCandidates('j1', { limit: 50 });
    expect(res.candidates).toHaveLength(1);
    expect(res.confidenceSummary).toEqual({ high: 4, med: 3, low: 2 });
    expect(mock.calls[0]!.url).toContain('order=asc');
    expect(mock.calls[0]!.url).toContain('status=ready%2Cfailed');
  });

  it('retryCandidate → POST /candidates/{id}/retry 注入 scope=candidate.retry；回新 retryJob eventsUrl', async () => {
    mock = installFetchMock({
      status: 202,
      json: {
        data: {
          candidateId: 'cf',
          extractJobId: 'j1',
          retryJobId: 'rj1',
          status: 'generating',
          retryCount: 1,
          eventsUrl: '/api/v1/jobs/rj1/events',
        },
      },
    });
    const res = await retryCandidate('cf');
    expect(res.retryJobId).toBe('rj1');
    const call = mock.calls[0]!;
    expect(call.url).toBe('/api/v1/candidates/cf/retry');
    expect(call.headers['X-Idempotency-Scope']).toBe('candidate.retry');
  });

  it('jobEventsUrl → 脊柱 §5 job 流端点（萃取/重试复用）', () => {
    expect(jobEventsUrl('rj1')).toBe('/api/v1/jobs/rj1/events');
  });
});

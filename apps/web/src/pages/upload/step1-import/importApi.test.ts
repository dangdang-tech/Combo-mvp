// F-10 STEP① 数据层测试：浏览器直传（presign / PUT / 建 Job）+ 铸码/取消写命令注入 Idempotency-Key + scope；快照查询解包。
import { describe, it, expect, afterEach } from 'vitest';
import { installFetchMock, type FetchMock } from '../../../test/mockFetch.js';
import { ApiError } from '../../../api/index.js';
import {
  createPair,
  cancelImportJob,
  fetchPairStatus,
  fetchSnapshot,
  fetchSnapshotSegments,
  importJobEventsUrl,
  presignUploads,
  putUploadPart,
  createImportJob,
} from './importApi.js';

let mock: FetchMock;
afterEach(() => mock?.restore());

describe('importApi 浏览器直传（B-20）', () => {
  it('presignUploads → POST /import/uploads/presign，注入可选 scope=import.presign + 按契约字段', async () => {
    mock = installFetchMock({
      status: 200,
      json: {
        data: {
          uploadId: 'up1',
          bucket: 'agora-raw',
          parts: [
            {
              clientPartId: 'a#0',
              url: 'https://s3.example/a',
              s3Key: 'raw/u/up1/a#0',
              expiresAt: '2026-06-19T01:00:00Z',
            },
          ],
        },
      },
    });
    const res = await presignUploads({
      parts: [{ clientPartId: 'a#0', sizeBytes: 10 }],
      source: 'mixed',
      totalBytes: 10,
    });
    expect(res.uploadId).toBe('up1');
    expect(res.parts[0]!.url).toBe('https://s3.example/a');
    const call = mock.calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.url).toBe('/api/v1/import/uploads/presign');
    expect(call.headers['X-Idempotency-Scope']).toBe('import.presign');
    expect(call.headers['Idempotency-Key']).toBeTruthy();
    expect(call.body).toEqual({
      parts: [{ clientPartId: 'a#0', sizeBytes: 10 }],
      source: 'mixed',
      totalBytes: 10,
    });
  });

  it('putUploadPart → PUT 预签名 URL，credentials=omit、八位字节流（直发对象存储，不带站点 Cookie）', async () => {
    mock = installFetchMock({ status: 200 });
    await putUploadPart('https://s3.example/a', new Blob(['x']));
    const call = mock.calls[0]!;
    expect(call.method).toBe('PUT');
    expect(call.url).toBe('https://s3.example/a');
    expect(call.credentials).toBe('omit');
    expect(call.headers['Content-Type']).toBe('application/octet-stream');
  });

  it('putUploadPart 非 2xx（URL 过期 403）→ 人话 UPLOAD_INTERRUPTED（retry，绝不裸露状态码）', async () => {
    mock = installFetchMock({ status: 403 });
    await expect(putUploadPart('https://s3.example/a', new Blob(['x']))).rejects.toMatchObject({
      action: 'retry',
    });
    await expect(putUploadPart('https://s3.example/a', new Blob(['x']))).rejects.toBeInstanceOf(
      ApiError,
    );
  });

  it('putUploadPart 网络断 → 人话 UPLOAD_INTERRUPTED（可续传）', async () => {
    mock = installFetchMock({ networkError: true });
    await expect(putUploadPart('https://s3.example/a', new Blob(['x']))).rejects.toMatchObject({
      action: 'retry',
    });
  });

  it('createImportJob → POST /import/jobs 注入 scope=import.create + 复用同 idempotencyKey（同 uploadId 回放同一 jobId）', async () => {
    mock = installFetchMock({
      status: 202,
      json: {
        data: {
          id: 'job1',
          type: 'import',
          status: 'queued',
          progress: {},
          attemptNo: 1,
          createdAt: '2026-06-19T00:00:00Z',
        },
      },
    });
    const job = await createImportJob({
      uploadId: 'up1',
      source: 'mixed',
      idempotencyKey: 'fixed-key',
      draftId: 'd1',
    });
    expect(job.id).toBe('job1');
    const call = mock.calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.url).toBe('/api/v1/import/jobs');
    expect(call.headers['X-Idempotency-Scope']).toBe('import.create');
    expect(call.headers['Idempotency-Key']).toBe('fixed-key');
    expect(call.body).toEqual({ uploadId: 'up1', source: 'mixed', draftId: 'd1' });
  });
});

describe('importApi', () => {
  it('createPair → POST /import/connect/pair 注入 Idempotency-Key + scope=import.connect.pair', async () => {
    mock = installFetchMock({
      status: 200,
      json: {
        data: {
          pairId: 'p1',
          pairingCode: '123456',
          command: 'cmd',
          curlOneLiner: 'curl -fsSL agora.app/import | sh',
          expiresAt: '2026-06-17T01:00:00Z',
        },
      },
    });
    const res = await createPair();
    expect(res.pairId).toBe('p1');
    const call = mock.calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.url).toBe('/api/v1/import/connect/pair');
    expect(call.headers['Idempotency-Key']).toBeTruthy();
    expect(call.headers['X-Idempotency-Scope']).toBe('import.connect.pair');
  });

  it('createPair(draftId) → body 带 draftId（续传草稿挂接）', async () => {
    mock = installFetchMock({
      status: 200,
      json: {
        data: {
          pairId: 'p1',
          pairingCode: '1',
          command: 'c',
          curlOneLiner: 'x',
          expiresAt: '2026-06-17T01:00:00Z',
        },
      },
    });
    await createPair({ draftId: 'd1' });
    expect(mock.calls[0]!.body).toEqual({ draftId: 'd1' });
  });

  it('cancelImportJob → POST /jobs/{id}/cancel 注入 scope=job.cancel', async () => {
    mock = installFetchMock({ status: 204 });
    await cancelImportJob('job1');
    const call = mock.calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.url).toBe('/api/v1/jobs/job1/cancel');
    expect(call.headers['X-Idempotency-Scope']).toBe('job.cancel');
    expect(call.headers['Idempotency-Key']).toBeTruthy();
  });

  it('fetchPairStatus → GET 读端点（无幂等头）', async () => {
    mock = installFetchMock({
      status: 200,
      json: { data: { pairId: 'p1', phase: 'uploading', uploadedParts: 2, totalParts: 5 } },
    });
    const res = await fetchPairStatus('p1');
    expect(res.phase).toBe('uploading');
    expect(mock.calls[0]!.url).toBe('/api/v1/import/connect/pair/p1');
    expect(mock.calls[0]!.headers['X-Idempotency-Scope']).toBeUndefined();
  });

  it('fetchSnapshot → 解包统计四格', async () => {
    mock = installFetchMock({
      status: 200,
      json: {
        data: {
          id: 'snap1',
          ownerUserId: 'u1',
          source: 'mixed',
          sources: ['claude'],
          stats: { segmentCount: 215, messageCount: 8420, timeSpan: null, projectCount: 14 },
          redaction: { applied: true, totalRedactions: 0, byCategory: [], rulesetVersion: 'v1' },
          createdAt: '2026-06-17T00:00:00Z',
        },
      },
    });
    const res = await fetchSnapshot('snap1');
    expect(res.stats.segmentCount).toBe(215);
    expect(mock.calls[0]!.url).toBe('/api/v1/snapshots/snap1');
  });

  it('fetchSnapshotSegments → 解包 + 透传分页 meta', async () => {
    mock = installFetchMock({
      status: 200,
      json: {
        data: [
          { segmentId: 's1', dateLabel: '03-20', title: 't', messageCount: 1, readOnly: true },
        ],
        meta: { page: { hasMore: true, nextCursor: 'c2', limit: 30, order: 'desc' } },
      },
    });
    const res = await fetchSnapshotSegments('snap1', { limit: 30 });
    expect(res.segments).toHaveLength(1);
    expect(res.hasMore).toBe(true);
    expect(res.nextCursor).toBe('c2');
    expect(mock.calls[0]!.url).toContain('/api/v1/snapshots/snap1/segments');
  });

  it('importJobEventsUrl → 脊柱 §5 job 流端点', () => {
    expect(importJobEventsUrl('job1')).toBe('/api/v1/jobs/job1/events');
  });
});

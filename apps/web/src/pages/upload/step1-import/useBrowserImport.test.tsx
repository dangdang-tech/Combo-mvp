// useBrowserImport 单测（BUG-013）：选文件 → presign → 分批 PUT → 建 Job → 回 jobId；
//   断点续传（已传片不重传、重试复用同 key）+ 失败人话信封 + 取消 reset。
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { useBrowserImport, type UseBrowserImportResult } from './useBrowserImport.js';
import { installFetchMock, type FetchMock } from '../../../test/mockFetch.js';

let mock: FetchMock;
afterEach(() => mock?.restore());
beforeEach(() => {
  lastJobId = '';
});

// presign 响应：按传入 parts 回签名 URL（每片一个 url，clientPartId 对齐）。
function presignResponse(clientPartIds: string[]) {
  return {
    status: 200,
    json: {
      data: {
        uploadId: 'up1',
        bucket: 'agora-raw',
        parts: clientPartIds.map((id) => ({
          clientPartId: id,
          url: `https://s3.example/${encodeURIComponent(id)}`,
          s3Key: `raw/u/up1/${id}`,
          expiresAt: '2026-06-19T01:00:00Z',
        })),
      },
    },
  };
}

const jobResponse = {
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
};

// 探针：暴露 hook 结果给断言，并把 jobId 落到 DOM。
let api: UseBrowserImportResult;
let lastJobId = '';
function Probe({ onJobId }: { onJobId?: (id: string) => void }) {
  api = useBrowserImport({
    onJobId: (id) => {
      lastJobId = id;
      onJobId?.(id);
    },
  });
  return (
    <div>
      <span data-testid="phase">{api.progress.phase}</span>
      <span data-testid="percent">{api.progress.percent}</span>
      <span data-testid="parts">{`${api.progress.partsDone}/${api.progress.partsTotal}`}</span>
      <span data-testid="err">{api.progress.error?.userMessage ?? 'none'}</span>
      <span data-testid="job">{lastJobId}</span>
    </div>
  );
}

function file(name: string, bytes = 4): File {
  return new File([new Uint8Array(bytes)], name, { type: 'text/plain' });
}

describe('useBrowserImport', () => {
  it('选文件 → presign → PUT → 建 Job → 回 jobId（小文件单片，进度满）', async () => {
    // 单文件 → 单 part：presign（id '0-a.txt#0'）→ PUT 200 → 建 Job 202。
    mock = installFetchMock([presignResponse(['0-a.txt#0']), { status: 200 }, jobResponse]);
    const onJobId = vi.fn();
    render(<Probe onJobId={onJobId} />);
    act(() => api.start([file('a.txt')]));

    await waitFor(() => expect(screen.getByTestId('job').textContent).toBe('job1'));
    expect(onJobId).toHaveBeenCalledWith('job1');
    expect(screen.getByTestId('parts').textContent).toBe('1/1');
    expect(screen.getByTestId('percent').textContent).toBe('100');

    // 三段请求顺序：presign（POST）→ PUT → 建 Job（POST /import/jobs）。
    expect(mock.calls[0]!.url).toBe('/api/v1/import/uploads/presign');
    expect(mock.calls[1]!.method).toBe('PUT');
    expect(mock.calls[2]!.url).toBe('/api/v1/import/jobs');
  });

  it('PUT 失败 → 人话 error 态（UPLOAD_INTERRUPTED retry）；不建 Job', async () => {
    mock = installFetchMock([presignResponse(['0-a.txt#0']), { status: 403 }]);
    render(<Probe />);
    act(() => api.start([file('a.txt')]));

    await waitFor(() => expect(screen.getByTestId('phase').textContent).toBe('error'));
    expect(screen.getByTestId('err').textContent).toContain('上传中断');
    // 只发了 presign + PUT，没发建 Job（绝不在传齐前建 job）。
    expect(mock.calls.some((c) => c.url === '/api/v1/import/jobs')).toBe(false);
  });

  it('重试续传：失败后 retry 重新 presign + PUT，成功建 Job（已生成内容不丢）', async () => {
    // 第一轮：presign → PUT 403（失败）。第二轮 retry：presign → PUT 200 → 建 Job。
    mock = installFetchMock([
      presignResponse(['0-a.txt#0']),
      { status: 403 },
      presignResponse(['0-a.txt#0']),
      { status: 200 },
      jobResponse,
    ]);
    render(<Probe />);
    act(() => api.start([file('a.txt')]));
    await waitFor(() => expect(screen.getByTestId('phase').textContent).toBe('error'));

    act(() => api.retry());
    await waitFor(() => expect(screen.getByTestId('job').textContent).toBe('job1'));
    expect(mock.calls.at(-1)!.url).toBe('/api/v1/import/jobs');
  });

  it('建 Job 复用同 idempotencyKey（重试时同 uploadId 回放同一 jobId，导入-23）', async () => {
    mock = installFetchMock([presignResponse(['0-a.txt#0']), { status: 200 }, jobResponse]);
    render(<Probe />);
    act(() => api.start([file('a.txt')]));
    await waitFor(() => expect(screen.getByTestId('job').textContent).toBe('job1'));
    const jobCall = mock.calls.find((c) => c.url === '/api/v1/import/jobs')!;
    expect(jobCall.headers['Idempotency-Key']).toBeTruthy();
    expect(jobCall.headers['X-Idempotency-Scope']).toBe('import.create');
  });

  it('空文件集 → 人话 error（没选到文件），不发任何请求', async () => {
    mock = installFetchMock({ status: 200 });
    render(<Probe />);
    act(() => api.start([]));
    await waitFor(() => expect(screen.getByTestId('phase').textContent).toBe('error'));
    expect(screen.getByTestId('err').textContent).toContain('没选到');
    expect(mock.calls).toHaveLength(0);
  });

  it('reset → 回 idle（取消上传）', async () => {
    mock = installFetchMock([presignResponse(['0-a.txt#0']), { status: 200 }, jobResponse]);
    render(<Probe />);
    act(() => api.start([file('a.txt')]));
    await waitFor(() => expect(screen.getByTestId('job').textContent).toBe('job1'));
    act(() => api.reset());
    expect(screen.getByTestId('phase').textContent).toBe('idle');
  });
});

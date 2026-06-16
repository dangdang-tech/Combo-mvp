// StreamLoading 测试（永不裸转圈 总装件）：connecting/open/reconnecting/error/done 每一态
// 都给「有结构」反馈——连接中给骨架、流动中给进度+子任务、重连给安抚条、错误给统一错误态、完成不挡。
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StreamLoading } from './StreamLoading.js';
import type { UseSSEState } from '../api/useSSE.js';

function base(partial: Partial<UseSSEState>): UseSSEState {
  return { kind: 'job', status: 'connecting', items: [], ...partial };
}

describe('StreamLoading 永不裸转圈', () => {
  it('connecting 且无 progress → 骨架（绝不空白/裸 spinner）', () => {
    const { container } = render(
      <StreamLoading state={base({ status: 'connecting' })} skeletonRows={3} />,
    );
    expect(container.querySelectorAll('.cb-skeleton__row').length).toBe(3);
  });

  it('open 且有 progress → 进度条 + 子任务清单', () => {
    const state = base({
      status: 'open',
      progress: {
        percent: 40,
        phrase: '40% · 80 / 200',
        subtasks: [{ key: 'redact', label: '导入并抹隐私', status: 'running' }],
      },
    });
    render(<StreamLoading state={state} />);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '40');
    expect(screen.getByText('导入并抹隐私')).toBeInTheDocument();
  });

  it('reconnecting → 安抚条「正在自动重连」（非错误、非裸转圈），保留进度', () => {
    const state = base({
      status: 'reconnecting',
      progress: { percent: 30, phrase: '30%', subtasks: [] },
    });
    render(<StreamLoading state={state} />);
    expect(screen.getByText(/正在自动重连/)).toBeInTheDocument();
    expect(screen.getByText(/已生成的内容不会丢/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument(); // 不是错误态
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
  });

  it('error → 渲染统一 ErrorState（只 userMessage + 退路）', async () => {
    const onRetry = vi.fn();
    const state = base({
      status: 'error',
      error: {
        userMessage: '这一步超时了，可重试。',
        retriable: true,
        action: 'retry',
        traceId: 't',
      },
    });
    render(<StreamLoading state={state} onRetry={onRetry} />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText('这一步超时了，可重试。')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('done → 不渲染加载（返回 null，让页面渲染结果）', () => {
    const { container } = render(<StreamLoading state={base({ status: 'done' })} />);
    expect(container.firstChild).toBeNull();
  });

  it('open 携 field_stuck → 透出三退路并回传选择', async () => {
    const onStuckChoice = vi.fn();
    const state = base({
      status: 'open',
      progress: { percent: 50, phrase: '50%', subtasks: [] },
      stuck: { field: 'tagline', elapsedMs: 30000, options: ['continue', 'regen', 'wait'] },
    });
    render(<StreamLoading state={state} onStuckChoice={onStuckChoice} />);
    await userEvent.click(screen.getByRole('button', { name: '继续生成' }));
    expect(onStuckChoice).toHaveBeenCalledWith('continue');
  });
});

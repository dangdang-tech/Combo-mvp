// F-10 STEP① 加载态组件测试：三层（进度量化文案 + 子任务清单 + 落库卡逐行）+ 取消 + 错误态切换。
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ImportedSegmentBrief, ProgressView, ErrorBody } from '@cb/shared';
import type { UseSSEState } from '../../../api/index.js';
import { ImportLoading } from './ImportLoading.js';

function progress(over: Partial<ProgressView> = {}): ProgressView {
  return {
    percent: 68,
    phrase: '68% · 已抓取 146 / 215 段会话 · 5,210 / 8,420 条消息',
    subtasks: [
      { key: 'credential', label: '连接凭证', status: 'done' },
      { key: 'fetch_index', label: '拉取会话索引', status: 'running' },
      { key: 'redact', label: '导入消息并抹掉隐私信息', status: 'pending' },
      { key: 'segment', label: '切分成段落', status: 'pending' },
      { key: 'snapshot', label: '生成原始数据', status: 'pending' },
    ],
    ...over,
  };
}

function seg(over: Partial<ImportedSegmentBrief> = {}): ImportedSegmentBrief {
  return {
    segmentId: 's1',
    dateLabel: '03-20',
    title: '保单条款梳理',
    messageCount: 42,
    status: 'imported',
    ...over,
  };
}

function sseState(over: Partial<UseSSEState> = {}): UseSSEState {
  return { kind: 'job', status: 'open', items: [], ...over };
}

describe('ImportLoading', () => {
  it('第 1+2 层：进度量化文案 + 五项子任务清单依次点亮', () => {
    render(<ImportLoading state={sseState({ progress: progress() })} />);
    expect(screen.getByText(/68% · 已抓取 146 \/ 215 段会话/)).toBeInTheDocument();
    expect(screen.getByText('连接凭证')).toBeInTheDocument();
    expect(screen.getByText('导入消息并抹掉隐私信息')).toBeInTheDocument();
    expect(screen.getByText('生成原始数据')).toBeInTheDocument();
  });

  it('第 3 层：落库卡逐行会话状态（导入中… / 已入）', () => {
    render(
      <ImportLoading
        state={sseState({
          progress: progress(),
          items: [
            seg({ status: 'imported', title: '已入的段' }),
            seg({ segmentId: 's2', status: 'importing', title: '导入中的段' }),
          ],
        })}
      />,
    );
    expect(screen.getByText('已入的段')).toBeInTheDocument();
    expect(screen.getByText('导入中的段')).toBeInTheDocument();
    expect(screen.getByText('已入')).toBeInTheDocument();
    expect(screen.getByText('导入中…')).toBeInTheDocument();
  });

  it('后台执行说明 + 取消链接（可关页云端续跑）；点取消触发 onCancel', async () => {
    const onCancel = vi.fn();
    render(<ImportLoading state={sseState({ progress: progress() })} onCancel={onCancel} />);
    expect(screen.getByText(/可以关掉这一页/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '取消导入' }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('error 态 → 切 ErrorState（人话 + 重试，无 code）；不再渲染清单/取消', () => {
    const err: ErrorBody = {
      userMessage: '上传中断了，续传或重新导入。',
      retriable: true,
      action: 'retry',
      traceId: 't',
    };
    const onRetry = vi.fn();
    render(
      <ImportLoading
        state={sseState({ status: 'error', error: err })}
        onCancel={() => undefined}
        onRetry={onRetry}
      />,
    );
    expect(screen.getByText('上传中断了，续传或重新导入。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument();
    // 错误态不渲染取消链接（避免噪声）。
    expect(screen.queryByRole('button', { name: '取消导入' })).not.toBeInTheDocument();
  });

  it('done 态 → 不再补尾部骨架（停止「正在来」暗示）', () => {
    const { container } = render(
      <ImportLoading state={sseState({ status: 'done', items: [seg()] })} />,
    );
    // 已抓取卡仍在，但 pendingSkeletons=0：无 itemstream__pending 骨架区。
    expect(screen.getByText('保单条款梳理')).toBeInTheDocument();
    expect(container.querySelector('.cb-itemstream__pending')).toBeNull();
  });
});

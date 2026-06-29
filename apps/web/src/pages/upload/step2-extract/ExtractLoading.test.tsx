// F-11 STEP② 加载态组件测试：策略说明 + 子任务点亮 + 逐个浮现计数 + 已识别卡 + 未识别骨架 + 失败行重试。
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CandidateItem, ProgressView } from '@cb/shared';
import type { UseSSEState } from '../../../api/index.js';
import { ExtractLoading } from './ExtractLoading.js';

function progress(over: Partial<ProgressView> = {}): ProgressView {
  return {
    percent: 33,
    phrase: '已识别 3 / 9 能力项…',
    done: 3,
    total: 9,
    subtasks: [
      { key: 'analyze', label: '分析会话段落', status: 'done' },
      { key: 'cluster', label: '聚类相似工作流', status: 'running' },
      { key: 'form', label: '形成候选能力', status: 'pending' },
      { key: 'score', label: '评估频率与可打包度', status: 'pending' },
      { key: 'rank', label: '按成功率排序', status: 'pending' },
    ],
    ...over,
  };
}

function item(over: Partial<CandidateItem> = {}): CandidateItem {
  return { id: 'c1', status: 'ready', name: '短视频脚本生成器', ...over };
}

function sseState(over: Partial<UseSSEState> = {}): UseSSEState {
  return { kind: 'job', status: 'open', items: [], ...over };
}

describe('ExtractLoading', () => {
  it('标题 + 策略说明 + 五项子任务依次点亮', () => {
    render(<ExtractLoading state={sseState({ progress: progress() })} />);
    expect(screen.getByText(/正在从你的对话历史里识别可复用的能力/)).toBeInTheDocument();
    expect(screen.getByText(/聚到一起/)).toBeInTheDocument(); // 策略说明
    expect(screen.getByText('分析会话段落')).toBeInTheDocument();
    expect(screen.getByText('按成功率排序')).toBeInTheDocument();
  });

  it('逐个浮现计数「已浮现 X / Y」+ 已识别卡逐张浮现 + 未识别骨架', () => {
    const { container } = render(
      <ExtractLoading
        state={sseState({
          progress: progress(),
          items: [item(), item({ id: 'c2', name: 'VC 拷打模拟器', isNew: true })],
        })}
      />,
    );
    expect(screen.getByText(/已浮现 3 \/ 9 个能力项/)).toBeInTheDocument();
    expect(screen.getByText('短视频脚本生成器')).toBeInTheDocument();
    expect(screen.getByText('VC 拷打模拟器')).toBeInTheDocument();
    expect(screen.getByLabelText('刚识别出')).toBeInTheDocument();
    // total(9) > items(2) → 尾部补占位骨架（最多 3 张）。
    expect(container.querySelectorAll('.cb-extract-loading__skeleton').length).toBeGreaterThan(0);
  });

  it('失败候选浮现 → 失败行 + 行内「重试」不阻塞其它', async () => {
    const onRetry = vi.fn();
    render(
      <ExtractLoading
        state={sseState({
          progress: progress(),
          items: [
            item(),
            item({
              id: 'cf',
              status: 'failed',
              name: '保单条款比对器',
              error: {
                userMessage: '这一项没能识别出来，可点重试。',
                retriable: true,
                action: 'retry',
                traceId: 't',
              },
            }),
          ],
        })}
        onRetry={onRetry}
      />,
    );
    // 正常卡仍在（不阻塞）。
    expect(screen.getByText('短视频脚本生成器')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(onRetry).toHaveBeenCalledWith('cf');
  });

  it('error 态 → 切 ErrorState（人话 + 重试）；不再渲染浮现列表', () => {
    const onJobRetry = vi.fn();
    render(
      <ExtractLoading
        state={sseState({
          status: 'error',
          error: {
            userMessage: '这一步超时了，可重试或稍后再看。',
            retriable: true,
            action: 'retry',
            traceId: 't',
          },
        })}
        onJobRetry={onJobRetry}
      />,
    );
    expect(screen.getByText('这一步超时了，可重试或稍后再看。')).toBeInTheDocument();
    expect(screen.queryByText(/已浮现/)).not.toBeInTheDocument();
  });
});

// STEP② 提取过程态：PRD 圆环进度 + 指标 + 已发现能力列表 + 失败行重试。
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
    metrics: { analyzedSegments: 166, discoveredCandidates: 3 },
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
  it('显示圆环百分比、提取说明和进度指标', () => {
    render(<ExtractLoading state={sseState({ progress: progress() })} />);
    expect(screen.getByText('正在提取你的能力…')).toBeInTheDocument();
    expect(screen.getByText(/正在阅读你的 sessions/)).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '33');
    expect(screen.getByText('33%')).toBeInTheDocument();
    expect(screen.getByText('166')).toBeInTheDocument();
    expect(screen.getByText('已分析 session')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('已发现能力')).toBeInTheDocument();
  });

  it('渲染已发现能力列表和未完成占位', () => {
    const { container } = render(
      <ExtractLoading
        state={sseState({
          progress: progress(),
          items: [item(), item({ id: 'c2', name: 'VC 拷打模拟器', isNew: true })],
        })}
      />,
    );
    expect(screen.getByText('已发现')).toBeInTheDocument();
    expect(screen.getByText('短视频脚本生成器')).toBeInTheDocument();
    expect(screen.getByText('VC 拷打模拟器')).toBeInTheDocument();
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
    expect(screen.queryByText('已发现')).not.toBeInTheDocument();
  });
});

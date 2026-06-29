// F-11 STEP② 结果态组件测试：结果横幅 + 批量勾选 + 置信分布摘要 + 失败行重试不阻塞。
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CandidateView, ConfidenceSummary, ExtractDoneResult } from '@cb/shared';
import { ExtractResult } from './ExtractResult.js';

function candidate(over: Partial<CandidateView> = {}): CandidateView {
  return {
    id: 'c1',
    extractJobId: 'ej1',
    snapshotId: 's1',
    status: 'ready',
    name: '短视频脚本生成器',
    intent: '按选题与受众生成口播脚本',
    slug: 'svs',
    type: 'recurring',
    confidence: 'high',
    segmentCount: 9,
    frequencyRatio: 0.6,
    reusability: null,
    scopeCoherence: 0.74,
    splitSuggested: null,
    scope: null,
    error: null,
    retryCount: 0,
    createdAt: '2026-06-10T00:00:00Z',
    ...over,
  };
}

const summary: ConfidenceSummary = { high: 4, med: 3, low: 2 };
const doneResult: ExtractDoneResult = {
  candidateCount: 9,
  readyCount: 7,
  failedCount: 2,
  analyzedSegments: 215,
  degraded: false,
};

describe('ExtractResult', () => {
  it('结果横幅「已分析 X 段原始数据，识别出 Y 个能力项」', () => {
    render(
      <ExtractResult
        candidates={[candidate()]}
        selectedIds={new Set()}
        onToggle={() => undefined}
        doneResult={doneResult}
        confidenceSummary={summary}
      />,
    );
    expect(screen.getByText(/已分析 215 段原始数据，识别出 9 个能力项/)).toBeInTheDocument();
  });

  it('批量选择列表每行：勾选 + 名称 + 置信徽章 + 类型标签 + 一句话描述 + 频次条', () => {
    const { container } = render(
      <ExtractResult
        candidates={[candidate()]}
        selectedIds={new Set()}
        onToggle={() => undefined}
        confidenceSummary={summary}
      />,
    );
    expect(screen.getByRole('checkbox')).toBeInTheDocument();
    expect(screen.getByText('短视频脚本生成器')).toBeInTheDocument();
    expect(screen.getByText('置信 高')).toBeInTheDocument();
    expect(screen.getByText('经常出现')).toBeInTheDocument();
    expect(screen.getByText('按选题与受众生成口播脚本')).toBeInTheDocument();
    expect(container.querySelector('.cb-extract-result__freq-fill')).toBeTruthy();
  });

  it('勾选/取消触发 onToggle；已勾选行高亮', async () => {
    const onToggle = vi.fn();
    const { rerender } = render(
      <ExtractResult
        candidates={[candidate()]}
        selectedIds={new Set()}
        onToggle={onToggle}
        confidenceSummary={summary}
      />,
    );
    await userEvent.click(screen.getByRole('checkbox'));
    expect(onToggle).toHaveBeenCalledWith('c1');
    rerender(
      <ExtractResult
        candidates={[candidate()]}
        selectedIds={new Set(['c1'])}
        onToggle={onToggle}
        confidenceSummary={summary}
      />,
    );
    expect(screen.getByRole('checkbox')).toBeChecked();
  });

  it('底部置信分布摘要「高 X · 中 Y · 低 Z」（提取-12）', () => {
    render(
      <ExtractResult
        candidates={[candidate()]}
        selectedIds={new Set()}
        onToggle={() => undefined}
        confidenceSummary={summary}
      />,
    );
    expect(screen.getByText(/置信分布：高 4 · 中 3 · 低 2/)).toBeInTheDocument();
  });

  it('meta 缺 confidenceSummary → 前端从候选现算兜底（仅 ready）', () => {
    render(
      <ExtractResult
        candidates={[candidate({ confidence: 'high' }), candidate({ id: 'c2', confidence: 'low' })]}
        selectedIds={new Set()}
        onToggle={() => undefined}
      />,
    );
    expect(screen.getByText(/置信分布：高 1 · 中 0 · 低 1/)).toBeInTheDocument();
  });

  it('失败行：! 名称 · 人话错误副文 + 行内重试不阻塞其它（无勾选框）', async () => {
    const onRetry = vi.fn();
    render(
      <ExtractResult
        candidates={[
          candidate(),
          candidate({
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
        ]}
        selectedIds={new Set()}
        onToggle={() => undefined}
        confidenceSummary={summary}
        onRetry={onRetry}
      />,
    );
    // 正常行仍可勾（不阻塞）。
    expect(screen.getByRole('checkbox')).toBeInTheDocument();
    expect(screen.getByText('保单条款比对器')).toBeInTheDocument();
    expect(screen.getByText(/这一项没能识别出来/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(onRetry).toHaveBeenCalledWith('cf');
  });

  it('无候选 → 空态退路副文（回上一步再提取）', () => {
    render(<ExtractResult candidates={[]} selectedIds={new Set()} onToggle={() => undefined} />);
    expect(screen.getByText(/没识别出可复用的能力/)).toBeInTheDocument();
  });
});

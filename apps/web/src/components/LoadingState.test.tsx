// LoadingState 测试（硬规则「永不裸转圈」）：进度条 + 量化文案 + 子任务逐条点亮 + 骨架，
// 任何分支都不出现裸 spinner。
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LoadingState, ProgressBar, SubtaskChecklist, Skeleton } from './LoadingState.js';
import type { ProgressView, SubtaskView } from '@cb/shared';

const subtasks: SubtaskView[] = [
  { key: 'a', label: '拉取会话索引', status: 'done' },
  { key: 'b', label: '导入并抹隐私', status: 'running' },
  { key: 'c', label: '切分成段落', status: 'pending' },
];

describe('ProgressBar', () => {
  it('渲染量化文案 + progressbar aria 值', () => {
    const progress: ProgressView = {
      percent: 68,
      phrase: '68% · 已抓取 146 / 215 段',
      subtasks: [],
    };
    render(<ProgressBar progress={progress} />);
    expect(screen.getByText('68% · 已抓取 146 / 215 段')).toBeInTheDocument();
    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '68');
  });

  it('percent 越界被夹到 0–100', () => {
    render(<ProgressBar progress={{ percent: 250, phrase: 'x', subtasks: [] }} />);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
  });

  it('slow=true 显示安抚文案', () => {
    render(<ProgressBar progress={{ percent: 10, phrase: 'x', subtasks: [], slow: true }} />);
    expect(screen.getByText('仍在处理，请稍候…')).toBeInTheDocument();
  });
});

describe('SubtaskChecklist 逐条点亮', () => {
  it('每条子任务带 data-status，标签可见', () => {
    render(<SubtaskChecklist subtasks={subtasks} />);
    expect(screen.getByText('拉取会话索引').closest('li')).toHaveAttribute('data-status', 'done');
    expect(screen.getByText('导入并抹隐私').closest('li')).toHaveAttribute(
      'data-status',
      'running',
    );
    expect(screen.getByText('切分成段落').closest('li')).toHaveAttribute('data-status', 'pending');
  });
});

describe('Skeleton（无进度也不空白）', () => {
  it('渲染指定行数的骨架，带 aria-busy', () => {
    const { container } = render(<Skeleton rows={4} label="加载能力中" />);
    expect(container.querySelectorAll('.cb-skeleton__row').length).toBe(4);
    expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByLabelText('加载能力中')).toBeInTheDocument();
  });
});

describe('LoadingState 编排：永不裸转圈', () => {
  it('有 progress → 进度条 + 子任务清单', () => {
    render(<LoadingState progress={{ percent: 50, phrase: '50%', subtasks }} />);
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
    expect(screen.getByText('拉取会话索引')).toBeInTheDocument();
  });

  it('无 progress → 退化为骨架（绝不空白/裸 spinner）', () => {
    const { container } = render(<LoadingState skeletonRows={2} label="加载中" />);
    expect(container.querySelectorAll('.cb-skeleton__row').length).toBe(2);
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });
});

// F-11 STEP② 候选浮现卡组件测试：已识别卡（刚识别出角标）/ 失败行 + 行内重试。
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CandidateItem } from '@cb/shared';
import { CandidateAppearingCard } from './CandidateAppearingCard.js';

function item(over: Partial<CandidateItem> = {}): CandidateItem {
  return { id: 'c1', status: 'ready', name: '短视频脚本生成器', ...over };
}

describe('CandidateAppearingCard', () => {
  it('ready + isNew → 卡片 + 「刚识别出」角标 + 类型/段数/置信徽章', () => {
    render(
      <CandidateAppearingCard
        item={item({
          isNew: true,
          intent: '按选题生成口播脚本',
          type: 'recurring',
          confidence: 'med',
          segmentCount: 9,
        })}
      />,
    );
    expect(screen.getByText('短视频脚本生成器')).toBeInTheDocument();
    expect(screen.getByLabelText('刚识别出')).toBeInTheDocument();
    expect(screen.getByText('按选题生成口播脚本')).toBeInTheDocument();
    expect(screen.getByText('经常出现')).toBeInTheDocument(); // 类型标签
    expect(screen.getByText('9 段')).toBeInTheDocument();
    expect(screen.getByText('置信 中')).toBeInTheDocument();
  });

  it('failed → 失败行（! 名称 · 人话错误副文，无 code）+ 行内重试', async () => {
    const onRetry = vi.fn();
    render(
      <CandidateAppearingCard
        item={item({
          status: 'failed',
          name: '保单条款比对器',
          error: {
            userMessage: '这一项没能识别出来，可点重试。',
            retriable: true,
            action: 'retry',
            traceId: 't',
            details: { stuckAt: '段 5 / 9' },
          },
        })}
        onRetry={onRetry}
      />,
    );
    expect(screen.getByText('保单条款比对器')).toBeInTheDocument();
    expect(screen.getByText(/这一项没能识别出来/)).toBeInTheDocument();
    expect(screen.getByText(/段 5 \/ 9/)).toBeInTheDocument(); // stuckAt 辅助副文
    // 不裸露错误码（envelope 无 code，UI 也不渲染 details 的内部键）。
    expect(screen.queryByText(/EXTRACT_UPSTREAM_TIMEOUT/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(onRetry).toHaveBeenCalledWith('c1');
  });

  it('failed 重试在途 → 按钮禁用 + 「重试中…」', () => {
    render(
      <CandidateAppearingCard
        item={item({
          status: 'failed',
          error: { userMessage: 'x', retriable: true, action: 'retry', traceId: 't' },
        })}
        onRetry={() => undefined}
        retrying
      />,
    );
    expect(screen.getByRole('button', { name: '重试中…' })).toBeDisabled();
  });

  it('置信缺失 → 「置信 —」（不臆造，不显 undefined）', () => {
    render(
      <CandidateAppearingCard item={item({ confidence: null, type: null, segmentCount: null })} />,
    );
    expect(screen.getByText('置信 —')).toBeInTheDocument();
    expect(screen.getByText('— 段')).toBeInTheDocument();
  });
});

// SummaryHeader 测试（外壳首页-08）：真实 publishedCount 代入 + monthlyInvocations 占位得体文案。
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DashboardSummary, Meta } from '@cb/shared';
import { SummaryHeader, renderSummarySentence } from './SummaryHeader.js';

function summary(over: Partial<DashboardSummary> = {}): DashboardSummary {
  return {
    title: '创作者中心',
    publishedCount: 8,
    monthlyInvocations: null,
    summaryTemplate: '你发布的 {publishedCount} 个能力体，{monthlyInvocations} 次调用',
    ...over,
  };
}

describe('renderSummarySentence', () => {
  it('publishedCount 代入真实值；monthlyInvocations 占位 → 占位文案（不代入 0/null）', () => {
    const meta: Meta = { placeholders: { monthlyInvocations: '暂无数据 / 上线后填充' } };
    const s = renderSummarySentence(summary(), meta);
    expect(s).toContain('8');
    expect(s).toContain('暂无数据 / 上线后填充');
    expect(s).not.toContain('{publishedCount}');
    expect(s).not.toContain('{monthlyInvocations}');
    expect(s).not.toContain('null');
  });

  it('monthlyInvocations 有真值（上线后）→ 代入真值', () => {
    const s = renderSummarySentence(summary({ monthlyInvocations: 1234 }), undefined);
    expect(s).toContain('1234');
  });
});

describe('SummaryHeader', () => {
  it('渲染标题 + 摘要句 + 上传主按钮，摘要不裸露 0/null', () => {
    const meta: Meta = { placeholders: { monthlyInvocations: '暂无数据 / 上线后填充' } };
    render(<SummaryHeader summary={summary()} meta={meta} onCreate={() => {}} />);
    expect(screen.getByRole('heading', { name: '创作者中心' })).toBeInTheDocument();
    expect(screen.getByText(/暂无数据/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '+ 上传新能力' })).toBeInTheDocument();
  });

  it('占位态打标记 data-monthly-placeholder=true', () => {
    const meta: Meta = { placeholders: { monthlyInvocations: '暂无数据 / 上线后填充' } };
    const { container } = render(
      <SummaryHeader summary={summary()} meta={meta} onCreate={() => {}} />,
    );
    expect(container.querySelector('[data-monthly-placeholder="true"]')).not.toBeNull();
  });

  it('点上传按钮 → onCreate 触发', async () => {
    const onCreate = vi.fn();
    render(<SummaryHeader summary={summary()} meta={undefined} onCreate={onCreate} />);
    await userEvent.click(screen.getByRole('button', { name: '+ 上传新能力' }));
    expect(onCreate).toHaveBeenCalledOnce();
  });
});

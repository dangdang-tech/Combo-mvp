// 分区局部错误条测试（主页-17）——只人话 + 重试按钮（绝不裸码）；重试中禁用文案。
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SectionError } from './SectionError.js';

describe('SectionError 分区局部错误条', () => {
  it('渲染人话 + 重试按钮，绝不裸露错误码', () => {
    render(<SectionError sectionLabel="会话足迹" onRetry={() => {}} />);
    expect(screen.getByText('这个分区没能加载，请重试。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument();
    // 无任何 PROFILE_SECTION_FAILED / 500 等码外泄。
    expect(screen.queryByText(/PROFILE_SECTION_FAILED|500/)).toBeNull();
  });

  it('点重试触发子端点重试回调', async () => {
    const onRetry = vi.fn();
    render(<SectionError sectionLabel="作品墙" onRetry={onRetry} />);
    await userEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('retrying=true → 「重试中…」，不再显错误条', () => {
    render(<SectionError sectionLabel="能力网络" retrying onRetry={() => {}} />);
    expect(screen.getByText('能力网络重试中…')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull();
  });
});

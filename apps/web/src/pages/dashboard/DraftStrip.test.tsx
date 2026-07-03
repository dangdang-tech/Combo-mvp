// DraftStrip 测试（外壳首页-16/17/23/33/34）：
//   单 bar 列未完成上传 + 进度短语 / 胶囊与 CTA 回精确断点 / 多条不串台 / 空态不渲染。
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DraftView } from '@cb/shared';
import { DraftStrip } from './DraftStrip.js';

function draft(over: Partial<DraftView> = {}): DraftView {
  return {
    id: 'draft-1',
    status: 'active',
    currentStep: 'structure',
    stepProgress: { percent: 60, phrase: '结构化中 60%' },
    title: '保险话术草稿',
    createdAt: '2026-06-10T00:00:00Z',
    updatedAt: '2026-06-11T00:00:00Z',
    ...over,
  };
}

describe('DraftStrip', () => {
  it('空 drafts → 不渲染（不出空白条）', () => {
    const { container } = render(<DraftStrip drafts={[]} onResume={() => {}} />);
    expect(container.querySelector('.cb-draft-strip')).toBeNull();
  });

  it('渲染草稿条 + 名称 + 进度短语 + mono 标签', () => {
    render(<DraftStrip drafts={[draft()]} onResume={() => {}} />);
    expect(screen.getByText('草稿与上传中')).toBeInTheDocument();
    expect(screen.getByText('保险话术草稿')).toBeInTheDocument();
    expect(screen.getByText(/结构化中 60%/)).toBeInTheDocument();
  });

  it('点「去上传流程」CTA → onResume 带首条草稿 + currentStep 对应路由（已过导入 → 能力页）', async () => {
    const onResume = vi.fn();
    render(<DraftStrip drafts={[draft()]} onResume={onResume} />);
    await userEvent.click(screen.getByRole('button', { name: /去上传流程/ }));
    expect(onResume).toHaveBeenCalledOnce();
    const [d, path] = onResume.mock.calls[0] ?? [];
    expect(d.id).toBe('draft-1');
    // PRD 2 步：草稿 currentStep=structure（已过导入）→ 续断点落能力页。
    expect(path).toBe('/create/capabilities');
  });

  it('多条草稿各回各的断点：仍在导入 → 上传页；已过导入 → 能力页', async () => {
    const onResume = vi.fn();
    render(
      <DraftStrip
        drafts={[
          draft({ id: 'a', title: 'A 草稿', currentStep: 'import' }),
          draft({ id: 'b', title: 'B 草稿', currentStep: 'publish' }),
        ]}
        onResume={onResume}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /B 草稿/ }));
    const [d, path] = onResume.mock.calls[0] ?? [];
    expect(d.id).toBe('b');
    expect(path).toBe('/create/capabilities');
    // 仍在导入的草稿 → 上传页。
    await userEvent.click(screen.getByRole('button', { name: /A 草稿/ }));
    const [d2, path2] = onResume.mock.calls[1] ?? [];
    expect(d2.id).toBe('a');
    expect(path2).toBe('/create/import');
  });

  it('无标题草稿 → 兜底「未命名草稿」', () => {
    const noTitle = draft();
    delete noTitle.title;
    render(<DraftStrip drafts={[noTitle]} onResume={() => {}} />);
    expect(screen.getByText('未命名草稿')).toBeInTheDocument();
  });
});

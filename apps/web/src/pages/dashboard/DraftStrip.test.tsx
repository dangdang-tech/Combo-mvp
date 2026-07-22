// DraftStrip 测试（外壳首页-16/17/23/33/34）：
//   单 bar 列进行中的创作 + 可理解阶段 / 动态 CTA 与精确断点 / 多条不串台 / 空态不渲染。
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

  it('渲染进行中的创作 + 名称 + 用户阶段 + 后端进度短语', () => {
    render(<DraftStrip drafts={[draft()]} onResume={() => {}} />);
    expect(screen.getByRole('region', { name: '进行中的创作' })).toBeInTheDocument();
    expect(screen.getByText('进行中的创作')).toBeInTheDocument();
    expect(screen.getByText('保险话术草稿')).toBeInTheDocument();
    expect(screen.getByText(/正在完善 Agent/)).toBeInTheDocument();
    expect(screen.getByText(/结构化中 60%/)).toBeInTheDocument();
  });

  it('点动态 CTA → onResume 带首条草稿 + currentStep 对应路由（已过导入 → 能力页）', async () => {
    const onResume = vi.fn();
    render(<DraftStrip drafts={[draft()]} onResume={onResume} />);
    await userEvent.click(screen.getByRole('button', { name: '继续完善 →' }));
    expect(onResume).toHaveBeenCalledOnce();
    const [d, path] = onResume.mock.calls[0] ?? [];
    expect(d.id).toBe('draft-1');
    // PRD 2 步：草稿 currentStep=structure（已过导入）→ 续断点落能力页。
    expect(path).toBe('/create/capabilities');
  });

  it.each([
    ['import', '正在导入会话', '继续导入', '/create/import'],
    ['extract', '正在分析工作历史', '查看分析进度', '/create/capabilities'],
    ['select', 'Agent 已准备好', '查看 Agent', '/create/capabilities'],
    ['structure', '正在完善 Agent', '继续完善', '/create/capabilities'],
    ['publish', '等待发布', '继续发布', '/create/capabilities'],
  ] as const)(
    '%s 阶段 → 展示「%s」并提供「%s」恢复动作',
    async (currentStep, stage, action, expectedPath) => {
      const onResume = vi.fn();
      render(
        <DraftStrip
          drafts={[
            draft({
              currentStep,
              stepProgress: { percent: 42, phrase: '已完成 42%' },
            }),
          ]}
          onResume={onResume}
        />,
      );

      expect(screen.getByText(new RegExp(stage))).toBeInTheDocument();
      const cta = screen.getByRole('button', { name: `${action} →` });
      await userEvent.click(cta);
      expect(onResume).toHaveBeenCalledWith(expect.objectContaining({ currentStep }), expectedPath);
    },
  );

  it('草稿胶囊的 accessible name 同时说明恢复动作、名称、阶段与实时进度', () => {
    render(<DraftStrip drafts={[draft()]} onResume={() => {}} />);
    expect(
      screen.getByRole('button', {
        name: '继续完善：保险话术草稿，正在完善 Agent · 结构化中 60%',
      }),
    ).toBeInTheDocument();
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
    await userEvent.click(screen.getByRole('button', { name: /继续发布：B 草稿/ }));
    const [d, path] = onResume.mock.calls[0] ?? [];
    expect(d.id).toBe('b');
    expect(path).toBe('/create/capabilities');
    // 仍在导入的草稿 → 上传页。
    await userEvent.click(screen.getByRole('button', { name: /继续导入：A 草稿/ }));
    const [d2, path2] = onResume.mock.calls[1] ?? [];
    expect(d2.id).toBe('a');
    expect(path2).toBe('/create/import');
  });

  it('无标题草稿 → 用更新时间形成可区分的创作项目名', () => {
    const noTitle = draft();
    delete noTitle.title;
    render(<DraftStrip drafts={[noTitle]} onResume={() => {}} />);
    const formatted = new Intl.DateTimeFormat('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(noTitle.updatedAt));
    const part = (type: Intl.DateTimeFormatPartTypes): string =>
      formatted.find((entry) => entry.type === type)?.value ?? '';
    expect(
      screen.getByText(
        `Agent 创作 · ${part('month')}/${part('day')} ${part('hour')}:${part('minute')}`,
      ),
    ).toBeInTheDocument();
  });

  it('提取终态已由 worker 持久化 → 自动变成可查看的识别结果，不再假装仍在分析', async () => {
    const onResume = vi.fn();
    render(
      <DraftStrip
        drafts={[
          draft({
            currentStep: 'extract',
            stepProgress: { percent: 100, phrase: '已准备好 5 个 Agent' },
          }),
        ]}
        onResume={onResume}
      />,
    );

    expect(screen.getByText(/识别已完成 · 已准备好 5 个 Agent/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '查看识别结果 →' }));
    expect(onResume).toHaveBeenCalledWith(
      expect.objectContaining({ currentStep: 'extract' }),
      '/create/capabilities',
    );
  });

  it('后端尚无进度短语时只展示阶段名称，不出现空分隔符', () => {
    render(
      <DraftStrip
        drafts={[draft({ currentStep: 'extract', stepProgress: { percent: 0, phrase: '  ' } })]}
        onResume={() => {}}
      />,
    );
    expect(screen.getByText('· 正在分析工作历史')).toBeInTheDocument();
    expect(screen.queryByText(/正在分析工作历史 ·\s*$/)).toBeNull();
  });

  it('发布终态已持久化 → 不再出现在“进行中的创作”', () => {
    const { container } = render(
      <DraftStrip
        drafts={[
          draft({
            currentStep: 'publish',
            stepProgress: { percent: 100, phrase: '发布完成' },
          }),
        ]}
        onResume={() => {}}
      />,
    );

    expect(container.querySelector('.cb-draft-strip')).toBeNull();
  });
});

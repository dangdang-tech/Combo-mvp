// SoftFieldCard 单测（F-13，40 §3.3）——重点：卡住字段必须有「就地可手填」编辑器，绝不冻在骨架。
//
// 契约基线：40 §3.3 continue「卡住字段留空可手填」 + 验收 选择结构化-16；硬规则「永不裸转圈 / 已生成不丢」。
// 覆盖：generating 显骨架；done 显终值可编辑；stuck 渲染内联编辑器且手填可保存（与 done 同一 onSave 落库路径）。
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { FieldStatus, SoftFieldKey } from '@cb/shared';
import { SoftFieldCard } from './SoftFieldCard.js';
import type { SoftFieldView } from './manifestFields.js';

/** 构造一个软字段视图（默认单值字段）。 */
function view(over: Partial<SoftFieldView> & { status: FieldStatus }): SoftFieldView {
  return {
    field: 'tagline' as SoftFieldKey,
    label: '一句话卖点',
    isArray: false,
    text: '',
    items: [],
    attempts: 0,
    ...over,
  };
}

describe('SoftFieldCard', () => {
  it('generating → 显骨架（永不裸转圈），无编辑/保存按钮', () => {
    render(
      <SoftFieldCard
        view={view({ status: 'generating' })}
        onSave={vi.fn()}
        onRegenerate={vi.fn()}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: '保存' })).not.toBeInTheDocument();
  });

  it('done → 显终值，可点「编辑」改并保存（onSave 收单值）', async () => {
    const onSave = vi.fn();
    render(
      <SoftFieldCard
        view={view({ status: 'done', text: '把杂乱想法炼成 PRD' })}
        onSave={onSave}
        onRegenerate={vi.fn()}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByText('把杂乱想法炼成 PRD')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '编辑' }));
    const ta = screen.getByLabelText('编辑一句话卖点');
    await userEvent.clear(ta);
    await userEvent.type(ta, '我的新卖点');
    await userEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(onSave).toHaveBeenCalledWith('我的新卖点');
  });

  it('stuck（核心）→ 渲染就地可手填编辑器（不是冻死骨架），手填后可保存', async () => {
    const onSave = vi.fn();
    render(
      <SoftFieldCard
        view={view({ status: 'stuck' })}
        onSave={onSave}
        onRegenerate={vi.fn()}
        onRetry={vi.fn()}
      />,
    );
    // 卡住态有可手填编辑器（绝不裸转圈干等）。
    const ta = screen.getByLabelText('手填一句话卖点');
    expect(ta).toBeInTheDocument();
    await userEvent.type(ta, '我自己补的卖点');
    await userEvent.click(screen.getByRole('button', { name: '保存' }));
    // 与 done/failed 同一落库路径：onSave 收手填值（continue 后该字段不丢、可填，验收 选择结构化-16）。
    expect(onSave).toHaveBeenCalledWith('我自己补的卖点');
  });

  it('stuck（数组字段）→ 手填多行按行拆成 string[] 保存', async () => {
    const onSave = vi.fn();
    render(
      <SoftFieldCard
        view={view({
          field: 'skill_set' as SoftFieldKey,
          label: '拿手本事',
          isArray: true,
          status: 'stuck',
        })}
        onSave={onSave}
        onRegenerate={vi.fn()}
        onRetry={vi.fn()}
      />,
    );
    const ta = screen.getByLabelText('手填拿手本事');
    await userEvent.type(ta, '本事一{enter}本事二');
    await userEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(onSave).toHaveBeenCalledWith(['本事一', '本事二']);
  });

  it('stuck → 已生成 partial 预填进编辑器（已生成不丢，可在其上接着改）', () => {
    render(
      <SoftFieldCard
        view={view({ status: 'stuck', text: '已生成的半截卖点' })}
        onSave={vi.fn()}
        onRegenerate={vi.fn()}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByLabelText('手填一句话卖点')).toHaveValue('已生成的半截卖点');
  });
});

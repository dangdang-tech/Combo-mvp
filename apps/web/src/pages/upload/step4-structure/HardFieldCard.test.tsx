// HardFieldCard 单测（F-13）：硬字段锁定、只读、无编辑/重生成操作（一眼区分，验收 选择结构化-09/11/27）。
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { HardFieldCard } from './HardFieldCard.js';

describe('HardFieldCard', () => {
  it('显锁定徽章 + 终值，无任何操作按钮', () => {
    render(<HardFieldCard view={{ field: 'version', label: '版本号', display: '0.1.0' }} />);
    expect(screen.getByText('版本号')).toBeInTheDocument();
    expect(screen.getByText('0.1.0')).toBeInTheDocument();
    expect(screen.getByLabelText('平台锁定')).toBeInTheDocument();
    // 硬字段不可改：无编辑/重生成按钮。
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('data-status=locked（恒锁定）', () => {
    const { container } = render(
      <HardFieldCard view={{ field: 'id', label: '唯一标识', display: 'pm-resume-scorer' }} />,
    );
    expect(container.querySelector('[data-status="locked"]')).toBeInTheDocument();
  });
});

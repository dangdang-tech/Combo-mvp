import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { GeneratingPageSkeleton } from './GeneratingPageSkeleton.js';

describe('GeneratingPageSkeleton', () => {
  it('shows only the compact, honest generation status and allows stopping', () => {
    const onStop = vi.fn();
    const { container } = render(<GeneratingPageSkeleton onStop={onStop} />);

    expect(screen.getByRole('status')).toHaveTextContent('正在生成页面完成后会自动显示');
    expect(screen.queryByText('理解页面与修改要求')).not.toBeInTheDocument();
    expect(screen.queryByText('更新 Miniapp 前端')).not.toBeInTheDocument();
    expect(container.querySelector('.rt-page-skeleton__document')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '停止' }));
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('keeps the canvas skeleton without repeating a status rendered elsewhere', () => {
    const { container } = render(<GeneratingPageSkeleton showStatus={false} />);

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '停止' })).not.toBeInTheDocument();
    expect(container.querySelector('[aria-busy="true"]')).toHaveAccessibleName('页面正在生成');
  });
});
